# Security model

Zen MCP controls a real browser, so this document describes the trust
boundaries and what each one is expected to stop. It matches the current
implementation. To report a problem, use the private channel in
[SECURITY.md](../SECURITY.md).

## Trust boundaries

```text
MCP client / model
        │  tool arguments only
        ▼
zen-mcp server (policy, audit, bridge host)
        │  Marionette on 127.0.0.1, one owned session
        ▼
Zen chrome scope (fixed server scripts)
        ▲
        │  loopback WebSocket, mutual HMAC authentication
        ▼
injected bridge in each normal browser window
        │
        ▼
page content (untrusted data)
```

### The model and the MCP client

The agent can only send tool names and structured arguments. Every browser
operation is built by the server: there is no tool that evaluates agent
supplied JavaScript, and page text is returned as data, never as instructions
that the server executes. Page content is treated as untrusted and may contain
prompt injection; the boundary is that it cannot grant new capabilities.

### Launch and ownership

Zen MCP launches its own Zen process with `-marionette`, `-no-remote`, an agent
profile, and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in the child environment only.
No Zen preference is changed, so a normal Zen launch never opens a debug port.
The server refuses to launch if the Marionette port is already open, and for the
normal profile it refuses if Zen is already running. There is no attach path to
someone else's browser.

Each launch carries a random nonce in `ZEN_MCP_LAUNCH_NONCE`. After connecting,
the server reads it back through `Services.env` in chrome scope and compares
it. Only then does it record Gecko's real `moz:processID`. On a mismatch the
server attaches nothing and kills nothing.

### Marionette lockdown

The server reaches Marionette on loopback, on the configured port (2828 by
default; current Zen builds do not offer a random port at launch). Marionette
itself has no authentication, so the server closes the gap in time: after
proving ownership it closes every other Marionette connection and calls
`setAcceptConnections(false)`. If a competing session is present or the
listener cannot be closed, startup fails and the owned browser is shut.

From that point the port refuses new connections. A browser whose session is
lost cannot be re-attached, because the listener stays shut. The server quits
the owned browser on shutdown: graceful quit, forced quit, then termination of
the recorded process. A browser whose identity was never verified is never
killed.

### Bridge authentication

The bridge is injected into each normal browser window at runtime. It connects
out to a WebSocket listener the server opens on `127.0.0.1` at an ephemeral
port, so the browser opens no listening port of its own.

Both sides share a 256-bit key generated for the server session and passed
into chrome only during injection. On every connection, including a reconnect
after the socket drops, the server sends a fresh 32-byte nonce,
the bridge answers with `HMAC-SHA256(key, "zen-mcp-client-auth-v1:" + nonce)`,
and the server verifies that proof with `timingSafeEqual`. The server then
sends its own proof over a differently labelled message, so a proof made for
one direction cannot be replayed as the other. The handshake must finish
within 10 seconds and the protocol and bridge versions must match. Non-loopback
connections are rejected.

The bridge exposes a fixed method map. It does not accept scripts from the
agent, and it renders its cards in a shadow root in browser chrome, not in page
content.

### Consent

With `requireConsent` on (the default), the browser shows a card before the
first read or change. Consent is enforced in the bridge hub, not only in the
MCP tool layer: every bridge request calls an internal assertion that requires
approval and rejects with `consent_required` otherwise. Declining closes the
owned browser. A timeout leaves the card open and returns an error, so a later
call can wait again.

### Global pause and read-only mode

The banner in Zen has a Pause button. Pausing rejects in-flight bridge requests,
hides progress, defers questions, pauses watches, and blocks every browser tool
with the `paused` error, both at the MCP guard and at the bridge request
boundary. `zen_events`, `zen_answers`, `zen_config`, and `zen_audit_tail` stay
available so the agent can see what happened.

`readOnly` blocks the complete mutating tool set: spaces, tabs, folders, pins,
essentials, split view, Glance, clipboard writes, watches, sessions, templates,
and evidence operations. Reads, lists, status, questions, events, and the audit
log keep working. A read-only server also refuses to auto-launch Zen and blocks
`zen_launch`, so it never starts a process or creates a profile.

### URL policy

One normalizer is shared by the MCP guard, the runtime, and the bridge. Inputs
without a scheme are treated as `https`, and only `http` and `https` are
accepted for opening, previewing, and evidence. `zen_tabs_open` additionally
allows `about:` URLs. The domain allowlist matches a host exactly or as a
subdomain on a label boundary, and is checked before tabs open, Glance,
evidence, session restores, and template applies. An empty list allows every
domain; a list whose entries all normalize away denies everything. Sessions
and templates are sanitized and capped before use.

### Reads

Reads go only through the authenticated bridge, never through an ad hoc
Marionette content script. The bridge is injected into normal windows only;
private browsing windows are skipped during injection and rechecked on entry,
and page reads accept only `http(s)` pages. Privileged `about:` pages and tabs
without a content document return a clear error instead of partial content.
PDF text is read through Zen's PDF viewer and requires a visible tab.

### Agent profile

The default is a dedicated agent profile under the Zen MCP data directory. The
normal profile is opt-in with `zen-mcp setup --use-default-profile` or
`useDefaultProfile`, and it lets the agent read pages where the user is signed
in. Before spawning, the server checks the profile lock and fails early if
another Zen owns it.

### Audit log and persistence

The audit log is `audit.jsonl` in the data directory. It records one JSON line
per tool call, including blocked calls, with outcome and duration. URLs keep
only scheme, host, and path; queries, fragments, and credentials are removed.
Long strings and sensitive arguments such as quotes, questions, answers, and
queries become a length and SHA-256 digest. The file is owner-only, rotates at
5 MB with one backup, and a write failure is reported to stderr once without
failing the tool call.

Sessions and templates are written atomically with owner-only permissions. The
directory is created `0700`, files `0600`, writes use a random `O_EXCL` temp
file followed by rename, and a symlink at the target is refused rather than
followed.

## What a local process can and cannot do

A local process running as the same user, which is the realistic attacker
model, can:

- race for a Marionette session in the short window between browser start and
  lockdown, because Marionette has no authentication. The server detects a
  competing session, refuses to continue, and shuts the browser it started.
- connect to the bridge port. Without the per-launch key it cannot complete
  the mutual handshake, so it cannot issue bridge requests.
- read process memory, inspect arguments, or attach a debugger, and read the
  owner-only data directory. No local harness can prevent this.
- cause denial of service, for example by holding the Marionette port or
  killing the browser process.

It cannot:

- attach a second Marionette session after lockdown, or make the server attach
  to a browser it did not start.
- drive the bridge without the key, replay an earlier handshake, or send
  commands before authenticating.
- make the agent run arbitrary JavaScript in chrome or in a page.
- read private windows through the bridge.
- bypass consent, pause, read-only mode, or the domain allowlist through the
  tool surface.
- recover page text or question answers from the audit log, because only
  digests are stored.

## Residual risks

- The startup race before lockdown exists while Marionette has no
  authentication. It is detected, not eliminated.
- The lockdown relies on Zen's internal Marionette module layout. A future Zen
  release can change it; the server then fails to start rather than continue
  without the boundary.
- Page text read by the agent is sent to whatever model provider the MCP
  client uses.
- Using the normal profile exposes signed-in pages to the agent and to that
  provider.
- A compromised account, a debugger, or a hostile extension with existing
  privileges is outside what this project can defend against. See
  [SECURITY.md](../SECURITY.md) for scope.

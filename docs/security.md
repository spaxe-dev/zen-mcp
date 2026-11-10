# Security model

Zen MCP controls a real browser, so this document describes the trust boundaries and what each one is expected to stop. It matches the current implementation. To report a problem, use the private channel in [SECURITY.md](../SECURITY.md).

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

The agent can only send tool names and structured arguments. Every browser operation is built by the server: there is no tool that evaluates agent-supplied JavaScript, and page text is returned as data, never as instructions that the server executes. Page content is treated as untrusted and may contain prompt injection; the boundary is that it cannot grant new capabilities.

### Launch and ownership

Zen MCP launches its own Zen process with `-marionette`, `-no-remote`, an agent profile, and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in the child environment only. No Zen preference is changed, so a normal Zen launch never opens a debug port. The server refuses to launch if the Marionette port is already open, and for the normal profile it refuses if Zen is already running. There is no attach path to someone else's browser.

Each launch carries a random nonce in `ZEN_MCP_LAUNCH_NONCE`. After connecting, the server reads it back through `Services.env` in chrome scope and compares it. Only then does it record Gecko's real `moz:processID`. On a mismatch the server attaches nothing and does not record the answering browser's pid; it shuts down only the process it spawned, never the browser that answered on the port.

### Marionette lockdown

The server reaches Marionette on loopback, on the configured port (2828 by default; current Zen builds do not offer a random port at launch). Marionette itself has no authentication, so the server closes the gap in time: after proving ownership it closes every other Marionette connection and calls `setAcceptConnections(false)`. If a competing session is present or the listener cannot be closed, startup fails and the owned browser is shut.

From that point the port refuses new connections. A browser whose session is lost cannot be re-attached, because the listener stays shut. The server quits the owned browser on `stop`, `SIGINT`, `SIGTERM`, and a closed stdio transport: graceful quit, forced quit, then termination of the recorded process. It only targets a process it launched. If identity was never verified, it does not send Marionette quit commands and terminates the spawned process instead. A crash or `SIGKILL` does not run the shutdown path, so the browser can remain open.

### Bridge authentication

The bridge is injected into each normal browser window at runtime. It connects out to a WebSocket listener the server opens on `127.0.0.1` at an ephemeral port, so the browser opens no listening port of its own.

Both sides share a 256-bit key generated for the server session and passed into chrome only during injection. On every connection, including a reconnect after the socket drops, the server sends a fresh 32-byte nonce, the bridge answers with `HMAC-SHA256(key, "zen-mcp-client-auth-v1:" + nonce)`, and the server verifies that proof with `timingSafeEqual`. The server then sends its own proof over a differently labelled message, so a proof made for one direction cannot be replayed as the other. The handshake must finish within 10 seconds and the protocol and bridge versions must match. Non-loopback connections are rejected.

The bridge exposes a fixed method map. It does not accept scripts from the agent, and it renders its cards in a shadow root in browser chrome, not in page content.

### Consent

With `requireConsent` on (the default), the browser shows a card before the first read or change. Consent is enforced in the bridge hub, not only in the MCP tool layer: every bridge request calls an internal assertion that requires approval and rejects with `consent_required` otherwise.

Consent is per server process, not per browser window. Once granted, relaunching the owned browser does not show the card again. Declining closes the owned browser and stores a denied state for the rest of the process, so the server must be restarted to ask again. A timeout leaves the card open and returns an error, so a later call can wait again. Nothing is read or changed before approval.

### Global pause and read-only mode

The banner in Zen has a Pause button. Pausing rejects pending bridge requests, hides the progress card, defers questions, skips watch polls, and blocks every browser tool with the `paused` error, both at the MCP guard and at the bridge request boundary. `zen_events`, `zen_answers`, `zen_config`, and `zen_audit_tail` stay available so the agent can see what happened.

A command that is already executing in Zen when Pause is pressed may still finish in the browser. The server drops its result and rejects later requests. Pause is held in memory, is not persisted, and does not remove evidence overlays that are already visible.

`readOnly` blocks the complete mutating tool set: `zen_launch` and 31 other tools covering spaces, tabs, folders, pins, essentials, split view, Glance, page clicks and typing, clipboard writes, watches, sessions, templates, tab grouping, evidence operations, and the on-screen progress, question, and notification cards. Reads, lists, status, events, collected answers, and the audit log keep working. A read-only server also refuses to auto-launch Zen, so it never starts a process or creates a profile.

Read-only mode is not a confidentiality boundary. Session and template listings still return stored URLs, and page reads still return page text. Use Pause when the user wants to stop browser access entirely.

### URL policy

One normalizer is shared by the MCP guard, the runtime, and the bridge. Inputs without a scheme are treated as `https`. `zen_tabs_open` accepts `http(s)` and `about:` URLs; Glance previews and both Evidence tools accept only `http(s)`. With an empty allowlist these are all permitted. With a non-empty allowlist, every URL is matched by host, so an `about:` URL is rejected along with any other non-`http(s)` scheme.

The domain allowlist matches a host exactly or as a subdomain on a label boundary, and is checked before tabs open, Glance, evidence, watches, session restores, and template applies. Page actions check the tab URL, an anchor's `href`, and the tab URL again after the action. Glance resolves the selected tab's current URL, requires `http(s)`, and checks the allowlist before the preview loads, so a privileged or off-list tab is refused before any load starts. The preview uses a content principal for that URL rather than the system principal. After it opens, the bridge reads the URL the preview actually committed; a redirect that lands outside the allowlist closes the preview and fails the call. A later location change on the glance is watched too, and a preview that leaves the allowlist is closed. The tab URL is checked again immediately after `zen_tabs_open` returns, and a tab that landed outside the list is closed. A slow script or meta redirect after that check can still move the tab; reads recheck the URL before returning content. An empty list allows every domain; a list whose entries all normalize away denies everything. Sessions and templates are sanitized and capped before use.

### Reads

Reads go only through the authenticated bridge, never through an ad hoc Marionette content script. The bridge is injected into normal windows only; private browsing windows are skipped during injection and rechecked on entry, and page reads accept only `http(s)` pages. Privileged `about:` pages and tabs without a content document return a clear error instead of partial content. A loaded tab in a background space can be read; a tab that has not loaded returns `tab_not_loaded`.

PDF text is read through Zen's PDF viewer. That viewer may not be initialized for a hidden tab, so a hidden PDF can return `pdf_unreadable`; open the PDF and retry. This path is not covered by the automated live suite. Text reads capture the rendered light DOM only; iframes (same-origin and cross-origin), shadow roots, canvas, images, SVG, and form controls are not included. The interactive format is the narrow exception: it enumerates visible form controls, links, buttons, and common ARIA controls, walks open shadow roots, and returns metadata plus refs instead of page text.

### Page actions

`zen_click` and `zen_type` are the only tools that send input to page content. They do not accept scripts: an interactive read assigns refs with a fixed server script, and the action resolves exactly one ref or CSS selector with another fixed script, then calls Marionette's native click or sendKeys command. There is no tool that evaluates agent-supplied JavaScript, and the agent cannot choose a script body.

Both tools require an `http(s)` tab and are blocked by read-only mode, Pause, and consent. The bridge checks the tab URL and, for a link, the resolved `href` against the domain allowlist before the action, and the host checks the tab URL again after it. The action can still have page-level effects the allowlist cannot predict: a click may submit a form, start a download, open a dialog, navigate, or make a purchase, and an in-page script may change location after the check. The user has to ask for the interaction; the tool descriptions tell the model to treat labels and nearby text as untrusted content.

`zen_type` refuses disabled and read-only targets and file inputs, caps text at 10,000 characters, and reports only a character count. Password inputs are never included in `value`, and a type into a password field returns a limitation instead of echoing anything. Interactive refs expire after another interactive read or a navigation, so a stale ref fails rather than targeting a different element. A ref still resolves against the page as it exists at action time, so a page that changes between the read and the action can move its controls; read again when the target matters.

### Private windows

Private windows are skipped during bridge injection, and an existing bridge found in a private window is destroyed. This is a best-effort boundary: the detection path is implemented, but private-window behavior is not covered by the automated live suite. Do not rely on it as the only protection when using the normal profile.

### Agent profile

The default is a dedicated agent profile under the Zen MCP data directory. The normal profile is opt-in with `zen-mcp setup --use-default-profile` or `useDefaultProfile`, and it lets the agent read pages where the user is signed in. Before spawning, the server checks the profile lock and fails early if another Zen owns it.

### Audit log and persistence

The audit log is `audit.jsonl` in the data directory. It records one JSON line per tool call, including blocked calls, with outcome and duration. Resource reads are recorded as `resource:<uri>` entries with no arguments.

The log separates execution from result. `executed` is `true` when the handler returned a result; policy blocks, Pause, cancellation, and thrown errors record `executed: false` and `ok: false`. `ok` reports whether the tool's structured result succeeded, so a returned result with `ok: false` is logged as `ok: false, executed: true` without changing the tool response. For `zen_show_evidence_batch`, `ok` reflects citation verification rather than execution: a batch with any failed citation is not logged as a success. Batch entries also carry `citationsVerified` and `citationsFailed`, plus `outcome` (`success` when the batch is ok and no citation failed, `partial` when some citations verified, `failed` when none verified). These fields hold counts and status only, never quote text or page content. Records written by older versions may omit `executed` and the citation fields.

Argument summaries are bounded by depth (3) and array length (20). URLs keep only scheme, host, and path; queries, fragments, and credentials are removed. Long strings and sensitive arguments such as quotes, questions, answers, queries, and page text become a length and SHA-256 digest. If the summarized argument JSON is still larger than 2,048 characters, the log stores `{ truncated, size, preview }`; the preview can contain up to about 1,950 characters of the already summarized JSON. Audit redaction reduces exposure but is not a guarantee that no argument text is ever stored.

The file is owner-only where POSIX modes apply, rotates at 5 MB with one backup, and a write failure is reported to stderr once without failing the tool call.

Sessions and templates are written atomically with owner-only permissions. The directory is created `0700`, files `0600`, writes use a random `O_EXCL` temp file followed by rename, and a symlink at the target is refused rather than followed. Windows does not apply POSIX mode bits the same way, so the permission guarantee there is best effort.

### Resources

MCP resources are not tool calls. They bypass the MCP guard, so they are not filtered by `readOnly` or `allowedDomains`. Each read is written to the audit log as `resource:<uri>` without arguments. Resources backed by live browser state still go through the bridge, so consent and Pause apply. `zen://questions` reports server-side state and remains readable while paused. Errors are returned as a JSON payload with an `error` string instead of failing the resource request.

## What a local process can and cannot do

A local process running as the same user, which is the realistic attacker model, can:

- race for a Marionette session in the short window between browser start and lockdown, because Marionette has no authentication. The server detects a competing session, refuses to continue, and shuts the browser it started.
- connect to the bridge port. Without the per-launch key it cannot complete the mutual handshake, so it cannot issue bridge requests.
- read process memory, inspect arguments, or attach a debugger, and read the owner-only data directory. No local harness can prevent this.
- cause denial of service, for example by holding the Marionette port or killing the browser process.

It cannot:

- attach a second Marionette session after lockdown, or make the server attach to a browser it did not start.
- drive the bridge without the key, replay an earlier handshake, or send commands before authenticating.
- make the agent run arbitrary JavaScript in chrome or in a page.
- bypass consent, Pause, read-only mode, or the domain allowlist through the tool surface.
- rely on the audit log as a place to recover page text or question answers: sensitive values are digested. A bounded preview of summarized arguments can remain, and resource entries carry no arguments.
- reach private browsing windows through the bridge on the tested path, but that exclusion is not covered by the automated live suite.

## Residual risks

- The startup race before lockdown exists while Marionette has no authentication. It is detected, not eliminated.
- The lockdown relies on Zen's internal Marionette module layout. A future Zen release can change it; the server then fails to start rather than continue without the boundary.
- Page text read by the agent is sent to whatever model provider the MCP client uses.
- Using the normal profile exposes signed-in pages to the agent and to that provider.
- A redirect that happens after the immediate post-open allowlist check can move a tab outside the list until the next read or action rechecks it.
- A click or typed input is a real browser event. The allowlist checks the tab URL and link target, but an in-page script can submit a form, start a download, open a dialog, or navigate somewhere else after the action. Read-only mode and Pause are the controls that remove this capability entirely.
- A complex or hostile page can still show misleading content to the model, even though it cannot gain new browser capabilities.
- A compromised account, a debugger, or a hostile extension with existing privileges is outside what this project can defend against. See [SECURITY.md](../SECURITY.md) for scope.

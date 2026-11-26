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

The key stays inside the bridge closure and is never placed on `window.__zenMcpBridge`. That global exposes only `version`, a non-secret SHA-256-derived `tokenId`, `windowId`, and the `isConnected`, `reconnect` and `destroy` callbacks. The server uses `tokenId` to recognise a bridge left by an earlier session and replace it; reconnects within the same session keep using the closure key, so the handshake is unchanged.

The bridge exposes a fixed method map. Dispatch checks that the requested name is an own property of that map, so inherited names such as `constructor`, `toString` or `__proto__` are rejected as unknown methods. The bridge does not accept scripts from the agent, and it renders its cards in a shadow root in browser chrome, not in page content.

### Consent

With `requireConsent` on (the default), the browser shows a card before the first read or change. Consent is enforced in the bridge hub, not only in the MCP tool layer: every bridge request calls an internal assertion that requires approval and rejects with `consent_required` otherwise.

Consent is per server process, not per browser window. Once granted, relaunching the owned browser does not show the card again. Declining closes the owned browser and stores a denied state for the rest of the process, so the server must be restarted to ask again. A timeout leaves the card open and returns an error, so a later call can wait again. Nothing is read or changed before approval.

### Global pause and read-only mode

The banner in Zen has a Pause button. Pausing rejects pending bridge requests, hides the progress card, defers questions, skips watch polls, and blocks every browser tool with the `paused` error, both at the MCP guard and at the bridge request boundary. `zen_events`, `zen_answers`, `zen_config`, and `zen_audit_tail` stay available so the agent can see what happened, but `zen_events` serves only control events while paused: new browser observations are dropped and buffered ones are hidden.

A command that is already executing in Zen when Pause is pressed may still finish in the browser. The server drops its result and rejects later requests. Pause is held in memory, is not persisted, and does not remove evidence overlays that are already visible.

`readOnly` blocks the complete mutating tool set: `zen_launch` and 31 other tools covering spaces, tabs, folders, pins, essentials, split view, Glance, page clicks and typing, clipboard writes, watches, sessions, templates, tab grouping, evidence operations, and the on-screen progress, question, and notification cards. Reads, lists, status, events, collected answers, and the audit log keep working. A read-only server also refuses to auto-launch Zen, so it never starts a process or creates a profile. When no `policy.json` exists, `readOnly` is translated in memory to deny-only capability restrictions, so the tool set is unchanged.

Read-only mode is not a confidentiality boundary. Session and template listings still return stored URLs, and page reads still return page text. Use Pause when the user wants to stop browser access entirely.

### Capability policy

`policy.json`, beside `config.json`, is the authoritative tool policy. A missing file never widens access: the server runs in `restricted` mode from memory and warns, and `zen-mcp policy init` creates the file explicitly. An invalid file fails closed: every browser capability is denied and only `diagnostics.read`, `audit.read`, `events.read` and `tools.discover` remain available so the agent can report the problem. No startup path writes or rewrites the file.

The four modes are cumulative:

| Mode | What it allows by default |
| --- | --- |
| `restricted` | Status, events, tool discovery, config and audit. No browser launch or page access. |
| `normal` | Reads, navigation, spaces, folders, tabs, pins, tab close, page clicks and typing, layout, watches, session and template reads, and questions. No evidence display, history, bookmarks, clipboard writes, space delete, session or template writes, or downloads. |
| `permissive` | Adds evidence display, space delete, history, bookmarks, clipboard writes, and session and template writes. |
| `full` | Everything that is not permanently denied. |

With permanent denies excluded, the current effective capability counts are 5 in `restricted`, 34 in `normal`, 42 in `permissive` and 42 in `full`.

Evaluation is deterministic and follows one order: an invalid policy, an unknown capability, a permanent deny, a permanent restriction, an explicit deny, an explicit allow or the mode, then website rules. A later rule never rescues an earlier deny. Permanent denies cannot be allowed by any mode, override or website rule: they cover downloads, internal privileged pages, cookies, saved passwords, settings, extensions, browsing data, the profile filesystem, DevTools, uploads, software installation and screenshots.

Website rules use the same canonical host matcher as the runtime allowlist. A bare host matches itself and its subdomains; `*.example.com` matches subdomains only. A block entry overrides an allow entry and a rule allow, a rule deny overrides a rule allow, and a non-empty `websites.allow` with `default: "deny"` rejects every other host. Non-`http(s)` URLs are denied; `about:blank` is the only exception, and only for navigation.

`zen-mcp policy init`, `policy show`, `policy set <capability> allow|deny` and `policy mode <mode>` are the writers. They share strict schema validation, revision checks and the atomic owner-only writer. MCP agents have no tool or bridge operation that writes policy, and `zen_config` reports only the source, mode, revision, website summary and restricted capability names with a `<config>/policy.json` placeholder.

Migration is explicit. `policy init` reads the current `config.json` once: a default config becomes `restricted`; `readOnly: true` becomes `permissive` plus a deny restriction on every tool that read-only blocked; a non-empty `allowedDomains` becomes `permissive` plus a website default deny and the normalized allow list. A migrated configuration never gains a capability it did not already have. A valid `policy.json` is authoritative for tools, but the legacy `readOnly` and `allowedDomains` runtime checks remain in place as defense in depth until they are removed from `config.json`; the server warns about this.

Phase 1 evaluates at the MCP tool boundary. Calls identified only by `tabId` (reads, clicks, typing, evidence), tab and history/bookmark listings, and watch polling are not website-filtered by `policy.json` yet; the existing runtime allowlist still enforces `allowedDomains` for those paths. Browser-side policy enforcement is Phase 2.

### URL policy

One normalizer is shared by the MCP guard, the runtime, and the bridge. Inputs without a scheme are treated as `https`. `zen_tabs_open` accepts `http(s)` and `about:` URLs; Glance previews and both Evidence tools accept only `http(s)`. With an empty allowlist these are all permitted. With a non-empty allowlist, every URL is matched by host, so an `about:` URL is rejected along with any other non-`http(s)` scheme.

The domain allowlist matches a host exactly or as a subdomain on a label boundary, and is checked before tabs open, Glance, evidence, watches, session restores, and template applies. Page actions check the tab URL, the target frame URL, an anchor's `href`, and the tab URL again after the action. Frame reads and listings also apply the allowlist, so a frame outside it is never listed, read, or driven. Glance resolves the selected tab's current URL, requires `http(s)`, and checks the allowlist before the preview loads, so a privileged or off-list tab is refused before any load starts. The preview uses a content principal for that URL rather than the system principal. After it opens, the bridge reads the URL the preview actually committed; a redirect that lands outside the allowlist closes the preview and fails the call. A later location change on the glance is watched too, and a preview that leaves the allowlist is closed. The tab URL is checked again immediately after `zen_tabs_open` returns, and a tab that landed outside the list is closed. A slow script or meta redirect after that check can still move the tab; reads recheck the URL before returning content. An empty list allows every domain; a list whose entries all normalize away denies everything. Sessions and templates are sanitized and capped before use.

### Reads

Reads go only through the authenticated bridge, never through an ad hoc Marionette content script. The bridge is injected into normal windows only; private browsing windows are skipped during injection and rechecked on entry, and page reads accept only `http(s)` pages. Privileged `about:` pages and tabs without a content document return a clear error instead of partial content. A loaded tab in a background space can be read; a tab that has not loaded returns `tab_not_loaded`.

PDF text is read through Zen's PDF viewer. That viewer may not be initialized for a hidden tab, so a hidden PDF can return `pdf_unreadable`; open the PDF and retry. This path is not covered by the automated live suite. Text reads capture one document's rendered light DOM; shadow roots, canvas, images, SVG, and form controls are not included. Iframe text is available through `framePath`, and an interactive read scans visible form controls, links, buttons, and common ARIA controls, walks open shadow roots, and merges controls from reachable frames with frame-prefixed refs. Off-list and non-http(s) frames are omitted and never read.

A semantic read is also a fixed server script. It returns a bounded model of the top document: landmarks, headings, sections, repeated collections, forms, tables, dialogs and a confidence-labelled page type, with refs shared with snapshot and interactive reads. The model never carries field values, value lengths, selected text or `aria-hidden` content, and it records whether each label was observed in accessibility attributes or inferred heuristically. Classification is deterministic but heuristic: a wrong or low-confidence type changes only how the model is labelled, not what is collected, and privacy does not depend on the classifier being right.

### Page actions

`zen_click` and `zen_type` are the only tools that send input to page content. They do not accept scripts: an interactive read assigns refs with a fixed server script, and the action resolves exactly one ref or CSS selector with another fixed script, then calls Marionette's native click or sendKeys command. A frame ref is resolved and acted on through that frame's own actor. There is no tool that evaluates agent-supplied JavaScript, and the agent cannot choose a script body.

Both tools require an `http(s)` tab, refuse frames that are not `http(s)`, and are blocked by read-only mode, Pause, and consent. The bridge checks the tab URL, the frame URL, and, for a link, the resolved `href` against the domain allowlist before the action, and the host checks the tab URL and frame URL again after it. The action can still have page-level effects the allowlist cannot predict: a click may submit a form, start a download, open a dialog, navigate, or make a purchase, and an in-page script may change location after the check. The user has to ask for the interaction; the tool descriptions tell the model to treat labels and nearby text as untrusted content.

`zen_type` refuses disabled and read-only targets and file inputs, caps text at 10,000 characters, and reports only a character count. Password inputs are never included in `value`, and a type into a password field returns a limitation instead of echoing anything. Interactive refs expire after another interactive read or a navigation, so a stale ref fails rather than targeting a different element. A ref still resolves against the page as it exists at action time, so a page that changes between the read and the action can move its controls; read again when the target matters.

`zen_wait_for` and the post-action effect probes are also fixed scripts. The wait probe returns only the document URL, title, ready state, and whether one server-chosen condition holds. The effect signature returns hashes of text and non-password form values, plus counts and lengths, never the values themselves. `zen_wait_for` is read-only and stays available in read-only mode; it does not select the tab or touch the page, and each frame poll rechecks the allowlist.

### Browser events

`zen_events` mixes control events from the server with browser observations
pushed from fixed chrome listeners: tab opened, closed or selected, navigation
phases, document replacement, and dialog shown or hidden. An event carries an
id, timestamp, tab or document identity and a source; it never carries page
text, form values, or dialog text, and dialogs are never dismissed. An event's
bounded `detail` may be the page title for an allowed page. Navigation and
document events for a URL outside the domain allowlist are dropped and counted
in `filtered`, so an off-list URL is not exposed through the stream. The buffer
is bounded at 200 events, browser kinds expire after 10 minutes, repeats are
deduplicated for 2 seconds, and `missed` reports events the cursor can no
longer read. Pause drops new browser observations and hides buffered ones from
the tool; only control events such as pause and resume are served. An
observation is evidence that a transition occurred, not proof of what caused
it.

### Private windows

Private windows are skipped during bridge injection, and an existing bridge found in a private window is destroyed. Dialog observation also skips windows marked as private. This is a best-effort boundary: the detection path is implemented, but private-window behavior is not covered by the automated live suite. Do not rely on it as the only protection when using the normal profile.

### Agent profile

The default is a dedicated agent profile under the Zen MCP data directory. The normal profile is opt-in with `zen-mcp setup --use-default-profile` or `useDefaultProfile`, and it lets the agent read pages where the user is signed in. Before spawning, the server checks the profile lock and fails early if another Zen owns it.

Agent-facing tool and resource output never carries an absolute storage location. `zen_status`, `zen_launch`, `zen_config`, `zen_audit_tail` and `zen://status` return `<profile>`, `<data>` and `<data>/audit.jsonl` placeholders instead of the profile, data directory and audit log paths. The real paths stay available to the operator in `zen-mcp status` and `zen-mcp doctor`; a future explicitly controlled diagnostics capability can expose them to the agent on request.

### Audit log and persistence

The audit log is `audit.jsonl` in the data directory. It records one JSON line per tool call, including blocked calls, with outcome and duration. Resource reads are recorded as `resource:<uri>` entries with no arguments.

Calls rejected by input schema validation are audited too. A direct call and a call routed through `zen_tools_use` both write an `invalid_args` entry with `ok: false, executed: false` and return a structured `invalid_args` error. The audit line stores the summarized arguments, so sensitive fields such as page text follow the same redaction as any other call and are not written in clear text. The error message names the validation failure without echoing the received values.

The log separates execution from result. `executed` is `true` when the handler returned a result; policy blocks, Pause, cancellation, and thrown errors record `executed: false` and `ok: false`. `ok` reports whether the tool's structured result succeeded, so a returned result with `ok: false` is logged as `ok: false, executed: true` without changing the tool response. Records from the capability policy also carry `capability`, `mode`, `policyRevision` and `policySource` (`file`, `legacy`, `default` or `invalid`), so a block can be traced to the rule set that produced it. These fields never include website lists, URLs, quotes or page content. For `zen_show_evidence_batch`, `ok` reflects citation verification rather than execution: a batch with any failed citation is not logged as a success. Batch entries also carry `citationsVerified` and `citationsFailed`, plus `outcome` (`success` when the batch is ok and no citation failed, `partial` when some citations verified, `failed` when none verified). These fields hold counts and status only, never quote text or page content. Records written by older versions may omit `executed`, the citation fields and the policy fields.

Argument summaries are bounded by depth (3) and array length (20). URLs keep only scheme, host, and path; queries, fragments, and credentials are removed. Long strings and sensitive arguments such as quotes, questions, answers, queries, and page text become a length and SHA-256 digest. If the summarized argument JSON is still larger than 2,048 characters, the log stores `{ truncated, size, preview }`; the preview can contain up to about 1,950 characters of the already summarized JSON. Audit redaction reduces exposure but is not a guarantee that no argument text is ever stored.

The file is owner-only where POSIX modes apply, rotates at 5 MB with one backup, and a write failure is reported to stderr once without failing the tool call.

Sessions and templates are written atomically with owner-only permissions. The directory is created `0700`, files `0600`, writes use a random `O_EXCL` temp file followed by rename, and a symlink at the target is refused rather than followed. Windows does not apply POSIX mode bits the same way, so the permission guarantee there is best effort.

### Resources

MCP resources are not tool calls. They bypass the MCP guard, so they are not filtered by the capability policy, `readOnly` or `allowedDomains`. Each read is written to the audit log as `resource:<uri>` without arguments. Resources backed by live browser state still go through the bridge, so consent and Pause apply. `zen://questions` reports server-side state and remains readable while paused. Errors are returned as a JSON payload with an `error` string instead of failing the resource request.

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
- bypass consent, Pause, the capability policy, read-only mode, or the domain allowlist through the tool surface.
- rely on the audit log as a place to recover page text or question answers: sensitive values are digested. A bounded preview of summarized arguments can remain, and resource entries carry no arguments.
- reach private browsing windows through the bridge on the tested path, but that exclusion is not covered by the automated live suite.

## Residual risks

- The startup race before lockdown exists while Marionette has no authentication. It is detected, not eliminated.
- The lockdown relies on Zen's internal Marionette module layout. A future Zen release can change it; the server then fails to start rather than continue without the boundary.
- Page text read by the agent is sent to whatever model provider the MCP client uses.
- Using the normal profile exposes signed-in pages to the agent and to that provider.
- A redirect that happens after the immediate post-open allowlist check can move a tab outside the list until the next read or action rechecks it.
- A click or typed input is a real browser event. The allowlist checks the tab URL, the frame URL, and the link target, but an in-page script can submit a form, start a download, open a dialog, or navigate somewhere else after the action. Read-only mode and Pause are the controls that remove this capability entirely.
- A complex or hostile page can still show misleading content to the model, even though it cannot gain new browser capabilities.
- A compromised account, a debugger, or a hostile extension with existing privileges is outside what this project can defend against. See [SECURITY.md](../SECURITY.md) for scope.

# Troubleshooting and known limitations

## First checks

```sh
zen-mcp status     # config path, profile mode, port state
zen-mcp doctor     # executable, profile lock, port, bridge, policy
```

Set `ZEN_MCP_LOG=debug` in the MCP client's environment for more detail. Logs go to stderr; stdout is the MCP transport.

Inside a session, `zen_config` shows the effective read-only mode, allowlist, audit settings, and data directory. `zen_audit_tail` shows recent calls, including blocked ones.

## Errors

**"Zen is not running. Zen MCP launches its own browser with agent access..."**
Nothing owns the agent browser yet and the server is not allowed to start one: `autoLaunch` is off, or read-only mode is on (a read-only server never auto-launches Zen). With `readOnly` off, call `zen_launch`, start the server again, or set `autoLaunch` to true.

**"Marionette is already listening on port 2828"**
Another Zen or a WebDriver session owns the port. Zen MCP will not attach to it. Quit that browser or stop the other tool, then call `zen_launch` again. Current Zen builds always use 2828, so changing `marionettePort` usually makes the launch fail instead of fixing the conflict.

**"Zen is already running with its normal profile"**
`useDefaultProfile` is on and a normal Zen is running. Zen MCP refuses to launch rather than attach to or share that instance. Quit Zen completely, or switch to the dedicated agent profile with `zen-mcp setup --dedicated-profile`.

**"Zen did not open Marionette on port 2828 within Ns"**
The browser process started but did not accept the Marionette port within the timeout. Check the executable with `zen-mcp doctor`, make sure no other Zen instance is interfering, and try again. The launch attempt was stopped so it cannot keep the profile locked.

**"The browser answering on the Marionette port was not the one Zen MCP just started"**
A second browser won the port during the startup race. Zen MCP did not attach to it and did not record its pid. The process Zen MCP spawned is shut down; the browser that answered is not touched. Quit the browser on 2828 and retry.

**"The Marionette port could not be locked down"**
Zen started, but the internal Marionette server did not close its listener. The server shut the owned browser instead of continuing without the boundary. This is usually a Zen version change; check `zen-mcp doctor`.

**"Zen MCP is waiting for approval in Zen"**
Click **Allow this session** on the card in the agent's Zen window, then call the tool again. The wait is `consentTimeoutSeconds` (90 seconds by default). A timeout leaves the card open.

**"Browser access was declined in Zen"**
The browser Zen MCP started was closed. The server stays unapproved for the rest of that process; restart the MCP server to ask again. Setting `requireConsent` to false removes the card, but also removes the approval step.

**A tool fails with `paused`**
Someone pressed **Pause** in the Zen banner. The browser is blocked until **Resume** is pressed. This is not a retryable error; wait for the user. A command that was already running may still finish in Zen, but its result is discarded.

**"The Zen profile at ... is already open in another browser"**
The configured profile is locked by a running Zen. Quit that instance, or use the dedicated agent profile. This check happens before spawning, so it fails immediately instead of waiting for a Marionette timeout.

**"Zen MCP never attaches to private browsing windows"**
Only normal windows get the bridge. Open a normal window for the agent.

**`zen_read_page` says the page is privileged or still loading**
`about:` pages and tabs without a content document cannot be scraped. Wait for loading to finish, or open the HTTP version of the page. A loaded tab in a background space is readable; a tab that has not loaded returns `tab_not_loaded`.

**A PDF reports `pdf_unreadable`**
Zen's PDF viewer may not be initialized for a hidden tab. Open the PDF, then read the active tab. PDF reads outside the active tab are not covered by the automated live suite.

**`zen_show_evidence` returns `QUOTE_NOT_FOUND`, `AMBIGUOUS_MATCH`, or `LOW_MATCH_CONFIDENCE`**
No highlight was added and the quote should not be presented as support. Copy the passage from the page, shorten it, or add surrounding `context`. PDFs and privileged pages cannot be inspected at all.

**A fuzzy evidence match has `verified: false`**
The passage is a possible match, not confirmed support. Check it manually. A batch is `ok: false` when any citation is unverified or failed.

**A tool reports `actor_unavailable`**
The owned browser disconnected. Because the Marionette listener stays shut, this server cannot re-attach. Quit that Zen window, then call `zen_launch` to start a new owned browser.

**The corner cards do not appear**
Only browser windows get the bridge. New windows are attached automatically when `autoAttachWindows` is on; a tool call also injects into a window that does not have it yet. If cards still do not show, run `zen-mcp doctor` and check the bridge line.

**A tool is blocked with `read_only` or `domain_not_allowed`**
Run `zen_config` to see the effective policy, then `zen_audit_tail` to see the blocked call. Change the config file or an environment variable and restart the server.

**An MCP resource returns `{ "error": ... }`**
Resources return errors as JSON instead of failing the request. The message describes the bridge or consent failure. Browser-backed resources still go through consent and Pause, so check for a pending approval card or a paused session. `zen://questions` is server-side and stays readable while paused.

## Known limitations

- Zen's internal workspace and folder APIs can change between releases. Pin a Zen version if a newer build breaks spaces; the error names the failing call.
- Marionette is fixed at port 2828 in current Zen builds, so there is one agent browser per machine. Two Zen MCP servers cannot share it.
- The startup race before lockdown cannot be eliminated while Marionette has no authentication. The server detects it and fails closed.
- A browser whose Marionette session is lost cannot be re-attached, because the listener stays shut. Quit it and start a new one.
- Shutdown runs on `stop`, `SIGINT`, `SIGTERM`, and a closed stdio transport. It does not run on a crash or `SIGKILL`, so the owned browser can stay open after an abnormal exit.
- Evidence Mode searches rendered DOM text, not pixels. Iframes (same-origin and cross-origin), open shadow roots, images, canvas, SVG, and form controls cannot be searched. Hidden, clipped, or off-screen passages are not indexed.
- Evidence only sees the current DOM. Infinite-scroll content and content behind interaction are invisible until loaded.
- Evidence marks are temporary overlays. They can drift if the page reflows while visible, and pages that change constantly may return `HIGHLIGHT_FAILED`. Pause does not remove them.
- `zen_clear_evidence` without a `tab_id` only knows about the 20 most recently marked tabs.
- Reads and searches capture the current DOM text. Client-rendered and infinite-scroll pages return only what has loaded.
- PDF text extraction depends on Zen's PDF viewer and is unreliable for hidden tabs.
- Watches run in the server process and stop when it exits. They do not survive a restart.
- Consent is per server process, not per browser window. Approval is reused across relaunches, and a decline requires a server restart.
- Read-only mode blocks mutations, not reads. Session and template listings still show stored URLs.
- The domain allowlist is checked before an action and again immediately after `zen_tabs_open`, but a redirect that happens later can move a tab outside the list. Reads recheck the tab URL.
- The audit log redacts sensitive values and long strings, but a bounded preview of the summarized argument JSON can remain. Resource reads are logged as `resource:<uri>` entries without arguments.
- Private-window exclusion is implemented but not covered by the automated live suite. Treat it as a best-effort boundary.
- No screenshot or click automation inside pages. This harness controls Zen and the agent conversation, not arbitrary web apps.
- No per-action approval cards. Approval is per server session, and Pause is the global stop switch. Use read-only mode and the domain allowlist for additional guardrails.
- macOS and Linux builds pass CI but have not had a live Zen launch verified. Windows is the only live-tested platform.

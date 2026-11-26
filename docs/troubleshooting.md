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

**`zen_click` or `zen_type` returns `element_not_found`, `stale_reference`, or `document_changed`**
The ref came from an older read, the element was removed or replaced by a same-shaped clone, the page navigated, or the selector matched nothing. A semantic `target.ref` reports `stale_reference`; a document that was replaced between resolution and input reports `document_changed`. Run `zen_read_page { format: "snapshot" }` or `{ format: "interactive" }` for that tab and use a fresh ref instead of retrying the stale one.

**A semantic target returns `target_not_found`, `target_ambiguous`, or `target_not_actionable`**
`target_not_found` means nothing matched the role, name, text, label, or placeholder; check the spelling and the page state, or take a snapshot. `target_ambiguous` means more than one element matched; `details.candidates` lists up to five, and the server will not pick the first. Use a more specific role+name, a label, or a ref. `target_not_actionable` means the match is hidden, disabled, read-only, not editable, or a file input; `details.reason` says which.

**A semantic scan returns `unsupported_operation` with reason `scan_limit`**
The page is too large or too deeply nested to prove a unique match within the bounded scan (6,000 nodes, six matches, six levels). The target was not reported as absent or unique. Narrow the page with a selector, take a snapshot, and act on a ref instead.

**`zen_click` or `zen_type` returns `element_disabled`, `element_readonly`, or `unsupported_target`**
The legacy shortcuts keep these codes. The control cannot accept that action right now. A disabled control has to be enabled by the page first; a read-only field cannot be typed into; file inputs are refused by design. Pick a different control or ask the user to complete that step.

**An interactive read returns `elementsTruncated: true`**
The scan stopped at 200 visible controls. Pass a `selector` that narrows the page area, or read a specific frame with `framePath`, then run the interactive read again.

**A snapshot reports `snapshotComplete: false`**
Some controls may be missing from the result. Read `limitations`: frames can be unlisted after the 20-frame listing cap, skipped by the domain allowlist, left unscanned after 10 frame scans, or fail to load. A selector-scoped snapshot is complete for its subtree but never includes frame controls. Output caps (`textTruncated`, `elementsTruncated`, `outlineTruncated`) do not make the snapshot incomplete; raise `maxElements` up to 200 or read the full text with `format: "text"`.

**A semantic read reports `coverage.complete: false`**
The model is partial. Read `limitations`: a region, heading, collection, dialog, or control cap was hit, the 6,000-node scan was truncated, the page has a child frame (the model covers the top document only), or the 20-frame listing was truncated. Narrow the read with `selector`, read a frame separately with `framePath`, or raise `maxElements` up to 120. Child frames are never merged into the semantic model.

**A semantic classification looks wrong or low-confidence**
Classification is heuristic and deliberately conservative. Read `signals` to see what it observed and `confidence` to see how close the top two candidates were. When two candidates are close, confidence is capped at 0.6. Treat `generic` as "no confident match", not a failure. Prefer structure (landmarks, regions, collections) over the label when deciding what to do.

**`zen_wait_for` returns `matched: false`**
The condition never held before the timeout, the document could not be probed, or the page left the domain allowlist. Read `limitation`: a probe failure names the error, a timeout means the condition did not appear (for `selector`, `text`, `url_contains`, `title_contains`, `document_id`, `new_tab`, or `dialog`), and `tab_closed` reports that the tab stayed open. Document waits never match an empty identity or a disconnected tab. Check the condition spelling, allow more time up to 30000 ms, or read the page to see its current state. A timeout is a normal result, not a failed call. `timeout_ms: 0` checks once.

**`zen_wait_for` returns `invalid_args`**
Pass exactly one condition. Two conditions at once, or none, are refused. `until: "absent"` applies only to `selector`, `text`, `url_contains`, and `title_contains`; `state` requires `selector`; and document conditions reject `frame_path`.

**`zen_events` returns `missed` above zero, or nothing for an expected transition**
The cursor fell behind the 200-event buffer or a browser observation expired after 10 minutes. Resume from `oldestCursor` and treat `missed` as events you cannot reconstruct. `filtered` above zero means navigation or document events were dropped because their URL was not allowed; add the domain to the allowlist, but note that events are only evidence and not proof of what caused a transition. While paused, new browser observations are dropped and buffered ones are hidden, so only control events such as pause and resume are returned.

**A click or type result has `effect.probeFailed: true` or `effect.changed: false`**
The signature script could not run on both sides of the action, usually because a navigation replaced the document, or nothing in the URL, title, text, element count, or form values changed. That does not mean the action failed. Check `effect.delta` for bounded control, heading, alert, and text changes, follow up with `zen_wait_for` on a state the action should produce, or read the page and compare. A replaced document reports `documentReplaced: true` and a `delta.limitation` instead of a cross-document diff.

**A type result has `observed.matchesInput: null` or `observed.matchesInput: false`**
`null` means the field is classified sensitive or could not be read back, so no comparison was attempted; the text was still sent. `false` means the field's value did not match the input after typing, possibly because the page reformatted or rejected it. Re-read the control state instead of retyping blindly.

**A read or action returns `frame_not_found`, `frame_not_loaded`, `unsupported_frame`, or `invalid_frame`**
`framePath` is a list of child indexes from the top document, such as `[0]` or `[0,1]`. `frame_not_found` means an index does not exist at that level; run a normal read to refresh the `frames` list first. `frame_not_loaded` means the frame has no document yet. `unsupported_frame` means the frame is not an `http(s)` page, and `invalid_frame` means the path has a non-integer, negative, or fourth-level entry. Frame refs follow the same path: `f0-e3` is the third control in the first child frame.

**`zen_show_evidence` returns `QUOTE_NOT_FOUND`, `AMBIGUOUS_MATCH`, or `LOW_MATCH_CONFIDENCE`**
No highlight was added and the quote should not be presented as support. Copy the passage from the page, shorten it, or add surrounding `context`. PDFs and privileged pages cannot be inspected at all.

**A fuzzy evidence match has `verified: false`**
The passage is a possible match, not confirmed support. Check it manually. A batch is `ok: false` when any citation is unverified or failed.

**A tool reports `actor_unavailable`**
The owned browser disconnected. Because the Marionette listener stays shut, this server cannot re-attach. Quit that Zen window, then call `zen_launch` to start a new owned browser.

**The corner cards do not appear**
Only browser windows get the bridge. New windows are attached automatically when `autoAttachWindows` is on; a tool call also injects into a window that does not have it yet. If cards still do not show, run `zen-mcp doctor` and check the bridge line.

**A tool is blocked with `restricted`, `mode_denied`, `site_blocked` or `policy_invalid`**
Run `zen_config` for the effective policy summary and `zen_audit_tail` for the blocked call, then `zen-mcp policy show` for the file and source. Use `zen-mcp policy mode` or `policy set` to change it, fix an invalid file, or remove it and run `zen-mcp policy init`. A missing file means `restricted`, not `normal`. Legacy `readOnly` or `allowedDomains` errors (`read_only`, `domain_not_allowed`) still come from the runtime compatibility path; migrate with `zen-mcp policy init`.

**An MCP resource returns `{ "error": ... }`**
Resources return errors as JSON instead of failing the request. The message describes the bridge or consent failure. Browser-backed resources still go through consent and Pause, so check for a pending approval card or a paused session. `zen://questions` is server-side and stays readable while paused.

## Known limitations

- Zen's internal workspace and folder APIs can change between releases. Pin a Zen version if a newer build breaks spaces; the error names the failing call.
- Marionette is fixed at port 2828 in current Zen builds, so there is one agent browser per machine. Two Zen MCP servers cannot share it.
- The startup race before lockdown cannot be eliminated while Marionette has no authentication. The server detects it and fails closed.
- A browser whose Marionette session is lost cannot be re-attached, because the listener stays shut. Quit it and start a new one.
- Shutdown runs on `stop`, `SIGINT`, `SIGTERM`, and a closed stdio transport. It does not run on a crash or `SIGKILL`, so the owned browser can stay open after an abnormal exit.
- Evidence Mode searches rendered DOM text, not pixels. It does not reach iframes, open shadow roots, images, canvas, SVG, or form controls. Frame text is available through `zen_read_page` with `framePath`. Hidden, clipped, or off-screen passages are not indexed.
- Evidence only sees the current DOM. Infinite-scroll content and content behind interaction are invisible until loaded.
- Evidence marks are temporary overlays. They can drift if the page reflows while visible, and pages that change constantly may return `HIGHLIGHT_FAILED`. Pause does not remove them.
- `zen_clear_evidence` without a `tab_id` only knows about the 20 most recently marked tabs.
- Reads and searches capture the current DOM text. Client-rendered and infinite-scroll pages return only what has loaded.
- PDF text extraction depends on Zen's PDF viewer and is unreliable for hidden tabs.
- Watches run in the server process and stop when it exits. They do not survive a restart.
- Consent is per server process, not per browser window. Approval is reused across relaunches, and a decline requires a server restart.
- `zen_essentials` captures a tab's space and pinned state before adding it and restores both when it is removed. The bridge never switches the user's space to do this. If Zen refuses the move back, the result includes a `limitation`; the essential still works, but the tab may need to be moved with the space tools.
- `zen_split_close` keeps the original tabs open and closes only clearly synthetic leftovers, such as a New Tab or blank tab that appeared while closing. A new non-empty tab that duplicates a source URL may have been opened by the user, so it is never closed automatically; the result includes a `limitation` with its id and title.
- Read-only mode blocks mutations, not reads. Session and template listings still show stored URLs.
- The domain allowlist is checked before an action and again immediately after `zen_tabs_open`, but a redirect that happens later can move a tab outside the list. Reads recheck the tab URL.
- The audit log redacts sensitive values and long strings, but a bounded preview of the summarized argument JSON can remain. Resource reads are logged as `resource:<uri>` entries without arguments.
- Private-window exclusion is implemented but not covered by the automated live suite. Treat it as a best-effort boundary.
- No screenshot, download handling, file upload, or arbitrary in-page automation. `zen_click` and `zen_type` send one native input to one resolved control; they cannot run a script or work inside closed shadow roots. Semantic targets also search open shadow roots; CSS selectors stay in the top document's light DOM. Frames are reachable only through their frame-prefixed refs, never with selectors or semantic targets.
- Semantic structure and classification are deterministic heuristics, not an accessibility-tree or a model call. Shadow content is composed into the parent tree for ancestry, but canvas, closed shadow roots, and child-frame content are not modelled. Treat the label as a hint and the regions as observations. A selector-scoped model can be complete for its subtree while omitting frames and other page areas, so read `limitations` before assuming it covers the page. A `main` region can have a null `heading` when the heading belongs to a nested `<article>`; follow `primaryRegion` and `parent` links instead of taking the first `h1`.
- Browser events are observed, bounded, and deduplicated. A burst, a long pause, or a lost cursor can drop observations, and same-document navigation may not produce a document event. `dialog` reports lifecycle only: prompt text is never read, and dialogs from private windows are not observed.
- Wait probes and action effects observe the current document only. They cannot see iframes that are not reachable, closed shadow roots, canvas, or cross-origin state changes that do not alter the probed document. Text matching uses `innerText` with a `textContent` fallback and is not a substitute for reading the page.
- No per-action approval cards. Approval is per server session, and Pause is the global stop switch. Use read-only mode and the domain allowlist for additional guardrails.
- macOS and Linux builds pass CI but have not had a live Zen launch verified. Windows is the only live-tested platform.

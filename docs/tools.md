# Tools, resources, and prompts

Zen MCP exposes 55 tools over MCP. The default `research` surface lists 17 of them; `core` lists 38 and `full` lists all 55. Every listed tool declares an `outputSchema` except `zen_tools_use`, which returns the target tool's result unchanged. The project is pre-1.0, so the tool surface can change between releases.

Capabilities outside the active surface are discoverable and callable: `zen_tools_search` finds a tool and returns its schema, `zen_tools_use` invokes it with normal policy and audit, and `zen://capabilities` lists everything. See [configuration.md](configuration.md#tool-surface) for the `toolSurface` setting.

For read formats and Evidence Mode behavior, see [reading-and-evidence.md](reading-and-evidence.md). For policy settings, see [configuration.md](configuration.md) and [security.md](security.md).

## Core

| Tool | What it does |
| --- | --- |
| `zen_status` | App version, active space and tab, every space with counts, bridge health |
| `zen_launch` | Start Zen with agent access or reconnect the bridge |
| `zen_spaces_list` | Spaces with tab, pinned, and folder counts |
| `zen_space_create` | Create a space; does not switch by default |
| `zen_space_switch` | Switch the visible space |
| `zen_space_delete` | Delete a space and its tabs (destructive) |

## Tabs and layout

| Tool | What it does |
| --- | --- |
| `zen_tabs_list` | Tabs across every space, filterable by space, query, or pinning |
| `zen_tabs_open` | Open up to 30 URLs in a space, in the background by default |
| `zen_tabs_close` | Close tabs by id |
| `zen_tab_select` | Bring a tab into view, switching space; reports active and focused state from observation |
| `zen_glance` | Preview a URL or tab in Zen's Glance overlay, without a new tab |
| `zen_split_view` | Show 2 to 4 tabs from the active space side by side |
| `zen_split_close` | Close a split view; the original tabs stay open. Only clearly synthetic leftovers (New Tab or blank tabs) are closed, and a duplicate source tab is reported as a limitation instead of being closed |
| `zen_pin_tabs` | Pin or unpin tabs in a space |
| `zen_essentials` | Add tabs to essentials or remove them. Both actions preserve the tab's original space and pinned state; a limitation is returned when Zen refuses the restoration |
| `zen_containers_list` | List Firefox containers for isolation |

`zen_tab_select` waits for a cross-space switch to settle, then retries the selection until Zen reports the tab as active. The returned tab has `active: true` only after that check, `windowFocused` reports whether the window actually took focus when `focusWindow: true` was requested, and a tab that never becomes active fails with `select_failed` instead of a false success.

## Folders

| Tool | What it does |
| --- | --- |
| `zen_folders_list` | Folders with space, label, and tab ids |
| `zen_folder_create` | Group existing tabs into a folder |
| `zen_folder_add_tabs` | Move tabs into a folder |

## Reading and research

| Tool | What it does |
| --- | --- |
| `zen_read_page` | Extract text or a structured view from one loaded tab or frame, without selecting it |
| `zen_read_pages` | Read up to 10 tabs in one call, three at a time |
| `zen_click` | Click one control by ref, semantic target, or CSS selector, in a loaded tab or frame |
| `zen_type` | Type text into one field by ref, semantic target, or CSS selector, in a loaded tab or frame |
| `zen_wait_for` | Wait for one of eight conditions in one tab or frame, including document identity, new tabs, tab closure, and dialogs |
| `zen_find_text` | Find literal text in one tab with raw offsets and excerpts |
| `zen_search_tabs` | Search up to 30 open tabs (20 by default) for the same text, two at a time |
| `zen_show_evidence` | Reuse a source in the background, find a cited quote, scroll to it, and mark it |
| `zen_show_evidence_batch` | Verify up to 20 citations in one call with per-citation results |
| `zen_clear_evidence` | Remove Evidence Mode overlays from one tab or every tracked tab |
| `zen_tabs_audit` | Find duplicate, stale, and domain-clustered tabs |
| `zen_tabs_group` | Create one folder per domain for ungrouped tabs |
| `zen_history_search` | Search history by title or URL, optionally by domain |
| `zen_history_recently_closed` | Recently closed tabs |
| `zen_bookmarks_search` | Search bookmarks by title or URL |
| `zen_clipboard_write` | Copy text to the user's clipboard |

`zen_read_page`, `zen_read_pages`, `zen_find_text`, `zen_search_tabs`, and `zen_wait_for` do not change the browser UI, and all five remain available in read-only mode. Read-only mode restricts mutations, not page text. `zen_click` and `zen_type` are mutations because they send real input to the page; both are blocked in read-only mode. See [Tool policy](#tool-policy).

### Page interaction

`zen_read_page { format: "interactive" }` returns up to 200 visible controls as `elements`, each with a short `ref` such as `e12`, plus its tag, role, type, label, current value, href, and state flags. The scan includes form controls, ARIA controls, contenteditable regions, and controls inside open shadow roots. At the top level it also scans child frames and merges their controls with refs such as `f0-e3` or `f0.1-e2`; those elements carry `framePath` and `frameUrl`. It caps at 200 across all scanned frames; `selector` narrows the scan to the top document, and `elementsTruncated` plus a limitation say when the cap was reached.

`zen_read_page { format: "snapshot" }` is the bounded view for deciding what to act on. It returns a 4,000-character text preview, up to 100 controls by default (`maxElements` raises the cap to 200), and up to 80 outline headings. Controls carry `valuePresent`, `autocomplete`, `selected`, and `form` when those carry information and omit absent state; no input value or value length is returned, even for fields the classifier does not recognize. `snapshotId`, `elementsTotal`, `snapshotComplete`, `framesComplete`, `textTruncated`, `elementsTruncated`, `outlineTruncated`, and a bounded `limitations` list separate what was collected from what was sent. A frame that was unlisted, skipped, failed, or left unscanned makes `snapshotComplete` false; output caps never do. `snapshot` is accepted by `zen_read_page` only.

`zen_read_page { format: "semantic" }` returns an agent-readable model of the top document: landmarks (`main`, `header`, `nav`, `footer`, `complementary`, `article`, `search`, forms, tables, dialogs, sections), their parent relationships, a heading hierarchy, repeated collections with bounded samples, the shared control list with element state, and a page classification with a confidence score and the signals behind it. Classification is conservative: `article`, `search-results`, `product`, `listing`, `dashboard`, `login`, `form`, `documentation`, `discussion`, or `generic`. Regions report whether their label came from an accessible name, a heading, or inference, so an observed fact is never passed off as an author's label. Model caps are 40 regions, 40 headings, 12 collections, and 5 dialogs. Regions carry only a numeric `controls` count; the control objects come back in the read's top-level `elements` array, not inside `semantic`. A semantic read collects 100 controls by default and accepts `maxElements` up to 120. `coverage.complete` is false when any cap was hit, the element scan was truncated, a child frame exists, or the frame list was truncated, and `limitations` says which. Hidden and `aria-hidden` content is omitted; field values, selected text, and other values never enter the model. The model covers the top document only; open shadow roots are traversed. Refs in the model share the same registry as snapshot and interactive reads, so a fresh read is required after a navigation or document replacement. `semantic` is accepted by `zen_read_page` only.

Every read result lists reachable `http(s)` frames under `frames`, each with a `path`, `url`, and `name`. Pass `framePath` (for example `[0]` or `[0,1]`) to read one frame's text or structured data instead of the top document; the result echoes `framePath`. Paths are limited to three levels and listing stops after 20 frames. Frames outside the domain allowlist are not listed or read.

`zen_click` and `zen_type` accept exactly one of:

- `target`: a semantic object with exactly one strategy: `{ ref }`, `{ role, name }`, `{ text }`, `{ label }`, `{ placeholder }`, or `{ selector }`. `match` is `exact` (default) or `contains` and applies only to role+name and text. Prefer this form.
- `ref`: a shortcut for `target.ref`, from the most recent snapshot or interactive read of that document, including frame-prefixed refs.
- `selector`: a shortcut for `target.selector`, resolved in the top document's light DOM.

One resolver handles every interaction. It resolves refs through the server-side WebElement registry, searches role, name, text, label, and placeholder across the document and open shadow roots, and then re-validates the chosen element's visibility, enabled state, and document identity immediately before acting. Semantic scans are bounded (6,000 nodes, six matches, six levels deep); a scan that hits its limit refuses with `unsupported_operation` and reason `scan_limit` rather than claiming the target is absent or unique.

Targets resolve strictly. Two matches are never rounded down to the first: the action fails with `target_ambiguous` and up to five candidate descriptors. Missing, hidden, disabled, read-only, non-editable, and unsupported targets fail with `target_not_found`, `target_not_actionable`, or `unsupported_operation` as appropriate. A semantic ref that the registry no longer holds fails with `stale_reference`; there is no silent fallback to resolving by selector or label. Mixing a top-level `ref` or `selector` with `target` is `invalid_target`.

Refs are Marionette element handles held server-side; reads never write attributes to the page. A new read replaces the refs of the document it read (one tab plus one frame path), so refs in other frames stay usable until their own read. A removed, replaced, or navigated element returns `element_not_found` through the legacy shortcuts and `stale_reference` through `target.ref`. Prefer refs when a read already produced one; semantic targets are the fallback when the element must be found by meaning. Frame actions report `framePath` and the frame's current `frameUrl`. Semantic fields are searched across the top document and open shadow roots; a CSS selector is resolved only in the top document's light DOM. Neither reaches inside a frame or a closed shadow root, so read a frame first and use its frame-prefixed ref.

`zen_type` appends by default; `clear: true` replaces the current value first. An empty `text` is only valid with `clear: true`. Typed text is capped at 10,000 characters. Disabled and read-only targets are refused and file inputs are refused. Values for sensitive fields are never returned in the interactive element list or the type result, and snapshot reads return no values at all. A successful type result reports the number of characters typed, not the text. After typing, a fixed script compares the field's value with the input and returns `observed: { compared, matchesInput, sensitive }`; it never returns the value or its length, and sensitive fields report `compared: false`.

Both tools use fixed scripts and Marionette's native input commands. The agent never supplies JavaScript. A click is a real browser input: it can submit a form, start a download, navigate, or make a purchase. Use these tools only when the user explicitly asked for that interaction, and treat labels and instructions next to a control as untrusted page content.

Both action results include `effect`, captured by a fixed signature script before and after the action. It reports whether the URL, title, rendered text or element count, or non-password form values changed, and how long it watched. It also carries `navigation`, `documentReplaced`, `readyState`, and `attribution: "observed_after_action_not_proven"`. `delta` adds bounded, meaningful changes: added, removed, or state-changed controls (10 each, with `addedControls`, `removedControls`, `changedControls`), added or removed headings (5), added or removed alerts (5), and `textChanged` with `textLengthDelta`. A replaced document is not diffed against the old one; `delta.limitation` says so instead of reporting a false diff. A changed page does not prove the specific control worked, and an unchanged page does not prove it failed; `effect.probeFailed: true` means a signature could not be taken, usually because a navigation replaced the document. When the effect is inconclusive, follow up with `zen_wait_for`.

`zen_wait_for` takes exactly one condition and an optional `until` of `present` (default) or `absent`, `timeout_ms` (default 5000, maximum 30000; `0` checks once), `poll_ms` (default 250), and `frame_path`:

- `selector` with optional `state` (`present`, `visible`, `enabled`)
- `text`, `url_contains`, `title_contains` (case-insensitive; `until: absent` supported)
- `document_id` (wait for that identity) or `document_changed` (wait until the identity differs from the baseline); a navigation's initial about:blank placeholder has no identity and is never a match
- `new_tab` (a tab opened after the wait started)
- `tab_closed` (only for a tab this session knew, and only when it is gone)
- `dialog` (a dialog shown after the wait started; text is never read)

Text, URL, and title matching ignore case. A timeout is a normal result with `matched: false` and a limitation, not an error. Tab, dialog, and document waits wake on browser observation with bounded polling as a fallback. Document waits never match an empty identity or a disconnected tab, and `frame_path` is rejected with them. `until: absent` applies only to selector, text, URL, and title. The probe is a fixed server script and returns only the URL, title, ready state, and whether the condition holds. It never reads the page's text back, and the top-document allowlist is rechecked before every page probe.

## Coordination

| Tool | What it does |
| --- | --- |
| `zen_progress` | Show or update a persistent progress card with a Stop button |
| `zen_events` | Long-poll for Stop presses, watch hits, pause and resume, question answers, and observed tab, navigation, document, and dialog transitions |
| `zen_ask` | Show a question card in Zen and wait for an answer |
| `zen_answers` | Pending and recently answered questions |
| `zen_notify` | Status card with an optional "open this space" action |
| `zen_watch_add` | Watch a tab for a text change or a selector appearing or disappearing |
| `zen_watch_list` | Active watches with interval, expiry, last check, and hit count |
| `zen_watch_remove` | Stop and remove a watch |

## Sessions and templates

| Tool | What it does |
| --- | --- |
| `zen_session_save` | Snapshot every space, tab, folder, and essential in the window |
| `zen_session_list` | Saved sessions with counts |
| `zen_session_restore` | Restore a session, reusing spaces by name or creating new ones |
| `zen_session_delete` | Delete a saved session |
| `zen_space_templates` | Built-in and user templates |
| `zen_template_apply` | Create a space from a template |
| `zen_template_save` | Save a live space as a reusable template |
| `zen_template_delete` | Delete a user template |

## Policy

| Tool | What it does |
| --- | --- |
| `zen_config` | Effective read-only mode, allowlist, audit settings, and data directory |
| `zen_audit_tail` | Recent tool calls, including blocked ones |

## Tool policy

The MCP guard applies policy before a tool runs:

- **Read-only mode** blocks the 32 tools that change browser, server, persisted, or on-screen state: `zen_launch`, space create/switch/delete, tab open/close/select, folder create/add, pin, essentials, Glance, split view/close, `zen_click`, `zen_type`, clipboard write, watch add/remove, session save/restore/delete, template save/apply/delete, tab grouping, the three evidence tools, and `zen_progress`, `zen_ask`, and `zen_notify`. A read-only server also refuses to auto-launch Zen.
- **Read-only mode only blocks the mutating set.** `zen_read_page`, `zen_read_pages`, `zen_find_text`, `zen_search_tabs`, history, bookmarks, status, lists, `zen_events`, `zen_answers`, `zen_config`, and `zen_audit_tail` keep working. Session and template listings can still show stored URLs.
- **The domain allowlist** checks URLs for tools that open, preview, verify, watch, restore, or apply a template, and checks the tab URL, target frame URL, and any link target before `zen_click` or `zen_type` acts. Frames outside the list are omitted from reads and refused as targets. An empty list allows everything. Entries are normalized to a host and match exactly or as a subdomain on a label boundary. URL checks happen before the action and again after `zen_tabs_open` returns; a redirect that happens later, such as a slow script or meta refresh, can still leave the tab on another host. Reads recheck the tab URL before returning content.
- **The audit log** records tool calls, including calls blocked by read-only mode or the allowlist, and resource reads under `resource:<uri>`. `executed` reports whether the handler returned a result; `ok` reports whether that result succeeded. Evidence batch entries add `citationsVerified`, `citationsFailed`, and `outcome` (`success`, `partial`, or `failed`), so a batch with a failed citation is not logged as full success.

## Progress, events, and watches

Long jobs should keep the user informed without blocking on a modal dialog:

```text
zen_progress { title: "Reading 12 sources", step: "3 of 12", progress: 0.25 }
zen_events   { after: <cursor>, waitSeconds: 25 }
```

A Stop press becomes a `kind: "stop"` event. The agent should finish the current step, then call `zen_progress { done: true }` to clear the card. A stopped event is not an error: it means the user asked for the job to wrap up.

To check Stop delivery by hand (still required on Zen 1.24b): note the `zen_events` cursor, call `zen_progress { title: "Stop check", stoppable: true }`, then press **Stop** once on the card and confirm the label changes to "Stopping...". Call `zen_events { after: <cursor>, waitSeconds: 25 }`: a working bridge returns `stopped: true` plus a `kind: "stop"` event, and the next `zen_progress` update keeps the button disabled until `zen_progress { done: true }` clears the card. If the button returns to "Retry stop", the press was not delivered; it is retried automatically after a reconnect, or press it again once the bridge is back.

The global Pause switch pushes `kind: "pause"` and `kind: "resume"` events, and `zen_events` reports `paused: true` until Resume. While paused, every browser tool returns the `paused` error; do not retry in a loop. Pause also hides the progress card and defers questions. New browser observations are dropped while paused and buffered ones are hidden, so `zen_events` serves only control events: the pause itself, then the resume when access returns.

`zen_events` also reports browser transitions, always tagged `source: "browser"`: `tab` (`opened`, `closed`, `selected`), `navigation` (`started`, `committed`, `completed`, `failed`, `redirect`, `same_document`), `document` (`replaced`), and `dialog` (`shown`, `hidden`). Events carry a monotonically increasing `id`, a timestamp, the tab and document identity where known, and bounded text. Sequence ids are the only cursor: pass the last `cursor` back as `after`. `missed` counts issued ids the cursor can no longer read after the 200-event cap or the 10-minute expiry of browser kinds; `filtered` counts navigation and document events dropped because their URL was not allowed. Control events are kept longer than browser observations. An event is evidence that a transition happened, not proof of what caused it; confirm outcomes with a read or a wait.

`zen_watch_add` watches a tab for:

- `change`: the page text changed, optionally only when it now contains a phrase.
- `appear`: a CSS selector appeared.
- `disappear`: a CSS selector disappeared.

Watches poll on the server, post a card in Zen when they fire, and report `kind: "watch"` events through `zen_events`. They expire after `maxMinutes` (120 by default), polling never goes below `watchMinIntervalSeconds` (15 by default), and at most 50 watches run at once. Adding or removing a watch changes server state, so both tools are blocked in read-only mode; `zen_watch_list` still works.

## Sessions and templates

`zen_session_save` snapshots every space, tab, folder, pin, and essential tab in a window. `zen_session_restore` reuses a space with the same name unless `newSpaces` is set, skips URLs that are already open, restores folders and pins, and reports warnings instead of failing the whole restore. Restores are limited to 300 tabs by default; `maxTabs` changes the cap.

`zen_space_templates` ships four built-ins: `research`, `github-triage`, `news`, and `docs`. `zen_template_save` turns a live space into a user template and `zen_template_apply` creates a new space from one, including folders. Built-in templates cannot be deleted.

## Resources and prompts

Six MCP resources expose live state as JSON: `zen://status`, `zen://spaces`, `zen://tabs`, `zen://questions`, `zen://watches`, and `zen://capabilities`.

Resources are read on demand. They are not tool calls, so they bypass the tool guard and are not filtered by `readOnly` or `allowedDomains`. Each read is audited with the tool name `resource:<uri>` and no arguments. Resources backed by live browser state still go through the bridge, so consent and Pause apply. `zen://questions` reports server-side state and remains readable while paused. A failed read returns a JSON payload with an `error` string instead of failing the resource request.

Three prompts set up common jobs:

- `zen_github_triage` for notifications and pull requests.
- `zen_research_brief` for a source-backed brief.
- `zen_clean_tabs` for tab cleanup with a session saved first.

## Client-visible behavior

Zen MCP uses the standard MCP request metadata rather than a custom side channel:

- **Structured results.** Every tool declares an `outputSchema`. A successful call returns the typed object in `structuredContent` and the same JSON in a text block, so older clients keep working. Errors are `isError: true`; `zen_click` and `zen_type` also return the structured `error` object (code, message, category, retryable, stateChanged, recovery, and details when present), and every other tool omits `structuredContent`.
- **Progress.** When a client supplies a progress token, `zen_read_page`, `zen_read_pages`, and `zen_show_evidence_batch` send `notifications/progress` between phases or after each tab or citation. No token means no notifications.
- **Cancellation.** A cancelled request stops waiting on the bridge and returns a cancellation error. A browser command that is already in flight may still finish in Zen, but the server never reports it as a success.
- **Resources.** All six resources carry a title. Successful tools that change tabs or spaces emit `notifications/resources/list_changed` so clients can refresh. Resource subscriptions are not offered in 0.3; clients re-read on demand. Completion is not offered either, because the fixed resource URIs have no template variables to complete.
- **Logging.** Server warnings and errors reach the client through `notifications/message`. Messages contain the tool name, error code, and a sanitized description with URLs replaced by `[redacted-url]`. They never contain arguments, page text, tab URLs, or bridge keys. The file audit log remains the durable record.

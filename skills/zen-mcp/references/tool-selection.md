# Tool selection

**Read this when** you know the intent but not the tool, when you are choosing
between read formats, or when a parameter name does not match what you expected.

Every tool below exists in Zen MCP 0.5.0. Names and parameters are taken from
the registered schemas. Defaults are server-side unless noted.

## Orientation and connection

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_status` | `windowId` | Connects first, then reports app version, platform, profile, active space and tab, every space with counts, and bridge windows. Success means a live bridge. |
| `zen_config` | none | Local, no browser needed. Read-only flag, allowlist, audit path, data dir, profile mode, consent requirement, session state (owns browser, paused, consent), auto-launch, timeouts, watch minimum, saved session and template counts. |
| `zen_launch` | none | Mutating. Starts the owned Zen, proves ownership, locks down, attaches the bridge, shows the consent card. Use only when a call reports Zen unreachable or the session was lost. |
| `zen_audit_tail` | `limit` (1-200, default 50) | Recent calls, including blocked ones. Works while paused. |
| `zen_events` | `after` (cursor), `waitSeconds` (0-25) | Stop, pause, resume, watch, and question events. Long-polls. Works while paused. |
| `zen_answers` | none | Open and recently answered question cards. Works while paused. |

## Spaces and templates

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_spaces_list` | none | Ids, names, icons, active space, counts. |
| `zen_space_create` | `name` (1-64), `icon`, `containerTabId`, `switchTo` | Background by default. |
| `zen_space_switch` | `space` | Visible action. |
| `zen_space_delete` | `space` | Deletes the space and its tabs. Destructive. |
| `zen_space_templates` | `name` | List all, or one template's folders and URLs. |
| `zen_template_apply` | `template`, `name`, `switchTo`, `windowId` | Creates a space with background tabs and folders. |
| `zen_template_save` | `space`, `name`, `description`, `icon`, `windowId` | Captures one space. |
| `zen_template_delete` | `name` | User templates only; built-ins are protected. |

Built-ins: `research`, `github-triage`, `news`, `docs`. Limits: 100 user
templates, 100 folders, 2,000 URLs.

## Tabs and windows

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_tabs_list` | `space`, `query`, `pinnedOnly`, `limit` (default 500, max 2,000) | Includes inactive spaces in the window. `query` matches title or URL substrings. |
| `zen_tabs_open` | `urls` (1-30), `space`, `background` (default true), `switchTo`, `folderId`, `container` | Returns the new tabs with ids. Deduplicates within the call only. |
| `zen_tabs_close` | `tabIds` (1-100) | Destructive. Returns how many closed. |
| `zen_tab_select` | `tabId`, `focusWindow` | Visible action; may switch space. |
| `zen_folders_list` | none | Id, label, space, collapsed, tab ids. |
| `zen_folder_create` | `label`, `tabIds` (≤100), `space`, `collapsed` | Tabs must share one space and be ungrouped. |
| `zen_folder_add_tabs` | `folderId`, `tabIds` (1-100) | Same space, not already grouped. |
| `zen_pin_tabs` | `tabIds` (1-30), `pinned` (default true) | Normal pins only. |
| `zen_essentials` | `action` (`add`/`remove`), `tabIds` (1-20) | Above every space; remove also unpins. |
| `zen_split_view` | `tabIds` (2-4), `gridType` (`grid`/`hsep`/`vsep`), `activate` (default true) | Active space only; visible. |
| `zen_split_close` | `tabId` | Unsplit; tabs stay open. |
| `zen_glance` | `url`, `tabId`, `container`, `width` (320-2560), `height` (240-1600) | Overlay, not a tab; visible. |
| `zen_containers_list` | none | `userContextId`, name, icon, color. |

## Reading and searching

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_read_page` | `tabId`, `format`, `selector` (≤500), `maxChars` (500-60,000, default 24,000), `offset`, `framePath` (≤3) | Reads without selecting, switching, or focusing. No `tabId` reads the active tab. |
| `zen_read_pages` | `tabIds` (1-10), `format`, `selector`, `maxChars`, `offset` | Concurrency 3. One format/selector/offset for the batch; `pages[]` entries succeed or fail independently. |
| `zen_find_text` | `tabId`, `query` (≤1,000), `case_sensitive`, `max_matches` (1-50, default 20), `context_chars` (0-300, default 120) | Literal text, not a regex. Offsets and excerpts. |
| `zen_search_tabs` | `query`, `space`, `tab_ids` (≤30), `max_tabs` (1-30, default 20), `max_matches_per_tab` (1-20, default 5), `context_chars` (0-300, default 80), `case_sensitive` | Searches open tabs only, focused window first. Caps: 200 matches total, 12 s per tab. |

Read formats:

| Format | Use | Caps |
| --- | --- | --- |
| `text` | Visible text when Markdown loses structure. | 200,000 chars server-side; paged. |
| `markdown` | Default for prose. | 200,000; paged. |
| `links` | Source discovery. | 300 links; 8,000 chars per URL. |
| `tables` | Spec and pricing tables. | 20 tables, 100 rows, 12 columns, 300 chars per cell. |
| `metadata` | Title, description, canonical, lang, author, published, site name, OG/Twitter. | Small fixed shape. |
| `outline` | Headings to orient. | 200 headings. |
| `interactive` | Controls with refs for click/type. | 200 controls across frames. |

`offset` and `nextOffset` apply to `text` and `markdown`; structured formats
ignore offset and report that in `limitation`. Reads also return `selectedText`
(the current selection in that tab, up to 4,000 characters, possibly empty).
There is no separate selection tool.

## Page actions and waits

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_click` | `tabId`, `ref` or `selector` (not both) | Mutating, real input, blocked in read-only. Returns `target` and `effect`. |
| `zen_type` | `tabId`, `ref` or `selector`, `text` (≤10,000), `clear` (default false) | Mutating. Typed text is not returned; file inputs refused. |
| `zen_wait_for` | `tabId`, one of `selector`/`text`/`url_contains`/`title_contains`, `until` (`present`/`absent`), `timeout_ms` (default 5,000, max 30,000), `poll_ms` (100-2,000, default 250), `frame_path` | Read-only. Timeout returns `matched: false`, not an error. Allowed in read-only mode. |

## Evidence

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_show_evidence` | `url`, `quote` (≤20,000), `claim`, `context`, `source_title`, `tab_id`, `min_confidence` (0.5-1, default 0.85), `highlight_ms` (1,000-120,000, default 20,000), `focus` (default false) | Reuses or opens the source, matches, scrolls, marks. |
| `zen_show_evidence_batch` | `citations` (1-20; `url`, `quote`, `claim`, `context`, `source_title`, `tab_id`), `focus`, `min_confidence`, `highlight_ms`, `concurrency` (1-3, default 2) | Max 5 citations per source. All URLs checked before opening. |
| `zen_clear_evidence` | `tab_id` | Removes only bridge-created overlays. |

## History, bookmarks, and cleanup

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_history_search` | `query`, `sinceDays`, `domain`, `groupByDomain`, `limit` (1-100) | Metadata only; not filtered by the allowlist. |
| `zen_history_recently_closed` | none | Session store. |
| `zen_bookmarks_search` | `query`, `limit` (1-100) | Metadata only. |
| `zen_tabs_audit` | `staleDays` (1-365, default 14), `duplicateLimit`, `staleLimit` | Duplicates, stale tabs, domain clusters. |
| `zen_tabs_group` | `space`, `minTabs` (1-20, default 2), `collapsed` | One folder per domain; skips pinned, grouped, essentials. |
| `zen_clipboard_write` | `text` (≤1,000,000) | Writes the user's clipboard. Mutating. |

## Sessions

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_session_save` | `name` (1-64), `windowId` | Whole window: spaces, tabs, folders, pins, essentials. |
| `zen_session_list` | none | Name, created, space/tab/essential counts. |
| `zen_session_restore` | `name`, `newSpaces`, `switchTo`, `maxTabs` (default 300, max 2,000) | Background tabs; partial failures are warnings. |
| `zen_session_delete` | `name` | Snapshot only; never closes tabs. |

## Coordination

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_progress` | `title` (first call), `step`, `detail`, `progress` (0-1), `tone`, `stoppable` (default true), `done` | Persistent card with Stop. `done: true` hides it and acknowledges Stop. |
| `zen_ask` | `question` (≤500), `options` (≤6), `context` (≤600), `waitSeconds` (0-600, default 120), `allowFreeform`, `multiSelect` | Status: `answered`, `deferred`, `pending`, `unavailable`. |
| `zen_answers` | none | Collect a late reply. |
| `zen_notify` | `title` (≤160), `detail` (≤600), `tone`, `space`, `actionLabel` (≤60), `autoHideMs` (default 12,000; 0 keeps) | Activity card; with `space` it gets an action button. |
| `zen_watch_add` | `tabId`, `mode` (`change`/`appear`/`disappear`), `selector`, `contains`, `intervalSeconds` (default 60, min 15), `maxMinutes` (default 120, max 1,440), `label`, `notify` (default true) | Max 50 watches. `selector` required for appear/disappear. |
| `zen_watch_list` | none | Tab, mode, interval, expiry, last error, hits. |
| `zen_watch_remove` | `watchId` | Stop and remove. |

## Resources and prompts

Resources are read-only JSON and bypass the tool guard; each read is audited as
`resource:<uri>`. There are no subscriptions and no dynamic resource templates.

| URI | Contents |
| --- | --- |
| `zen://status` | Same area as `zen_status`. |
| `zen://spaces` | Spaces, via the bridge. |
| `zen://tabs` | Tabs, via the bridge. |
| `zen://questions` | Open and recent questions. |
| `zen://watches` | Watches and the minimum interval. |

Prompts are static text templates; they do not touch the browser. Use them when
the user's request matches, then run the tools yourself.

| Prompt | Arguments |
| --- | --- |
| `zen_research_brief` | `topic` (required), `depth` (`quick`/`standard`/`deep`) |
| `zen_github_triage` | `repos` (optional comma-separated `owner/repo`) |
| `zen_clean_tabs` | `staleDays` (optional, default 14) |

## Parameter names that differ

The surface is not perfectly uniform. Copy names exactly:

- Tab id: `tabId` in tabs, reads, waits, click/type, and `zen_find_text`;
  `tab_id` in evidence tools and `zen_clear_evidence`; `tab_ids` in
  `zen_search_tabs`.
- Tab id arrays: `tabIds` in open/close/folder/pin/essentials/split/read_pages.
- Read paging: `maxChars` and `offset`; frames use `framePath`, but waits use
  `frame_path`.
- Waits: `url_contains`, `title_contains`, `timeout_ms`, `poll_ms`,
  `frame_path`.
- Evidence: `source_title`, `min_confidence`, `highlight_ms`.
- Opening: `switchTo`, `folderId`; spaces use `containerTabId`.

## What does not exist

Do not promise these, and do not invent tool names for them:

- Screenshots or any visual capture. Use text, links, tables, metadata,
  outline, and interactive reads.
- JavaScript evaluation, script injection, or arbitrary selectors as code.
- A standalone selection-read tool. `selectedText` is a field on page reads.
- File upload, download handling, or attachment support. File inputs are
  refused.
- Attaching to the user's existing Zen, or re-attaching after the owned
  Marionette session is lost.
- Installing or updating software from a tool. The banner's Update button is a
  user action, not a tool.
- Cross-browser support. This is Zen-specific; other MCP browser servers have
  different tools.

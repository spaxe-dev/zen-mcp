# Tab management

**Read this when** the workspace has many tabs, a tab id stopped working, the
user asks for cleanup, or you are about to close, group, pin, or restore
anything.

## Tab ids

Every tab tool takes ids from a listing or an open result. An id points at a
live Zen tab and is valid only while that tab is open. Closing a tab, closing
its window, or the user quitting the browser invalidates it.

```text
zen_tabs_list({ space: "CI vendors", query: "pricing", limit: 200 })
zen_tabs_list({ pinnedOnly: true })
```

`zen_tabs_list` returns `windowId`, `activeSpaceId`, `total`, and `tabs[]` with
`id`, `windowId`, `spaceId`, `spaceName`, `title`, `url`, `requestedUrl`,
`pinned`, `essential`, `active`, `loading`, `folderId`, `folderLabel`, `index`,
`lastAccessed`, and container fields where relevant. `limit` defaults to 500 and
caps at 2,000.

Rules:

- Re-list after any close, navigation-heavy sequence, or browser relaunch. Do
  not carry ids across turns.
- `PAGE_NOT_FOUND` on a read or `tab_not_found` on an action means the id is
  stale, not that the page is gone. List again.
- `zen_tabs_open` returns the new tabs with ids, so you rarely need a separate
  list call afterwards.

## Finding tabs

Two different jobs:

- **Title or URL**: `zen_tabs_list({ query: "arxiv" })` filters on substrings of
  both.
- **Page text**: `zen_search_tabs({ query: "per-token pricing" })` searches the
  text of up to 30 tabs (default 20) and returns matches plus excerpts.

`zen_search_tabs` is the best "is it already open?" check. It searches windows
in focus order and stops at `max_tabs`, so a large workspace can miss the tab
you want. Narrow with `space` when you know it, or pass `tab_ids` for a specific
set.

```text
zen_search_tabs({ query: "cache eviction", space: "Vendor comparison", max_tabs: 30 })
zen_search_tabs({ query: "deprecation", tab_ids: [id1, id2], max_matches_per_tab: 3 })
```

Per-tab failures (privileged, PDF, non-HTML, missing, off-list) are reported
without failing the batch. `skipped` counts tabs that were not searched.

Single-tab alternative: `zen_find_text({ tabId, query })` with `max_matches`
(default 20, max 50) and `context_chars` (default 120, max 300).

## Audit before cleanup

```text
zen_tabs_audit({ staleDays: 21 })
```

Returns `totals` (tabs, spaces, folders, pinned, essentials, grouped, loading,
duplicates, stale), `bySpace`, `duplicates[]` (url, title, tabIds, spaces),
`staleTabs[]` (tabId, title, url, spaceName, lastAccessed, ageDays), and
`domains[]` (domain, count, tabIds).

- `staleDays` defaults to 14 (1-365). It measures last access, not importance.
- Duplicate detection normalizes URLs; fragments and case can make two different
  pages look identical. Treat the report as a proposal, not a verdict.
- Never close from audit output alone. Confirm the specific tabs.

## Grouping by domain

```text
zen_tabs_group({ space: "Research", minTabs: 2 })
```

Creates one folder per domain for ungrouped, unpinned tabs in the space, leaving
pinned tabs, essentials, and already-grouped tabs alone. `minTabs` defaults to
2. The result reports `planned`, `created[]` (folderId, label, tabs), and
`groupedTabs`.

Run it once per space. Running it again mostly creates noise or reports zero.
When the user wants deliberate groupings (one folder per vendor), use
`zen_folder_create` instead of domain grouping.

## Closing tabs

```text
zen_tabs_close({ tabIds: [...] })
```

- Up to 100 ids per call. Returns how many actually closed.
- Closing is destructive to the user's session. Close tabs you opened for this
  job, or tabs the user explicitly named.
- Before closing anything you did not open:
  1. Run `zen_tabs_audit` and summarize what you propose to close.
  2. `zen_ask` with concrete options ("close 12 duplicates", "close stale tabs
     older than 30 days", "leave everything").
  3. Close only the ids covered by the answer.
- Do not close pinned tabs, essentials, or tabs in a space you did not create
  unless the user asked for exactly that.
- When in doubt, `zen_session_save` first. A snapshot is recoverable; a closed
  tab is only recoverable from history.

If a close partially fails, re-list and report which ids remain. Do not loop.

## Duplicates

A duplicate is a URL that is already open. The fix is usually not "close one":

- If you need one of them, read the existing tab instead of opening another.
- If the user wants duplicates removed, propose the exact set and ask.
- Keep the tab that carries the user's context (folder, pin, later access)
  when the choice is otherwise arbitrary, or say that you cannot tell and let
  the user decide.

`zen_tabs_open` deduplicates URLs within a single call, not against tabs that
are already open. That is why the pre-open search matters.

## Sessions and layout

`zen_session_save` snapshots the whole window: spaces, tabs, folders, pins,
essentials. Use it before a cleanup, before a risky restore, or when the user
says the layout matters to them.

```text
zen_session_save({ name: "before-cleanup-2026-11-20" })
zen_session_restore({ name: "before-cleanup-2026-11-20", newSpaces: true })
zen_session_delete({ name: "before-cleanup-2026-11-20" })
```

Restore matches spaces by name, reuses them unless `newSpaces: true`, skips
duplicate URLs, opens background tabs, and caps at 300 tabs by default
(`maxTabs`, 0-2,000). Deleting a session never closes tabs.

Limits: 100 saved sessions, 50 spaces per session, 2,000 tabs per session, 200
folders per space, 4,096 characters per URL. If a save fails on a limit, say
so; do not silently restore a partial layout.

## Pins, essentials, and split view

- `zen_pin_tabs` pins normal tabs in their space (up to 30). Pins are per space.
- `zen_essentials` adds or removes tabs above every space (up to 20). Removing
  also unpins. Do not essential a user's tab without asking.
- `zen_split_view` shows 2-4 tabs from the active space. `zen_split_close`
  unsplits without closing. Both are visible actions.

## Multiple windows

Each window has its own bridge and tab set. `zen_tabs_list` reports the
`windowId` for each tab, but most tools act on the focused window. Only
`zen_status`, `zen_session_save`, and `zen_template_apply` accept `windowId`. If
the user has two windows and the tab count looks wrong, check `zen_status` and
ask which window they mean. Zen MCP cannot attach to a window it did not
launch, so a second window must come from the same owned browser.

## Failure cases

| Symptom | Cause | Response |
| --- | --- | --- |
| `tab_not_found` | Id stale or wrong window | `zen_tabs_list`, re-resolve. |
| `PAGE_NOT_FOUND` on read | Tab closed or navigated | Re-list; do not reuse the id. |
| `folder_not_found` | Folder deleted or wrong window | `zen_folders_list`. |
| `mixed_spaces` | Tabs and folder in different spaces | Move tabs or pick a folder in their space. |
| `no_tabs` | Empty `tabIds` | List first; never send an empty close. |
| Tabs already grouped | `zen_folder_add_tabs` on grouped tabs | Use a new folder or leave them. |
| `space_not_found` | Name differs from the label | `zen_spaces_list` and use the id. |
| Close count lower than requested | Some ids were already gone | Report the difference; do not retry blindly. |

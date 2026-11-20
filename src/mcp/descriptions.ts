/**
 * Consumer-facing tool descriptions.
 *
 * One entry per registered tool. The first paragraph must stand alone and stay
 * within 400 characters; it is what an agent sees in `tools/list`. Put critical
 * caveats in a second short paragraph only when the agent cannot safely use the
 * tool without them. Parameter detail belongs in the Zod schema, and longer
 * workflows belong in the consumer skill.
 */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  zen_status:
    "Report the connected Zen Browser, its version, active space and tab, and every space with tab and folder counts. Use it first to orient yourself; a successful call proves the bridge is live.",
  zen_launch:
    "Start a Zen window owned by Zen MCP, prove ownership, lock down Marionette, and attach the bridge. Shows a one-time approval card. Use only when a tool reports Zen unreachable or after the owned session was lost; it never attaches to an existing browser.",
  zen_spaces_list:
    "List every Zen space with its id, name, icon, and tab, pinned, and folder counts. Space ids and names are accepted wherever a tool takes a space.",
  zen_space_create:
    "Create a space for a job. It does not switch by default, so the user stays put. Name it descriptively; use switchTo only when the user asked to go there.",
  zen_space_switch:
    "Switch the browser to an existing space by id or name. This changes what the user sees, so do it only when asked or after telling them.",
  zen_space_delete:
    "Delete a space and every tab it holds. Destructive: use only for a finished job space you created, or when the user explicitly asks.",
  zen_tabs_list:
    "List open tabs across spaces in the window, including inactive ones, with ids, titles, URLs, space, folder, and state. Filter by space, title or URL substring, or pinned/folder state. Ids are valid only while the tab stays open.",
  zen_tabs_open:
    "Open up to 30 URLs in a space without changing what the user sees (background defaults true). Returns the new tabs with ids. Split longer lists. Optionally use an existing folder or a Firefox container.",
  zen_tabs_close:
    "Close tabs by id, up to 100. Destructive to the user's session: close only tabs you opened or tabs the user explicitly named.",
  zen_tab_select:
    "Bring a tab into view, switching space and possibly focusing the window. This takes over the user's screen; use zen_read_page for background reading instead.",
  zen_glance:
    "Open Zen's Glance overlay for a URL or an open tab without creating a tab. Visible on the current page; use when the user wants a quick look, not a full switch.",
  zen_split_view:
    "Show 2 to 4 tabs from the active space side by side. This changes what the user sees; use it only when asked or for a comparison they requested.",
  zen_split_close:
    "Unsplit the group containing a tab, or the current split view. Tabs stay open.",
  zen_pin_tabs:
    "Pin tabs to the space's pinned strip, or unpin them. Essentials use zen_essentials instead.",
  zen_essentials:
    "Add or remove essentials, which stay pinned above every space. Removing also unpins. Up to 20 tabs; use sparingly and never on user tabs without asking.",
  zen_containers_list:
    "List the Firefox containers in this profile. Pass a container name or id to zen_tabs_open or zen_glance to isolate a site.",
  zen_folders_list:
    "List tab folders in the window with their space, label, collapsed state, and tab ids.",
  zen_folder_create:
    "Create a Zen folder around existing tabs, optionally collapsed. Tabs must share one space and must not already be grouped or split. Up to 100 tabs.",
  zen_folder_add_tabs:
    "Move existing tabs into an existing folder. Tabs must be in the folder's space and not already grouped.",
  zen_history_search:
    "Search the user's browsing history by title or URL, newest first. Use it to find pages they already visited instead of guessing URLs. Metadata only; not filtered by the domain allowlist.",
  zen_history_recently_closed:
    "List recently closed tabs from Zen's session store, newest first. Use it when a tab vanished or the user wants to reopen a page.",
  zen_bookmarks_search:
    "Search bookmarks by title or URL, newest first. Use it to find saved dashboards, repositories, and docs. Metadata only.",
  zen_read_page:
    "Extract one tab, including tabs in spaces the user is not looking at, without selecting or focusing anything. Use markdown for prose, links for sources, tables for data, metadata or outline to orient, interactive for controls. `selector` reads one element; long text is paged with offset/nextOffset.",
  zen_read_pages:
    "Read up to 10 tabs in one call, three at a time. Each tab succeeds or fails independently. One format, selector, and offset apply to the batch; use it for the first pass across sources, then read selectively.",
  zen_click:
    "Click one control by interactive ref or top-document CSS selector. Use only when the user asked you to operate the page. Refs expire after another interactive read or a navigation. This is real input: it can submit, download, navigate, or purchase.",
  zen_type:
    "Type into one field by interactive ref or top-document CSS selector. Use only when asked; refs expire. `clear` replaces the value; the default appends. Typed text is never returned, file inputs are refused, and passwords are typed only when the user supplied them.",
  zen_wait_for:
    "Wait for exactly one condition in a tab: selector present or absent, text, URL substring, or title substring. Read-only and safe in read-only mode. Timeout returns matched:false, not an error.",
  zen_find_text:
    "Find literal text in one tab and return match offsets with short excerpts. Read-only: no selection, scroll, or highlight. Case and typographic folding by default; the query is text, not a regex.",
  zen_search_tabs:
    "Find literal text across up to 30 open tabs and report which contain it, with offsets and excerpts. Read-only. Narrow with `space` or `tab_ids`; per-tab failures are reported without failing the batch.",
  zen_show_evidence:
    "Verify an exact quote in a source, scroll to it, and mark it; reuses an open matching tab or opens the source in the background. Count it as supported only when ok and verified are true. focus=true is visible.\n\nQUOTE_NOT_FOUND, AMBIGUOUS_MATCH, LOW_MATCH_CONFIDENCE, and HIGHLIGHT_FAILED are honest misses; a fuzzy match is not verified.",
  zen_show_evidence_batch:
    "Verify up to 20 citations, five per source, two at a time. Sources are grouped, tabs reused or opened once in the background, and each citation returns its own result. One non-http(s) URL rejects the batch before anything opens.",
  zen_clear_evidence:
    "Remove highlight overlays created by this bridge session, for one tab or all marked tabs. Page-owned nodes are never touched.",
  zen_tabs_audit:
    "Report duplicate tabs, stale tabs, and domain clusters with ids and counts. Read-only; use zen_tabs_group to turn domain clusters into folders.",
  zen_tabs_group:
    "Create one Zen folder per domain for ungrouped, unpinned tabs in a space. Leaves pinned tabs, essentials, and existing folders alone. Run it once per space.",
  zen_clipboard_write:
    "Write text to the user's clipboard. Use for handoff, not secrets; the user can paste it anywhere.",
  zen_progress:
    "Show or update a persistent progress card with a Stop button. Call at each stage of long work; `done:true` hides it and acknowledges Stop. Poll zen_events to notice Stop.",
  zen_events:
    "Collect Stop, Pause, Resume, watch, and question events after a cursor. `waitSeconds` long-polls up to 25. A stop event means stop; a pause means stop retrying browser tools until resume.",
  zen_watch_add:
    "Watch a tab without taking it over: text changes, or a selector appearing or disappearing. Polls server-side, posts events and an optional card, and expires after maxMinutes. At most 50 watches.",
  zen_watch_list:
    "List active watches with tab, mode, interval, expiry, last error, and hit count.",
  zen_watch_remove: "Stop and remove a watch by id.",
  zen_config:
    "Show effective policy and storage: read-only, allowlist, audit, data directory, surface, launch settings, pause, and consent. Use it to explain a blocked call; it needs no browser.",
  zen_audit_tail:
    "Show the most recent tool calls from the audit log, including blocked calls. Use it to review what ran or why an action was denied.",
  zen_ask:
    "Show a compact question card in Zen with optional choices and freeform text, and wait up to waitSeconds. Pending or deferred leaves it open for zen_answers. Prefer 2-5 concrete options.",
  zen_answers:
    "List questions still open in Zen and recently answered ones. Use it after zen_ask returns pending or deferred, or to collect a late reply.",
  zen_notify:
    "Show a small activity card in Zen. With `space`, it gets a button that takes the user there, which is the handover for a finished background job.",
  zen_session_save:
    "Snapshot the whole window's spaces, tabs, folders, pinned tabs, and essentials as a named session in the local data directory. Use it before a cleanup or risky restore.",
  zen_session_list:
    "List saved session snapshots with creation time, space, tab, and essential counts.",
  zen_session_restore:
    "Reopen a saved session: spaces matched by name and reused unless newSpaces, duplicate URLs skipped, tabs opened in the background, folders and pins recreated. Partial failures are warnings; maxTabs defaults to 300.",
  zen_session_delete:
    "Delete a saved session snapshot. It never closes open tabs.",
  zen_space_templates:
    "List built-in and user space templates, or pass a name for one template's folders and URLs.",
  zen_template_apply:
    "Create a new space from a template, opening its tabs in the background and recreating folders. The space gets a unique name; partial failures are warnings.",
  zen_template_save:
    "Turn a live space's tabs and folders into a reusable user template in the local data directory.",
  zen_template_delete:
    "Delete a user template. Built-in templates cannot be deleted.",
  zen_tools_search:
    "Search Zen MCP's full capability catalogue by keyword or category, including tools not currently exposed. Pass `name` to get one tool's description and input schema. Use it before zen_tools_use.",
  zen_tools_use:
    "Invoke any Zen MCP tool by name, including one not in the current surface, with normal validation, policy, audit, and result shape. Set publish=true to add it to tools/list when the client supports list changes.",
};

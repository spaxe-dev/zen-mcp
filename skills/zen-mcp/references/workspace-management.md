# Workspace management

**Read this when** you are deciding where a job should live, creating or
deleting spaces, grouping tabs into folders, pinning or handover, or saving a
layout with sessions or templates.

Tool names and parameters here are verified against Zen MCP 0.6.0. The main
`SKILL.md` has the decision rules; this file has the detail.

## Spaces

| Tool | Parameters | Notes |
| --- | --- | --- |
| `zen_spaces_list` | none | Id, name, icon, `active`, counts. |
| `zen_space_create` | `name` (1-64), `icon`, `containerTabId`, `switchTo` | Creates in the background; `switchTo` defaults false. |
| `zen_space_switch` | `space` | Changes what the user sees. Visible action. |
| `zen_space_delete` | `space` | Deletes the space **and its tabs**. Destructive. |

Ids and names are interchangeable wherever a tool takes `space`. Names are
resolved by Zen and can differ from the label you remember, so list first when a
name lookup fails with `space_not_found`.

### When to reuse, create, or stay

- **Reuse** when a space already represents the same job: a matching name, or
  tabs that already cover the sources. Open into it with
  `zen_tabs_open({ urls, space })`.
- **Create** when the job is distinct, will open more than a couple of tabs, or
  must survive the turn. A name the user will recognize beats a clever one.
- **Stay in the active space** for a single page and a single question. Read
  only; do not turn the user's current space into a research board.
- **Ask** before creating a second space for the same topic. Two "Research"
  spaces are worse than one organized one.

`zen_space_create` returning `switched: false` is the normal background result.
Do not follow it with `zen_space_switch` unless the user asked to go there.

### Templates

`zen_space_templates({ name })` lists the four built-ins and any user
templates, or shows one template's folders and URLs.

| Built-in | Layout |
| --- | --- |
| `research` | Folder "Sources": Wikipedia, arXiv, Google Scholar, Semantic Scholar. |
| `github-triage` | Folder "Review": notifications, pulls, issues; folder "CI": actions. |
| `news` | Hacker News, Reuters, AP, BBC News as loose tabs. |
| `docs` | MDN, CanIUse, Stack Overflow as loose tabs. |

`zen_template_apply({ template, name, switchTo })` creates a new space, opens
the tabs in the background, and recreates folders. The space gets a unique name.
Use it instead of hand-building a layout, and adjust afterwards with
`zen_folder_add_tabs` if the job needs different grouping.

`zen_template_save({ space, name, description, icon })` captures one live
space's tabs and folders. Built-ins cannot be deleted. Limits: 100 user
templates, 100 folders, 2,000 URLs.

## Folders

A folder is a result set: one per vendor, one per research question, one per
domain. It is an organizer, not a privacy boundary.

```text
zen_folder_create({ label: "Vendor sources", tabIds: [...], space: "CI vendors", collapsed: false })
zen_folder_add_tabs({ folderId: "...", tabIds: [...] })
zen_folders_list({})
```

Constraints, enforced by the bridge:

- All tabs must be in one space; `mixed_spaces` otherwise.
- Tabs cannot already be in a folder or split view.
- The folder and the tabs must share a space.
- At most 100 tab ids per call.
- `zen_tabs_open({ folderId })` needs an existing folder in the target space.

When a folder call fails, re-list with `zen_folders_list` and
`zen_tabs_list({ space })` before retrying. Do not guess ids.

## Pins and essentials

- `zen_pin_tabs({ tabIds, pinned })` pins normal tabs in their space. Up to 30
  ids; `pinned` defaults true.
- `zen_essentials({ action: "add" | "remove", tabIds })` adds or removes tabs
  above **every** space. Removing also unpins. Up to 20 ids.

Essentials are the most intrusive organizational tool in Zen. Add only when the
user asks for a page to be always available, and never essential a user's tab
without saying so.

## Split view and Glance

Both are visible actions. Use them only when the user asked to see something.

- `zen_split_view({ tabIds, gridType, activate })` takes 2-4 tabs from the
  active space. `gridType` is `grid`, `hsep`, or `vsep`; `activate` defaults
  true.
- `zen_split_close({ tabId })` unsplits the group containing that tab, or the
  current split. Tabs stay open.
- `zen_glance({ url, tabId, container, width, height })` opens Zen's Glance
  overlay, not a tab. Width is 320-2560, height 240-1600. It returns `opened`
  and `mode`; when Glance is unavailable the result says so and you should
  report that instead of improvising a tab.

A comparison the user asked to see is a good split-view case. A comparison you
are doing yourself is not.

## Containers

`zen_containers_list()` returns containers in this profile with
`userContextId`, name, icon, color, and `public`.

- Pass `container` (name or id) to `zen_tabs_open` or `zen_glance`.
- `zen_space_create({ containerTabId })` isolates a space in a container.

Containers are useful for separating work from personal accounts. They do not
make the agent invisible, and the dedicated profile is still the default
isolation boundary.

## Sessions

A session is a snapshot of the window, not a task log.

```text
zen_session_save({ name: "vendor-comparison-2026-11" })
zen_session_list({})
zen_session_restore({ name: "vendor-comparison-2026-11", maxTabs: 300 })
zen_session_delete({ name: "vendor-comparison-2026-11" })
```

- `zen_session_save` snapshots **every** space, folder, pinned tab, and
  essential in the window. Name it for the whole window, not one space.
- Restore matches spaces by name and reuses them unless `newSpaces: true`.
  Duplicate URLs are skipped, tabs open in the background, and partial failures
  come back as warnings.
- `maxTabs` defaults to 300 (0-2000). Restoring 500 tabs when 20 matter wastes
  the user's memory and your context.
- `zen_session_delete` removes the snapshot only; it never closes tabs.

Save before a cleanup the user agreed to, and before restoring a layout that
might change the current one. `zen_session_save` is the safety net for both.

## Windows

Zen MCP talks to a bridge per window. Most tools act on the focused window.
Only `zen_status`, `zen_session_save`, and `zen_template_apply` accept
`windowId`. If the user has two windows, confirm which one you are in with
`zen_status` before snapshotting or restoring.

## Handover

`zen_notify({ title, detail, tone, space, actionLabel })` shows an activity card.
With `space`, it gets a button that takes the user straight there, which is the
intended way to hand back a finished background job.

- `tone`: `info`, `success`, `warning`.
- `autoHideMs` defaults to 12000; `0` keeps the card until dismissed.
- Keep `title` under a short headline and put the useful detail in `detail`.

A handover is not done until the space is explainable: a name, folders, and
tabs that match the story you tell in the answer.

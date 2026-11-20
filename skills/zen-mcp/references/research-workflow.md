# Research workflow

**Read this when** the task is to answer something from the web, gather
sources, compare options, or watch a page over time.

This assumes the first-move checks in `SKILL.md` are done. Evidence rules live
in `evidence-and-verification.md`; tab mechanics in `tab-management.md`.

## Before opening anything

1. `zen_status()` — is the browser there, what space is active, how many tabs.
2. `zen_spaces_list()` and `zen_tabs_list({ query })` — is this job already
   half-done in an existing space?
3. `zen_search_tabs({ query })` — does an open tab already contain the answer?
4. `zen_history_search({ query })` and `zen_bookmarks_search({ query })` — did
   the user already save a good source?
5. `zen_config()` if a previous call was blocked. It works without a browser.

Only then decide: read an existing tab, or open new ones.

## Answering from one page

Use the active tab only when the user means "this page". Otherwise pass an
explicit `tabId`; the active tab may belong to them.

```text
zen_read_page({ tabId, format: "metadata" })          # title, description, URL
zen_read_page({ tabId, format: "markdown", maxChars: 12000 })
zen_read_page({ tabId, selector: "main article", maxChars: 6000 })
```

- Start with `metadata` or `outline` when you do not know the page shape.
- Use `selector` when the answer lives in one section; it is the cheapest real
  read and avoids surrounding navigation text.
- Use `format: "text"` only when Markdown conversion loses structure you need.
- Quote the exact sentence you rely on, then verify it with
  `zen_show_evidence` before presenting it as sourced.
- If the read returns `PAGE_STILL_LOADING`, use `zen_wait_for` with a condition
  from the expected page (a selector or a phrase), then read once more.

A single-page answer does not need a space, a folder, or a progress card. Do
not create them for one read.

## Researching across sources

### 1. Define the shape before opening tabs

Write down, in the conversation, the dimensions the answer must cover. Example
for "which CI vendor should we use": price at team size, self-hosted support,
cache limits, macOS runners, migration path. Dimensions decide folders, read
format, and what counts as missing data.

### 2. Choose the workspace

- Reuse a matching space, or create one named for the decision.
- `zen_template_apply({ template: "research" })` is a reasonable default for a
  literature scan.
- Open sources in the background (`background` defaults true). Never use
  `switchTo` for research.

### 3. Discover sources

- Read `format: "links"` on a hub page to get candidate URLs instead of
  guessing them.
- Open at most 30 URLs per `zen_tabs_open`; split longer lists.
- Deduplicate against open tabs first. `zen_tabs_open` deduplicates only within
  one call, not against tabs that are already open.
- Keep one folder for sources, or one folder per option when comparing.

### 4. First pass: batch, don't serialize

```text
zen_read_pages({ tabIds: [...up to 10], format: "markdown", maxChars: 8000 })
```

The result is `pages[]`, each with `tabId`, `ok`, `title`, `url`, `page`, or an
`error` string. One slow or blocked page does not spoil the batch. Process what
succeeded and report what did not.

A single `format`, `selector`, and `offset` applies to the whole batch. That is
a feature for comparison and a limitation for mixed pages: run a second batch
with a different selector rather than ten single reads.

### 5. Second pass: targeted

For each promising source, read the section that actually answers the
dimension:

```text
zen_find_text({ tabId, query: "per-minute pricing", context_chars: 160 })
zen_read_page({ tabId, selector: "#pricing", maxChars: 6000 })
```

Prefer `zen_find_text` when you need to know whether a phrase exists and where;
prefer `selector` when you need the surrounding content.

### 6. Keep notes as you go

Zen MCP has no built-in research ledger. Keep a compact note per source in the
conversation or in the artifact you are writing:

```text
Source: <title> — <url> (read 2026-11-20)
Claim: <one sentence>
Quote: "<exact text>"   [verified | unverified]
Caveat: <date, scope, paywall, conflict>
```

This is what lets you write a cited answer later without re-reading every tab.

### 7. Verify, then answer

- Verify every quote used in the answer, in one batch when there are several
  (`zen_show_evidence_batch`).
- State which claims are supported, which are inferred, and which are missing.
- Link the sources inline; the user can also open the space.
- Save the session only when the layout is worth restoring.

### 8. Hand over

Set `zen_progress` at each stage of a long run and poll `zen_events` between
steps. A `kind: "stop"` event means stop: summarize partial results and clear
the card with `zen_progress({ done: true })`.

Finish with `zen_notify({ title, space, actionLabel: "Open sources" })` so the
user lands in the space you built.

## Comparing options

Comparison fails when each source is read differently. Fix the shape first:

1. One space, one folder per option (or one folder of sources plus a table).
2. The same dimensions for every option, decided before reading.
3. The same read format for every source. `format: "tables"` is best for spec
   and pricing tables; `markdown` with a `selector` for prose pages.
4. A result table with one row per option and one column per dimension.
5. Explicit gaps: "not published", "requires sales contact", "page did not
   load". Never fill a gap with a plausible guess.

Use `zen_split_view` only if the user asked to see the comparison side by side.

## Monitoring a page

Watches poll server-side and survive between tool calls.

```text
zen_watch_add({ tabId, mode: "change", contains: "In stock", intervalSeconds: 60, label: "stock" })
zen_watch_add({ tabId, mode: "appear", selector: ".price-drop", notify: true })
zen_watch_list({})
zen_events({ waitSeconds: 25 })
zen_watch_remove({ watchId })
```

- `mode`: `change` (page text), `appear` or `disappear` (CSS selector).
- `intervalSeconds` defaults to 60; the server enforces a minimum (15 by
  default, configurable).
- `maxMinutes` defaults to 120, maximum 1,440. Watches expire; do not promise
  permanent monitoring.
- At most 50 watches. Each hit posts a `kind: "watch"` event and, with
  `notify: true`, a card in Zen.
- Remove watches when the user no longer needs them, and say when one expires.

If the user wants a one-off check, read the page instead of installing a watch.

## PDFs

PDF text is extracted through Zen's viewer. A PDF in a hidden space may return
`pdf_unreadable` because Firefox has not initialized the viewer for that tab.
Ask the user to open the PDF visibly (or select that tab), then retry. Do not
retry a hidden PDF repeatedly.

## Paywalls, logins, and blocked pages

- There is no paywall bypass. Report the limitation and use an accessible
  source.
- A dedicated profile starts with no logins. If the user chose the normal
  profile, signed-in pages may be readable within policy; do not assume either.
- `UNSUPPORTED_PAGE` and `PRIVILEGED_PAGE` mean the page is out of scope. Do not
  try to force browser-internal access.
- With a domain allowlist set, a page that redirects off-list is rejected when
  its result comes back. The navigation still happened; report the block rather
  than retrying alternate URL forms.

## Deliverable checklist

- Direct answer first, then the evidence that supports it.
- Every quoted claim verified, or explicitly marked unverified.
- Contradictions between sources shown, not averaged away.
- Missing data named.
- Sources linked; the space and folders named.
- What you would check next, if anything.
- Temporary watches removed, progress card cleared, job space kept only if it
  is useful to the user.

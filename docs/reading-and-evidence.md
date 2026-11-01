# Reading pages, finding text, and Evidence Mode

Zen MCP reads pages through the authenticated bridge. It does not use an ad hoc Marionette content script, and it never runs agent-supplied JavaScript.

## Reading pages in the background

`zen_read_page` and `zen_read_pages` do not change what the user is looking at. They go through the browser's own content actor, which can reach a loaded tab in any space, including a space that is not currently rendered. A tab that has not loaded its document returns `tab_not_loaded`; a privileged page returns a clear error instead of partial content.

Formats:

- `text`: readable page text, preferring `<article>`, `<main>`, or `role=main`.
- `markdown`: headings, lists, links, and tables as Markdown.
- `links`: unique http(s) links with their text.
- `tables`: table captions, headers, and rows.
- `metadata`: title, description, canonical URL, Open Graph tags, and language.
- `outline`: the heading tree.

A separate `selector` option limits any format to one CSS-selected element. When `selector` is supplied and the element is missing, the read returns `selector_not_found` instead of falling back to the whole page. HTML pages are read from the rendered DOM. Iframes (same-origin and cross-origin), shadow roots, canvas, images, SVG, and form controls are not read.

The result includes the title, URL, selected text, content type, length, `offset`, and `nextOffset`. `maxChars` limits each chunk (24,000 by default, 60,000 maximum).

Long `text` and `markdown` reads are paged. Pass `nextOffset` from one result as `offset` on the next call; `nextOffset` is `null` when the stream is exhausted. Offsets are clamped to the page length, so reading past the end returns empty text instead of an error.

```text
zen_read_page { tabId: "42", maxChars: 24000, offset: 0 }
→ { text: "...", length: 85213, offset: 0, nextOffset: 24000, truncated: true }

zen_read_page { tabId: "42", maxChars: 24000, offset: 24000 }
→ { text: "...", length: 85213, offset: 24000, nextOffset: 48000, truncated: true }
```

`zen_read_pages` applies the same offset to every tab in the batch. `links`, `tables`, `metadata`, and `outline` ignore `offset` and return their complete structured data with a `limitation` note, because a character cursor does not map cleanly to a list of items.

Offsets are positions in the extracted text, not the raw HTML. They stay stable while the page is unchanged. If the page changes between calls, earlier offsets can shift, so start again from offset 0 when the content has changed.

### PDFs

PDF text is extracted through Zen's built-in PDF viewer. That viewer is not always initialized for a PDF tab that is not visible, so a hidden PDF can return `pdf_unreadable`. Open the PDF and retry on the active tab. This path is not covered by the automated live suite, so treat PDF reads outside the active tab as best effort.

Pages that cannot expose a document (privileged `about:` pages, tabs that have not loaded) return a clear error instead of partial nonsense.

### Policy

Reads are checked against the domain allowlist before content is returned, and the tab URL is rechecked at that point. Read-only mode does not block reads. Consent and Pause still apply because the request goes through the bridge.

URLs for page reads, Glance, and evidence must be `http(s)`. `zen_tabs_open` also accepts `about:` URLs. When a domain allowlist is configured, `about:` URLs fail the allowlist check because it only covers `http(s)`.

## Finding text in tabs

Two tools locate literal text without regex, selection, scrolling, or highlights:

| Tool | Scope | Defaults |
| --- | --- | --- |
| `zen_find_text` | One tab | 20 matches, 120 characters of context |
| `zen_search_tabs` | Up to 30 tabs, two at a time | 5 matches per tab, 80 characters of context, 20 tabs searched |

Both accept a literal `query` and optional `case_sensitive`. By default matching folds case, diacritics, typographic punctuation, and whitespace differences, so `cafe` finds `Café` and `"hello"` finds `“hello”`. `case_sensitive` switches to exact `indexOf`. Matches carry raw page offsets (`start`, `end`), the matched text, and a short excerpt with ellipses.

`zen_search_tabs` searches every open tab, a `space`, or an explicit `tab_ids` list. Each tab succeeds or fails independently, so privileged pages, PDFs, and missing tabs appear as error entries in the results instead of failing the call. Results are capped per tab and at 200 matches in total, and `truncated` reports when anything was clipped. The batch searches 20 tabs by default and accepts `max_tabs` up to 30. Use `zen_show_evidence` when the user should see the passage.

Like page reads, both tools search the rendered DOM text, so infinite-scroll content and content behind interaction are invisible until loaded. Neither tool changes the browser UI.

## Evidence Mode

An answer is only as useful as the user's ability to check it. `zen_show_evidence` turns a citation into something visible without interrupting the user: it reuses or opens the source tab in the background, finds the cited passage, scrolls to it, marks it, and shows a card in browser chrome with the claim, source, excerpt, and match status. The card has a **Show source** action; pass `focus: true` when the user asked to see the source immediately.

```text
zen_show_evidence {
  url: "https://example.com/report",
  claim: "The pilot cut response time in half",
  quote: "Median response time fell from 42 seconds to 21 seconds.",
  context: "Results after the six-week pilot",
  source_title: "2026 operations report"
}
```

The flow:

1. Reuse an open tab whose URL matches the source, or open the URL in the background. A supplied `tab_id` is used only when that tab still shows the same URL. `focus: true` switches to the tab and brings its window forward.
2. Wait up to 12 seconds for the document to leave `about:blank` and finish loading.
3. Read the page's rendered text through the Marionette content actor.
4. Locate the quote, then verify the page text has not changed before marking.
5. Scroll the passage toward the center of the viewport.
6. Paint an absolutely positioned overlay over the passage. The overlay fades out after 20 seconds by default.
7. Return structured JSON and show an activity card with a dismiss button.

### Input

| Field | Required | Meaning |
| --- | --- | --- |
| `url` | yes | `http(s)` source URL. A missing scheme is assumed to be `https`. |
| `quote` | yes | The passage expected in the source, up to 20,000 characters. |
| `claim` | no | The claim the passage supports. It becomes the card title. |
| `context` | no | Nearby source text, used to choose between repeated passages. |
| `source_title` | no | Human-readable source name for the card. |
| `tab_id` | no | Reuse this tab only if it still shows `url`. |
| `min_confidence` | no | Fuzzy-match threshold from 0.5 to 1. Defaults to 0.85. |
| `highlight_ms` | no | How long the mark stays visible, 1,000 to 120,000 ms. Defaults to 20,000. |
| `focus` | no | Bring the source tab and window to the front. Defaults to `false`. |

`zen_clear_evidence` takes an optional `tab_id`. With no id it removes marks from tabs tracked during the server session. Tracking is bounded to the 20 most recently marked tabs, so older tabs are not cleared automatically.

### Result

```json
{
  "ok": true,
  "tabId": "42",
  "tabReused": true,
  "focused": false,
  "sourceUrl": "https://example.com/report",
  "url": "https://example.com/report",
  "title": "2026 operations report",
  "claim": "The pilot cut response time in half",
  "matchedQuote": "Median response time fell from 42 seconds to 21 seconds.",
  "matchMethod": "normalized",
  "confidence": 0.99,
  "occurrences": 1,
  "scrolled": true,
  "highlighted": true,
  "verified": true
}
```

`verified` is true when the chosen passage came from exact, normalized, or context-assisted matching and the passage is in view. A fuzzy match still returns `ok: true` when it clears `min_confidence`, but sets `verified: false`; present it as a possible match, not as confirmed support.

A failure sets `ok` to `false`, adds `error: { code, message }`, and never highlights a different passage. Some successes carry a `limitation` string, for example when the page was too large to search completely or the passage has no visible box to paint.

| Code | Meaning |
| --- | --- |
| `PAGE_NOT_FOUND` | The tab closed, navigated away, or could not be reached. |
| `PAGE_STILL_LOADING` | The document did not finish loading within 12 seconds. |
| `QUOTE_NOT_FOUND` | The quote is absent from the page's readable text. |
| `AMBIGUOUS_MATCH` | The passage repeats and no context selected one occurrence. |
| `LOW_MATCH_CONFIDENCE` | The closest fuzzy passage is below the threshold. |
| `HIGHLIGHT_FAILED` | The page changed too often between matching and marking, or the passage is not visible. |
| `PRIVILEGED_PAGE` | The tab is on a browser-internal page. |
| `ACTOR_UNAVAILABLE` | Marionette no longer exposes the content actor. |
| `UNSUPPORTED_PAGE` | PDF, non-HTML, or non-`http(s)` content. |

### Matching behavior

Matching runs in fixed code inside the bridge, in this order:

1. **Exact.** A raw substring match with exact offsets, including case.
2. **Normalized.** HTML entities are decoded; typographic quotes, dashes, and ellipses are folded; Unicode is NFKC-normalized, lowercased, and stripped of diacritics; whitespace is collapsed. Offsets are mapped back to the raw page text so the highlight covers the original characters.
3. **Context.** When the quote appears more than once, the 800 characters around each occurrence are scored against `context` using token containment and bigram overlap. A clear winner is required; a tie stays ambiguous.
4. **Fuzzy.** Token-anchored windows are compared with a bounded Levenshtein distance. This only runs for quotes up to 300 characters and accepts a match at or above `min_confidence`. A fuzzy match never changes a number or a negation word.

The matcher never picks one of several equally plausible passages. It reports `AMBIGUOUS_MATCH` or `LOW_MATCH_CONFIDENCE` instead. Before painting, the highlight script re-reads the page and checks that the raw text at the chosen offsets still equals the matched passage; if not, it re-indexes and retries, up to three times.

### Supported pages

- `http(s)` HTML and XML documents with a loaded content document.
- Text that is rendered in the DOM and visible. Hidden, clipped, or off-screen passages are not indexed and can return `HIGHLIGHT_FAILED`.
- Same-document content only. Text inside iframes (same-origin or cross-origin), open shadow roots, images, canvas, SVG, or form controls is not searched.
- PDFs, `about:`/`chrome:` pages, `file:` URLs, and other non-HTML responses return `UNSUPPORTED_PAGE` or `PRIVILEGED_PAGE`.

### Limitations

- The first 600,000 characters of page text are indexed. Truncation is reported in `limitation`.
- Pages that continuously change can exhaust the three marking attempts and return `HIGHLIGHT_FAILED`.
- The mark is an overlay, not a DOM edit. Layout changes while it is visible can move the underlying text away from the boxes. It disappears after `highlight_ms`, and `zen_clear_evidence` removes it sooner.
- Only the current DOM is searched. Infinite-scroll content and content behind interaction are invisible until loaded.
- Pause does not remove an existing evidence overlay. The overlay fades on its own schedule.

### Security

- Agents send only `url`, `quote`, `context`, and numeric options. Every DOM operation is a fixed script built on the server; no agent-supplied JavaScript is ever evaluated.
- URLs are normalized to `http(s)` and checked against the domain allowlist before a tab opens. The tab URL is rechecked when evidence is returned. A redirect that happens after the initial check can still move the tab; the next read or evidence call rechecks it.
- Read-only mode blocks `zen_show_evidence`, `zen_show_evidence_batch`, and `zen_clear_evidence` because they open or select a tab and add overlays.
- Overlay nodes are marked `aria-hidden`, ignore pointer events, and live in a closed shadow root. The page's text nodes and styles are never modified.
- The result card is rendered in a shadow root in browser chrome through the existing activity-card system. Page scripts cannot reach it. Evidence Mode does not create a second notification system.
- The Marionette endpoint and bridge token stay inside the local server; neither is exposed to pages or to the agent.

### Verifying several citations

`zen_show_evidence_batch` checks up to 20 citations in one call, two sources at a time (three maximum). Citations that share a source URL reuse one tab, and missing sources are opened once in the background. Every citation gets its own result with the same fields as `zen_show_evidence`, and one summary card reports how many were verified and lists up to three failures. `focus: true` brings the first source forward once instead of switching for every citation.

Each source may have at most 5 quotes per batch. If any citation URL is not `http(s)`, the whole batch is rejected before a tab opens, so a bad URL cannot pull the batch halfway through. The call reports `total`, `matched`, `verified`, `failed`, `openedTabs`, and `reusedTabs`.

Batch `ok` is stricter than a single result: it is true only when every citation matched and every match was verified. A fuzzy match still has per-citation `ok: true`, but it does not count toward `verified` and makes the batch `ok: false`. The summary card calls those citations out for a manual check.

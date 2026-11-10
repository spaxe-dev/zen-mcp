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
- `interactive`: visible controls with stable refs, for `zen_click` and `zen_type`.

A separate `selector` option limits any format to one CSS-selected element. When `selector` is supplied and the element is missing, the read returns `selector_not_found` instead of falling back to the whole page. Text, Markdown, and the structured list formats read the rendered light DOM of one document. Shadow roots, canvas, images, SVG, and form controls are not included in those formats. `interactive` is the exception: it scans form controls and controls inside open shadow roots, and at the top level it also collects controls from child frames.

Iframes are read through `framePath`, an array of child frame indexes such as `[0]` or `[0,1]`. Every read result lists reachable http(s) frames under `frames`, each with its path, URL, and name, so the agent can drill in without guessing. A frame read returns that frame's document as `title`, `url`, `text`, and the other formats; `framePath` echoes the target. Frame paths are capped at three levels and listing stops after 20 frames; omitted frames are counted in `limitation`. Frames outside the domain allowlist and non-http(s) frames are never listed, read, or driven.

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

### Interactive elements

`format: "interactive"` returns `elements`, a list of up to 200 visible controls found in the selected scope. Each element carries:

| Field | Meaning |
| --- | --- |
| `ref` | Short stable target such as `e12`, or a frame-prefixed ref such as `f0-e3` or `f0.1-e2`, valid only for the current page state. |
| `tag`, `role`, `type` | Element identity, including `input` types and ARIA roles. |
| `label` | Accessible name from `aria-label`, `aria-labelledby`, labels, text, placeholder, or name. |
| `value` | Current value for text, select, and similar controls. Always `null` for password inputs. |
| `placeholder`, `href` | Optional attributes that help identify a target. |
| `disabled`, `checked`, `readOnly` | State flags, with `checked` only for checkboxes and radios. |
| `sensitive` | True for password inputs. |
| `editable` | True when `zen_type` can reasonably target the element. |
| `framePath`, `frameUrl` | Present for controls inside a frame, so the agent can tell where they live. |

The scan covers links, buttons, inputs other than hidden ones, textareas, selects, summaries, contenteditable regions, elements with a non-negative tabindex, and common ARIA roles. It skips elements that are not visible. At the top level it also scans child frames and merges their controls into the same list, with refs prefixed by the frame path. The 200-element cap applies across the whole list; `elementsTruncated: true` and a limitation report when it was reached, and `selector` narrows the scan to the top document without scanning frames. Up to 10 frames are scanned per read; unread frames are counted in `limitation`. Interactive reads do not return page text, so their `text`, `length`, and `offset` are empty or zero.

`zen_click` and `zen_type` take the `tabId` plus exactly one of `ref` or `selector`. A ref is resolved through the fixed script that assigned it, including open shadow roots and the frame encoded in its prefix; a selector is resolved in the top document's light DOM. Refs are cleared by the next interactive read of the tab and are invalid after a navigation. When resolution fails, the call returns `element_not_found`; run a fresh interactive read rather than guessing a ref.

`zen_click` refuses a disabled target, checks the tab URL, the frame URL, and an anchor's `href` against the domain allowlist, then sends a native click. `zen_type` refuses disabled or read-only targets and file inputs, can clear the field first, and caps text at 10,000 characters. It reports `typed` (a character count), never the text, and adds a limitation when the target is a password field. Frame actions report `framePath` and the frame's current `frameUrl`. Neither tool evaluates agent-supplied JavaScript, and both are blocked in read-only mode because they change page state.

A click is a real input event. It can submit a form, start a download, open a dialog, navigate, or make a purchase. The allowlist covers the tab URL before the action, the frame URL, an anchor target, and the tab URL after the action; it cannot predict what an in-page script does in between.

### PDFs

PDF text is extracted through Zen's built-in PDF viewer. That viewer is not always initialized for a PDF tab that is not visible, so a hidden PDF can return `pdf_unreadable`. Open the PDF and retry on the active tab. This path is not covered by the automated live suite, so treat PDF reads outside the active tab as best effort.

Pages that cannot expose a document (privileged `about:` pages, tabs that have not loaded) return a clear error instead of partial nonsense.

### Policy

Reads are checked against the domain allowlist before content is returned, and the tab URL is rechecked at that point. Read-only mode does not block reads, but it does block `zen_click` and `zen_type`. Consent and Pause still apply because the request goes through the bridge.

URLs for page reads, Glance, and evidence must be `http(s)`. `zen_tabs_open` also accepts `about:` URLs. When a domain allowlist is configured, `about:` URLs fail the allowlist check because it only covers `http(s)`. Page actions require an `http(s)` tab, check the tab URL and any link target against the allowlist, and check the resulting tab URL again before returning.

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

An answer is only as useful as the user's ability to check it. `zen_show_evidence` turns a citation into something visible without interrupting the user: it reuses or opens the source tab in the background, finds the cited passage, scrolls to it, marks it, and shows a card in browser chrome with the claim, source, excerpt, and match status. The card has a **Show source** action; pass `focus: true` when the user asked to see the source immediately. Both report `focused` from observed state, not from the requested option: it is true only when the bridge reports the source tab as active.

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

1. Reuse an open tab whose URL matches the source, or open the URL in the background. A supplied `tab_id` is used only when that tab still shows the same URL. `focus: true` switches to the tab, waits for a cross-space switch to settle, and brings its window forward. If the tab never becomes active, the result says so in `limitation` instead of reporting focus.
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
| `focus` | no | Ask to bring the source tab and window to the front; `focused` reports what was observed. Defaults to `false`. |

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
| `QUOTE_NOT_FOUND` | The quote is absent from the page's readable text, or the closest candidate is below the 70% plausibility floor for a paraphrase. |
| `AMBIGUOUS_MATCH` | The passage repeats and no context clearly selected one occurrence, or the occurrence scan hit its cap without a clear winner. |
| `LOW_MATCH_CONFIDENCE` | The closest candidate is at least 70% similar but below the requested `min_confidence` threshold. The message reports both scores. |
| `HIGHLIGHT_FAILED` | The page changed too often between matching and marking, or the passage is not visible. |
| `PRIVILEGED_PAGE` | The tab is on a browser-internal page. |
| `ACTOR_UNAVAILABLE` | Marionette no longer exposes the content actor. |
| `UNSUPPORTED_PAGE` | PDF, non-HTML, or non-`http(s)` content. |

### Show source

The activity card carries a **Show source** action when the call did not already focus the source. Clicking it selects the evidence tab, switching to its space when needed, and verifies that Zen actually activated it before doing anything else. The bridge then replays the same fixed evidence request the agent used (quote, context, and confidence floor), scrolls to the passage, and paints a fresh overlay for 25 seconds. Even after the original mark expired, asking to see the proof shows the passage again.

The bridge keeps only the most recent successful request per tab, bounded to 20 tabs. It stores the quote, context, and confidence floor from the agent's tool call, never page text, URLs, selectors, or scripts, and the action itself carries only a tab id. If the page changed and the quote can no longer be matched, the action fails with the underlying code such as `QUOTE_NOT_FOUND` or `HIGHLIGHT_FAILED`, the card shows the message, and no other passage is highlighted. If the tab was never marked successfully, the action only selects it.

### Matching behavior

Matching runs in fixed code inside the bridge, in this order:

1. **Exact.** A raw substring match with exact offsets, including case.
2. **Normalized.** HTML entities are decoded; typographic quotes, dashes, and ellipses are folded; Unicode is NFKC-normalized, lowercased, and stripped of diacritics; whitespace is collapsed. Offsets are mapped back to the raw page text so the highlight covers the original characters.
3. **Context.** When the quote appears more than once, the matcher scores `context` before the occurrence cap becomes a hard ambiguity. Up to 300 occurrences are scanned when context is supplied (50 without context) and each candidate is scored against 240 characters before and 240 after it, using token containment, bigram overlap, and a proximity weight that rewards context words nearer the candidate. A clear winner is required: the best score must be at least 0.2 and lead the runner-up by at least 0.1; otherwise the result stays ambiguous. A context-assisted match can still be one of several occurrences, so `occurrencesTruncated` is reported when the scan hit its cap.
4. **Fuzzy.** Token-anchored windows are compared with a bounded Levenshtein distance. This only runs for quotes up to 300 characters and accepts a match at or above `min_confidence`. A candidate below 70% similarity is treated as absent and returns `QUOTE_NOT_FOUND`; a candidate at or above 70% but below `min_confidence` returns `LOW_MATCH_CONFIDENCE`. Both messages report the best score and the threshold. A fuzzy match never changes a number or a negation word.

The matcher never picks one of several equally plausible passages. It reports `AMBIGUOUS_MATCH` or `LOW_MATCH_CONFIDENCE` instead. Results report `occurrences`, and ambiguous results include candidate excerpts plus `occurrencesTruncated` when the scan stopped at its cap. Before painting, the highlight script re-reads the page and checks that the raw text at the chosen offsets still equals the matched passage; if not, it re-indexes and retries, up to three times.

### Supported pages

- `http(s)` HTML and XML documents with a loaded content document.
- Text that is rendered in the DOM and visible. Hidden, clipped, or off-screen passages are not indexed and can return `HIGHLIGHT_FAILED`.
- Same-document content only. Evidence Mode does not search iframes, open shadow roots, images, canvas, SVG, or form controls. Use `zen_read_page` with `framePath` to read frame text.
- PDFs, `about:`/`chrome:` pages, `file:` URLs, and other non-HTML responses return `UNSUPPORTED_PAGE` or `PRIVILEGED_PAGE`.

### Limitations

- The first 600,000 characters of page text are indexed. Truncation is reported in `limitation`.
- A quote is scanned up to 50 occurrences without context, or 300 with context. When the cap is reached, `occurrences` and `occurrencesTruncated` are a lower bound, and a context-assisted match can still be one of several matching passages.
- Pages that continuously change can exhaust the three marking attempts and return `HIGHLIGHT_FAILED`.
- The mark is an overlay, not a DOM edit. Layout changes while it is visible can move the underlying text away from the boxes. It disappears after `highlight_ms`, and `zen_clear_evidence` removes it sooner.
- Only the current DOM is searched. Infinite-scroll content and content behind interaction are invisible until loaded.
- Pause does not remove an existing evidence overlay. The overlay fades on its own schedule.
- Tab selection is verified, not assumed. When Zen will not activate the source tab, or the window cannot be raised, the result keeps the evidence status but reports `focused: false` and adds a `limitation` explaining what did not happen. `zen_tab_select` turns the same failure into a `select_failed` error.

### Security

- Agents send only `url`, `quote`, `context`, and numeric options. Every DOM operation is a fixed script built on the server; no agent-supplied JavaScript is ever evaluated.
- The **Show source** action carries only a tab id. The bridge replays the last successful request it stored for that tab through the same fixed pipeline and never accepts a URL, quote, selector, or script from the card or the page.
- URLs are normalized to `http(s)` and checked against the domain allowlist before a tab opens. The tab URL is rechecked when evidence is returned. A redirect that happens after the initial check can still move the tab; the next read or evidence call rechecks it.
- Read-only mode blocks `zen_show_evidence`, `zen_show_evidence_batch`, and `zen_clear_evidence` because they open or select a tab and add overlays.
- Overlay nodes are marked `aria-hidden`, ignore pointer events, and live in a closed shadow root. The page's text nodes and styles are never modified.
- The result card is rendered in a shadow root in browser chrome through the existing activity-card system. Page scripts cannot reach it. Evidence Mode does not create a second notification system.
- The Marionette endpoint and bridge token stay inside the local server; neither is exposed to pages or to the agent.

### Verifying several citations

`zen_show_evidence_batch` checks up to 20 citations in one call, two sources at a time (three maximum). Citations that share a source URL reuse one tab, and missing sources are opened once in the background. Every citation gets its own result with the same fields as `zen_show_evidence`, and one summary card reports how many were verified and lists up to three failures. `focus: true` brings the first source forward once instead of switching for every citation, and both the batch and per-citation `focused` values report what was observed.

Each source may have at most 5 quotes per batch. If any citation URL is not `http(s)`, the whole batch is rejected before a tab opens, so a bad URL cannot pull the batch halfway through. The call reports `total`, `matched`, `verified`, `failed`, `openedTabs`, and `reusedTabs`.

Batch `ok` is stricter than a single result: it is true only when every citation matched and every match was verified. A fuzzy match still has per-citation `ok: true`, but it does not count toward `verified` and makes the batch `ok: false`. The summary card calls those citations out for a manual check.

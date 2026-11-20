# Evidence and verification

**Read this when** an answer will contain a claim taken from a web page, the
user asks you to check a citation, or a source may contradict something you
already wrote.

Evidence Mode is the difference between "I saw a page" and "this page contains
this sentence". Use it whenever the answer depends on what a page says.

## What evidence is, and is not

Zen MCP's `zen_show_evidence` locates a quote in a live page, scrolls to it,
and draws a temporary overlay. It returns structured facts about that match.

It is a receipt for a quotation. It is not:

- proof that the statement is true,
- proof that the source is authoritative, current, or representative,
- proof that no contradicting passage exists elsewhere on the page,
- a search engine for a claim you have not read.

A verified quote means the page visibly contains those words. Your reasoning
still has to be yours.

## Source states

Track each source at one of these states, and never promote it silently:

| State | Meaning | What you may write |
| --- | --- | --- |
| Discovered | A link or search result exists. | "A source exists"; never a claim. |
| Opened | The tab exists, content may be unread. | Nothing about content. |
| Read | You have the text in context. | Summary, labeled as your reading. |
| Claim extracted | You wrote down one specific statement. | A draft claim, still unsourced. |
| Quote verified | `zen_show_evidence` returned `ok: true` and `verified: true`. | A citation with the quote. |
| Corroborated | An independent source says the same thing. | "Two sources report…" |
| Contradicted | Another source disagrees. | Both positions, with both quotes. |
| Unresolved | You could not verify, read, or find it. | "Unverified" and why. |

"If the page exists, it supports the claim" is never one of these states.

## Single verification

```text
zen_show_evidence({
  url: "https://example.com/pricing",
  quote: "The Team plan is $12 per user per month, billed annually.",
  claim: "The Team plan costs $12/user/month annually.",
  context: "Pricing table, Team row",
  source_title: "Example pricing"
})
```

| Parameter | Bound | Notes |
| --- | --- | --- |
| `url` | ≤4,000 chars | http(s) only; a missing scheme is treated as https. |
| `quote` | 1-20,000 chars | Copy it from the page text, verbatim. |
| `claim` | ≤1,000 chars | Shown as the card title; optional. |
| `context` | ≤2,000 chars | Nearby text; the tie-breaker for repeated quotes. |
| `source_title` | ≤300 chars | Human label for the card. |
| `tab_id` | ≤200 chars | Reused only if it still shows that URL. |
| `min_confidence` | 0.5-1, default 0.85 | Floor for fuzzy matches. |
| `highlight_ms` | 1,000-120,000, default 20,000 | How long the overlay stays. |
| `focus` | boolean, default false | `true` brings the tab and window forward. |

Behavior: it reuses a tab whose URL matches, otherwise opens the source in the
background, then matches. Matching tries exact text, normalized text,
context-assisted disambiguation for repeated passages, and finally fuzzy
matching above the floor. A fuzzy match never changes a number or a negation
word.

`focus: true` is a visible action. Use it only when the user asked to see the
source, not to "make sure" a check worked.

## Reading the result

| Field | Meaning |
| --- | --- |
| `ok` | The operation completed and a passage was located. |
| `verified` | The passage was visibly highlighted and the match is not fuzzy. |
| `matchedQuote` | The text that was actually matched. Compare it with your quote. |
| `matchMethod` | Exact, normalized, context-assisted, or fuzzy. |
| `confidence` | Match confidence, not truth confidence. |
| `occurrences` | How many candidates existed. |
| `scrolled`, `highlighted` | Whether the page moved and the overlay was drawn. |
| `tabReused` | Whether an existing tab was used. |
| `focused` | Whether the window was brought forward. |
| `limitation` | Anything that narrowed the result. |
| `error.code`, `error.message` | Why it failed. |

Present a claim as supported **only** when `ok === true` and
`verified === true`. Everything else is an honest miss or a lead.

### Outcome codes

| Code | Meaning | Correct response |
| --- | --- | --- |
| `QUOTE_NOT_FOUND` | The page does not contain the passage. | Do not cite it. Shorten the quote, check you are on the right page, or report the miss. |
| `AMBIGUOUS_MATCH` | Several passages fit and context did not settle it. | Add a longer `quote` or more `context`, then retry once. |
| `LOW_MATCH_CONFIDENCE` | The best fuzzy match is below the floor. | Treat as unsupported unless the user confirms the passage manually. |
| `HIGHLIGHT_FAILED` | The text was found, but no visible mark could be drawn. | The quote may exist but is not verified; say so. |
| `PAGE_NOT_FOUND` | The source could not be opened or the tab vanished. | Re-list tabs, retry once with the URL. |
| `PAGE_STILL_LOADING` | The page was not ready. | Wait for a condition, then retry once. |
| `UNSUPPORTED_PAGE` | Not an http(s) page or not inspectable. | Report; do not force it. |
| `PRIVILEGED_PAGE` | Browser-internal page. | Report; out of scope. |
| `ACTOR_UNAVAILABLE` | The page or frame changed under the operation. | Re-read the tab, then retry once. |

`HIGHLIGHT_FAILED` is not the same as `QUOTE_NOT_FOUND`. Do not collapse the
distinction: one means "not visibly supported", the other means "not there".

## Batch verification

Use the batch form when an answer cites several sources or several quotes.

```text
zen_show_evidence_batch({
  citations: [
    { url: "https://a.example/pricing", quote: "...", claim: "...", source_title: "A pricing" },
    { url: "https://a.example/docs",    quote: "...", claim: "...", source_title: "A docs" },
    { url: "https://b.example/limits",  quote: "...", claim: "...", source_title: "B limits" }
  ],
  min_confidence: 0.85
})
```

- Up to 20 citations, at most 5 per source URL.
- Sources are grouped: matching tabs are reused, missing sources open once in
  the background.
- Concurrency defaults to 2 (maximum 3).
- Every URL is checked before anything opens. One non-http(s) URL rejects the
  whole batch.
- `focus` defaults false. `focus: true` brings the first source forward.
- The result has `total`, `matched`, `verified`, `failed`, `openedTabs`,
  `reusedTabs`, and a `results[]` entry per citation.
- One summary card lists at most three failures so the UI is not flooded. Your
  answer can still report all of them.

A batch is not a blanket pass. Read `results[]`; a citation can fail while the
batch reports partial success.

## Verification discipline

1. **Quote what you read.** Copy the sentence from the page text you actually
   retrieved. Do not paraphrase into the `quote` field; verification matches
   text, not meaning.
2. **One quote, one claim.** Do not bundle two facts into one quote and then
   cite both.
3. **Prefer the primary page.** A blog quoting a pricing page is weaker than
   the pricing page. Verify the page you cite.
4. **Do not lower `min_confidence` to make a check pass.** The default is a
   quality floor, not an obstacle. If 0.85 fails, the quote is probably wrong.
5. **Do not present fuzzy as verified.** `verified: false` means a human should
   look, or you should mark it unverified.
6. **Do not infer absence from a failed check.** `QUOTE_NOT_FOUND` means that
   string is not there, not that the page disagrees.
7. **Report contradiction.** If two verified quotes disagree, show both and say
   they disagree. Do not pick the more convenient one silently.
8. **Mark inference.** "The pricing page lists $12; at 20 seats that is $240"
   is arithmetic on a verified fact, not a verified fact itself.

## What matching cannot see

- Text hidden by CSS, clipped, off-screen, or behind an interaction may not be
  indexed; it can fail with `HIGHLIGHT_FAILED`.
- Dynamic content that changed after your read may no longer match.
- Paywalled, private, or signed-out pages may not expose the passage.
- A PDF that is not visibly open may be unreadable (`pdf_unreadable`).
- Fuzzy matching is deliberately conservative, but it is still approximate;
  that is why it never counts as verified.

## Clearing marks

`zen_clear_evidence({ tab_id })` removes overlays created by this bridge
session. With no `tab_id` it clears every tab marked this session. It never
touches page-owned nodes. Clear marks when the user asks, or when a page will be
handed over and the marks are clutter.

## Audit notes

Evidence tool arguments are digested in the audit log: `quote`, `claim`,
`context`, `citations`, and `source_title` are stored as length plus hash, and
URLs keep scheme, host, and path only. That protects the log, not the page: the
site still sees the requests, and the overlay is visible in the browser.

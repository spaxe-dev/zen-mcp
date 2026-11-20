# Browser interaction

**Read this when** the user explicitly asks you to click, type, submit, or
otherwise operate a page, or when you need to confirm that a visible change
happened.

Reading is the default. Interaction exists for the steps a read cannot do.
Read-only mode blocks `zen_click` and `zen_type`; `zen_wait_for` still works.

## Before you act

1. The user asked for this action, not just the outcome. "Book it" authorizes a
   booking flow; "find the price" does not.
2. You know the page and the control. If you do not, read first.
3. The action is reversible, or the user accepted that it is not. Clicks can
   submit forms, start downloads, navigate, or make a purchase.
4. No secret is involved that the user did not give you. Never type a password,
   card number, or token on your own initiative.

When those fail, ask with `zen_ask` and concrete options instead of guessing.

## Snapshot and interactive reads

```text
zen_read_page({ tabId, format: "snapshot" })
```

Snapshot is the default choice before acting. It returns up to 100 controls
(200 with `maxElements`) across the top document and reachable frames, a short
text preview, an outline, and a `frames[]` list with `path`, `url`, and `name`.
Each control has:

| Field | Use |
| --- | --- |
| `ref` | The handle to act on: `e12`, `f0-e3`, `f0.1-e2`. |
| `tag`, `role`, `type` | What it is. |
| `label` | Accessible name or text. The main thing to match. |
| `valuePresent`, `autocomplete`, `selected`, `form` | State hints. Snapshot never returns a value or value length. |
| `placeholder`, `href` | Optional attributes that help identify a target. |
| `disabled`, `checked`, `readOnly` | Whether acting is sensible. |
| `editable` | Whether `zen_type` is appropriate. |
| `sensitive` | Password, payment, one-time-code, telephone, email, or account-like field. |
| `framePath`, `frameUrl` | Where it lives. |

Read `snapshotComplete` before trusting the list. `false` means a frame was
unlisted, skipped, failed, or left unscanned; `limitations` says which.
`elementsTruncated: true` is an output cap only: narrow with `selector`, raise
`maxElements`, or read the full text with `format: "text"`.

`format: "interactive"` returns up to 200 controls in one list, including the
legacy `value` field for non-sensitive editable controls. Use it when the
snapshot cap is too small or you need a control value. Sensitive values are
omitted in both formats.

## Refs are handles, not ids

A ref is valid only for the read that produced it:

- A new snapshot or interactive read replaces the refs of the document it read:
  one tab plus one frame path. Refs in other frames stay usable until their own
  read.
- A navigation replaces them.
- A frame ref must be used with the frame it came from; `click` and `type`
  accept the prefixed ref directly (`f0-e3`), while frame text reads and waits
  need `framePath`.

Reads never write attributes into the page. The bridge holds each ref as a
Marionette element handle, so a same-shaped clone is not a substitute for the
node you read.

If an action returns `element_not_found`, do not retry the same ref. Re-read
and resolve the control again by label.

Prefer refs over CSS selectors. Selectors are supported for the top document's
light DOM only, capped at 500 characters, and brittle on modern pages.

## Clicking

```text
zen_click({ tabId, ref: "e12" })
zen_click({ tabId, target: { role: "button", name: "Save" } })
zen_click({ tabId, target: { text: "Continue", match: "exact" } })
zen_click({ tabId, target: { label: "Email" } })
```

- Exactly one strategy: `target` with one of `ref`, role+name, `text`,
  `label`, `placeholder`, or `selector`; or the top-level `ref`/`selector`
  shortcuts. Never combine them.
- Role, text, label, and placeholder are matched against the document and open
  shadow roots. `match` is `exact` (default) or `contains` for role+name and
  text.
- Two matches fail with `target_ambiguous` and `candidates`; the server never
  picks the first. Missing, hidden, disabled, or unsupported targets fail with
  `target_not_found`, `target_not_actionable`, or `unsupported_operation`.
  A semantic ref that expired is `stale_reference`; do not retry it, re-read.
- The target is re-validated immediately before input: visibility, enabled
  state, and the document root. A replaced document is refused.
- Returns `clicked`, `target` (tag, role, label, type, sensitive), and an
  `effect` object.
- Check `target` before trusting the result: it is the server's view of what it
  clicked.

## Typing

```text
zen_type({ tabId, ref: "e7", text: "example", clear: true })
zen_type({ tabId, target: { placeholder: "Search files" }, text: "report" })
```

- `text` is capped at 10,000 characters. `clear` defaults to false, so the
  default appends.
- Returns `typed` (characters), `cleared`, `target`, `effect`, and `observed`.
- `observed` is `{ compared, matchesInput, sensitive }`. It says whether the
  field matched without returning the value or its length; sensitive fields
  return `compared: false`.
- File inputs, read-only fields, and non-editable targets are refused. There is
  no upload or download handling.

## The effect signature

`effect` reports `changed`, `urlChanged`, `titleChanged`, `domChanged`,
`valueChanged`, `waitedMs`, and sometimes `probeFailed`. It also carries
`navigation`, `documentReplaced`, `readyState`,
`attribution: "observed_after_action_not_proven"`, and a bounded `delta`:

- `addedControls`, `removedControls`, `changedControls` (up to 10 each; changes
  name state such as `checked` or `valuePresent`).
- `addedHeadings`, `removedHeadings`, `addedAlerts`, `removedAlerts` (up to 5
  each).
- `textChanged` and `textLengthDelta`.
- `limitation` when the document was replaced, so an unrelated page is never
  diffed against the old one.

Use it like this:

- `delta.addedAlerts` or `delta.addedHeadings` is a useful confirmation; a
  `changedControls` entry proves the control's state moved.
- `changed: true` means something observable changed. It does not prove the
  action had the intended business effect.
- `changed: false` is ambiguous. A form may have submitted asynchronously, or
  the probe may have failed. Do not conclude "nothing happened".
- `documentReplaced: true` or `probeFailed: true` means the server could not
  compare the old page with the new one; verify with a read instead.

Never report "submitted" or "clicked successfully" from dispatch alone. Confirm
the state you expect.

## Waiting for a state

```text
zen_wait_for({ tabId, selector: "[data-testid=result]", timeout_ms: 10000 })
zen_wait_for({ tabId, selector: ".spinner", until: "absent" })
zen_wait_for({ tabId, selector: "#save", state: "enabled" })
zen_wait_for({ tabId, text: "Payment received" })
zen_wait_for({ tabId, url_contains: "/checkout/success" })
zen_wait_for({ tabId, document_changed: true })
zen_wait_for({ tabId, new_tab: true })
zen_wait_for({ tabId, tab_closed: true })
zen_wait_for({ tabId, dialog: true })
```

- Provide exactly one primary condition: `selector`, `text`, `url_contains`,
  `title_contains`, `document_id` / `document_changed`, `new_tab`,
  `tab_closed`, or `dialog`. Text, URL, and title matching ignore case.
- `selector` waits are present by default; `state` is `present`, `visible`, or
  `enabled` and requires a selector.
- `until` is `present` (default) or `absent`. `absent` applies to selector,
  text, URL, and title only.
- `document_id` waits for that identity; `document_changed` waits until it
  differs from the supplied id or from the identity when the wait started. A
  missing identity never counts as a match.
- `new_tab` and `dialog` only count transitions after the wait starts.
  Dialog text is never read, and dialogs are never dismissed.
- `timeout_ms` defaults to 5,000 and caps at 30,000; `0` checks once.
  `poll_ms` is 100-2,000, default 250.
- A timeout returns `matched: false` and a `limitation`; it is not an error.
  Report the wait, then decide whether to retry or stop.
- A wait stops when the tab closes or the page navigates off the allowlist.
  Results only include a URL, title, or frame URL that is still allowed.
- `frame_path` waits inside one frame; document conditions reject it.

Use `zen_wait_for` after actions, after opening slow pages, and after anything
that is expected to change the URL, document, tabs, or a dialog. It is
read-only and works in read-only mode. It never assumes network idle: wait for
the specific condition you will check next.

## Frames

Interactive reads see into reachable frames and prefix their refs. To read a
frame's text, pass the path from `frames[]`:

```text
zen_read_page({ tabId, framePath: [0], format: "markdown", maxChars: 6000 })
zen_read_page({ tabId, framePath: [0, 1], format: "text" })
```

`framePath` has at most three indexes. A frame ref used in the wrong frame
fails; use the path that came from the same read. Off-allowlist frames are
filtered before you see them, so a missing frame may be policy, not a page bug.

## Forms and side effects

- A form submission can create an account, send an email, charge a card, or
  delete data. Treat the submit control as a destructive action unless you know
  otherwise.
- Fill fields one at a time with `zen_type`, verify values with a read, and
  confirm the page state before the submit click.
- If a click triggers a navigation, wait for the destination before assuming
  success.
- If a click may have submitted twice, inspect before retrying. Double submits
  are real.

## Recovery

| Symptom | Meaning | Response |
| --- | --- | --- |
| `ACTOR_UNAVAILABLE` | Marionette content actor is gone outside a ref lookup | Re-list tabs; retry once. |
| `element_not_found` | Legacy ref from an older read, or the element was removed, replaced, or navigated | New snapshot or interactive read; new ref. |
| `stale_reference` | Semantic ref that is no longer valid | Re-read; do not retry the ref. |
| `document_changed` | The document was replaced between resolution and input | Re-read the new page and act again only if the user asked. |
| `target_ambiguous` | More than one element matched | Read `details.candidates`; use a unique role+name, label, text, or ref. |
| `target_not_found` | No element matched the semantic target | Re-read; check the control exists and is visible. |
| `target_not_actionable` | Hidden, disabled, read-only, or not editable | Report the state; do not force input. |
| `unsupported_operation` | Scan limit or an operation the target does not support | Narrow the target or read the page instead. |
| `invalid_target` | Bad combination or value in `target` | Fix the input: exactly one strategy. |
| `PAGE_NOT_FOUND` | Tab closed or navigated | Re-list tabs; re-read. |
| `PAGE_STILL_LOADING` | Page not ready | `zen_wait_for`, then retry once. |
| `UNSUPPORTED_PAGE` | Not an inspectable page | Report; do not force. |
| `PRIVILEGED_PAGE` | Browser-internal page | Out of scope. |
| `matched: false` | Wait timed out | Report; verify with a read; do not loop. |
| Click returns a different target than expected | Ref or selector resolved to something else | Stop; re-read; tell the user what happened. |

One corrective retry is reasonable. A retry loop is not: it multiplies side
effects and hides the real failure.

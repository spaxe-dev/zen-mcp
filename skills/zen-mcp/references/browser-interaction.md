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

## Interactive reads

```text
zen_read_page({ tabId, format: "interactive" })
```

Returns up to 200 controls across the top document and reachable frames, plus a
`frames[]` list with `path`, `url`, and `name`. Each control has:

| Field | Use |
| --- | --- |
| `ref` | The handle to act on: `e12`, `f0-e3`, `f0.1-e2`. |
| `tag`, `role`, `type` | What it is. |
| `label` | Accessible name or text. The main thing to match. |
| `value`, `placeholder`, `href` | Current state, when present. |
| `disabled`, `checked`, `readOnly` | Whether acting is sensible. |
| `editable` | Whether `zen_type` is appropriate. |
| `sensitive` | Password or payment-like field. |
| `framePath`, `frameUrl` | Where it lives. |

`elementsTruncated: true` means the page has more controls than the cap. Narrow
the read with `selector` before acting, or you may be choosing from a partial
list.

## Refs are handles, not ids

A ref is valid only for the read that produced it:

- Another `format: "interactive"` read expires the previous refs.
- A navigation expires them.
- A frame ref must be used with the frame it came from; `click` and `type`
  accept the prefixed ref directly (`f0-e3`), while frame text reads and waits
  need `framePath`.

If an action returns `ACTOR_UNAVAILABLE`, do not retry the same ref. Re-read
interactively and resolve the control again by label.

Prefer refs over CSS selectors. Selectors are supported for the top document's
light DOM only, capped at 500 characters, and brittle on modern pages.

## Clicking

```text
zen_click({ tabId, ref: "e12" })
```

- Exactly one of `ref` or `selector`, never both.
- Returns `clicked`, `target` (tag, role, label, type, sensitive), and an
  `effect` object.
- Check `target` before trusting the result: it is the server's view of what it
  clicked.

## Typing

```text
zen_type({ tabId, ref: "e7", text: "example", clear: true })
```

- `text` is capped at 10,000 characters. `clear` defaults to false, so the
  default appends.
- Returns `typed` (characters), `cleared`, `target`, and `effect`.
- The typed text is never returned. Password values are not read back.
- File inputs are refused. There is no upload or download handling.

## The effect signature

`effect` reports `changed`, `urlChanged`, `titleChanged`, `domChanged`,
`valueChanged`, `waitedMs`, and sometimes `probeFailed`.

Use it like this:

- `changed: true` means something observable changed. It does not prove the
  action had the intended business effect.
- `changed: false` is ambiguous. A form may have submitted asynchronously, or
  the probe may have failed. Do not conclude "nothing happened".
- `probeFailed: true` means the server could not observe the page; verify with
  a read instead.

Never report "submitted" or "clicked successfully" from dispatch alone. Confirm
the state you expect.

## Waiting for a state

```text
zen_wait_for({ tabId, selector: "[data-testid=result]", timeout_ms: 10000 })
zen_wait_for({ tabId, text: "Payment received", until: "present" })
zen_wait_for({ tabId, url_contains: "/checkout/success" })
zen_wait_for({ tabId, selector: ".spinner", until: "absent" })
```

- Provide exactly one of `selector`, `text`, `url_contains`, or `title_contains`.
  Text, URL, and title matching ignore case.
- `until` is `present` (default) or `absent`.
- `timeout_ms` defaults to 5,000 and caps at 30,000; `poll_ms` is 100-2,000,
  default 250.
- A timeout returns `matched: false` and a `limitation`; it is not an error.
  Report the wait, then decide whether to retry or stop.
- `frame_path` waits inside one frame.

Use `zen_wait_for` after actions, after opening slow pages, and after anything
that is expected to change the URL. It is read-only and works in read-only mode.

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
| `ACTOR_UNAVAILABLE` | Ref expired or element replaced | New interactive read; new ref. |
| `PAGE_NOT_FOUND` | Tab closed or navigated | Re-list tabs; re-read. |
| `PAGE_STILL_LOADING` | Page not ready | `zen_wait_for`, then retry once. |
| `UNSUPPORTED_PAGE` | Not an inspectable page | Report; do not force. |
| `PRIVILEGED_PAGE` | Browser-internal page | Out of scope. |
| `matched: false` | Wait timed out | Report; verify with a read; do not loop. |
| Click returns a different target than expected | Ref or selector resolved to something else | Stop; re-read; tell the user what happened. |

One corrective retry is reasonable. A retry loop is not: it multiplies side
effects and hides the real failure.

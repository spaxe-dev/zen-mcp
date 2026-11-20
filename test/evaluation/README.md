# Agent evaluation: OLD vs NEW page representation

`scripts/agent-eval.mjs` is a deterministic harness that compares the page
representation Zen MCP exposed before the semantic view with the representation
after it was added.

- **OLD**: `zen_read_page` with `format` `text`, `snapshot` or `interactive`
  only. There is no semantic format.
- **NEW**: `zen_read_page format="semantic"`, which returns landmarks,
  headings, collections, dialogs, classification plus confidence, controls and
  a text preview in one payload.

There is **no LLM evaluation**. Every task is a fixed, hand-written policy and
every success is an asserted expected fact. Nothing is graded by a model, and
no task asks a model to interpret the page. The harness prints
`No LLM evaluation; deterministic policies only.` before and after the run.

Both modes execute the **same policy function** over a normalized observation.
The only difference is which representation the observation was built from, so
a policy is byte-identical across modes; in OLD mode the semantic field is
simply absent.

## Prerequisites

- Node 22 or newer and `npm ci`.
- A built server: `npm run build` (`dist/cli.js` must exist).
- A real Zen install (`node dist/cli.js doctor` should pass).
- Marionette port 2828 free, or set `ZEN_MCP_EVAL_MARIONETTE_PORT` (also
  accepts `ZEN_MCP_TEST_MARIONETTE_PORT`).
- `ZEN_MCP_E2E=1`. Without it the script prints a clear message and exits 2,
  like the integration suite.
- Set `ZEN_MCP_TEST_HEADFUL=1` to watch the run in a real window.

The harness starts its own fixture HTTP server on `127.0.0.1`, launches its
own headless Zen with a throwaway profile and data directory, and never
attaches to or reuses the user's browser.

## Run

```bash
ZEN_MCP_E2E=1 node scripts/agent-eval.mjs
ZEN_MCP_E2E=1 node scripts/agent-eval.mjs --json docs/context/bench-new.json
```

The compact table and the JSON summary always go to stdout. `--json <path>`
additionally writes the same summary to a file; it is opt-in and off by default.
Diagnostics and the artifact path go to stderr, keeping stdout parseable.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Ran, no NEW-mode regression detected |
| 1 | Ran, at least one NEW-mode regression versus OLD mode |
| 2 | Gate failed (no `ZEN_MCP_E2E=1`, no build, bad arguments, setup error) |

## Fixtures

One local server serves nine pages:

| Path | Contents |
| --- | --- |
| `/article` | Article nested sections, section nav, footer links, aside with a decoy `h1` |
| `/search` | Search control, repeated result cards, result count, pagination nav |
| `/products` | Three priced product cards, each with an identical "Add to cart" button |
| `/dashboard` | Two tables, nav, "Open incidents" stat |
| `/login` | Email/password form with a "Sign in" submit |
| `/docs` | Documentation headings and code blocks, including a fake heading inside `<pre>` |
| `/thread` | Repeated discussion articles and a modal dialog opened by a button |
| `/shadow` | Open shadow root with a rebuildable button, plus an iframe |
| `/frame` | Cross-document frame body used by `/shadow` |

Tabs open in the background in a job space. Setup calls (status, space create,
tab open, load waits) are not charged to any task.

## The nine tasks

Each task runs twice, OLD then NEW, against the same tab. The policy and the
expected facts are identical; only the read plan differs.

| Task | Page | Policy | Success facts |
| --- | --- | --- | --- |
| `article-main-heading` | article | Pick the main landmark heading; OLD takes the first `h1` in the outline | `heading` |
| `nav-sections` | article | Identify the navigation landmark and its link count | `nav`, `links` |
| `search-results-count` | search | Read the result total, count the result collection, identify pagination | `total`, `cards`, `pagination` |
| `product-add-to-cart` | products | Choose the Add to cart control for the Nimbus card and verify the click marker | `picked` |
| `dashboard-page-type` | dashboard | Read the incidents cell and the page classification | `incidents`, `type` |
| `login-form` | login | Detect email, password and submit, then the page classification | `password`, `email`, `submit` (primary); `type` (completeness) |
| `docs-heading` | docs | Find the real "Configure the bridge" heading, not the code-sample line | `heading`, `level` (primary); `type` (completeness) |
| `modal-dialog` | thread | Open the dialog, read its label and modal flag, count posts, close it | `dialog`, `modal` (primary); `posts` (completeness) |
| `stale-ref-recovery` | shadow | Rebuild the shadow widget, retry the stale ref, re-read and click, verify the marker | `stale`, `recovered` (primary); `saved` (completeness) |

Deterministic tie-breaks: the first candidate in document order. A tie is also
recorded as ambiguity, so the tie-break never hides a loss of information.

## Live result (2026-11-20)

One run per mode on Windows, Node v24.22.1, headless owned Zen, the fixture
server above, after the 0.6.0 runtime context optimization (compact JSON and
lean semantic regions). The full summary is in
`docs/context/agent-eval-0.6.0.json`.

| Metric | OLD | NEW |
| --- | ---: | ---: |
| Tasks successful (primary facts) | 2 / 9 | 8 / 9 |
| Tasks complete (all facts) | 1 / 9 | 8 / 9 |
| Tool calls | 19 | 19 |
| Context characters read | 22,558 | 33,345 |
| Ambiguous choices | 4 | 0 |
| Wrong selections | 2 | 1 |

NEW mode had no regression under the harness rules. The remaining NEW miss is
`article-main-heading`: the policy reads the `main` landmark's own `heading`
field, which is null because the heading belongs to a nested `<article>`
region, then falls back to the first `h1` in document order, which is an
`<aside>` decoy. Following `primaryRegion` into the nested article region
would pass. NEW still reads more characters than OLD because the semantic
model is a superset, but the optimization pass cut both: the earlier 0.6.0 run
measured 37,566 OLD and 67,544 NEW characters, and compact serialization with
lean regions brought them to 22,558 and 33,345 without changing completion or
tool calls. These are results for fixed policies, not a model benchmark.

## Metrics

Per task and per mode:

- **success**: every primary expected fact matches.
- **complete**: every expected fact, including completeness-only facts,
  matches.
- **toolCalls**: `zen_read_page`, `zen_click` and verification calls issued by
  the policy. Setup calls are excluded.
- **contextChars**: characters of the text content returned by those tool
  calls. This is the model-visible payload, not a token count.
- **ambiguous**: the policy saw more than one equally good candidate (or lost
  the landmark that resolves the choice).
- **wrongSelections**: a chosen candidate or clicked control that verification
  proved was the wrong one.
- **recovered**: for the stale-ref task, the stale attempt failed and the
  re-read retry succeeded.
- **ms**: wall time for the task in that mode.

Aggregates sum these across the nine tasks per mode and report the delta in
calls and characters.

A regression is reported, and the exit code becomes 1, when NEW mode:

- loses success or completeness that OLD mode had,
- makes more wrong selections than OLD mode,
- becomes ambiguous where OLD mode was not,
- or fails a recovery that OLD mode completed.

Higher character cost alone is reported, not treated as a defect: the semantic
payload is a superset and is expected to be larger.

## Limitations

- **No LLM, no statistical claim.** Policies are fixed functions written by
  hand. Results describe what these policies can extract from each
  representation, not how a particular model would perform. One run per mode;
  there is no variance estimate.
- **Policy quality is the ceiling.** A task can fail because the policy is
  naive, not because the representation is missing data. The policies are
  intentionally simple and inspectable.
- **Document-order assumption.** The product task maps a card index from the
  semantic collection to the same index among "Add to cart" controls. The
  click marker verifies the mapping, but the mapping itself is an assumption.
- **Flat link lists are not collections.** The semantic model exposes a
  navigation landmark's label and link count, not the labels of its flat
  `<a>` children. Nav and pagination facts are therefore landmark-level. A
  maintainer may want to extend collections to flat link lists.
- **Child frames are outside the semantic model.** The fixture page contains an
  iframe; the recovery task deliberately acts in the top document. Reading a
  frame still requires `framePath` in both modes.
- **Classification is a heuristic.** The semantic classification is asserted
  only on pages whose signals are unambiguous in this fixture set.
- **Platform.** The harness is written to run anywhere the integration suite
  runs, but results in this repository are only live-verified on Windows.
  macOS and Linux remain CI-only for live browser work.
- **Not in CI.** It needs a desktop browser, a fresh profile and a free port.
  Run it manually when touching reads, actions or the semantic model.
- **State carries over.** OLD runs before NEW on the same tab. Policies reset
  what they mutate (they close the dialog and verify markers), but a task that
  left the page mutated would affect the NEW run.
- **Not a benchmark artifact by default.** Writing
  `docs/context/bench-new.json` requires `--json`; no artifact is committed by
  the script.

## Cleanup

The harness closes the job space and its tabs, reads the browser pid, closes
the MCP client, waits for Zen to exit (and force-kills the owned process tree
if it does not), stops the fixture server and removes the temporary profile and
data directory. It never touches the user's normal Zen profile.

# Context budget benchmark

Reproduce with:

```sh
npm run build
npm run context:budget
npm run context:budget -- --compare docs/context/baseline-0.5.0.json
npm run context:check
```

The numbers come from a real stdio server, using the `tools/list` payload and
the initialize instructions a client receives. `docs/context/baseline-0.5.0.json`
is the pre-change 0.5.0 snapshot; `docs/context/current.json` is a sample after
snapshot. Character counts and tool counts are exact and are what the budget
gate uses, so CI stays deterministic.

Token counts are cl100k counts only when `js-tiktoken` resolves for that run.
Otherwise the scripts fall back to `characters / 4`, and every token value in
that run is an estimate, not a cl100k measurement. Each artifact records which
was used in a `tokenizer` field: `baseline-0.5.0.json` says
`js-tiktoken/cl100k_base`, and a freshly generated `current.json` records
`chars/4 fallback` when the package is absent.

## Before and after

| Surface | Tools | Tool definitions | Instructions | Combined | Tokens (method per row) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.5.0 full (baseline) | 53 | 88,399 | 7,453 | 95,852 | 21,807 (cl100k) |
| Research (default) | 17 | 34,491 | 1,145 | 35,636 | 8,916 (chars/4) |
| Core | 38 | 64,485 | 1,141 | 65,626 | 16,422 (chars/4) |
| Full | 55 | 80,959 | 1,141 | 82,100 | 20,547 (chars/4) |

- Character counts are exact in every row. The token columns use different
  methods, so compare characters, not tokens, across rows.
- Default reduction against 0.5.0 full: **-62.8% characters**
  (95,852 → 35,636 characters).
- Research has **17 tools**, inside the 16-19 target, and uses 34,491 of the
  35,200-character definition budget: 709 characters of headroom. No limit was
  raised for 0.6.0.
- Server instructions dropped from **7,453 to 1,145 characters** (-84.6%),
  below the 1,500-character budget.
- Tool descriptions dropped from **14,144 to 9,256 characters**; the ten
  descriptions whose first paragraph exceeded 400 characters are now zero.
- Output schemas across all tools are **40,908 characters**, below the 42,589
  in 0.5.0 even after adding two discovery tools, completing the action result
  contracts, and declaring the semantic region fields.
- Core is close to its 65,000-character cap (515 characters of headroom) and
  Research keeps 709 characters of headroom, so further growth needs a
  deliberate budget decision rather than a silent description change.
- Full remains 100% functional: all 53 original tools still register and are
  reachable, plus `zen_tools_search` and `zen_tools_use`.

The full surface is smaller than 0.5.0 despite two new tools because
descriptions and schemas were compressed. Core and Research are the surfaces
that matter for startup cost.

The largest definitions are `zen_read_page` (6,654), `zen_type` (4,103),
`zen_click` (3,711), `zen_wait_for` (3,091) and `zen_show_evidence_batch`
(2,946).

## Per-tool cost

`docs/context/current.json` records, for every tool: name length, description
length, first paragraph length, input schema size, output schema size, total
serialized definition size, and token estimate. The report prints the eight
largest definitions per surface.

## Budget gate

`docs/context/budget.json` pins:

- Research tool count (17) and the 16-19 range.
- Max definition characters for each surface. Research keeps 709 characters of
  headroom and core 515, so growth past those caps needs a deliberate update.
- Instructions at or below 1,500 characters.
- Description first paragraphs at or below 400 characters.
- Default reduction at or above 60% against the 0.5.0 full baseline.
- Required research tools and the `zen://capabilities` resource.
- A 55-tool manifest with a summary, category and surfaces per entry.
- Name-based discoverability for every tool in the manifest.

CI runs `npm run context:check` after the build on every matrix job. A new tool,
a longer description, a larger schema, a surface change or a missing manifest
entry fails the gate until the budget is deliberately updated.

## Live task benchmark

Run on 2026-11-20, with the new side refreshed on 2026-11-21 against the same
build that ships 0.6.0, using the same scripted client, local pages, a headless
owned Zen, and a throwaway profile:

- Old: commit `9ecaa3a` (0.5.0 surface), `toolSurface=full` by default.
- New: this working tree, default Research surface.

The harness (`scripts/benchmark-surfaces.mjs`) disables consent **only for the
benchmark**; the product default remains one approval card. It starts a local
HTTP server, launches headless Zen, runs the tasks in one space, records each
tool call's wall time and result size, then quits the browser. Its `tokens()`
helper uses `js-tiktoken`/cl100k when the package resolves and
`characters / 4` otherwise; newer artifacts record the choice in `tokenizer`.

| Metric | Old (53 tools) | New (17 tools) | Delta |
| --- | ---: | ---: | ---: |
| Initial context | 97,972 chars / 22,274 tok | 36,316 chars / 9,093 tok | **-62.9% chars** |
| Server startup | 803 ms | 792 ms | -11 ms |
| First launch (headless) | 3,835 ms | 3,411 ms | -424 ms |
| Tasks passed | 6 / 6 | 7 / 7 | +1 discovery task |
| Tool calls | 15 | 21 | +6 |
| Task wall time | 1,735 ms | 1,868 ms | +133 ms |
| Result payload | 13,562 chars / 4,621 tok | 19,789 chars / 4,954 tok | +45.9% chars |

Character columns are exact. The old run resolved a real encoder: 22,274
tokens is below what characters/4 would produce, so it is a cl100k measurement
even though the artifact predates the `tokenizer` field. The refreshed new run
recorded `chars/4 fallback`, so its token values are estimates. Compare
characters across runs, not tokens.

Per task (old → new, result characters are exact):

| Task | Old | New |
| --- | --- | --- |
| One page | 270 ms, 2 calls, 1,512 chars | 279 ms, 2 calls, 1,241 chars |
| Multi-source | 280 ms, 2 calls, 4,573 chars | 299 ms, 2 calls, 3,446 chars |
| Compare | 245 ms, 3 calls, 2,898 chars | 290 ms, 3 calls, 2,082 chars |
| Verify | 392 ms, 1 call, 485 chars | 413 ms, 1 call, 426 chars |
| Cleanup audit | 14 ms, 1 call, 875 chars | 19 ms, 2 calls, 1,358 chars |
| Interact | 534 ms, 6 calls, 3,219 chars | 542 ms, 9 calls, 9,420 chars |
| Discover and use | not available | 26 ms, 2 calls, 1,816 chars |

Reading the result:

- **Context**: the default surface removes 61,494 characters before the first
  task.
- **Time**: the common six tasks take 1,735 ms old vs 1,842 ms new (+6.2%),
  within the noise of a single run on a busy machine. The seven-task total is
  1,868 ms.
- **Calls**: the new surface needs four extra calls on the common tasks
  (cleanup +1, interaction +3) because `zen_tabs_audit`, `zen_type`,
  `zen_click` and `zen_wait_for` are discovered rather than listed. The
  discovery task itself is two calls.
- **Payload**: search-by-name returns the full input schema, and interactive
  reads carry refs and state. Common-task payload rises 32.5% in characters
  (13,562 → 17,973).
- **Net first-task cost** on the common six tasks: old 111,534 characters
  (97,972 initial + 13,562 payload) vs new 54,289 (36,316 + 17,973), a **51.3%
  reduction** even after the discovery payload.
- **Success**: all mechanical assertions passed; the new run also completed
  the discovery-and-publish task.

Limitations: one run per build, local pages (no network latency), headless, a
scripted agent rather than an LLM, and mechanical assertions rather than answer
quality. Treat wall times as indicative, not a benchmark suite. The script and
raw JSON (`docs/context/bench-old.json`, `bench-new.json`) are kept so the run
can be repeated.

### Reproduce

```sh
git worktree add --detach .tmp/bench-old 9ecaa3a
# make node_modules available in the worktree, then:
npm run build --prefix .tmp/bench-old
node scripts/benchmark-surfaces.mjs --label old \
  --server .tmp/bench-old/dist/cli.js --out docs/context/bench-old.json
npm run build
node scripts/benchmark-surfaces.mjs --label new --out docs/context/bench-new.json
```

Port 2828 must be free for each run. The harness quits the browser it started.


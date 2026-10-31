# Features that might be added but aren't sure

This is the parking lot for ideas that are useful to consider but are not
approved for implementation. Each item is tracked with the `needs-decision`
label on the repo, and none of them should be scheduled until the decision
criteria at the end of its section are answered.

Approved ideas live in GitHub issues #1 through #5 and the candidate ideas in
this document are issues #6 through #8. Everything is triaged on the
[Zen MCP Roadmap](https://github.com/users/spaxe-dev/projects/3) board:
approved work starts in **Backlog**, and every item in this document sits in
**Needs decision**.

| Candidate | Source idea | Proposed tool | New bridge operation | Read-only | Privacy risk | Size | Tracking |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Selection-aware reading | 5 | `zen_read_selection` | Fixed selection script | Yes | Medium | Small | [#6](https://github.com/spaxe-dev/zen-mcp/issues/6) |
| Agent-facing diagnostics | 6 | `zen_doctor` | None | Yes | Low to medium | Small to medium | [#7](https://github.com/spaxe-dev/zen-mcp/issues/7) |
| Screenshot capture | 6 | `zen_screenshot` | Fixed screenshot operation | Yes, behind a config gate | High | Large | [#8](https://github.com/spaxe-dev/zen-mcp/issues/8) |

## Selection-aware reading

Read the user's current text selection from the active tab so the agent can
explain or verify it without copy and paste.

### Why it is not approved

- The agent only sees the selection when it calls the tool. A user often
  selects text and immediately asks a question, so the selection may change or
  disappear before the call.
- Selection is personal context. Reading it automatically can feel invasive
  even when no page action occurs.
- Background tabs cannot provide the visible selection, so the tool only works
  on the active tab.
- The interaction may not feel seamless until agents can respond quickly enough
  to match the user's expectation.

### Tool mapping

- Recommended: a new read-only tool, `zen_read_selection`.
- Alternative: extend `zen_read_page` with `selection: true`. This keeps the
  tool count lower but makes the result shape conditional.
- No new Marionette command is required. A dedicated fixed script is clearer
  than overloading the full read script.

### Proposed behavior

- Parameters: `contextChars` (default 200, range 0 to 500) and optional `tabId`
  that must match the active tab.
- Return `{tabId, url, title, selectedText, length, contextBefore,
  contextAfter, empty}`.
- Use `window.getSelection()` in a fixed script. Do not read input values,
  textarea contents, or password fields. Return empty for privileged pages.
- Do not highlight, scroll, write, or change focus.
- Consider a server config `allowSelectionRead` default false, or a one-time
  consent setting consistent with the existing consent and pause model. Do not
  add a per-action approval card.

### Security

- Read-only, active tab only, `http(s)` only.
- Never return values from password, hidden, or form fields.
- Selection text may contain sensitive personal data. Do not log it in the
  audit log and do not persist it.
- A config gate or one-time consent is recommended.
- Page scripts cannot access the result, and the tool exposes no chrome
  controls.

### Costs and tradeoffs

**Pros**

- Natural "explain this" workflow.
- Avoids clipboard round trips.
- Small implementation.

**Cons**

- Timing: agents are not fast enough for the interaction to feel seamless.
- Selection can change or disappear before the call.
- Privacy concerns.
- Only works on the visible active tab.
- Adds a tool with narrow value.

**Implementation size:** Small

### Decision criteria

- [ ] Is the workflow fast enough in practice?
- [ ] Is a config gate or one-time consent acceptable?
- [ ] Does the value justify another tool?

### Open questions

- Should it return the selection's DOM context or only text?
- Should it work when the user selected text in a background tab that was
  previously active?
- Should it be part of a broader "current view" tool that also reports scroll
  position and active element?

## Agent-facing diagnostics

Add an agent-facing `zen_doctor` tool for bridge, Marionette, config, and launch
diagnostics.

### Why it is not approved

- `zen_status`, `zen_launch`, and detailed error messages already cover most
  recovery paths.
- Diagnostics can expose paths, versions, and environment details.
- The value is highest when the bridge is broken, which is exactly when the
  tool may not work.
- The CLI already has `zen-mcp doctor`. Adding a second diagnostic surface
  could duplicate maintenance.

### Tool mapping

- Recommended: a new read-only tool, `zen_doctor`.
- Alternative: extend `zen_status` with `diagnostics: true`. This keeps the
  tool count lower but makes status heavier.
- Reuse or extract the existing CLI doctor code into a shared diagnostics
  module. No new bridge operation is required.

### Proposed behavior

- Return structured checks:
  - Config file present and valid.
  - Zen executable found.
  - Profile lock status.
  - Marionette listening.
  - Marionette session connected.
  - Bridge injected in each window.
  - Bridge version matches the server version.
  - Pending requests and recent failures.
  - Effective policy summary.
- Each check returns `{name, ok, detail, fix}`.
- Never return raw tokens, cookies, URLs with credentials, or profile
  contents. Redact the bridge token. Decide whether to include the Marionette
  port, which is already documented as 2828, or only a boolean.
- Provide suggested next actions such as "run `zen_launch`" or "quit the other
  Zen instance".
- Reuse the CLI doctor implementation instead of duplicating logic.

### Security

- Redact tokens and secrets.
- Do not expose Marionette authentication material.
- Do not read page content.
- Do not launch or kill processes outside the existing launch path.
- Audit the call.

### Costs and tradeoffs

**Pros**

- Faster self-recovery.
- Fewer "run doctor" handoffs to the user.
- Reuses existing CLI logic.

**Cons**

- Mostly duplicates `zen_status` and `zen_launch`.
- Environment details may be sensitive.
- Diagnostics can be stale or wrong while the bridge is down.
- Adds maintenance.

**Implementation size:** Small to Medium

### Decision criteria

- [ ] Are existing errors insufficient?
- [ ] Is redaction sufficient?
- [ ] Would an agent use this instead of `zen_launch`?

### Open questions

- Should the tool only report checks, or also attempt safe repairs?
- Should it be hidden unless the user asks?

## Screenshot capture

Capture a screenshot of a tab so the agent can inspect charts, maps, images,
and visual UI states.

### Why it is not approved

- The harness is text-first and currently returns JSON text only.
- Screenshots can capture sensitive personal data.
- Image payloads can be large in both bytes and model tokens.
- Visual pages are sometimes the only way to understand a chart, map, or UI
  state, so the value is real but the risk is higher than other items.

### Tool mapping

- Recommended: a new read-only tool, `zen_screenshot` or `zen_capture_tab`.
- Proposed parameters:
  - `tabId`: required.
  - `format`: `png` or `jpeg`, default `png`.
  - `fullPage`: optional, default false.
  - `maxWidth`: optional, default 1600, hard cap 2560.
  - `quality`: optional for JPEG, default 80.
- Capture only the tab's content area, not browser chrome or other windows.
- Delivery options:
  - MCP image content block. Most useful, but changes the response path and
    may exceed message limits.
  - Save to the data directory and return a file path. Simpler, but the agent
    may not be able to view it.
  - Recommendation: image content with a hard byte cap, and a saved-file
    fallback when the image is too large.
- Skip privileged pages, PDFs, and non-`http(s)` content.
- Add a config flag `allowScreenshots` default false, or a one-time consent
  setting consistent with the existing consent and pause model.
- No click, scroll, or page action follows from a screenshot.

### Security

- Screenshots can include passwords, private messages, and personal data.
- Use a default-off config gate, explicit user awareness, and an audit entry.
- Never capture browser chrome or other windows.
- Cap resolution, bytes, and frequency.
- Do not persist unless the user opts in. If saving, use a private temporary
  directory and document cleanup.
- Read-only mode should still require the screenshot config gate.
- No page script can request or read the screenshot.

### Costs and tradeoffs

**Pros**

- Useful for charts, maps, images, visual UI, and pages where text extraction
  fails.
- Helps verify visual claims.

**Cons**

- High privacy risk.
- Large payloads and token cost.
- Requires MCP image content or file handling.
- Cross-origin content and some visual layers may be missing.
- More complex tests and platform differences.

**Implementation size:** Large

### Decision criteria

- [ ] Is visual verification a required use case?
- [ ] Is a default-off gate acceptable?
- [ ] Which delivery method: image content or file path?
- [ ] What are the maximum resolution and byte size?

### Open questions

- Should the tool capture the viewport or the full page by default?
- Should it redact form fields or password inputs, and how?
- Should evidence cards ever include a screenshot?

## Approved elsewhere

These ideas are approved and tracked in GitHub issues:

- [#1](https://github.com/spaxe-dev/zen-mcp/issues/1): background evidence
  verification by default.
- [#2](https://github.com/spaxe-dev/zen-mcp/issues/2): batch evidence
  verification.
- [#3](https://github.com/spaxe-dev/zen-mcp/issues/3): find text in a tab and
  across open tabs.
- [#4](https://github.com/spaxe-dev/zen-mcp/issues/4): offset and `nextOffset`
  for long reads.
- [#5](https://github.com/spaxe-dev/zen-mcp/issues/5): evidence context and
  card actions.

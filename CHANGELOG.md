# Changelog

All notable changes to Zen MCP are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A capability policy at `policy.json` with four cumulative modes
  (`restricted`, `normal`, `permissive`, `full`), explicit per-capability
  allow/deny overrides, deny-only permanent restrictions and website
  allow/block/rule entries. Evaluation is deterministic and deny-first:
  invalid policy, unknown capability, permanent deny, restriction, explicit
  deny and website blocks all win over a later allow. Downloads, internal
  pages, cookies, passwords, settings, extensions, browsing data, profile
  files, DevTools, uploads, software install and screenshots are permanently
  denied, including in `full` mode. Tab close, page clicks and typing, and
  questions are available from `normal`; evidence, history, bookmarks,
  clipboard writes, space delete and session and template writes start at
  `permissive`.
- `zen-mcp policy show [--json]`, `zen-mcp policy set <capability> allow|deny`,
  `zen-mcp policy mode <mode>` and `zen-mcp policy init`. The CLI shares strict
  schema and semantic validation, revision-conflict checks, a stale-lock
  takeover and the atomic owner-only writer. No MCP tool or bridge operation
  can write policy.
- `policy init` migrates `readOnly` to deny-only restrictions and
  `allowedDomains` to a website default deny plus the normalized allow list,
  without granting access. A missing policy runs `restricted`; an invalid
  policy fails closed. Legacy `readOnly` and `allowedDomains` keep working in
  memory only while no policy file exists.
- `zen_config` reports the policy source, mode, revision, website summary and
  restricted capability names under a `<config>/policy.json` placeholder.
  Audit entries record `capability`, `mode`, `policyRevision` and
  `policySource`.
- The browser bridge now enforces the same policy independently of the MCP
  server. It re-reads `policy.json`, rejects work that does not carry the
  current revision and digest, resolves the actual tab and frame URLs for
  reads, clicks, typing, waits and evidence, rechecks them after actions and
  redirects, and hides or skips metadata and stored session and template URLs
  that the policy would not open.

### Security

- Bridge operations fail closed when the policy file disappears, cannot be
  read, is invalid, or changes to a lower or rewritten revision. Site checks
  always use browser-owned URLs, including cross-origin frame URLs, and a
  preview or opened tab that redirects to a blocked host is closed.
- Bridge dispatch now accepts only own properties of the fixed operation map.
  Inherited names such as `constructor`, `__proto__`, `prototype`, `toString`,
  `valueOf` and `hasOwnProperty` are rejected as unknown methods instead of
  resolving through the prototype chain.
- The bridge authentication key is no longer placed on
  `window.__zenMcpBridge`. The global exposes only the version, a non-secret
  `tokenId` digest, the window id and the reconnect/destroy callbacks; the key
  stays inside the bridge closure, so the mutual HMAC handshake and reconnect
  behaviour are unchanged.
- Tool calls rejected by input schema validation are now audited as
  `invalid_args` with `ok: false` and `executed: false`, including calls routed
  through `zen_tools_use`. Arguments keep the existing sensitive-field
  redaction, and the error message does not echo received values.
- Agent-facing tool and resource output now returns `<profile>`, `<data>` and
  `<data>/audit.jsonl` placeholders instead of absolute profile, data directory
  and audit log paths. `zen-mcp status` and `zen-mcp doctor` still show the real
  paths to the operator.

### Fixed

- Corrected the documented version drift in `docs/handoff/surface.md` and
  `AGENTS.md`, which still described 0.6.0 while the package and registry are
  at 0.6.3.

## [0.6.3] - 2026-11-22

### Fixed

- The install-time skill offer now appears on Windows during
  `npm install -g @spaxe-dev/zen-mcp`. Node cannot open `\\.\CONIN$` or
  `\\.\CONOUT$` because libuv resolves those names as relative file paths, so
  the 0.6.2 attempt silently skipped itself. The Windows offer now asks
  through a short generated cmd script that reads and writes the console the
  install was started from. The installer runs with captured output that is
  replayed to that console, because cmd stores raw CR/LF bytes when a nested
  batch inherits a redirected console handle. The 30-second answer timeout,
  CI skip, `ZEN_MCP_NO_SKILL_PROMPT=1` and the one-offer-per-process guard are
  unchanged. POSIX still uses `/dev/tty`.
- On macOS and Linux, a completed install-time offer crashed the postinstall
  with `EBADF` and could leave the process alive: closing the terminal streams
  closed their descriptors first, and an async read stuck on a console that
  never sent input could not be cancelled by closing it. The offer now reads
  the terminal synchronously with a nonblocking descriptor, writes straight to
  it, and closes it best effort, so `npm install` exits 0 after asking,
  declining or timing out.
- The skill offer now asks for `--global --yes`. The previous command let the
  skills CLI prompt for install scope and target agents, which could stall the
  Windows installer's non-interactive child, and its default project scope
  pointed at the package directory inside `node_modules`. Global scope installs
  where the user's agents look, and `--yes` keeps the CLI from asking again.
- The skill installer now drops `npm_config_global` before spawning `npx`. npm
  exports that variable into lifecycle scripts during `npm install -g`, and an
  `npx` that inherits it with a cold cache skips the temporary install's bin
  directory, fails with `sh: skills: command not found` and reports "Skill
  install failed (exit 127)". The rest of the environment is inherited
  unchanged.

## [0.6.2] - 2026-11-22

### Fixed

- The skill offer now appears during `npm install -g @spaxe-dev/zen-mcp`.
  npm runs lifecycle scripts without a TTY on stdin/stdout and buffers their
  output, so the 0.6.1 offer silently skipped itself. The install script now
  opens the controlling terminal directly (`CONIN$`/`CONOUT$` on Windows,
  `/dev/tty` on POSIX), asks there, and times out after 30 seconds so an
  unattended install cannot hang. CI and `ZEN_MCP_NO_SKILL_PROMPT=1` still skip
  the offer.

## [0.6.1] - 2026-11-22

### Added

- A consumer skill offer on the install and setup paths. A fresh `npm install`,
  `zen-mcp setup`, `zen-mcp onboard`, and a successful `zen-mcp update` now ask
  whether to install the `zen-mcp` agent skill. Answering yes runs
  `npx skills add spaxe-dev/zen-mcp --skill zen-mcp`; answering no prints that
  command so it can be run later. The browser banner's Update button reports
  the command in its result instead of prompting in a terminal. CI,
  non-interactive sessions and `ZEN_MCP_NO_SKILL_PROMPT=1` skip the offer, and
  a declined or failed skill install never fails the surrounding command.

### Fixed

- The README's test counts now match the current suite: eight skipped unit
  tests and 61 live integration declarations.

## [0.6.0] - 2026-11-20

### Added

- Configurable tool surfaces. The default `research` surface exposes 17 tools
  for orienting, background research, reads, evidence and handover. `core`
  exposes 38 and `full` exposes all 55. The new `toolSurface` key and
  `ZEN_MCP_TOOL_SURFACE` environment variable choose one at startup.
- A discovery gateway: `zen_tools_search` finds any capability by keyword,
  category or name and returns its input schema, and `zen_tools_use` invokes a
  tool outside the active surface with the same validation, read-only,
  allowlist, pause and audit behavior. `publish: true` adds it to `tools/list`.
  The `zen://capabilities` resource is the complete machine-readable catalogue.
- Context measurement and gates: `npm run context:budget` reports per-tool and
  per-surface cost, `npm run context:check` enforces the 17-tool default,
  the 1,500-character instruction budget, 400-character descriptions and
  surface growth limits in CI.
- A consumer agent skill in `skills/zen-mcp/`, installable with
  `npx skills add spaxe-dev/zen-mcp`. It teaches a connected agent the
  background-first workflow, the space/folder/tab/ref/evidence model, targeted
  reads, evidence verification, tab etiquette, and recovery. `SKILL.md` stays
  under 2,000 tokens and links to seven references plus an evaluation set.
- `docs/agent-skill.md` covers installation, updates, supported clients, and
  limitations. `npm run check:skill` validates the skill against the live tool
  surface: tool and prompt names, example arguments, enum values, links, the
  token budget, and a denylist of parked capabilities.
- `zen_read_page` accepts `format: "snapshot"`: a bounded view with up to 100
  controls (200 via `maxElements`), 80 outline headings, a 4,000-character text
  preview, and a control ref for each element. Controls report `valuePresent`,
  `autocomplete`, `selected` and `form` where that state exists, never a value
  or length.
  `snapshotId`, `elementsTotal`, `snapshotComplete`, `framesComplete`,
  `textTruncated`, `elementsTruncated`, `outlineTruncated` and a bounded
  `limitations` list separate collection completeness from output truncation.
- Element refs are now held in a bounded server-side registry keyed by tab and
  frame path and backed by Marionette WebElements. A ref resolves to the same
  DOM node, is rejected with `element_not_found` after the node is removed,
  replaced or navigated, and a new read replaces the refs of the document it
  read. Reads no longer write attributes into the page.
- `zen_click` and `zen_type` accept a semantic `target` object: one of a ref,
  role+name, text, label, placeholder or selector, with exact or contains
  matching where it applies. One shared resolver searches the document and open
  shadow roots, refuses ambiguity with up to five candidates instead of picking
  the first, and re-validates the element's document, visibility and actionability
  immediately before input. Failures use `invalid_target`, `stale_reference`,
  `document_changed`, `target_not_found`, `target_ambiguous`,
  `target_not_actionable` or `unsupported_operation`.
- Click and type failures now carry structured details in
  `structuredContent.error`: `category`, `retryable`, `stateChanged`,
  `recovery` and bounded `details`. The legacy top-level `ref`/`selector`
  shortcuts keep their existing codes. No other tool advertises an error
  variant, so its structured output is unchanged.
- Action effects now include `navigation`, `documentReplaced`, `readyState`,
  `attribution: "observed_after_action_not_proven"` and a bounded `delta` of
  added, removed or state-changed controls (10 each), headings and alerts
  (5 each), and text length. A replaced document is not diffed across pages.
- `zen_type` reports `observed: { compared, matchesInput, sensitive }` after
  typing. It never returns the value or its length, and sensitive fields are
  not read back.
- `zen_read_page` accepts `format: "semantic"`: a deterministic, agent-readable
  model of the top document with landmarks, heading hierarchy, sections,
  repeated collections, forms and controls, tables, dialogs and a
  confidence-labelled classification (`article`, `search-results`, `product`,
  `listing`, `dashboard`, `login`, `form`, `documentation`, `discussion` or
  `generic`). Regions carry stable refs shared with snapshot and interactive
  reads, and `coverage` plus bounded `limitations` distinguish a complete model
  from a truncated one. Field values and hidden text are never included, and
  every label records whether it was observed or inferred.
- `zen_events` now reports browser observations alongside control events:
  tab opened, closed and selected; navigation started, committed, completed,
  redirected, failed and same-document; document replacement; and dialog shown
  and hidden. Each event carries an id, timestamp, tab or document identity and
  a source. The buffer caps at 200 events, browser kinds expire after 10
  minutes, repeats are deduplicated for 2 seconds, and `missed`, `dropped` and
  `filtered` count events the cursor can no longer read or the policy refused.
- `zen_wait_for` adds four conditions: `document` (identity unchanged or
  changed against a supplied baseline), `newTab`, `tabClosed` and `dialog`.
  Selector waits accept `state: "visible"` or `"enabled"`, `until: "absent"`
  works for text, URL and title as well as selectors, and the result reports
  the current `documentId`, `newTabId` or `limitation`.

### Changed

- Page reads return compact JSON instead of indented JSON, which cuts delivered
  context by roughly half without changing the data. Snapshot and semantic
  controls omit state that carries no information: `value` (never returned in
  those formats), a false `valuePresent`, and null `autocomplete`, `selected`
  or `form`. Semantic regions omit `label` when it equals `heading`, zero
  counts and absent relation fields. Semantic reads also drop the duplicate
  top-level `outline` (headings stay in `semantic.headings`) and report the
  child-frame caveat only when a child frame exists.
- Pause now hides buffered browser observations from `zen_events` as well as
  suppressing new ones, so a transition that happened before the pause is not
  served afterwards. Control events still arrive.
- Dialog observation skips private windows, matching the best-effort privacy
  rule for private browsing.
- `urlContains` arguments are redacted in the audit log like `url`, so a
  credential or token embedded in a wait query is not persisted.
- Wait results only return the final title, URL and frame URL when they still
  match the domain allowlist, and a wait stops probing when the tab closes or
  navigates off-list.
- `zen_click` and `zen_type` accept refs from snapshot or interactive reads.
- The sensitive-field classifier now covers password, file, email, telephone,
  payment, one-time-code, verification-code and account-like fields. The
  interactive format omits values for those fields, and snapshot reads omit
  every value. The legacy interactive format still returns values for fields
  it does not classify as sensitive.
- Existing `element_not_found` responses are preserved for ref and selector
  misses, including stale refs, with unchanged error codes.

### Fixed

- Click and type structured output declares `title`, which the runtime already
  returned, and now validates it as a required success field.
- The action output schemas now describe what the runtime already returned:
  the resolved `target`, the full `effect` (including `navigation`,
  `documentReplaced`, `readyState` and `attribution`), a typed `delta` instead
  of an untyped record, `framePath`/`frameUrl` for frame actions, and the
  structured `error` with `recovery` and bounded `details`. Declared fields are
  advisory, so existing payloads stay valid.
- The semantic-target input no longer repeats each field's name in a
  per-field description; the parent description lists the strategies, which
  keeps click and type inside the core context budget.
- Wait enums for conditions, element states and `until` are defined once and
  shared by the calculator, server schema and structured-output schema.
- `document_changed` and `document_id` waits no longer resolve to a
  navigation's initial about:blank placeholder. During a cross-process
  navigation the placeholder briefly held an identity and was replaced moments
  later, so a wait could match it and a follow-up wait for that identity could
  never match. The placeholder now reports no identity, and the wait resolves
  on the committed document.
- Semantic page regions now declare `labelSource` and `itemKind`, which the
  runtime already returned, with their exact values.

## [0.5.0] - 2026-11-10

### Added

- `zen_read_page` accepts `format: "interactive"`. It returns up to 200 visible
  controls with short refs, including labels, roles, input types, current
  values, and state flags. The scan covers form controls, common ARIA controls,
  contenteditable regions, and controls inside open shadow roots.
- `zen_click` clicks one control by interactive ref or CSS selector, and
  `zen_type` types into one field, optionally replacing the current value.
  Both resolve the target with fixed server scripts and use Marionette's native
  input commands, so the agent still cannot supply JavaScript. Read-only mode
  blocks both tools, the domain allowlist checks the tab URL and link target,
  password values are never read back, file inputs are refused, and refs expire
  after another interactive read or a navigation.
- Frame support for reads and actions. `zen_read_page` takes `framePath`, an
  array of child frame indexes such as `[0]` or `[0,1]`, and every read lists
  reachable `http(s)` frames with their paths and URLs. Top-level interactive
  reads merge controls from child frames with prefixed refs such as `f0-e3` and
  `f0.1-e2`; `zen_click` and `zen_type` resolve those refs in the right frame.
  Frame URLs are checked against the domain allowlist, and off-list or
  non-`http(s)` frames are never listed, read, or driven.
- `zen_wait_for` polls one tab or frame until exactly one condition holds: a
  selector is present or absent, text appears, the URL contains a string, or
  the title contains a string. Timeout and poll interval are configurable, a
  timeout returns `matched: false` instead of an error, and the probe is a
  fixed server script that never reads page text back. Read-only mode allows
  it.
- `zen_click` and `zen_type` results now include `effect`: a fixed signature
  taken before the action and polled for up to 1.2 seconds afterwards reports
  whether the URL, title, rendered text, element count, or non-password form
  values changed. When the document cannot be signed, `probeFailed` is set
  instead of failing the action.
- `zen-mcp update` checks the npm registry, compares the latest release with
  the installed version, and, when a newer one exists, runs the matching
  global install command for npm, pnpm, yarn, or bun. `--check` reports the
  versions without installing, and `--manager` overrides detection. `doctor`
  prints the same status as an advisory `Update` line.
- The MCP server checks npm once at startup and offers a newer release in the
  browser banner. The first discovery prompts with **Update** and dismiss;
  dismissing leaves a small icon that reopens the prompt, and the prompt is
  remembered per release so later sessions only show the icon. **Update** runs
  the global install from the authenticated banner and reports the result
  there. No MCP tool can install software, and `ZEN_MCP_NO_UPDATE_CHECK`
  disables the check.

## [0.4.0] - 2026-11-08

### Added

- `zen-mcp onboard` now covers 28 MCP clients. Alongside the original nine it
  knows OpenCode, oh-my-pi (OMP), DeepSeek Harness (DSH), ZCode (Z.ai), Roo
  Code, Kilo Code, Continue, Amp, Crush, Qwen Code, Kiro, Warp, Copilot CLI,
  Factory Droid, Amazon Q, Goose, LM Studio, Junie and Pi.
- The client list scrolls inside a fixed pane, with `up N more` and
  `down N more` markers and Page Up, Page Down, Home and End keys. The header
  and the selection footer stay in place while the rows move.
- Writers for the formats those clients use: nested JSON keys such as
  `mcp.servers` and `amp.mcpServers`, JSONC with comments and trailing commas,
  TOML tables, YAML (the DSH patch file, Continue's list and Goose's
  `extensions` mapping) and shell rc files (Crush). Each writer creates or
  replaces only the `zen-mcp` entry and leaves every other entry alone.
- The Other client runbook describes each of these config paths and entry
  shapes.

## [0.3.3] - 2026-11-02

### Added

- `zen-mcp onboard` lists common MCP clients, preselects the ones found on
  this machine, and merges a `zen-mcp` stdio server into each selected
  client's configuration. Existing servers, JSONC comments, trailing commas,
  and TOML tables are left alone, and rerunning updates the entry instead of
  duplicating it. An **Other MCP client** option prints a paste-ready prompt
  for clients the picker does not know.

### Fixed

- Glance validates the selected tab's current URL as `http(s)`, enforces the
  domain allowlist before the preview loads, and uses a content principal for
  the URL instead of the system principal. It also checks the URL the preview
  actually committed and closes the preview when a redirect leaves the
  allowlist.
- Malformed safety settings in the config file or safety environment variables
  stop startup with a clear error instead of falling back to a weaker policy.
  That includes `autoLaunch` and `autoAttachWindows`, which no longer fall back
  to `true` when the value is malformed.
- Read-only mode also blocks `zen_progress`, `zen_ask`, and `zen_notify`, so an
  agent cannot draw or change cards while the server is read-only.
- `zen_tabs_close`, `zen_folder_create`, and `zen_folder_add_tabs` cap their
  tab id lists at 100 per call.
- Launch ownership is read through the chrome sandbox globals with a component
  service fallback, so Zen 1.24b can start and an unavailable chrome scope
  produces a clear error instead of bare `moz-nullprincipal` frames. (#15)
- POSIX process detection covers the real Zen process names and reports
  platform status correctly. (#15)
- Foreground tab selection activates the requested tab and reports the
  observed focus state instead of a false success. (#16)
- Show source repaints the evidence overlay and scrolls the quoted passage
  back into view after the first highlight expires. (#17)
- Adding and removing an essential restores the tab's original space and
  pinned state. (#18)
- Closing a split view verifies the split is gone and closes only clearly
  synthetic leftovers. (#19)
- Evidence scoring checks surrounding context before the occurrence cap, so a
  repeated word can still be disambiguated. (#20)
- Quotes that are definitely absent return `QUOTE_NOT_FOUND` instead of
  `LOW_MATCH_CONFIDENCE`. (#21)
- Batch evidence records the real citation outcomes in the audit log instead
  of reporting a partial failure as clean. (#22)
- A Stop press from the progress card produces a stop event, changes the
  button to "Stopping...", and is re-sent after a bridge reconnect. (#23)
- Concurrent evidence work on one tab is serialized, so verification and
  clearing cannot leave an overlay host behind.
- Consent decline guidance now says to restart the server, and batch evidence
  uses the documented 20-second highlight default.
- Sandbox script errors report the error name and message before the stack.

## [0.3.2] - 2026-11-01

### Fixed

- The CLI and MCP server report the package version again. The advertised
  version stayed at 0.3.0 after the previous bump, and a unit test now keeps
  the two in sync.

## [0.3.1] - 2026-11-01

### Changed

- Releases are published with OIDC trusted publishing. The release workflow
  stores no npm token, restores no dependency cache, and publishes with
  provenance.

## [0.3.0]

### Added

- An owned browser model. Zen MCP launches its own Zen window, proves with a
  per-launch identity that the browser on the Marionette port is the one it
  started, then closes every other connection and the port itself. After
  startup, no other local process can open a Marionette session, and the
  browser is quit when the server stops.
- One-time consent before the first read or change, shown as a card inside
  Zen. Declining closes the browser. A global Pause button in the banner
  blocks every read and change immediately, and Resume restores access.
- A dedicated agent profile as the default, with an explicit opt-in to use
  your normal profile when the agent should see signed-in pages.
- Background research spaces and folders, including creating a space without
  switching to it and grouping existing tabs into folders.
- Page reading in several formats: text, Markdown, links, tables, metadata,
  and outline, plus CSS selectors, PDF reads through the Zen viewer, and
  `offset` / `nextOffset` paging for long text.
- Evidence Mode with `zen_show_evidence`, `zen_show_evidence_batch`, and
  `zen_clear_evidence`: sources are reused or opened in the background, the
  cited passage is located, scrolled to, and marked without changing page
  content, and each citation reports its own result.
- Session snapshots and space templates for repeatable research layouts.
- Progress cards with a working Stop button, question cards answered inside
  Zen, and watches for text changes and selectors that appear or disappear.
- Cross-platform launch handling for Windows installs, macOS app bundles,
  and Linux distro, Flatpak, and Snap package layouts.

### Changed

- Node.js 22 is now the minimum supported version, and CI covers Node 22 and
  24. Node 20 reached end-of-life and is no longer tested or targeted.

### Security

- Bridge reconnects now require mutual authentication, with a fresh challenge
  for every connection, so a reconnecting bridge cannot be impersonated.
- Consent is enforced at the bridge boundary, not only in the agent-facing
  tool layer.
- One URL policy normalizes and checks addresses for opening, previewing,
  evidence, sessions, and templates.
- Reads are limited to normal `http(s)` pages and private windows are never
  attached or read.
- Evidence results are hardened: only fixed server-built scripts run, marks
  are inert overlays, and failed matches never highlight a different passage.
- Audit logging and on-disk persistence are hardened: URLs are reduced to
  scheme, host, and path, long or sensitive values become digests, files are
  owner-only and written atomically, and symlinks are never followed.
- Read-only mode now covers the complete mutating tool set, including watch,
  session, template, and evidence operations.

## Earlier versions

Changes for 0.1.0 and 0.2.0 are not recorded here. See the release notes on
GitHub.

[0.6.3]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.6.3
[0.6.2]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.6.2
[0.6.1]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.6.1
[0.6.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.6.0
[0.5.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.4.0
[0.3.3]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.3
[0.3.2]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.2
[0.3.1]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.0

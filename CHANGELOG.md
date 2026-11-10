# Changelog

All notable changes to Zen MCP are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.4.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.4.0
[0.3.3]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.3
[0.3.2]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.2
[0.3.1]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.0

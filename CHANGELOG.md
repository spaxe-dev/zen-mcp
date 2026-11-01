# Changelog

All notable changes to Zen MCP are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/spaxe-dev/zen-mcp/releases/tag/v0.3.0

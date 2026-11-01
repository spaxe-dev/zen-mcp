# Architecture

Zen MCP has three layers: a launcher and control plane, an injected browser bridge, and the MCP surface. The design goal is to control a real Zen window without attaching to one the user already has open.

```text
MCP client (Claude Code, Cursor, ...)
        │ stdio, JSON-RPC
        ▼
zen-mcp server ──── Marionette (127.0.0.1:2828) ──── Zen chrome scope
        │                                                   launch, inject,
        │ WebSocket on 127.0.0.1, random token              background reads
        ▼
bridge inside each normal Zen window (system principal)
        │
        ▼
gZenWorkspaces · gZenFolders · gBrowser · Places · UI cards
```

## Layers

### 1. Launch and control plane

The server spawns Zen with `-marionette`, `-no-remote`, the agent profile, and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in that child's environment only. No Zen preference is changed, so a normal Zen launch never opens a debug port.

Each launch carries a random nonce in `ZEN_MCP_LAUNCH_NONCE`. The server connects to Marionette, reads the nonce back through `Services.env` in chrome scope, and compares it. Only after that check does it record Gecko's real `moz:processID`. If the nonce does not match, the server does not attach and does not record the answering browser's pid; it shuts down only the process it spawned.

After identity is proven, the server closes every other Marionette connection and calls `setAcceptConnections(false)`. From that point the port refuses new connections. If the listener cannot be closed, startup fails and the owned browser is shut instead of continuing without the boundary.

Chrome-scope scripts are fixed server code for setup, diagnostics, and the content-actor read path. Agents cannot submit arbitrary scripts.

### 2. Browser bridge

A small bundle is injected into each normal browser window. It owns the tab-id mapping, talks to Zen's internal space and folder APIs, and renders the UI cards in a shadow root in browser chrome. It connects out to the server over loopback with a token, so the browser opens no listening port of its own.

Every connection, including a reconnect, completes a mutual HMAC-SHA256 challenge with a fresh nonce before any request is accepted. The key is generated for the server session and passed into chrome only during injection. Protocol and bridge versions must match. Non-loopback connections are rejected.

The bridge exposes a fixed method map. It does not accept scripts from the agent.

### 3. MCP surface

Tools validate input, map to bridge operations, and wrap errors with actionable messages. Server instructions carry workflow guidance. Sessions, templates, watches, and the audit log are managed by the server; sessions, templates, and the audit log persist to the data directory.

Every tool declares an `outputSchema`; successful calls return `structuredContent` plus the same JSON in a text block. Resources expose live state as JSON. Prompts package common workflows. See [tools.md](tools.md).

## Lifecycle

1. **Start.** The MCP server starts on stdio. No browser is launched until a tool needs one and `autoLaunch` is true.
2. **Launch or reject.** If the Marionette port is already open, the server refuses to attach. If the normal profile is selected and Zen is already running, it refuses before spawning. Otherwise it launches an owned browser with the dedicated agent profile.
3. **Verify and lock down.** The nonce and `moz:processID` prove ownership, then every other Marionette connection and the listener are closed.
4. **Inject.** The bridge is injected into normal windows. Private windows are skipped, and an existing bridge in a private window is destroyed.
5. **Consent.** With `requireConsent` on, one card asks for approval. Approval is stored for the life of the server process, so relaunching the browser does not ask again. A decline closes the owned browser and leaves the server unapproved until it restarts. A timeout leaves the card open.
6. **Run.** Tools call the bridge. Pause blocks browser work and hides the progress card; local tools remain available.
7. **Shut down.** `stop`, `SIGINT`, `SIGTERM`, and a closed stdio transport trigger shutdown. The server tries a graceful Marionette quit, then a forced quit, then terminates the recorded browser process. It only targets the process it launched. A crash or `SIGKILL` does not run this path, so the browser can remain open.

A lost Marionette session cannot be re-attached because the listener stays shut. Quit the browser and call `zen_launch` to start a new owned browser.

## Why native APIs

Space and folder operations use Zen's own JS APIs (`gZenWorkspaces`, `gZenFolders`) rather than UI automation, so they behave like native actions. Page reads go through the browser's content actor, which can reach a loaded tab in a background space without selecting it. The tradeoff is coupling to Zen internals: a future Zen release can change them, and the server will fail with an error naming the failing call rather than silently doing something else.

## State and storage

| State | Location | Survives restart |
| --- | --- | --- |
| Config | Config file | Yes |
| Sessions | `<data>/sessions.json` | Yes |
| Templates | `<data>/templates.json` | Yes |
| Audit log | `<data>/audit.jsonl` and `.1` | Yes |
| Default agent profile | `<data>/agent-profile/` | Yes |
| Consent, pause, watches, evidence tracking, tab mapping | Server or bridge memory | No |

Sessions and templates are sanitized and capped before use. They are written atomically with owner-only permissions, and a symlink at the target is refused rather than followed. The audit log is owner-only where the platform supports POSIX modes and rotates at 5 MB with one backup.

## Boundaries

The trust model is described in [security.md](security.md). The short version:

- Page content is untrusted data. It cannot grant capabilities or cause the server to run its text as instructions.
- The model can send only tool names and structured arguments. Every browser operation is fixed server code.
- The bridge authenticates both sides over loopback and never listens for inbound connections.
- Consent and Pause are enforced at the bridge request boundary, not only in the MCP tool layer.
- Read-only mode, the domain allowlist, and the audit log are enforced by the MCP guard. Resource reads bypass that guard by design.

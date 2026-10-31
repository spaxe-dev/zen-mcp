# Zen Sidekick

An agent harness for [Zen Browser](https://zen-browser.app). Zen Sidekick gives an
MCP agent hands-on control of a real Zen window: native spaces, folders, tabs,
history, bookmarks, page reading, and questions that the user answers inside the
browser.

The point is that agents work *around* the user instead of taking over their
screen. A research job can open twenty tabs in a new space while the user keeps
reading, ask a clarifying question in a small corner card, and finish with a
notification that jumps straight to the results.

## What that looks like

> "Make a GitHub space and find all the PRs assigned to me that I haven't replied to."

The agent:

1. creates a `GitHub` space without switching to it,
2. searches history and bookmarks for the user's repositories,
3. opens the PR list and each PR in the background (Zen stays on the current page),
4. reads every tab through the agent bridge, without selecting anything,
5. answers in the chat, then shows a card: **"4 PRs need a reply" — Open GitHub**.

One click takes the user to the space with all the work already laid out.

## Requirements

- Node.js 20 or newer.
- Zen Browser. Developed and tested against Zen 1.24b on Windows; the mechanisms
  are Firefox-based and should work on macOS and Linux.
- Zen Sidekick must start Zen itself. Firefox only exposes chrome-level remote
  control when the browser process is launched with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`,
  and the harness sets that only in the child process it spawns. A Zen that was
  already open cannot be adopted.

## Install from source

```sh
git clone https://github.com/spaxe-dev/zen-sidekick.git
cd zen-sidekick
npm install
npm run build
npm link            # optional: puts `zen-sidekick` on PATH
```

Then check the machine:

```sh
zen-sidekick setup   # detects Zen, writes a config, prints an MCP snippet
zen-sidekick doctor  # config, executable, Marionette, bridge
```

`setup` writes `$APPDATA/zen-sidekick/config.json` on Windows or
`~/.config/zen-sidekick/config.json` elsewhere. Nothing is installed into Zen
itself: the bridge is injected at runtime.

## Connect an MCP client

Claude Code:

```sh
claude mcp add zen-sidekick -- zen-sidekick serve
```

Any MCP client:

```json
{
  "mcpServers": {
    "zen-sidekick": {
      "command": "zen-sidekick",
      "args": ["serve"]
    }
  }
}
```

If the package is not on `PATH`, use the absolute path to `dist/cli.js` as the
command. `serve` is also the default when the CLI is run without arguments.

The server starts no browser on its own. The first tool call attaches to Zen,
launching it if `autoLaunch` is enabled (the default). That call can take a few
seconds while Zen starts.

## Tools

| Tool | What it does |
| --- | --- |
| `zen_status` | App version, active space and tab, all spaces with counts, bridge health |
| `zen_launch` | Start Zen with agent access or reconnect the bridge |
| `zen_spaces_list` | Spaces with tab, pinned, and folder counts |
| `zen_space_create` | Create a space; does not switch by default |
| `zen_space_switch` | Switch the visible space |
| `zen_space_delete` | Delete a space and its tabs (destructive) |
| `zen_tabs_list` | Tabs across every space, filterable by space, query, pinning |
| `zen_tabs_open` | Open up to 30 URLs in a space, in the background by default |
| `zen_tabs_close` | Close tabs by id |
| `zen_tab_select` | Bring a tab into view (takes over the screen) |
| `zen_folders_list` | Folders with space, label, and tab ids |
| `zen_folder_create` | Group existing tabs into a folder |
| `zen_folder_add_tabs` | Move tabs into a folder |
| `zen_history_search` | Search history by title or URL |
| `zen_bookmarks_search` | Search bookmarks by title or URL |
| `zen_read_page` | Extract text from the active tab or any tab id, without selecting it |
| `zen_ask` | Show a question card in Zen and wait for an answer |
| `zen_answers` | Pending and recently answered questions |
| `zen_notify` | Status card with an optional "open this space" button |

The MCP server ships instructions that teach agents the background workflow:
create a space, batch tabs, read by id, ask before guessing, notify when done,
and leave the active tab alone.

### Questions that stay in the browser

`zen_ask` renders a compact card in the corner of the current Zen window with
numbered options, an optional freeform field, and "Ask me later". Answers go
straight back to the waiting tool call. If the wait expires or the user defers,
the card stays open and `zen_answers` collects the reply later.

### Reading pages in the background

`zen_read_page` never changes what the user is looking at. It goes through the
browser's own Marionette content actor, which can reach a loaded tab in any
space, including spaces that are not currently rendered. The text extractor
prefers `<article>`, `<main>`, or `role=main`, falls back to the body, and
returns the title, URL, meta description, selected text, and length with
truncation at `maxChars`.

Pages that cannot expose a document (privileged `about:` pages, PDF viewers,
tabs that have not loaded) return a clear error instead of partial nonsense.

## CLI

```text
zen-sidekick [serve]        Run the MCP server over stdio
zen-sidekick launch         Start Zen with agent access and verify the bridge
zen-sidekick status         Print window, spaces, and tabs as JSON
zen-sidekick doctor         Diagnose config, executable, Marionette, and bridge
zen-sidekick setup          Detect Zen, write config, print an MCP snippet
zen-sidekick config show    Print the config path and values
zen-sidekick config set <key> <value>
```

Config keys: `zenPath`, `profilePath`, `autoLaunch`, `launchTimeoutMs`,
`askTimeoutSeconds`, `marionettePort`.

Environment variables override the file:

| Variable | Effect |
| --- | --- |
| `ZEN_SIDEKICK_CONFIG` | Config file path |
| `ZEN_SIDEKICK_ZEN_PATH` | Zen executable |
| `ZEN_SIDEKICK_PROFILE` | Profile directory to launch with |
| `ZEN_SIDEKICK_MARIONETTE_PORT` | Marionette port (Zen currently always uses 2828) |
| `ZEN_SIDEKICK_LOG` | `debug`, `info`, `warn`, or `error` |
| `ZEN_SIDEKICK_BRIDGE_SCRIPT` | Override the bundled `bridge.js` path |

Logs always go to **stderr**; stdout belongs to the MCP transport.

## How it works

```text
MCP client (Claude Code, Cursor, ...)
        │ stdio, JSON-RPC
        ▼
zen-sidekick server ──── Marionette (127.0.0.1:2828) ──── Zen chrome scope
        │                                                   launch, inject,
        │ WebSocket on 127.0.0.1, random token              background reads
        ▼
bridge inside each Zen window (system principal)
        │
        ▼
gZenWorkspaces · gZenFolders · gBrowser · Places · UI cards
```

Three layers:

1. **Launch and control plane.** Zen is always listened to on Marionette port
   2828. The harness spawns Zen with remote system access, opens a session, and
   uses chrome-scope script execution only for setup, diagnostics, and the
   content-actor read path. Agents cannot submit arbitrary scripts.
2. **Browser bridge.** A small bundle is injected into each browser window. It
   owns the tab-id mapping, talks to Zen's internal space and folder APIs, and
   renders the UI cards in a shadow root. It connects out to the server over
   loopback with a token, so no listening port exists in the browser.
3. **MCP surface.** Tools validate input, map to bridge operations, and wrap
   errors with actionable messages. Server instructions carry the workflow
   guidance.

Space and folder operations use Zen's own JS APIs (`gZenWorkspaces`,
`gZenFolders`) rather than UI automation, so they behave like native actions.

## Security model

This is a local development tool that gives an agent control of a real browser
profile. Treat it accordingly.

- Chrome access exists only for a Zen process that Zen Sidekick launched. The
  environment variable is never written to Zen preferences.
- The bridge socket binds to `127.0.0.1`, requires a 256-bit random token, and
  checks the token both on the socket URL and in the hello message.
- Agents can only call the fixed operations in the bridge. There is no
  eval-from-agent tool.
- `zen_tabs_open` accepts only `http:`, `https:`, and `about:` URLs.
- Marionette itself is unauthenticated on loopback while the harness runs. Any
  local process could connect during that window. Close the server when you are
  done.
- Question and notification cards render in the browser chrome, not in page
  content, and cannot be reached by the pages the agent reads.

## Troubleshooting

**"Zen is not running. Start it with Zen Sidekick..."**
The bridge is fine; nobody was listening on Marionette. Call `zen_launch` or run
`zen-sidekick launch`.

**"Zen is running, but Marionette never opened on port 2828"**
A normal Zen was already open, so the new process handed off to it. Quit Zen
completely, then launch it through Zen Sidekick again.

**"The Zen profile at ... is already open in another browser"**
The configured profile is locked by a running Zen. Quit that instance, or change
`profilePath` to a separate profile. This check happens before spawning, so it
fails immediately instead of waiting for a Marionette timeout.

**"Maximum number of active sessions"**
Zen supports one Marionette session at a time. Another MCP server or WebDriver
client owns it. Stop the other client.

**`zen_read_page` says the page is privileged or still loading**
`about:` pages, PDF viewers, and tabs without a content document cannot be
scraped. Wait for loading to finish, or open the HTTP version of the page.

**A tool reports `actor_unavailable`**
The Marionette session no longer exposes the content actor. Run `zen_launch`
again to restart Zen with a fresh session.

**The corner cards do not appear**
Only browser windows get the bridge. If the window was opened after the server
started, the next tool call injects into it. If cards still do not show, run
`zen-sidekick doctor` and check the bridge line.

## Tests

```sh
npm test                     # unit tests, no browser
ZEN_SIDEKICK_E2E=1 npm run test:zen
```

The integration suite launches a headless Zen with a fresh disposable profile,
drives real spaces and tabs, clicks the real question card, and kills the
browser afterwards. Profiles are created under `D:\tmp\zen-marionette-test` on
Windows and `$TMPDIR/zen-sidekick-test` elsewhere, then removed; override with
`ZEN_SIDEKICK_TEST_PROFILE` to reuse a specific profile for debugging.

Manual probes with verbose output live in `scripts/probe-smoke.ts` (bridge, UI,
history, bookmarks) and `scripts/probe-mcp.ts` (stdio MCP round trip).

## Known limitations

- Zen's internal workspace and folder APIs can change between releases. Pin a
  Zen version if a newer build breaks spaces; the error will name the failing
  call.
- Marionette is fixed at port 2828 in current Zen builds.
- One Marionette session per browser, so two Zen Sidekick servers cannot control
  the same Zen at once.
- Reads capture the current DOM text. Infinite-scroll and client-rendered pages
  only return what has loaded.
- No screenshot or click automation inside pages. This harness is for Zen and
  agent conversation, not a full WebDriver replacement.

## License

MIT. See [LICENSE](LICENSE).

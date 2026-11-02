# Configuration and CLI

Zen MCP reads a JSON config file and lets environment variables override individual values. `setup` writes the file; `config set` validates and rewrites it.

## CLI

```text
zen-mcp [serve]                 Run the MCP server over stdio
zen-mcp launch                  Launch Zen once, verify ownership, then quit it
zen-mcp status                  Print config, profile mode, and port state
zen-mcp doctor                  Check config, executable, bridge, profile, port, policy
zen-mcp setup                   Detect Zen, write config, print an MCP snippet
zen-mcp onboard                 Pick MCP clients and add Zen MCP to their config
zen-mcp setup --use-default-profile
zen-mcp setup --dedicated-profile
zen-mcp config show             Print the config path and values
zen-mcp config set <key> <value>
```

`launch` is a one-shot self-check: it starts an owned browser, proves the nonce and lockdown work, then quits the browser before exiting. It does not keep a browser open for later use.

`setup` options:

| Option | Effect |
| --- | --- |
| `--zen-path <path>` | Set the Zen executable path |
| `--profile <path>` | Use a custom dedicated profile directory |
| `--use-default-profile` | Use your normal Zen profile |
| `--dedicated-profile` | Use the dedicated agent profile (default) |
| `--no-auto-launch` | Never launch Zen automatically from a tool call |
| `--ask-timeout <seconds>` | Default wait for in-browser answers |
| `--marionette-port <port>` | Port the server connects to |
| `--skip-doctor` | Write the config without running diagnostics |

`setup` does not install anything into Zen. The bridge is injected at runtime.

## MCP clients

`onboard` merges Zen MCP into MCP client configurations:

```text
zen-mcp onboard
zen-mcp onboard --clients claude-code,cursor
zen-mcp onboard --clients all
zen-mcp onboard --clients other
```

The picker knows Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf, Cline, and Zed. It preselects clients found on this machine. Only the `zen-mcp` entry is created or replaced; other servers stay, and JSONC files keep their comments and trailing commas. `other` prints a step-by-step runbook with config paths, entry shapes, merge rules, a validation checklist and a completion report. `--command` changes the command clients should run.

## File locations

Config file:

- Windows: `%APPDATA%\zen-mcp\config.json`
- macOS and Linux: `$XDG_CONFIG_HOME/zen-mcp/config.json` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/zen-mcp/config.json`
- Any platform: the path in `ZEN_MCP_CONFIG`

Data directory (sessions, templates, audit log, and the default agent profile):

- `dataDir` in the config, or
- `ZEN_MCP_DATA_DIR`, or
- `data` beside the config file

Files inside the data directory:

| Path | Contents |
| --- | --- |
| `sessions.json` | Saved window snapshots |
| `templates.json` | User space templates |
| `audit.jsonl` | Audit log, rotated to `audit.jsonl.1` at 5 MB |
| `agent-profile/` | Default dedicated Zen profile |

Session and template files are written atomically with owner-only permissions. The directory is created `0700` and files `0600` where the platform supports POSIX modes. A symlink at the target is refused rather than followed. On Windows the permission bits are best effort; the files are still readable by the same user.

## Config keys

| Key | Default | Meaning |
| --- | --- | --- |
| `zenPath` | auto-detected | Zen executable |
| `profilePath` | unset | Custom profile directory; implies a dedicated profile |
| `dataDir` | unset | Data directory; also holds the default agent profile |
| `useDefaultProfile` | `false` | Use Zen's normal profile instead of the dedicated one |
| `requireConsent` | `true` | Show one approval card before the first browser action |
| `consentTimeoutSeconds` | `90` | How long a tool waits for approval (1 to 600) |
| `autoLaunch` | `true` | Launch an owned browser when a tool needs one |
| `autoAttachWindows` | `true` | Inject the bridge into new normal windows automatically |
| `launchTimeoutMs` | `45000` | How long to wait for Marionette after launch (1,000 to 300,000) |
| `askTimeoutSeconds` | `120` | Default wait for an in-browser answer (1 to 3,600) |
| `marionettePort` | `2828` | Port the server connects to (1 to 65,535) |
| `readOnly` | `false` | Block mutating tools and auto-launch |
| `allowedDomains` | `[]` | Domain allowlist; empty allows everything |
| `auditLog` | `true` | Append tool calls to `audit.jsonl` |
| `watchMinIntervalSeconds` | `15` | Lower bound for watch polling (1 to 3,600) |
| `launchArgs` | `[]` | Extra arguments passed when Zen MCP starts Zen |

Numeric file values outside their range are clamped when loaded. `config set` rejects them instead, so use it when you want a validation error.

### Marionette port

Current Zen builds listen on 2828. The launcher passes `-marionette` without a port, so Zen does not follow `marionettePort`; the setting only changes the port the server tries to reach. Leave it at `2828` unless you know your Zen build supports another port. If another process owns 2828, quit that process; changing the setting usually makes the launch fail.

## Environment variables

Environment variables override the file for that process. They are never written back by `config set` or `setup`.

| Variable | Effect |
| --- | --- |
| `ZEN_MCP_CONFIG` | Config file path |
| `ZEN_MCP_DATA_DIR` | Sessions, templates, audit log, and the default agent profile directory |
| `ZEN_MCP_ZEN_PATH` | Zen executable |
| `ZEN_MCP_PROFILE` | Custom agent profile directory |
| `ZEN_MCP_USE_DEFAULT_PROFILE` | `1` uses Zen's normal profile instead of the dedicated one |
| `ZEN_MCP_REQUIRE_CONSENT` | `0` skips the one-time approval card |
| `ZEN_MCP_CONSENT_TIMEOUT_SECONDS` | How long a tool waits for approval |
| `ZEN_MCP_LAUNCH_ARGS` | Extra Zen arguments, split on whitespace |
| `ZEN_MCP_MARIONETTE_PORT` | Port the server connects to (see [Marionette port](#marionette-port)) |
| `ZEN_MCP_READ_ONLY` | `1`, `true`, or `yes` enables read-only mode |
| `ZEN_MCP_ALLOWED_DOMAINS` | Comma-separated domain allowlist |
| `ZEN_MCP_AUDIT_LOG` | `1`, `true`, or `yes` enables the audit log |
| `ZEN_MCP_WATCH_MIN_INTERVAL_SECONDS` | Lower bound for watch polling |
| `ZEN_MCP_LOG` | `debug`, `info`, `warn`, or `error` |
| `ZEN_MCP_BRIDGE_SCRIPT` | Override the bundled `bridge.js` path; `doctor` warns when set |

Logs always go to **stderr**; stdout belongs to the MCP transport.

## `config set`

```sh
zen-mcp config set readOnly true
zen-mcp config set allowedDomains "github.com, docs.example.com"
zen-mcp config set launchArgs "--width 1600 --height 1000"
zen-mcp config set auditLog false
```

Accepted values:

- Booleans: `true` or `false`, also `1`/`0` and `yes`/`no`.
- Numbers: whole numbers within the range in the table above.
- `allowedDomains`: comma-separated hosts. A leading `*.` or `.` is normalized away.
- `launchArgs`: whitespace-separated arguments.
- Paths: an empty string clears the value.

Unknown keys are rejected with the list of valid keys.

## Doctor

`zen-mcp doctor` checks the config, Zen executable, profile lock, Marionette port, and bridge, and prints a **Policy** line. That line warns when consent, read-only mode, the domain allowlist, or the audit log is weakened, when extra launch arguments are set, or when `ZEN_MCP_BRIDGE_SCRIPT` replaces the bundled bridge. It does not fail the command; it tells you which protections are off.

## Audit log

`audit.jsonl` records one JSON line per tool call, including calls blocked by read-only mode or the allowlist. Each line has a timestamp, tool name, outcome, duration, summarized arguments, redacted URLs, and an error code when present.

- Argument values are summarized to a bounded depth and array length.
- Strings longer than 500 characters become `sha256:<digest> (N chars)`.
- Sensitive keys such as `answer`, `quote`, `question`, `query`, `context`, and `text` become digests regardless of length.
- If the summarized argument JSON is still larger than 2,048 characters, the log stores `{ truncated, size, preview }`. The preview contains up to about 1,950 characters of the already summarized JSON, so redaction runs before truncation.
- URLs keep the scheme, host, and path. Query strings, fragments, and credentials are removed. At most 30 URLs are recorded.
- The active file rotates to `audit.jsonl.1` at 5 MB with one backup.
- A write failure is reported to stderr once and does not fail the tool call.

Resource reads are recorded with the tool name `resource:<uri>` and no arguments.

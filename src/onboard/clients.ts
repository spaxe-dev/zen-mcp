import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";

const MAX_CLIENT_CONFIG_BYTES = 20 * 1024 * 1024;

/** Name the server is registered under in every client. */
export const SERVER_ENTRY_NAME = "zen-mcp";
/** Arguments every client should pass to the server command. */
export const SERVER_ARGS = ["serve"];

export interface ClientContext {
  /** Command clients should run. Defaults to `zen-mcp`. */
  command?: string;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface ResolvedContext {
  command: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  configBase: string;
}

interface ClientDefinition {
  id: string;
  label: string;
  detail: string;
  popular: boolean;
  format: "json" | "toml";
  configPaths(ctx: ResolvedContext): string[];
  /** Directories or files whose presence means the client is installed. */
  detectPaths(ctx: ResolvedContext): string[];
  json?: {
    key: string;
    entry(ctx: ResolvedContext): Record<string, unknown>;
  };
  toml?: {
    section: string;
    values(ctx: ResolvedContext): Record<string, string | string[]>;
  };
}

export interface ClientEntry {
  id: string;
  label: string;
  detail: string;
  popular: boolean;
  detected: boolean;
  /** File that will be created or updated. */
  configPath: string;
  format: "json" | "toml";
}

export interface ApplyResult {
  id: string;
  label: string;
  path: string;
  status: "ok" | "failed";
  message: string;
}

const CLINE_SETTINGS = join(
  "User",
  "globalStorage",
  "saoudrizwan.claude-dev",
  "settings",
  "cline_mcp_settings.json"
);

const DEFINITIONS: ClientDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: "Anthropic's terminal agent",
    popular: true,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".claude.json")],
    detectPaths: (ctx) => [
      join(ctx.home, ".claude.json"),
      join(ctx.home, ".claude"),
    ],
    json: {
      key: "mcpServers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    detail: "The Claude desktop app",
    popular: true,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.configBase, "Claude", "claude_desktop_config.json"),
    ],
    detectPaths: (ctx) => [join(ctx.configBase, "Claude")],
    json: {
      key: "mcpServers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    detail: "Cursor editor",
    popular: true,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".cursor", "mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".cursor")],
    json: {
      key: "mcpServers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "vscode",
    label: "VS Code",
    detail: "GitHub Copilot agent mode",
    popular: true,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.configBase, "Code", "User", "mcp.json"),
      join(ctx.configBase, "Code - Insiders", "User", "mcp.json"),
    ],
    detectPaths: (ctx) => [
      join(ctx.configBase, "Code", "User"),
      join(ctx.configBase, "Code - Insiders", "User"),
    ],
    json: {
      key: "servers",
      entry: (ctx) => ({
        type: "stdio",
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "codex",
    label: "Codex CLI",
    detail: "OpenAI Codex terminal agent",
    popular: true,
    format: "toml",
    configPaths: (ctx) => [
      join(ctx.env.CODEX_HOME ?? join(ctx.home, ".codex"), "config.toml"),
    ],
    detectPaths: (ctx) => [
      ctx.env.CODEX_HOME ?? join(ctx.home, ".codex"),
    ],
    toml: {
      section: "mcp_servers",
      values: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    detail: "Google's terminal agent",
    popular: true,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".gemini", "settings.json")],
    detectPaths: (ctx) => [join(ctx.home, ".gemini")],
    json: {
      key: "mcpServers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detail: "Windsurf editor",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.home, ".codeium", "windsurf", "mcp_config.json"),
    ],
    detectPaths: (ctx) => [join(ctx.home, ".codeium", "windsurf")],
    json: {
      key: "mcpServers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "cline",
    label: "Cline",
    detail: "Cline extension for VS Code-compatible editors",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.configBase, "Code", CLINE_SETTINGS),
      join(ctx.configBase, "Cursor", CLINE_SETTINGS),
      join(ctx.configBase, "Windsurf", CLINE_SETTINGS),
    ],
    detectPaths: (ctx) => [
      dirname(join(ctx.configBase, "Code", CLINE_SETTINGS)),
      dirname(join(ctx.configBase, "Cursor", CLINE_SETTINGS)),
      dirname(join(ctx.configBase, "Windsurf", CLINE_SETTINGS)),
    ],
    json: {
      key: "mcpServers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "zed",
    label: "Zed",
    detail: "Zed editor",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.configBase, ctx.platform === "linux" ? "zed" : "Zed", "settings.json"),
    ],
    detectPaths: (ctx) => [
      join(ctx.configBase, ctx.platform === "linux" ? "zed" : "Zed"),
    ],
    json: {
      key: "context_servers",
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
];

/** Lists every supported client id. */
export function clientIds(): string[] {
  return DEFINITIONS.map((definition) => definition.id);
}

/** Lists every supported client and its resolved config path. */
export function catalog(ctx: ClientContext = {}): ClientEntry[] {
  const resolved = resolveContext(ctx);
  return DEFINITIONS.map((definition) => {
    const paths = definition.configPaths(resolved);
    return {
      id: definition.id,
      label: definition.label,
      detail: definition.detail,
      popular: definition.popular,
      detected: definition.detectPaths(resolved).some((path) => existsSync(path)),
      configPath: paths.find((path) => existsSync(path)) ?? paths[0],
      format: definition.format,
    };
  });
}

/** Adds or replaces the Zen MCP server in one client's configuration. */
export function applyClient(id: string, ctx: ClientContext = {}): ApplyResult {
  const definition = DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    return {
      id,
      label: id,
      path: "",
      status: "failed",
      message: "unknown client",
    };
  }

  const resolved = resolveContext(ctx);
  const paths = definition.configPaths(resolved);
  const path = paths.find((candidate) => existsSync(candidate)) ?? paths[0];
  const existed = existsSync(path);

  try {
    const existing = existed
      ? readFileTextBounded(path, MAX_CLIENT_CONFIG_BYTES)
      : undefined;

    if (definition.format === "toml") {
      const toml = definition.toml;
      if (!toml) throw new Error("TOML settings are missing for this client");
      const next = mergeTomlServer(
        existing ?? "",
        `${toml.section}.${SERVER_ENTRY_NAME}`,
        toml.values(resolved)
      );
      atomicWritePrivate(path, next);
    } else {
      const json = definition.json;
      if (!json) throw new Error("JSON settings are missing for this client");
      const next = mergeJsonServer(existing, json.key, json.entry(resolved));
      atomicWritePrivate(path, next);
    }

    return {
      id: definition.id,
      label: definition.label,
      path,
      status: "ok",
      message: `${existed ? "Updated" : "Created"} ${path}`,
    };
  } catch (error) {
    return {
      id: definition.id,
      label: definition.label,
      path,
      status: "failed",
      message: `${path}: ${(error as Error).message}`,
    };
  }
}

/**
 * Merges one server entry into a JSON config without touching other keys.
 * The target key must be an object (or absent); anything else is an error
 * rather than being overwritten.
 */
export function mergeJsonServer(
  existing: string | undefined,
  key: string,
  entry: Record<string, unknown>
): string {
  let text = existing;
  if (text && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  if (!text || !text.trim()) {
    return `${JSON.stringify({ [key]: { [SERVER_ENTRY_NAME]: entry } }, null, 2)}\n`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    try {
      return mergeJsoncServer(text, key, entry);
    } catch {
      throw new Error(
        `existing file is not valid JSON or JSONC (${(error as Error).message})`
      );
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("existing file is not a JSON object");
  }
  const root = parsed as Record<string, unknown>;

  const current = root[key];
  if (
    current !== undefined &&
    (current === null || typeof current !== "object" || Array.isArray(current))
  ) {
    throw new Error(`"${key}" is not a JSON object`);
  }

  root[key] = {
    ...((current as Record<string, unknown> | undefined) ?? {}),
    [SERVER_ENTRY_NAME]: entry,
  };
  return `${JSON.stringify(root, null, 2)}\n`;
}

interface JsoncMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface JsoncObject {
  open: number;
  close: number;
  members: JsoncMember[];
}

/**
 * Merges into a JSONC document without reserializing it, so comments and
 * trailing commas survive. Only the `zen-mcp` entry is replaced or added.
 */
function mergeJsoncServer(
  text: string,
  key: string,
  entry: Record<string, unknown>
): string {
  const rootStart = skipJsoncTrivia(text, 0);
  if (text[rootStart] !== "{") {
    throw new Error("the top level is not a JSON object");
  }
  const root = scanJsoncObject(text, rootStart);
  if (!root) throw new Error("the file has an unterminated object");

  const target = root.members.find((member) => member.key === key);
  if (!target) {
    return insertJsoncMember(text, root, key, {
      [SERVER_ENTRY_NAME]: entry,
    });
  }
  if (text[target.valueStart] !== "{") {
    throw new Error(`"${key}" is not a JSON object`);
  }
  const serverMap = scanJsoncObject(text, target.valueStart);
  if (!serverMap) throw new Error(`"${key}" is not a complete object`);

  const current = serverMap.members.find(
    (member) => member.key === SERVER_ENTRY_NAME
  );
  if (!current) {
    return insertJsoncMember(text, serverMap, SERVER_ENTRY_NAME, entry);
  }

  const inline = !text.slice(current.valueStart, current.valueEnd).includes("\n");
  const replacement = inline
    ? JSON.stringify(entry)
    : indentJson(
        JSON.stringify(entry, null, 2),
        memberIndent(text, current.keyStart, serverMap)
      );
  return (
    text.slice(0, current.valueStart) +
    replacement +
    text.slice(current.valueEnd)
  );
}

function insertJsoncMember(
  text: string,
  object: JsoncObject,
  name: string,
  entry: Record<string, unknown>
): string {
  let source = text;
  let close = object.close;
  const last = object.members[object.members.length - 1];

  if (last) {
    const between = source.slice(last.valueEnd, object.close);
    if (!between.includes(",")) {
      source =
        source.slice(0, last.valueEnd) + "," + source.slice(last.valueEnd);
      close += 1;
    }
  }

  const lineStart = source.lastIndexOf("\n", close - 1) + 1;
  const onOwnLine =
    lineStart > object.open && source.slice(lineStart, close).trim() === "";

  if (!onOwnLine) {
    const inline = JSON.stringify({ [name]: entry }).slice(1, -1);
    return `${source.slice(0, close)} ${inline} ${source.slice(close)}`;
  }

  const indent = last
    ? memberIndent(source, last.keyStart, object)
    : `${closeIndent(source, object)}  `;
  const entryText = `${JSON.stringify(name)}: ${indentJson(
    JSON.stringify(entry, null, 2),
    indent
  )}`;
  return (
    source.slice(0, lineStart) +
    `${indent}${entryText}\n` +
    source.slice(lineStart)
  );
}

function scanJsoncObject(text: string, open: number): JsoncObject | null {
  const members: JsoncMember[] = [];
  let index = open + 1;
  let expectingMember = true;

  while (true) {
    index = skipJsoncTrivia(text, index);
    if (index >= text.length) return null;

    const char = text[index];
    if (char === "}") {
      return { open, close: index, members };
    }
    if (!expectingMember) {
      if (char !== ",") return null;
      index += 1;
      expectingMember = true;
      continue;
    }
    if (char !== '"') return null;

    const keyStart = index;
    const keyEnd = scanJsoncString(text, index);
    if (keyEnd < 0) return null;
    let key: string;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    } catch {
      return null;
    }

    index = skipJsoncTrivia(text, keyEnd);
    if (text[index] !== ":") return null;
    index = skipJsoncTrivia(text, index + 1);

    const valueStart = index;
    const valueEnd = skipJsoncValue(text, index);
    if (valueEnd < 0) return null;
    members.push({ key, keyStart, valueStart, valueEnd });

    index = skipJsoncTrivia(text, valueEnd);
    expectingMember = false;
  }
}

function skipJsoncTrivia(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const char = text[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
    } else if (char === "/" && text[cursor + 1] === "/") {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== "\n") cursor += 1;
    } else if (char === "/" && text[cursor + 1] === "*") {
      cursor += 2;
      while (
        cursor < text.length &&
        !(text[cursor] === "*" && text[cursor + 1] === "/")
      ) {
        cursor += 1;
      }
      cursor += 2;
    } else {
      break;
    }
  }
  return Math.min(cursor, text.length);
}

function scanJsoncString(text: string, index: number): number {
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
    } else if (text[cursor] === '"') {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

function skipJsoncValue(text: string, index: number): number {
  const char = text[index];
  if (char === '"') return scanJsoncString(text, index);
  if (char === "{" || char === "[") {
    let depth = 0;
    let cursor = index;
    while (cursor < text.length) {
      const current = text[cursor];
      if (current === '"') {
        const end = scanJsoncString(text, cursor);
        if (end < 0) return -1;
        cursor = end;
        continue;
      }
      if (current === "/" && (text[cursor + 1] === "/" || text[cursor + 1] === "*")) {
        cursor = skipJsoncTrivia(text, cursor);
        continue;
      }
      if (current === "{" || current === "[") depth += 1;
      else if (current === "}" || current === "]") {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
      cursor += 1;
    }
    return -1;
  }

  let cursor = index;
  while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
  return cursor > index ? cursor : -1;
}

function memberIndent(text: string, keyStart: number, object: JsoncObject): string {
  let start = keyStart;
  while (start > object.open && (text[start - 1] === " " || text[start - 1] === "\t")) {
    start -= 1;
  }
  if (start > object.open && text[start - 1] === "\n") {
    return text.slice(start, keyStart);
  }
  const openLine = text.lastIndexOf("\n", object.open - 1) + 1;
  return `${" ".repeat(object.open - openLine + 2)}`;
}

function closeIndent(text: string, object: JsoncObject): string {
  const start = text.lastIndexOf("\n", object.close - 1) + 1;
  const between = text.slice(start, object.close);
  if (/^[ \t]*$/.test(between)) return between;
  const openLine = text.lastIndexOf("\n", object.open - 1) + 1;
  return " ".repeat(object.open - openLine);
}

function indentJson(value: string, indent: string): string {
  return value.replace(/\n/g, `\n${indent}`);
}

/**
 * Adds or replaces a TOML table for one server. Only that table is touched;
 * comments, other tables and unrelated keys keep their place.
 */
export function mergeTomlServer(
  existing: string,
  table: string,
  values: Record<string, string | string[]>
): string {
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const header = `[${table}]`;
  const headerPattern = new RegExp(
    `^\\s*\\[\\s*(?:"${escapeRegExp(table)}"|'${escapeRegExp(table)}'|${escapeRegExp(
      table
    )})\\s*\\]\\s*(?:#.*)?$`
  );
  const block = [
    header,
    ...Object.entries(values).map(
      ([name, value]) => `${name} = ${tomlValue(value)}`
    ),
  ];

  const start = lines.findIndex((line) => headerPattern.test(line));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    lines.splice(start, end - start, ...block);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    if (lines.length > 0) lines.push("");
    lines.push(...block);
  }

  return `${lines.join("\n")}\n`;
}

/** A paste-ready runbook for any client the picker does not know. */
export function agentSetupPrompt(
  command = "zen-mcp",
  ctx: ClientContext = {}
): string {
  const resolved = resolveContext({ ...ctx, command });
  const locations = DEFINITIONS.map((definition) => {
    const path = placeholderPath(definition.configPaths(resolved)[0], resolved);
    const detail =
      definition.id === "vscode"
        ? " (Insiders uses the same path under `Code - Insiders`)"
        : definition.id === "cline"
          ? " (same relative path under Cursor or Windsurf)"
          : "";
    const shape =
      definition.id === "vscode"
        ? ' top-level `servers`, entry needs `"type": "stdio"`'
        : definition.id === "zed"
          ? " top-level `context_servers`"
          : definition.id === "codex"
            ? " TOML table `[mcp_servers.zen-mcp]`"
            : " top-level `mcpServers`";
    return `- ${definition.label}: \`${path}\`${detail};${shape}.`;
  }).join("\n");

  return [
    "# Set up Zen MCP in this agent",
    "",
    "Add a local stdio MCP server named `zen-mcp` to the agent you are running in.",
    "Do the work yourself by running commands and editing the client's configuration.",
    "Do not ask me to run any of these commands. Only ask me when a step needs a",
    "browser approval or when no configuration file can be found.",
    "",
    "## Server definition",
    "",
    "- Name: zen-mcp",
    "- Transport: stdio, local process (no URL, no OAuth)",
    `- Command: ${command}`,
    `- Arguments: ${JSON.stringify(SERVER_ARGS)}`,
    "- Environment: none",
    "",
    "If the command is not on PATH, resolve it with `where <command>` on Windows or",
    "`command -v <command>` on macOS and Linux. Use the absolute path as the command",
    "and keep the arguments unchanged.",
    "",
    "## 1. Prefer the client's own command",
    "",
    "If the client has a first-class way to add a stdio server, use it instead of",
    "editing files. Example for Claude Code:",
    "",
    `    claude mcp add zen-mcp -- "${command}" serve`,
    "",
    "Then skip to step 4. An add command that expects a URL is the wrong tool.",
    "",
    "## 2. Find the configuration file",
    "",
    "Use the first location that exists for this client:",
    "",
    locations,
    "",
    "For any other client, look for a top-level `mcpServers`, `servers` or",
    "`context_servers` object in its settings, or follow its official MCP",
    "documentation. Ask me only if no configuration file can be found.",
    "",
    "## 3. Merge the entry",
    "",
    "- Preserve every existing server, key, comment and trailing comma.",
    "- Edit only the `zen-mcp` member. If it already exists, update it instead of",
    "  adding a duplicate.",
    "- Never replace the whole file with a generated object.",
    "- For JSONC files (VS Code, Zed), splice the `zen-mcp` member in place so",
    "  comments and formatting survive.",
    "- Do not reorder or reformat unrelated settings.",
    "",
    "Standard JSON clients use a top-level `mcpServers` object:",
    "",
    "    {",
    '      "mcpServers": {',
    '        "zen-mcp": {',
    '          "command": "<command>",',
    '          "args": ["serve"]',
    "        }",
    "      }",
    "    }",
    "",
    "VS Code uses `servers` and requires the transport type:",
    "",
    "    {",
    '      "servers": {',
    '        "zen-mcp": {',
    '          "type": "stdio",',
    '          "command": "<command>",',
    '          "args": ["serve"]',
    "        }",
    "      }",
    "    }",
    "",
    "Zed uses `context_servers` with the same command and args:",
    "",
    "    {",
    '      "context_servers": {',
    '        "zen-mcp": {',
    '          "command": "<command>",',
    '          "args": ["serve"]',
    "        }",
    "      }",
    "    }",
    "",
    "Codex CLI uses TOML:",
    "",
    "    [mcp_servers.zen-mcp]",
    '    command = "<command>"',
    '    args = ["serve"]',
    "",
    "## 4. Validate",
    "",
    "- Parse the file in its own format and confirm there is exactly one `zen-mcp`",
    "  entry with the command and arguments above.",
    "- Confirm no other server was removed, renamed or changed.",
    "- If the client has a list command such as `claude mcp list`, run it and confirm",
    "  `zen-mcp` appears. Do not start the server manually just to test it.",
    "",
    "## 5. Reload",
    "",
    "Restart the client or run its reload command so it picks up the new server.",
    "Tell me which one you did.",
    "",
    "## 6. Report",
    "",
    "Reply with the client name, the file or command you changed, the validation",
    "result and the reload instruction. End with:",
    "",
    "    ┌─ Zen MCP setup ──────────────────────────────────────┐",
    "    │  ✓ Server   zen-mcp (stdio)                          │",
    "    │  ✓ Config   <file or command>                        │",
    "    │                                                      │",
    "    │  Restart <client> to load the server.                │",
    "    └──────────────────────────────────────────────────────┘",
    "",
    "## Constraints",
    "",
    "- Zen MCP runs locally over stdio. Do not add a remote URL, API key or OAuth",
    "  flow, and do not change the command or arguments.",
    "- Do not install or patch anything inside Zen; the bridge is injected at",
    "  runtime.",
    '- Do not launch a browser to test the server. On the first real browser tool',
    '  call, Zen shows an approval card. Tell me to click "Allow this session".',
  ].join("\n");
}

function resolveContext(ctx: ClientContext): ResolvedContext {
  const platform = ctx.platform ?? process.platform;
  const home = ctx.home ?? homedir();
  const env = ctx.env ?? process.env;
  const command = ctx.command?.trim() || "zen-mcp";

  const configBase =
    platform === "win32"
      ? env.APPDATA ?? join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME ?? join(home, ".config");

  return { command, home, platform, env, configBase };
}

/** Replaces machine-specific roots so prompts never embed a real user name. */
function placeholderPath(path: string, ctx: ResolvedContext): string {
  const windows = ctx.platform === "win32";
  const roots: Array<[string, string]> = [];
  const codexHome = ctx.env.CODEX_HOME;
  if (codexHome) {
    roots.push([codexHome, windows ? "%CODEX_HOME%" : "$CODEX_HOME"]);
  }
  if (windows) {
    roots.push([ctx.configBase, "%APPDATA%"]);
  } else if (ctx.env.XDG_CONFIG_HOME) {
    roots.push([ctx.configBase, "$XDG_CONFIG_HOME"]);
  }
  roots.push([ctx.home, windows ? "%USERPROFILE%" : "~"]);

  const normalize = (value: string) => {
    const slashed = value.replace(/\\/g, "/");
    return windows ? slashed.toLowerCase() : slashed;
  };
  const target = normalize(path);

  for (const [root, label] of roots) {
    const prefix = normalize(root);
    if (target === prefix) return label;
    if (target.startsWith(`${prefix}/`)) {
      const rest = path.slice(root.length);
      const separator = windows ? "\\" : "/";
      return label + rest.replace(windows ? /\//g : /\\/g, separator);
    }
  }
  return path;
}

function tomlValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

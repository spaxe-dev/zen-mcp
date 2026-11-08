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
  format: "json" | "toml" | "yaml" | "bash";
  configPaths(ctx: ResolvedContext): string[];
  /** Directories or files whose presence means the client is installed. */
  detectPaths(ctx: ResolvedContext): string[];
  json?: {
    /** Nested key path to the server map, for example ["mcp", "servers"]. */
    path: string[];
    entry(ctx: ResolvedContext): Record<string, unknown>;
  };
  toml?: {
    section: string;
    values(ctx: ResolvedContext): Record<string, string | string[]>;
  };
  /** Text formats that cannot be parsed generically (YAML, shell files). */
  text?: (existing: string | undefined, ctx: ResolvedContext) => string;
}

export interface ClientEntry {
  id: string;
  label: string;
  detail: string;
  popular: boolean;
  detected: boolean;
  /** File that will be created or updated. */
  configPath: string;
  format: "json" | "toml" | "yaml" | "bash";
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

/** Cross-platform tools keep their config under `~/.config` on every OS. */
const xdgConfig = (ctx: ResolvedContext): string =>
  ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config");

const mcpServers = (ctx: ResolvedContext): Record<string, unknown> => ({
  command: ctx.command,
  args: [...SERVER_ARGS],
});

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
      path: ["mcpServers"],
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
      path: ["mcpServers"],
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
      path: ["mcpServers"],
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
      path: ["servers"],
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
      path: ["mcpServers"],
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
      path: ["mcpServers"],
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
      path: ["mcpServers"],
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
      path: ["context_servers"],
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    detail: "sst terminal agent",
    popular: true,
    format: "json",
    configPaths: (ctx) => [
      join(xdgConfig(ctx), "opencode", "opencode.json"),
      join(xdgConfig(ctx), "opencode", "opencode.jsonc"),
    ],
    detectPaths: (ctx) => [join(xdgConfig(ctx), "opencode")],
    json: {
      path: ["mcp", "servers"],
      entry: (ctx) => ({
        type: "local",
        command: [ctx.command, ...SERVER_ARGS],
      }),
    },
  },
  {
    id: "omp",
    label: "oh-my-pi (omp)",
    detail: "can1357's terminal agent",
    popular: true,
    format: "json",
    configPaths: (ctx) => [
      join(
        ctx.env.PI_CONFIG_DIR ?? join(ctx.home, ".omp"),
        "agent",
        "mcp.json"
      ),
    ],
    detectPaths: (ctx) => [
      ctx.env.PI_CONFIG_DIR ?? join(ctx.home, ".omp"),
    ],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => ({
        type: "stdio",
        command: ctx.command,
        args: [...SERVER_ARGS],
      }),
    },
  },
  {
    id: "dsh",
    label: "DeepSeek Harness",
    detail: "dsh agent framework",
    popular: true,
    format: "yaml",
    configPaths: (ctx) => [
      join(ctx.env.DSH_HOME ?? join(ctx.home, ".dsh"), "cordis.patch.yml"),
    ],
    detectPaths: (ctx) => [ctx.env.DSH_HOME ?? join(ctx.home, ".dsh")],
    text: (existing, ctx) => mergeDshPatch(existing, ctx),
  },
  {
    id: "zcode",
    label: "ZCode (Z.ai)",
    detail: "Z.ai coding agent",
    popular: true,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".zcode", "cli", "config.json")],
    detectPaths: (ctx) => [join(ctx.home, ".zcode")],
    json: {
      path: ["mcp", "servers"],
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
        env: {},
      }),
    },
  },
  {
    id: "roo-code",
    label: "Roo Code",
    detail: "VS Code extension",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      join(
        ctx.configBase,
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json"
      ),
    ],
    detectPaths: (ctx) => [
      join(
        ctx.configBase,
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline"
      ),
    ],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
        disabled: false,
        alwaysAllow: [],
      }),
    },
  },
  {
    id: "kilo-code",
    label: "Kilo Code",
    detail: "Kilo editor extension",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(xdgConfig(ctx), "kilo", "kilo.jsonc")],
    detectPaths: (ctx) => [join(xdgConfig(ctx), "kilo")],
    json: {
      path: ["mcp"],
      entry: (ctx) => ({
        type: "local",
        command: [ctx.command, ...SERVER_ARGS],
        enabled: true,
        timeout: 10000,
      }),
    },
  },
  {
    id: "continue",
    label: "Continue",
    detail: "VS Code and JetBrains extension",
    popular: false,
    format: "yaml",
    configPaths: (ctx) => [join(ctx.home, ".continue", "config.yaml")],
    detectPaths: (ctx) => [join(ctx.home, ".continue")],
    text: (existing, ctx) =>
      mergeYamlListSection(existing, "mcpServers", SERVER_ENTRY_NAME, [
        `name: ${SERVER_ENTRY_NAME}`,
        "type: stdio",
        `command: ${yamlScalar(ctx.command)}`,
        `args: ${yamlFlowArray(SERVER_ARGS)}`,
      ]),
  },
  {
    id: "amp",
    label: "Amp",
    detail: "Sourcegraph terminal agent",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      ctx.platform === "win32"
        ? join(ctx.configBase, "amp", "settings.json")
        : join(xdgConfig(ctx), "amp", "settings.json"),
    ],
    detectPaths: (ctx) => [
      ctx.platform === "win32"
        ? join(ctx.configBase, "amp")
        : join(xdgConfig(ctx), "amp"),
    ],
    json: {
      path: ["amp.mcpServers"],
      entry: (ctx) => mcpServers(ctx),
    },
  },
  {
    id: "crush",
    label: "Crush",
    detail: "Charmbracelet terminal agent",
    popular: false,
    format: "bash",
    configPaths: (ctx) => [
      ctx.env.CRUSH_GLOBAL_CONFIG ?? join(xdgConfig(ctx), "crush", "crushrc"),
    ],
    detectPaths: (ctx) => [join(xdgConfig(ctx), "crush")],
    text: (existing, ctx) => mergeCrushrc(existing, ctx),
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    detail: "Alibaba terminal agent",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.env.QWEN_HOME ?? join(ctx.home, ".qwen"), "settings.json"),
    ],
    detectPaths: (ctx) => [ctx.env.QWEN_HOME ?? join(ctx.home, ".qwen")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => mcpServers(ctx),
    },
  },
  {
    id: "kiro",
    label: "Kiro",
    detail: "AWS agentic IDE and CLI",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".kiro", "settings", "mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".kiro")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => ({
        command: ctx.command,
        args: [...SERVER_ARGS],
        disabled: false,
        autoApprove: [],
      }),
    },
  },
  {
    id: "warp",
    label: "Warp",
    detail: "Warp terminal agent",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".warp", ".mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".warp")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => mcpServers(ctx),
    },
  },
  {
    id: "copilot-cli",
    label: "Copilot CLI",
    detail: "GitHub Copilot terminal agent",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".copilot", "mcp-config.json")],
    detectPaths: (ctx) => [join(ctx.home, ".copilot")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => ({
        type: "local",
        command: ctx.command,
        args: [...SERVER_ARGS],
        tools: ["*"],
      }),
    },
  },
  {
    id: "droid",
    label: "Factory Droid",
    detail: "Factory terminal agent",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".factory", "mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".factory")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => ({
        type: "stdio",
        command: ctx.command,
        args: [...SERVER_ARGS],
        disabled: false,
      }),
    },
  },
  {
    id: "amazon-q",
    label: "Amazon Q",
    detail: "Amazon Q Developer CLI",
    popular: false,
    format: "json",
    configPaths: (ctx) => [
      join(ctx.home, ".aws", "amazonq", "mcp.json"),
    ],
    detectPaths: (ctx) => [join(ctx.home, ".aws", "amazonq")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => mcpServers(ctx),
    },
  },
  {
    id: "goose",
    label: "Goose",
    detail: "Block's terminal agent",
    popular: false,
    format: "yaml",
    configPaths: (ctx) => [
      ctx.platform === "win32"
        ? join(ctx.configBase, "Block", "goose", "config", "config.yaml")
        : join(xdgConfig(ctx), "goose", "config.yaml"),
    ],
    detectPaths: (ctx) => [
      ctx.platform === "win32"
        ? join(ctx.configBase, "Block", "goose")
        : join(xdgConfig(ctx), "goose"),
    ],
    text: (existing, ctx) =>
      mergeYamlMappingSection(existing, "extensions", SERVER_ENTRY_NAME, [
        "type: stdio",
        `name: ${SERVER_ENTRY_NAME}`,
        "enabled: true",
        `cmd: ${yamlScalar(ctx.command)}`,
        `args: ${yamlFlowArray(SERVER_ARGS)}`,
        "envs: {}",
        "timeout: 300",
      ]),
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    detail: "LM Studio desktop app",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".lmstudio", "mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".lmstudio")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => mcpServers(ctx),
    },
  },
  {
    id: "junie",
    label: "Junie",
    detail: "JetBrains Junie CLI",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".junie", "mcp", "mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".junie")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => mcpServers(ctx),
    },
  },
  {
    id: "pi",
    label: "Pi",
    detail: "pi.dev terminal agent",
    popular: false,
    format: "json",
    configPaths: (ctx) => [join(ctx.home, ".pi", "agent", "mcp.json")],
    detectPaths: (ctx) => [join(ctx.home, ".pi")],
    json: {
      path: ["mcpServers"],
      entry: (ctx) => mcpServers(ctx),
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
  const entries = DEFINITIONS.map((definition) => {
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
  // The picker draws one POPULAR section, so popular entries must be adjacent.
  return [
    ...entries.filter((entry) => entry.popular),
    ...entries.filter((entry) => !entry.popular),
  ];
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

    if (definition.text) {
      atomicWritePrivate(path, definition.text(existing, resolved));
    } else if (definition.format === "toml") {
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
      const next = mergeJsonServerPath(
        existing,
        json.path,
        json.entry(resolved)
      );
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
  return mergeJsonServerPath(existing, [key], entry);
}

/** Merges into a nested key path, creating missing objects along the way. */
export function mergeJsonServerPath(
  existing: string | undefined,
  path: string[],
  entry: Record<string, unknown>
): string {
  let text = existing;
  if (text && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  if (!text || !text.trim()) {
    const root: Record<string, unknown> = {};
    placeJsonServer(root, path, entry);
    return `${JSON.stringify(root, null, 2)}\n`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    try {
      return mergeJsoncServerPath(text, path, entry);
    } catch {
      throw new Error(
        `existing file is not valid JSON or JSONC (${(error as Error).message})`
      );
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("existing file is not a JSON object");
  }
  placeJsonServer(parsed as Record<string, unknown>, path, entry);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function placeJsonServer(
  root: Record<string, unknown>,
  path: string[],
  entry: Record<string, unknown>
): void {
  let node = root;
  for (const key of path) {
    const current = node[key];
    if (current === undefined) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      throw new Error(`"${key}" is not a JSON object`);
    }
    node = current as Record<string, unknown>;
  }
  node[SERVER_ENTRY_NAME] = entry;
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
function mergeJsoncServerPath(
  text: string,
  path: string[],
  entry: Record<string, unknown>
): string {
  const rootStart = skipJsoncTrivia(text, 0);
  if (text[rootStart] !== "{") {
    throw new Error("the top level is not a JSON object");
  }
  let object = scanJsoncObject(text, rootStart);
  if (!object) throw new Error("the file has an unterminated object");

  for (let index = 0; index < path.length; index += 1) {
    const key = path[index];
    const member = object.members.find((item) => item.key === key);
    if (!member) {
      return insertJsoncMember(
        text,
        object,
        key,
        nestedJsonValue(path.slice(index + 1), entry)
      );
    }
    if (text[member.valueStart] !== "{") {
      throw new Error(`"${key}" is not a JSON object`);
    }
    const child = scanJsoncObject(text, member.valueStart);
    if (!child) throw new Error(`"${key}" is not a complete object`);
    if (index === path.length - 1) {
      return upsertJsoncServer(text, child, entry);
    }
    object = child;
  }
  throw new Error("the server path is empty");
}

function nestedJsonValue(
  keys: string[],
  entry: Record<string, unknown>
): Record<string, unknown> {
  return keys.reduceRight<Record<string, unknown>>(
    (value, key) => ({ [key]: value }),
    { [SERVER_ENTRY_NAME]: entry }
  );
}

function upsertJsoncServer(
  text: string,
  serverMap: JsoncObject,
  entry: Record<string, unknown>
): string {
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

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlFlowArray(values: string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

interface YamlSection {
  start: number;
  end: number;
  indent: string;
}

/** Finds a top-level YAML key and the lines that belong to it. */
function findYamlSection(lines: string[], section: string): YamlSection | null {
  const header = new RegExp(`^${escapeRegExp(section)}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (
      line.trim() === "" ||
      /^[ \t]/.test(line) ||
      line.trimStart().startsWith("#")
    ) {
      end += 1;
    } else {
      break;
    }
  }
  const child = lines
    .slice(start + 1, end)
    .find((line) => /^[ \t]+\S/.test(line));
  return { start, end, indent: child?.match(/^[ \t]+/)?.[0] ?? "  " };
}

function splitYamlLines(existing: string | undefined): string[] {
  const lines = (existing ?? "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Adds or replaces one key under a top-level YAML mapping. The block is
 * spliced into the text so comments and unrelated keys keep their place.
 */
function mergeYamlMappingSection(
  existing: string | undefined,
  section: string,
  key: string,
  block: string[]
): string {
  const lines = splitYamlLines(existing);
  const found = findYamlSection(lines, section);

  if (!found) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${section}:`,
      `${key}:`,
      ...block.map((line) => `  ${line}`)
    );
    return `${lines.join("\n")}\n`;
  }

  const indent = found.indent;
  const keyLine = `${indent}${key}:`;
  const keyPattern = new RegExp(
    `^${escapeRegExp(indent)}${escapeRegExp(key)}:\\s*(?:#.*)?$`
  );
  const index = lines.findIndex(
    (line, position) =>
      position > found.start && position < found.end && keyPattern.test(line)
  );

  if (index >= 0) {
    let end = index + 1;
    while (end < found.end) {
      const line = lines[end];
      if (line.trim() === "") {
        end += 1;
        continue;
      }
      const lineIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (lineIndent <= indent.length) break;
      end += 1;
    }
    lines.splice(
      index,
      end - index,
      keyLine,
      ...block.map((line) => `  ${indent}${line}`)
    );
  } else {
    lines.splice(
      found.end,
      0,
      keyLine,
      ...block.map((line) => `  ${indent}${line}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Adds or replaces one `- name:` item under a top-level YAML list. */
function mergeYamlListSection(
  existing: string | undefined,
  section: string,
  name: string,
  block: string[]
): string {
  const lines = splitYamlLines(existing);
  const found = findYamlSection(lines, section);
  const item = [`- name: ${name}`, ...block.slice(1)];

  if (!found) {
    if (lines.length > 0) lines.push("");
    lines.push(`${section}:`, ...item.map((line) => `  ${line}`));
    return `${lines.join("\n")}\n`;
  }

  const itemIndent =
    lines
      .slice(found.start + 1, found.end)
      .find((line) => /^[ \t]*-[ \t]+\S/.test(line))
      ?.match(/^[ \t]*/)?.[0] ?? "  ";
  const namePattern = new RegExp(
    `^${escapeRegExp(itemIndent)}-[ \\t]+name:\\s*['"]?${escapeRegExp(
      name
    )}['"]?\\s*(?:#.*)?$`
  );
  const index = lines.findIndex(
    (line, position) =>
      position > found.start && position < found.end && namePattern.test(line)
  );

  if (index >= 0) {
    let end = index + 1;
    while (end < found.end) {
      const line = lines[end];
      if (line.trim() === "") {
        end += 1;
        continue;
      }
      if (new RegExp(`^${escapeRegExp(itemIndent)}-[ \\t]`).test(line)) break;
      if ((line.match(/^[ \t]*/)?.[0].length ?? 0) < itemIndent.length) break;
      end += 1;
    }
    lines.splice(
      index,
      end - index,
      `${itemIndent}${item[0]}`,
      ...item.slice(1).map((line) => `${itemIndent}  ${line}`)
    );
  } else {
    lines.splice(
      found.end,
      0,
      `${itemIndent}${item[0]}`,
      ...item.slice(1).map((line) => `${itemIndent}  ${line}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

/** DSH stores MCP clients as plugin entries in a Cordis patch overlay. */
function mergeDshPatch(
  existing: string | undefined,
  ctx: ResolvedContext
): string {
  const lines = splitYamlLines(existing);
  const item = [
    "- id: zen-mcp",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: zen_mcp",
    "    transport: stdio",
    `    command: ${yamlScalar(ctx.command)}`,
    `    args: ${yamlFlowArray(SERVER_ARGS)}`,
  ];
  const idPattern = /^([ \t]*)-[ \t]*id:\s*['"]?zen-mcp['"]?\s*$/;
  const index = lines.findIndex((line) => idPattern.test(line));

  if (index < 0) {
    if (lines.length > 0) lines.push("");
    lines.push("- insert:", ...item.map((line) => `    ${line}`));
    return `${lines.join("\n")}\n`;
  }

  const indent = lines[index].match(idPattern)?.[1] ?? "  ";
  let start = index;
  while (start > 0) {
    const previous = lines[start - 1];
    const previousIndent = previous.match(/^[ \t]*/)?.[0].length ?? 0;
    if (previousIndent < indent.length) break;
    if (
      previousIndent === indent.length &&
      /^[ \t]*-[ \t]/.test(previous)
    ) {
      break;
    }
    start -= 1;
  }

  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (line.trim() !== "" && lineIndent < indent.length) break;
    if (lineIndent === indent.length && /^[ \t]*-[ \t]/.test(line)) break;
    end += 1;
  }

  lines.splice(
    start,
    end - start,
    ...item.map((line) => `${indent}${line}`)
  );
  return `${lines.join("\n")}\n`;
}

/** Crush reads a shell rc file, so the entry is an `mcp add` command. */
function mergeCrushrc(
  existing: string | undefined,
  ctx: ResolvedContext
): string {
  const lines = splitYamlLines(existing);
  const command = `mcp add zen-mcp --command ${shellQuote(
    ctx.command
  )} --args ${SERVER_ARGS.map(shellQuote).join(" ")}`;
  const index = lines.findIndex((line) =>
    /^\s*mcp\s+add\s+zen-mcp(?:\s|$)/.test(line)
  );
  if (index >= 0) {
    lines[index] = command;
  } else {
    if (lines.length > 0) lines.push("");
    lines.push(command);
  }
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
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
    const jsonPath = definition.json?.path;
    const shape =
      definition.format === "toml"
        ? " TOML table `[mcp_servers.zen-mcp]`"
        : definition.format === "yaml"
          ? " YAML configuration, keep existing entries"
          : definition.format === "bash"
            ? " shell rc file, add it with `mcp add`"
            : definition.id === "vscode"
              ? ' top-level `servers`, entry needs `"type": "stdio"`'
              : jsonPath && jsonPath.length > 1
                ? ` nested \`${jsonPath.join(".")}\` object`
                : jsonPath?.[0] === "context_servers"
                  ? " top-level `context_servers`"
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

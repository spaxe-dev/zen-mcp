import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ZenMcpConfig {
  /** Absolute path to the Zen executable. Auto-detected when omitted. */
  zenPath?: string;
  /** Optional profile directory to launch Zen with. */
  profilePath?: string;
  /** Launch Zen when a tool needs it and it is not running. */
  autoLaunch: boolean;
  /** How long to wait for Marionette after launching Zen. */
  launchTimeoutMs: number;
  /** Default wait for a question answered in the browser. */
  askTimeoutSeconds: number;
  /** Marionette port. Zen currently always listens on 2828. */
  marionettePort: number;
}

export const DEFAULT_CONFIG: ZenMcpConfig = {
  autoLaunch: true,
  launchTimeoutMs: 45_000,
  askTimeoutSeconds: 120,
  marionettePort: 2828,
};

export function configFilePath(): string {
  if (process.env.ZEN_MCP_CONFIG) {
    return process.env.ZEN_MCP_CONFIG;
  }
  const appData =
    process.env.APPDATA ??
    (process.env.XDG_CONFIG_HOME
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config"));
  return join(appData, "zen-mcp", "config.json");
}

export function loadConfig(): ZenMcpConfig {
  const path = configFilePath();
  let fileConfig: Partial<ZenMcpConfig> = {};
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, "utf8")) as Partial<ZenMcpConfig>;
    } catch (error) {
      throw new Error(
        `Could not parse ${path}: ${(error as Error).message}. Fix or delete the file.`
      );
    }
  }

  const envPort = process.env.ZEN_MCP_MARIONETTE_PORT;
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    zenPath: process.env.ZEN_MCP_ZEN_PATH || fileConfig.zenPath,
    profilePath: process.env.ZEN_MCP_PROFILE || fileConfig.profilePath,
    marionettePort: envPort
      ? Number(envPort)
      : (fileConfig.marionettePort ?? DEFAULT_CONFIG.marionettePort),
  };
}

export function saveConfig(updates: Partial<ZenMcpConfig>): string {
  const path = configFilePath();
  const next = { ...loadConfig(), ...updates };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}

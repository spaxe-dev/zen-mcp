import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  atomicWritePrivate,
  readFileTextBounded,
} from "./utils/safe-file.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ZenMcpConfig {
  /** Absolute path to the Zen executable. Auto-detected when omitted. */
  zenPath?: string;
  /** Optional profile directory to launch Zen with. */
  profilePath?: string;
  /**
   * Use Zen's normal profile instead of the dedicated agent profile. The agent
   * can then see pages where the user is signed in.
   */
  useDefaultProfile: boolean;
  /** Show an approval card in Zen before the agent may control the browser. */
  requireConsent: boolean;
  /** How long a tool waits for the approval card before reporting pending. */
  consentTimeoutSeconds: number;
  /** Launch Zen when a tool needs it and it is not running. */
  autoLaunch: boolean;
  /** How long to wait for Marionette after launching Zen. */
  launchTimeoutMs: number;
  /** Default wait for a question answered in the browser. */
  askTimeoutSeconds: number;
  /** Marionette port. Zen currently always listens on 2828. */
  marionettePort: number;
  /** Reject every tool that would change browser state. */
  readOnly: boolean;
  /** When non-empty, only URLs on these domains may be opened or previewed. */
  allowedDomains: string[];
  /** Append tool calls and their outcome to audit.jsonl in the data directory. */
  auditLog: boolean;
  /** Directory for sessions, templates and logs. Defaults next to the config. */
  dataDir?: string;
  /** Attach the agent bridge to new Zen windows automatically. */
  autoAttachWindows: boolean;
  /** Never poll a watched tab more often than this. */
  watchMinIntervalSeconds: number;
  /** Extra command-line arguments passed when Zen MCP starts Zen. */
  launchArgs: string[];
}

export const DEFAULT_CONFIG: ZenMcpConfig = {
  useDefaultProfile: false,
  requireConsent: true,
  consentTimeoutSeconds: 90,
  autoLaunch: true,
  launchTimeoutMs: 45_000,
  askTimeoutSeconds: 120,
  marionettePort: 2828,
  readOnly: false,
  allowedDomains: [],
  auditLog: true,
  autoAttachWindows: true,
  watchMinIntervalSeconds: 15,
  launchArgs: [],
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

export function dataDirPath(): string {
  if (process.env.ZEN_MCP_DATA_DIR) {
    return process.env.ZEN_MCP_DATA_DIR;
  }
  return join(dirname(configFilePath()), "data");
}

export function loadConfig(): ZenMcpConfig {
  const fileConfig = readConfigFile();

  const envPort = process.env.ZEN_MCP_MARIONETTE_PORT;
  const envReadOnly = process.env.ZEN_MCP_READ_ONLY;
  const envAuditLog = process.env.ZEN_MCP_AUDIT_LOG;
  const envDomains = process.env.ZEN_MCP_ALLOWED_DOMAINS;
  const envWatchMin = process.env.ZEN_MCP_WATCH_MIN_INTERVAL_SECONDS;
  const envUseDefault = process.env.ZEN_MCP_USE_DEFAULT_PROFILE;
  const envConsent = process.env.ZEN_MCP_REQUIRE_CONSENT;
  const envConsentTimeout = process.env.ZEN_MCP_CONSENT_TIMEOUT_SECONDS;
  const envLaunchArgs = process.env.ZEN_MCP_LAUNCH_ARGS;

  const fileReadOnly = fileBoolean(
    fileConfig.readOnly,
    DEFAULT_CONFIG.readOnly
  );
  const fileAuditLog = fileBoolean(
    fileConfig.auditLog,
    DEFAULT_CONFIG.auditLog
  );
  const fileDomains = Array.isArray(fileConfig.allowedDomains)
    ? fileConfig.allowedDomains.filter(
        (entry): entry is string => typeof entry === "string"
      )
    : DEFAULT_CONFIG.allowedDomains;
  const domains =
    envDomains !== undefined
      ? envDomains
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : fileDomains;
  const launchArgs = Array.isArray(fileConfig.launchArgs)
    ? fileConfig.launchArgs.map(String).filter(Boolean)
    : DEFAULT_CONFIG.launchArgs;
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    zenPath:
      process.env.ZEN_MCP_ZEN_PATH ||
      (typeof fileConfig.zenPath === "string" ? fileConfig.zenPath : undefined),
    profilePath:
      process.env.ZEN_MCP_PROFILE ||
      (typeof fileConfig.profilePath === "string"
        ? fileConfig.profilePath
        : undefined),
    useDefaultProfile:
      envUseDefault !== undefined
        ? parseBoolean(envUseDefault, DEFAULT_CONFIG.useDefaultProfile)
        : fileBoolean(
            fileConfig.useDefaultProfile,
            DEFAULT_CONFIG.useDefaultProfile
          ),
    requireConsent:
      envConsent !== undefined
        ? parseBoolean(envConsent, DEFAULT_CONFIG.requireConsent)
        : fileBoolean(fileConfig.requireConsent, DEFAULT_CONFIG.requireConsent),
    consentTimeoutSeconds:
      envConsentTimeout !== undefined && envConsentTimeout.trim()
        ? boundedInt(
            envConsentTimeout,
            1,
            600,
            DEFAULT_CONFIG.consentTimeoutSeconds
          )
        : boundedInt(
            fileConfig.consentTimeoutSeconds,
            1,
            600,
            DEFAULT_CONFIG.consentTimeoutSeconds
          ),
    launchArgs: envLaunchArgs
      ? envLaunchArgs.split(/\s+/).filter(Boolean)
      : launchArgs,
    marionettePort:
      envPort !== undefined && envPort.trim()
        ? boundedInt(envPort, 1, 65535, DEFAULT_CONFIG.marionettePort)
        : boundedInt(
            fileConfig.marionettePort,
            1,
            65535,
            DEFAULT_CONFIG.marionettePort
          ),
    readOnly:
      envReadOnly !== undefined
        ? parseBoolean(envReadOnly, fileReadOnly)
        : fileReadOnly,
    allowedDomains: domains.map((domain) =>
      domain.replace(/^\*?\./, "").toLowerCase()
    ),
    auditLog:
      envAuditLog !== undefined
        ? parseBoolean(envAuditLog, fileAuditLog)
        : fileAuditLog,
    watchMinIntervalSeconds:
      envWatchMin !== undefined && envWatchMin.trim()
        ? boundedInt(
            envWatchMin,
            1,
            3600,
            DEFAULT_CONFIG.watchMinIntervalSeconds
          )
        : boundedInt(
            fileConfig.watchMinIntervalSeconds,
            1,
            3600,
            DEFAULT_CONFIG.watchMinIntervalSeconds
          ),
    launchTimeoutMs: boundedInt(
      fileConfig.launchTimeoutMs,
      1_000,
      300_000,
      DEFAULT_CONFIG.launchTimeoutMs
    ),
    askTimeoutSeconds: boundedInt(
      fileConfig.askTimeoutSeconds,
      1,
      3_600,
      DEFAULT_CONFIG.askTimeoutSeconds
    ),
    autoLaunch: fileBoolean(fileConfig.autoLaunch, DEFAULT_CONFIG.autoLaunch),
    autoAttachWindows: fileBoolean(
      fileConfig.autoAttachWindows,
      DEFAULT_CONFIG.autoAttachWindows
    ),
  };
}

function readConfigFile(): Partial<ZenMcpConfig> {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(
      readFileTextBounded(path, MAX_CONFIG_BYTES)
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Partial<ZenMcpConfig>;
  } catch (error) {
    throw new Error(
      `Could not parse ${path}: ${(error as Error).message}. Fix or delete the file.`
    );
  }
}

function parseBoolean(value: string, fallback: boolean): boolean {
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return fallback;
}

function fileBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function saveConfig(updates: Partial<ZenMcpConfig>): string {
  const path = configFilePath();
  // Read the file directly so environment overrides are never baked into it.
  const next = { ...DEFAULT_CONFIG, ...readConfigFile(), ...updates };
  atomicWritePrivate(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

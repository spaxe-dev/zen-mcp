import { existsSync } from "node:fs";
import type { ZenMcpConfig } from "../config.js";
import { configFilePath } from "../config.js";
import { resolveBridgeScriptPath } from "../bridge/host.js";
import {
  findZenExecutable,
  isPortOpen,
  isProfileLocked,
  isZenProcessRunning,
  resolvedProfilePath,
} from "./launcher.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  /** No check failed. Warnings are allowed. */
  ok: boolean;
  /**
   * Always false: doctor deliberately never creates a Marionette session, so
   * it cannot report that a live agent connection exists.
   */
  ready: boolean;
  configPath: string;
  config: ZenMcpConfig;
  checks: DoctorCheck[];
}

/**
 * Verifies the static pieces needed for agent control without ever connecting
 * to a browser. A live check would have to create a chrome session, which this
 * tool will not do to a browser it did not launch; use `zen-mcp launch` for a
 * one-shot live verification.
 */
export async function runDoctor(
  config: ZenMcpConfig,
  options: { bridgeScriptPath?: string } = {}
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const path = configFilePath();

  checks.push({
    name: "Config",
    status: existsSync(path) ? "ok" : "warn",
    detail: existsSync(path)
      ? `Loaded ${path}`
      : "No config file yet; built-in defaults are in use.",
    hint: existsSync(path)
      ? undefined
      : "Run `zen-mcp setup` to detect Zen and write a config file.",
  });

  try {
    checks.push({
      name: "Zen executable",
      status: "ok",
      detail: findZenExecutable(config),
    });
  } catch (error) {
    checks.push({
      name: "Zen executable",
      status: "fail",
      detail: (error as Error).message,
      hint: "Set ZEN_MCP_ZEN_PATH or run `zen-mcp setup --zen-path <exe>`.",
    });
  }

  const bridgeBundle = options.bridgeScriptPath ?? resolveBridgeScriptPath();
  const bundleExists = existsSync(bridgeBundle);
  checks.push({
    name: "Bridge bundle",
    status: bundleExists ? "ok" : "fail",
    detail: bundleExists ? bridgeBundle : `Missing ${bridgeBundle}.`,
    hint: bundleExists ? undefined : "Run `npm run build` (or reinstall Zen MCP).",
  });

  const profile = resolvedProfilePath(config);
  if (profile) {
    const locked = isProfileLocked(profile);
    checks.push({
      name: "Agent profile",
      status: locked ? "warn" : "ok",
      detail: locked
        ? `${profile} is in use by another Zen instance.`
        : `${profile} (kept separate from your normal browsing profile).`,
      hint: locked
        ? "Quit that Zen instance before launching. Zen MCP will not attach to it."
        : undefined,
    });
  } else {
    const running = isZenProcessRunning();
    checks.push({
      name: "Profile mode",
      status: running ? "warn" : "ok",
      detail: running
        ? "Normal profile: Zen is running, and Zen MCP never takes over an existing browser."
        : "Normal profile: the agent shares your signed-in browsing profile.",
      hint: running
        ? "Quit Zen completely before the agent launches it. Use the dedicated profile to keep them separate."
        : "Pages the agent reads can include sites where you are signed in.",
    });
  }

  try {
    const open = await isPortOpen(config.marionettePort);
    checks.push({
      name: "Marionette port",
      status: open ? "warn" : "ok",
      detail: open
        ? `127.0.0.1:${config.marionettePort} is accepting connections. ` +
          "Zen MCP will refuse to launch while another process owns that port."
        : `127.0.0.1:${config.marionettePort} is closed. Zen MCP opens it only ` +
          "while launching its own browser, then closes it for good.",
      hint: open
        ? "Quit the process using that port, or set ZEN_MCP_MARIONETTE_PORT."
        : undefined,
    });
  } catch (error) {
    checks.push({
      name: "Marionette port",
      status: "fail",
      detail: (error as Error).message,
    });
  }

  checks.push({
    name: "Ownership",
    status: "ok",
    detail:
      "Zen MCP launches its own Zen window, verifies it with a per-launch " +
      "nonce, then closes every other Marionette connection and the listener. " +
      "It never attaches to a running Zen.",
  });

  const weak: string[] = [];
  if (!config.requireConsent) weak.push("consent is off");
  if (!config.readOnly) weak.push("read-only mode is off");
  if (config.allowedDomains.length === 0) weak.push("the domain allowlist is empty");
  if (!config.auditLog) weak.push("the audit log is off");
  if (config.launchArgs.length > 0) weak.push("extra launch arguments are set");
  if (process.env.ZEN_MCP_BRIDGE_SCRIPT) {
    weak.push("ZEN_MCP_BRIDGE_SCRIPT overrides the bridge bundle");
  }
  checks.push({
    name: "Policy",
    status: weak.length > 0 ? "warn" : "ok",
    detail:
      weak.length > 0
        ? `More permissive than the safest settings: ${weak.join(", ")}.`
        : "Consent, read-only mode, the domain allowlist and the audit log are all on.",
    hint:
      weak.length > 0
        ? "Run `zen-mcp config set readOnly true`, set allowedDomains, and keep auditLog on."
        : undefined,
  });

  return {
    ok: !checks.some((check) => check.status === "fail"),
    ready: false,
    configPath: path,
    config,
    checks,
  };
}

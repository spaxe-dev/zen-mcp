import { existsSync } from "node:fs";
import type { SidekickConfig } from "../config.js";
import { configFilePath } from "../config.js";
import { ZenRuntime } from "./runtime.js";
import { findZenExecutable, isPortOpen, ZenLaunchError } from "./launcher.js";

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
  /** A live bridge answered, so the agent tools can work right now. */
  ready: boolean;
  configPath: string;
  config: SidekickConfig;
  checks: DoctorCheck[];
}

/**
 * Verifies the pieces needed for agent control: a Zen executable, the bridge
 * bundle, Marionette with chrome access, and a live browser bridge.
 *
 * This never launches Zen. When another process already owns the Marionette
 * session (for example a running MCP server), the report says so instead of
 * failing.
 */
export async function runDoctor(
  config: SidekickConfig,
  options: { bridgeScriptPath?: string } = {}
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const path = configFilePath();

  checks.push({
    name: "Config",
    status: existsSync(path) ? "ok" : "warn",
    detail: existsSync(path)
      ? `Loaded ${path}`
      : `No config file yet; built-in defaults are in use.`,
    hint: existsSync(path)
      ? undefined
      : "Run `zen-sidekick setup` to detect Zen and write a config file.",
  });

  let executable = config.zenPath ?? "";
  try {
    executable = findZenExecutable(config);
    checks.push({
      name: "Zen executable",
      status: "ok",
      detail: executable,
    });
  } catch (error) {
    checks.push({
      name: "Zen executable",
      status: "fail",
      detail: (error as Error).message,
      hint:
        "Set ZEN_SIDEKICK_ZEN_PATH or run `zen-sidekick setup --zen-path <exe>`.",
    });
  }

  const runtime = new ZenRuntime({
    config,
    bridgeScriptPath: options.bridgeScriptPath,
  });

  const bridgeBundle = runtime.hub.bridgeScriptPath;
  const bundleExists = existsSync(bridgeBundle);
  checks.push({
    name: "Bridge bundle",
    status: bundleExists ? "ok" : "fail",
    detail: bundleExists
      ? bridgeBundle
      : `Missing ${bridgeBundle}.`,
    hint: bundleExists ? undefined : "Run `npm run build` (or reinstall Zen Sidekick).",
  });

  let marionetteOpen = false;
  try {
    marionetteOpen = await isPortOpen(config.marionettePort);
    checks.push({
      name: "Marionette port",
      status: marionetteOpen ? "ok" : "warn",
      detail: marionetteOpen
        ? `127.0.0.1:${config.marionettePort} is accepting connections.`
        : `Nothing is listening on 127.0.0.1:${config.marionettePort}.`,
      hint: marionetteOpen
        ? undefined
        : "Zen is not running with agent access. Run `zen-sidekick launch` or call zen_launch from the agent.",
    });
  } catch (error) {
    checks.push({
      name: "Marionette port",
      status: "fail",
      detail: (error as Error).message,
    });
  }

  if (!marionetteOpen) {
    return {
      ok: !checks.some((c) => c.status === "fail"),
      ready: false,
      configPath: path,
      config,
      checks,
    };
  }

  let ready = false;
  try {
    await runtime.start();
    await runtime.connect({ allowLaunch: false });
    const status = await runtime.status();

    checks.push({
      name: "Chrome access",
      status: "ok",
      detail: `${status.appName} ${status.appVersion} on ${status.platform}, profile ${status.profile || "(unknown)"}.`,
    });

    checks.push({
      name: "Bridge",
      status: runtime.hub.connectionCount > 0 ? "ok" : "fail",
      detail:
        runtime.hub.connectionCount > 0
          ? `${runtime.hub.connectionCount} Zen window(s) attached on port ${runtime.hub.port}.`
          : "The agent bridge could not attach to a browser window.",
      hint:
        runtime.hub.connectionCount > 0
          ? undefined
          : "Quit Zen completely, then run `zen-sidekick launch`. Zen must be started by Zen Sidekick so remote chrome access is enabled.",
    });

    checks.push({
      name: "Spaces",
      status: status.workspacesEnabled ? "ok" : "warn",
      detail: status.workspacesEnabled
        ? `${status.spaces.length} space(s), ${status.tabCount} tab(s), ${status.folderCount} folder(s).`
        : "Spaces are disabled in this window.",
      hint: status.workspacesEnabled
        ? undefined
        : "Spaces are unavailable in private windows or when workspaces are turned off in Zen settings.",
    });

    ready = runtime.hub.connectionCount > 0;
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const sessionBusy = /maximum number of active sessions/i.test(message);
    checks.push({
      name: "Agent session",
      status: sessionBusy ? "warn" : "fail",
      detail: sessionBusy
        ? "Another process already owns the Marionette session (a running Zen Sidekick server)."
        : message,
      hint: sessionBusy
        ? "This is normal when the MCP server is running. Doctor cannot attach a second session at the same time."
        : error instanceof ZenLaunchError
          ? undefined
          : "See the message above. `zen-sidekick launch` starts a fresh Zen with agent access.",
    });
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }

  return {
    ok: !checks.some((c) => c.status === "fail"),
    ready,
    configPath: path,
    config,
    checks,
  };
}

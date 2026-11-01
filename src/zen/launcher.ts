import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readlinkSync,
  statSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDirPath, type ZenMcpConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("launcher");

export class ZenLaunchError extends Error {
  override name = "ZenLaunchError";
}

export interface LaunchResult {
  executable: string;
  pid: number;
  port: number;
  /** Per-launch marker the browser must expose through `Services.env`. */
  nonce: string;
}

/**
 * Resolves the profile a launch will use. `null` means Zen's normal profile,
 * which is opt-in because the agent can then see signed-in pages.
 */
export function resolvedProfilePath(
  config: Partial<
    Pick<ZenMcpConfig, "profilePath" | "useDefaultProfile" | "dataDir">
  >
): string | null {
  if (config.profilePath) return resolve(config.profilePath);
  if (config.useDefaultProfile) return null;
  return join(config.dataDir ?? dataDirPath(), "agent-profile");
}

export function buildLaunchArgs(
  config: Partial<
    Pick<
      ZenMcpConfig,
      "profilePath" | "useDefaultProfile" | "dataDir" | "launchArgs"
    >
  >,
  extraArgs: string[] = []
): { args: string[]; profile: string | null } {
  const profile = resolvedProfilePath(config);
  // `-no-remote` keeps the owned launch from handing its command line to a
  // Zen that is already running, which would ignore the agent profile and
  // never open Marionette. `extraArgs` stay last so test-only flags such as
  // --headless add to the launch without replacing the profile.
  const args = ["-marionette", "-no-remote"];
  if (profile) args.push("-profile", profile);
  args.push(...(config.launchArgs ?? []), ...extraArgs);
  return { args, profile };
}

export function findZenExecutable(config: Pick<ZenMcpConfig, "zenPath">): string {
  if (config.zenPath) {
    if (!existsSync(config.zenPath)) {
      throw new ZenLaunchError(
        `Configured Zen executable does not exist: ${config.zenPath}`
      );
    }
    return config.zenPath;
  }

  for (const candidate of zenCandidates()) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    return candidate;
  }

  throw new ZenLaunchError(
    "Could not find Zen Browser. Install Zen, or set ZEN_MCP_ZEN_PATH / " +
      "zenPath in the Zen MCP config to the zen executable."
  );
}

function zenCandidates(): string[] {
  switch (process.platform) {
    case "win32":
      return [
        join(process.env.ProgramFiles ?? "C:\\Program Files", "Zen Browser", "zen.exe"),
        join(
          process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
          "Zen Browser",
          "zen.exe"
        ),
        join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Programs",
          "Zen Browser",
          "zen.exe"
        ),
        join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Zen Browser",
          "zen.exe"
        ),
      ];
    case "darwin":
      return [
        "/Applications/Zen Browser.app/Contents/MacOS/zen",
        join(homedir(), "Applications", "Zen Browser.app", "Contents", "MacOS", "zen"),
      ];
    default:
      return [
        "/usr/bin/zen",
        "/usr/bin/zen-browser",
        "/opt/zen/zen",
        "/usr/lib/zen/zen",
        "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
        join(
          homedir(),
          ".local/share/flatpak/exports/bin/app.zen_browser.zen"
        ),
        "/snap/bin/zen-browser",
      ];
  }
}

export function isPortOpen(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Process names used by Zen packages across macOS and Linux. `pgrep -x` matches
 * the kernel's comm field exactly, so every name is checked on its own instead
 * of using a broad `-f` pattern that could match unrelated tools such as this
 * project's own `zen-mcp` process.
 */
const ZEN_PROCESS_NAMES = [
  "zen",
  "zen-bin",
  "zen-browser",
  "zen_browser",
  "zenbrowser",
];

export function isZenProcessRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("tasklist", ["/FI", "IMAGENAME eq zen.exe", "/NH"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      });
      return /zen\.exe/i.test(output);
    }
    for (const name of ZEN_PROCESS_NAMES) {
      try {
        const output = execFileSync("pgrep", ["-x", name], {
          encoding: "utf8",
          timeout: 4000,
        });
        if (output.trim().length > 0) return true;
      } catch {
        // pgrep exits non-zero when nothing matches, so try the next name.
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  config: Pick<
    ZenMcpConfig,
    | "zenPath"
    | "profilePath"
    | "useDefaultProfile"
    | "dataDir"
    | "launchTimeoutMs"
    | "marionettePort"
    | "launchArgs"
  >;
  /** Extra command-line arguments, mainly for tests. */
  args?: string[];
  /** Wait for Marionette's TCP port after spawning. */
  wait?: boolean;
}

/**
 * Starts Zen with Marionette and full chrome access enabled for this process
 * only. No preference is written, so a normal Zen launch never opens a debug
 * port.
 *
 * Every launch carries a random nonce in its environment. Zen's chrome scope
 * can read it back with `Services.env`, which is how the runtime proves that
 * the browser answering on the Marionette port is the one it just started.
 */
export async function launchZen(options: LaunchOptions): Promise<LaunchResult> {
  const executable = findZenExecutable(options.config);
  const { args, profile } = buildLaunchArgs(options.config, options.args ?? []);

  // Zen MCP never attaches to a browser it did not start. If Marionette is
  // already open, that browser belongs to someone else (or to a crashed
  // session), so fail instead of racing for the session.
  if (await isPortOpen(options.config.marionettePort)) {
    throw new ZenLaunchError(
      `Marionette is already listening on port ${options.config.marionettePort}. ` +
        "Zen MCP only controls a browser it launched itself and never attaches " +
        "to an existing session. Quit that Zen instance, or change " +
        "ZEN_MCP_MARIONETTE_PORT if another tool owns that port."
    );
  }

  if (profile) {
    mkdirSync(profile, { recursive: true });
    assertProfileAvailable(profile);
  } else if (isZenProcessRunning()) {
    throw new ZenLaunchError(
      "Zen is already running with its normal profile. Zen MCP will not take " +
        "over an existing browser, and a second launch would only hand the URL " +
        "to it. Quit Zen completely, then try again. To keep your normal Zen " +
        "open while the agent works, use the dedicated agent profile instead " +
        "(zen-mcp setup --dedicated-profile)."
    );
  }

  const nonce = randomUUID();
  logger.info(`launching ${executable} with agent access`);
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
      ZEN_MCP_LAUNCHED: "1",
      ZEN_MCP_LAUNCH_NONCE: nonce,
    },
  });
  child.once("error", (error) => {
    logger.error(`could not start ${executable}: ${error.message}`);
  });
  child.unref();

  if (options.wait === false) {
    return {
      executable,
      pid: child.pid ?? 0,
      port: options.config.marionettePort,
      nonce,
    };
  }

  const port = options.config.marionettePort;
  const deadline = Date.now() + options.config.launchTimeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) {
      logger.info(`Marionette is listening on ${port}`);
      return { executable, pid: child.pid ?? 0, port, nonce };
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  // A failed launch must not leave a browser holding the profile or the
  // singleton lock, which would break every later attempt.
  terminateZenProcess(child.pid);
  throw new ZenLaunchError(
    `Zen did not open Marionette on port ${port} within ${Math.round(
      options.config.launchTimeoutMs / 1000
    )}s. Check that ${executable} is a working Zen installation. The launch ` +
      "attempt was stopped."
  );
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH"],
        { encoding: "utf8", timeout: 4000, windowsHide: true }
      );
      return new RegExp(`\\b${pid}\\b`).test(output);
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForProcessExit(
  pid: number | null | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Firefox and Zen mark a profile as in use differently per platform. Windows
 * holds an exclusive share lock on `parent.lock`, which can be probed by trying
 * to open the file. macOS and Linux create a `.parentlock` symlink (with the
 * older `lock` name still read for compatibility) whose target ends in the
 * owner's PID, so the lock is live only while that process is alive.
 * Spawning a second browser at a locked profile only ends in a hand-off and a
 * long Marionette timeout, so fail early instead.
 */
function assertProfileAvailable(profilePath: string): void {
  if (!isProfileLocked(profilePath)) return;
  throw new ZenLaunchError(
    `The Zen profile at ${profilePath} is already open in another browser. ` +
      "Quit that Zen instance first, or point zenPath/profilePath at another " +
      "profile, then try again."
  );
}

export function isProfileLocked(profilePath: string): boolean {
  if (process.platform === "win32") {
    const lock = join(profilePath, "parent.lock");
    if (!existsSync(lock)) return false;
    try {
      closeSync(openSync(lock, "r+"));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EBUSY";
    }
  }

  // Firefox uses `.parentlock` on Unix, with the older `lock` name still read
  // for compatibility. Some builds leave a `parent.lock` link as well, so
  // check all three. A stale link whose process is gone counts as unlocked:
  // Firefox overwrites it on the next launch.
  for (const name of [".parentlock", "lock", "parent.lock"]) {
    let target: string;
    try {
      target = readlinkSync(join(profilePath, name));
    } catch {
      continue;
    }
    const pid = parsePosixLockPid(target);
    if (pid !== null && isProcessAlive(pid)) return true;
  }
  return false;
}

/**
 * Reads the PID out of a POSIX profile lock target. The target looks like
 * `127.0.0.1:+12345` or `host.name:+12345`, and the PID is whatever integer
 * appears at the end. Returns null when no usable PID is present.
 */
export function parsePosixLockPid(target: string): number | null {
  const match = /(\d+)$/.exec(target.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function terminateZenProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // The process may have exited already, or handed off to an existing Zen.
  }
}

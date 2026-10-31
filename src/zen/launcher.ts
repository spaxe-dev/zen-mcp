import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SidekickConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("launcher");

export class ZenLaunchError extends Error {
  override name = "ZenLaunchError";
}

export interface LaunchResult {
  executable: string;
  pid: number;
  port: number;
}

export function findZenExecutable(config: Pick<SidekickConfig, "zenPath">): string {
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
    "Could not find Zen Browser. Install Zen, or set ZEN_SIDEKICK_ZEN_PATH / " +
      "zenPath in the Zen Sidekick config to the zen executable."
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
    if (process.platform === "darwin") {
      const output = execFileSync("pgrep", ["-x", "zen"], {
        encoding: "utf8",
        timeout: 4000,
      });
      return output.trim().length > 0;
    }
    const output = execFileSync("pgrep", ["-x", "zen"], {
      encoding: "utf8",
      timeout: 4000,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  config: Pick<SidekickConfig, "zenPath" | "profilePath" | "launchTimeoutMs" | "marionettePort">;
  /** Extra command-line arguments, mainly for tests. */
  args?: string[];
  /** Wait for Marionette's TCP port after spawning. */
  wait?: boolean;
}

/**
 * Starts Zen with Marionette and full chrome access enabled for this process
 * only. No preference is written, so a normal Zen launch never opens a debug
 * port.
 */
export async function launchZen(options: LaunchOptions): Promise<LaunchResult> {
  const executable = findZenExecutable(options.config);
  if (options.config.profilePath) {
    assertProfileAvailable(options.config.profilePath);
  }
  const args = ["-marionette", ...(options.args ?? [])];
  if (options.config.profilePath) {
    args.push("-profile", options.config.profilePath);
  }

  logger.info(`launching ${executable} with agent access`);
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
      ZEN_SIDEKICK_LAUNCHED: "1",
    },
  });
  child.unref();

  if (options.wait === false) {
    return { executable, pid: child.pid ?? 0, port: options.config.marionettePort };
  }

  const port = options.config.marionettePort;
  const deadline = Date.now() + options.config.launchTimeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) {
      logger.info(`Marionette is listening on ${port}`);
      return { executable, pid: child.pid ?? 0, port };
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  // A failed launch must not leave a browser holding the profile or the
  // singleton lock, which would break every later attempt.
  terminateChildTree(child.pid);
  const running = isZenProcessRunning();
  throw new ZenLaunchError(
    running
      ? `Zen is running, but Marionette never opened on port ${port}. ` +
        "Zen was probably already open before Zen Sidekick launched it, so the new " +
        "process handed the URL to the existing one. Quit Zen completely, then run " +
        "`zen-sidekick launch` again (or call the zen_launch tool)."
      : `Zen did not open Marionette on port ${port} within ${Math.round(
          options.config.launchTimeoutMs / 1000
        )}s. Check that ${executable} is a working Zen installation. The launch ` +
        "attempt was stopped."
  );
}

/**
 * Firefox holds an exclusive share lock on `parent.lock` while a profile is in
 * use. Spawning a second browser at that profile only ends in a hand-off and a
 * long Marionette timeout, so fail immediately instead.
 */
function assertProfileAvailable(profilePath: string): void {
  if (process.platform !== "win32") return;
  const lock = join(profilePath, "parent.lock");
  if (!existsSync(lock)) return;
  try {
    closeSync(openSync(lock, "r+"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") return;
    throw new ZenLaunchError(
      `The Zen profile at ${profilePath} is already open in another browser. ` +
        "Quit that Zen instance first, or point zenPath/profilePath at another " +
        "profile, then try again."
    );
  }
}

function terminateChildTree(pid: number | undefined): void {
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

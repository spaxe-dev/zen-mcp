import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type SidekickConfig } from "../../src/config.js";
import { launchZen } from "../../src/zen/launcher.js";
import { MarionetteClient } from "../../src/zen/marionette.js";

/**
 * Real-Zen tests are opt-in: they launch a browser, need a disposable profile,
 * and only make sense on a machine with Zen installed.
 *
 *   ZEN_SIDEKICK_E2E=1 npm run test:zen
 */
export function e2eEnabled(): boolean {
  return process.env.ZEN_SIDEKICK_E2E === "1";
}

let generatedProfile: string | null = null;

/**
 * A fresh profile per test-file process. Reusing one profile across runs let a
 * single leaked browser lock it and turn every later run into a 60s timeout.
 */
export function testProfilePath(): string {
  if (process.env.ZEN_SIDEKICK_TEST_PROFILE) {
    return process.env.ZEN_SIDEKICK_TEST_PROFILE;
  }
  if (!generatedProfile) {
    const root =
      process.platform === "win32"
        ? "D:\\tmp\\zen-marionette-test"
        : join(tmpdir(), "zen-sidekick-test");
    mkdirSync(root, { recursive: true });
    generatedProfile = mkdtempSync(join(root, `profile-${process.pid}-`));
  }
  return generatedProfile;
}

export function testConfig(): SidekickConfig {
  return {
    ...loadConfig(),
    profilePath: testProfilePath(),
    autoLaunch: false,
    launchTimeoutMs: 60_000,
    marionettePort: Number(process.env.ZEN_SIDEKICK_TEST_MARIONETTE_PORT ?? 2828),
  };
}

export interface PageServer {
  url: string;
  close(): Promise<void>;
}

export async function startPageServer(html: string): Promise<PageServer> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no http port");
  return {
    url: `http://127.0.0.1:${address.port}/page`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface LaunchedZen {
  launcherPid: number;
  browserPid: number;
}

/**
 * Launches a headless Zen with agent access and resolves the real browser
 * process id (the launcher pid can belong to a short-lived stub).
 */
export async function launchHeadlessZen(
  config: SidekickConfig
): Promise<LaunchedZen> {
  const launch = await launchZen({
    config,
    args: ["--headless", "--new-instance", "-no-remote"],
  });
  const deadline = Date.now() + 5_000;
  const scout = new MarionetteClient({ port: config.marionettePort });
  for (;;) {
    try {
      await scout.connect();
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const browserPid = Number(
    await scout.executeChrome("return Services.appinfo.processID;")
  );
  await scout.disconnect();
  return { launcherPid: launch.pid, browserPid };
}

export function killZen(zen: LaunchedZen | null): void {
  if (!zen) return;
  const pids = new Set([zen.browserPid, zen.launcherPid].filter(Boolean));
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }
}

/** Removes a generated profile. A profile chosen via env is left alone. */
export function removeTestProfile(profilePath: string): void {
  if (process.env.ZEN_SIDEKICK_TEST_PROFILE) return;
  try {
    rmSync(profilePath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {
    // Windows can still hold a file for a moment; the next run uses a new
    // profile anyway, so a leftover directory is harmless.
  }
}

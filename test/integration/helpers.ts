import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ZenMcpConfig } from "../../src/config.js";

/**
 * Real-Zen tests are opt-in: they launch a browser, need a disposable profile,
 * and only make sense on a machine with Zen installed.
 *
 *   ZEN_MCP_E2E=1 npm run test:zen
 */
export function e2eEnabled(): boolean {
  return process.env.ZEN_MCP_E2E === "1";
}

/**
 * Only the headless flag. Isolation from a running user Zen must come from
 * the launcher's own `-no-remote`, so the tests exercise the production path.
 */
const TEST_LAUNCH_ARGS = ["--headless"];

let generatedProfile: string | null = null;

/**
 * A fresh profile per test-file process. The runtime is the only thing that
 * launches Zen now, so this profile is free until the server takes ownership.
 */
export function testProfilePath(): string {
  if (process.env.ZEN_MCP_TEST_PROFILE) {
    return process.env.ZEN_MCP_TEST_PROFILE;
  }
  if (!generatedProfile) {
    const root =
      process.platform === "win32"
        ? "D:\\tmp\\zen-marionette-test"
        : join(tmpdir(), "zen-mcp-test");
    mkdirSync(root, { recursive: true });
    generatedProfile = mkdtempSync(join(root, `profile-${process.pid}-`));
  }
  return generatedProfile;
}

/**
 * Config for an in-process runtime. Headless and consent-free, because a
 * headless window cannot click the approval card.
 */
export function testConfig(): ZenMcpConfig {
  return {
    ...loadConfig(),
    profilePath: testProfilePath(),
    useDefaultProfile: false,
    requireConsent: false,
    consentTimeoutSeconds: 5,
    autoLaunch: false,
    launchTimeoutMs: 60_000,
    marionettePort: Number(process.env.ZEN_MCP_TEST_MARIONETTE_PORT ?? 2828),
    launchArgs: TEST_LAUNCH_ARGS,
  };
}

export interface PageServer {
  url: string;
  close(): Promise<void>;
}

export async function startPageServer(
  html: string | (() => string)
): Promise<PageServer> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(typeof html === "function" ? html() : html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no http port");
  return {
    url: `http://127.0.0.1:${address.port}/page`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Environment for the spawned MCP server. Config and data live in a throwaway
 * directory so a developer config cannot change test policy, and so session,
 * template and audit files never land in the real data directory.
 *
 * The server launches and owns Zen, so the profile and headless flags travel
 * through the environment rather than a separately spawned browser.
 */
export function testServerEnv(): Record<string, string> {
  if (process.env.ZEN_MCP_TEST_SERVER_ENV === "1") {
    return process.env as Record<string, string>;
  }
  const base = process.platform === "win32" ? "D:\\tmp" : tmpdir();
  mkdirSync(base, { recursive: true });
  const dir =
    process.env.ZEN_MCP_TEST_DATA_DIR ??
    mkdtempSync(join(base, "zen-mcp-e2e-"));
  mkdirSync(dir, { recursive: true });
  return {
    ...(process.env as Record<string, string>),
    ZEN_MCP_CONFIG: join(dir, "config.json"),
    ZEN_MCP_DATA_DIR: dir,
    ZEN_MCP_PROFILE: testProfilePath(),
    ZEN_MCP_USE_DEFAULT_PROFILE: "0",
    ZEN_MCP_REQUIRE_CONSENT: "0",
    ZEN_MCP_CONSENT_TIMEOUT_SECONDS: "5",
    ZEN_MCP_LAUNCH_ARGS: TEST_LAUNCH_ARGS.join(" "),
    ZEN_MCP_READ_ONLY: "0",
    ZEN_MCP_ALLOWED_DOMAINS: "",
    ZEN_MCP_AUDIT_LOG: "1",
    ZEN_MCP_WATCH_MIN_INTERVAL_SECONDS: "5",
  };
}

export function killZen(pid: number | null | undefined): void {
  if (!pid) return;
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

/** Removes a generated profile. A profile chosen via env is left alone. */
export function removeTestProfile(profilePath: string): void {
  if (process.env.ZEN_MCP_TEST_PROFILE) return;
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

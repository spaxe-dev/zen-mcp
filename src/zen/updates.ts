import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVER_VERSION } from "../shared/brand.js";

export const PACKAGE_NAME = "@spaxe-dev/zen-mcp";
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(
  PACKAGE_NAME
)}/latest`;

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim()
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Semantic-version precedence. Returns null when either input is not a plain
 * version, so callers can treat an unparseable registry response as unknown.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

export interface UpdateInfo {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: number;
  registry: string;
  error?: string;
}

type FetchLike = (
  input: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Reads the latest published version from the npm registry. Failure is a
 * normal result: callers report `error` and keep working with the installed
 * version instead of failing startup or doctor.
 */
export async function checkForUpdate(
  options: {
    currentVersion?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
  } = {}
): Promise<UpdateInfo> {
  const currentVersion = options.currentVersion ?? SERVER_VERSION;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const base = {
    packageName: PACKAGE_NAME,
    currentVersion,
    checkedAt: Date.now(),
    registry: REGISTRY_URL,
  };
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      headers: {
        accept: "application/json",
        "user-agent": `zen-mcp/${currentVersion}`,
      },
    });
    if (!response.ok) {
      throw new Error(`the registry returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { version?: unknown };
    const latestVersion =
      typeof body?.version === "string" ? body.version.trim() : "";
    if (!parseVersion(latestVersion)) {
      throw new Error("the registry response did not contain a valid version");
    }
    return {
      ...base,
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
    };
  } catch (error) {
    const failure = error as Error;
    const message =
      failure?.name === "TimeoutError" || failure?.name === "AbortError"
        ? "the update check timed out"
        : String(failure?.message ?? failure);
    return {
      ...base,
      latestVersion: null,
      updateAvailable: false,
      error: message,
    };
  }
}

/** Picks the package manager that is running this process, if any. */
export function detectPackageManager(
  env: NodeJS.ProcessEnv = process.env
): PackageManager {
  const agent = String(env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = String(env.npm_execpath ?? "").toLowerCase();
  if (agent.startsWith("pnpm/") || execPath.includes("pnpm")) return "pnpm";
  if (agent.startsWith("yarn/") || execPath.includes("yarn")) return "yarn";
  if (agent.startsWith("bun/") || execPath.includes("bun")) return "bun";
  return "npm";
}

export function updateCommand(
  manager: PackageManager,
  packageName: string = PACKAGE_NAME
): { command: string; args: string[] } {
  const spec = `${packageName}@latest`;
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", spec] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", spec] };
    case "bun":
      return { command: "bun", args: ["add", "-g", spec] };
    default:
      return { command: "npm", args: ["install", "-g", spec] };
  }
}

/**
 * Runs the global install. npm and pnpm are `.cmd` shims on Windows, so those
 * need a shell; the command and arguments are fixed by updateCommand.
 */
export function runInstaller(
  command: string,
  args: string[],
  options: { stdio?: "inherit" | "ignore" } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export interface UpdatePromptState {
  /** The newest release the user has already been prompted about. */
  promptedVersion?: string;
}

/**
 * The prompt is shown once per release; after that the banner keeps only the
 * small icon. A missing or unreadable state file counts as "not prompted".
 */
export function readUpdatePromptState(path: string): UpdatePromptState {
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as {
      promptedVersion?: unknown;
    };
    return typeof body?.promptedVersion === "string"
      ? { promptedVersion: body.promptedVersion }
      : {};
  } catch {
    return {};
  }
}

export function writeUpdatePromptState(
  path: string,
  state: UpdatePromptState
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    // Losing this hint only means the prompt may show again next session.
  }
}

export function shouldPromptUpdate(
  promptedVersion: string | undefined,
  latestVersion: string
): boolean {
  return promptedVersion !== latestVersion;
}

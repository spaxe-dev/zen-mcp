import { spawn } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SERVER_VERSION } from "../shared/brand.js";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";

export const PACKAGE_NAME = "@spaxe-dev/zen-mcp";
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(
  PACKAGE_NAME
)}/latest`;

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const MAX_UPDATE_STATE_BYTES = 64 * 1024;
const DEFAULT_PATHEXT = [".com", ".exe", ".bat", ".cmd"];

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

/** True when candidate is parent itself or sits below it. */
function isSameOrInside(
  candidate: string,
  parent: string,
  caseInsensitive: boolean
): boolean {
  const normalize = (value: string) =>
    caseInsensitive ? value.toLowerCase() : value;
  const rel = relative(normalize(parent), normalize(candidate));
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

/**
 * Finds the installer executable on PATH without letting the current working
 * directory win. Windows resolves bare command names from the cwd before PATH,
 * so a repository that contains npm.cmd would otherwise run on update.
 */
export function resolveInstallerExecutable(
  command: string,
  options: {
    platform?: NodeJS.Platform;
    pathValue?: string;
    pathExt?: string;
    cwd?: string;
  } = {}
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return command;
  const cwd = resolve(options.cwd ?? process.cwd());
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const configuredExt = (options.pathExt ?? process.env.PATHEXT ?? "")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const extensions = configuredExt.length ? configuredExt : DEFAULT_PATHEXT;
  const candidates = command.includes(".") ? [""] : extensions;

  for (const rawEntry of pathValue.split(";")) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!entry) continue;
    const dir = resolve(cwd, entry);
    // An absolute entry is trusted as given, but never the cwd itself.
    // Repo-relative entries that land in the cwd are not trusted.
    const unsafeDir = isAbsolute(entry)
      ? dir.toLowerCase() === cwd.toLowerCase()
      : isSameOrInside(dir, cwd, true);
    if (unsafeDir) continue;
    for (const extension of candidates) {
      const candidate = resolve(join(dir, `${command}${extension}`));
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present in this directory; keep looking along PATH.
      }
    }
  }
  return null;
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
  return new Promise((resolveCode) => {
    const stdio = options.stdio ?? "inherit";
    let child: ReturnType<typeof spawn>;
    try {
      if (process.platform === "win32") {
        // Resolve first: cmd.exe searches the cwd before PATH.
        const executable = resolveInstallerExecutable(command);
        if (!executable) {
          console.error(
            `Could not find ${command} on PATH outside the working directory.`
          );
          resolveCode(1);
          return;
        }
        const comspec = isAbsolute(process.env.ComSpec ?? "")
          ? process.env.ComSpec!
          : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
        child = spawn(
          comspec,
          // cmd /s strips the outer quotes; the inner pair keeps a path with
          // spaces together.
          ["/d", "/s", "/c", `""${executable}" ${args.join(" ")}"`],
          {
            stdio,
            cwd: homedir(),
            env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
            windowsVerbatimArguments: true,
          }
        );
      } else {
        child = spawn(command, args, { stdio });
      }
    } catch {
      resolveCode(1);
      return;
    }
    child.on("error", () => resolveCode(1));
    child.on("close", (code) => resolveCode(code ?? 1));
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
    // Refuse symlinks and oversized files before parsing the contents.
    if (lstatSync(path).isSymbolicLink()) return {};
    const body = JSON.parse(
      readFileTextBounded(path, MAX_UPDATE_STATE_BYTES)
    ) as {
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
    atomicWritePrivate(path, JSON.stringify(state));
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

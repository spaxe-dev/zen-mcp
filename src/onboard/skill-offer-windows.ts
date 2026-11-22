import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";
import {
  installerEnv,
  offerSkillInstall,
  type SkillOfferDeps,
  type SkillOfferOptions,
  type SkillOfferResult,
} from "./skill-offer.js";

/** Matches the POSIX answer timeout; the offer must never hang an install. */
export const WINDOWS_ANSWER_TIMEOUT_MS = 30_000;

const ANSWER_BYTE_LIMIT = 64;
const ANSWER_FILE = "answer.txt";

/**
 * Node cannot open `\\.\CONIN$`/`\\.\CONOUT$`: libuv resolves those names as
 * cwd-relative file paths. cmd.exe can redirect to the console devices, so the
 * prompt runs as a generated batch script whose stdio goes to the console npm
 * detached us from, and the answer comes back through a file.
 */
export function askScript(prompt: string): string {
  return [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    "set \"ZEN_MCP_SKILL_ANSWER=\"",
    `set /p "ZEN_MCP_SKILL_ANSWER=${prompt}" <CON >CON 2>&1`,
    `>"${ANSWER_FILE}" echo(ANSWER=!ZEN_MCP_SKILL_ANSWER!`,
    "endlocal",
    "exit /b 0",
    "",
  ].join("\r\n");
}

/**
 * cmd stores raw CR/LF bytes, instead of moving the cursor, when a nested batch
 * inherits a redirected CON handle. So the installer child never gets CON: its
 * output is captured and replayed through direct console writes, which render
 * correctly.
 */
const INSTALL_COMMAND =
  "npx -y skills add spaxe-dev/zen-mcp --skill zen-mcp --global --yes";

const MAX_CAPTURE_BYTES = 8 * 1024;
const MAX_REPLAY_LINES = 40;
const MAX_REPLAY_CHARS = 4_000;
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Turns captured installer output into console-ready lines, bounded. */
export function capturedOutputText(stdout: string, stderr = ""): string {
  const lines = (stdout + stderr)
    .replace(ANSI_SEQUENCE, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length === MAX_REPLAY_LINES || used + line.length > MAX_REPLAY_CHARS) {
      kept.push("[output truncated]");
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

/** Escapes cmd metacharacters so text prints literally from a batch script. */
export function escapeCmdEcho(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\^/g, "^^")
    .replace(/[&|<>]/g, (char) => `^${char}`)
    .replace(/%/g, "%%");
}

export function printScript(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => `echo(${escapeCmdEcho(line)} >CON 2>&1`);
  return ["@echo off", ...lines, "exit /b 0", ""].join("\r\n");
}

/** Reads the answer the script wrote, stripping the `ANSWER=` marker. */
export function parseWindowsAnswer(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.startsWith("ANSWER=") ? line.slice("ANSWER=".length).trim() : "";
}

interface ScriptRun {
  code: number | null;
  timedOut: boolean;
}

function runScript(dir: string, name: string, text: string, timeoutMs?: number): Promise<ScriptRun> {
  atomicWritePrivate(join(dir, name), text);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", name], {
        cwd: dir,
        stdio: "ignore",
      });
    } catch {
      resolve({ code: null, timedOut: false });
      return;
    }
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut });
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export async function askOnWindowsConsole(
  prompt = "Install the zen-mcp skill for your agent? [y/N] ",
  timeoutMs = WINDOWS_ANSWER_TIMEOUT_MS
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zen-mcp-skill-"));
  try {
    await runScript(dir, "ask.cmd", askScript(prompt), timeoutMs);
    try {
      return parseWindowsAnswer(
        readFileTextBounded(join(dir, ANSWER_FILE), ANSWER_BYTE_LIMIT)
      );
    } catch {
      return "";
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function printOnWindowsConsole(text: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zen-mcp-skill-"));
  try {
    await runScript(dir, "print.cmd", printScript(text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runInstaller(): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", INSTALL_COMMAND], {
        stdio: ["ignore", "pipe", "pipe"],
        env: installerEnv(),
      });
    } catch {
      resolve({ code: 1, output: "" });
      return;
    }
    let captured = "";
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, output: capturedOutputText(captured) });
    };
    const append = (chunk: Buffer): void => {
      if (captured.length < MAX_CAPTURE_BYTES) {
        captured += chunk.toString("utf8", 0, MAX_CAPTURE_BYTES - captured.length);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export async function installOnWindowsConsole(): Promise<number> {
  await printOnWindowsConsole("Installing the zen-mcp skill...");
  const { code, output } = await runInstaller();
  if (output) await printOnWindowsConsole(output);
  return code;
}

/**
 * The install-time offer on Windows. The generated scripts write to the
 * console npm detached us from, so this works with npm's piped stdio and
 * with a terminal. No script contains input from an agent or a user.
 */
export async function offerOnWindowsConsole(
  overrides: Partial<SkillOfferDeps> = {},
  options: SkillOfferOptions = {}
): Promise<SkillOfferResult> {
  return offerSkillInstall(
    {
      isInteractive: () => true,
      ask: () => askOnWindowsConsole(),
      print: (line) => printOnWindowsConsole(line),
      install: () => installOnWindowsConsole(),
      ...overrides,
    },
    options
  );
}

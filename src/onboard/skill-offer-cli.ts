import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installerEnv,
  offerSkillInstall,
  type SkillOfferDeps,
  type SkillOfferOptions,
  type SkillOfferResult,
} from "./skill-offer.js";
import { offerOnWindowsConsole } from "./skill-offer-windows.js";

const ANSWER_TIMEOUT_MS = 30_000;
const TTY_POLL_MS = 20;
const ANSWER_BYTE_LIMIT = 256;

export interface OfferConsole {
  /** Streams back console-backed test doubles; real terminals use readLine. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  outputFd?: number;
  /** Reads one line synchronously from a real terminal. */
  readLine?(timeoutMs: number): string;
  close(): void;
}

/**
 * npm runs lifecycle scripts with no TTY on stdin/stdout and buffers their
 * output, so process.stdin.isTTY is false even in an interactive shell. Open
 * the controlling terminal directly instead. Returns null when there is no
 * console at all (services, CI, GUI installers), in which case the offer is
 * skipped.
 *
 * The read side is nonblocking and read synchronously: an async read parks a
 * threadpool thread in read(2), and closing the descriptor does not cancel it,
 * so the process would outlive the offer on a console that never sends input.
 */
export function openConsole(path = "/dev/tty"): OfferConsole | null {
  // Windows has no equivalent Node can open; it uses skill-offer-windows.ts.
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  try {
    inputFd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    outputFd = openSync(path, "w");
    const readFd = inputFd;
    let closed = false;
    return {
      outputFd,
      readLine: (timeoutMs) => readConsoleLine(readFd, timeoutMs),
      close() {
        if (closed) return;
        closed = true;
        closeConsoleFd(inputFd);
        closeConsoleFd(outputFd);
      },
    };
  } catch {
    closeConsoleFd(inputFd);
    closeConsoleFd(outputFd);
    return null;
  }
}

function closeConsoleFd(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {}
}

/** Sleeps between polls without async handles. Safe on the main thread here. */
const POLL_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** Reads one terminal line (canonical mode) with a hard wall-clock deadline. */
function readConsoleLine(fd: number, timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  while (Date.now() < deadline && bytes.length < ANSWER_BYTE_LIMIT) {
    let read: number;
    try {
      read = readSync(fd, byte, 0, 1, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINTR") continue;
      if (code === "EAGAIN") {
        Atomics.wait(POLL_SLEEP, 0, 0, TTY_POLL_MS);
        continue;
      }
      return "";
    }
    if (read === 0) return "";
    if (byte[0] === 0x0a || byte[0] === 0x0d) break;
    bytes.push(byte[0]!);
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Writes straight to the terminal descriptor: stream writes are buffered and
 * asynchronous, and a closing install must not lose its last lines.
 */
function writeConsole(terminal: OfferConsole, text: string): void {
  if (terminal.outputFd !== undefined) {
    try {
      writeSync(terminal.outputFd, text);
      return;
    } catch {
      return;
    }
  }
  terminal.output?.write(text);
}

function consoleInstall(
  terminal: OfferConsole,
  overrides: Partial<SkillOfferDeps>
): () => Promise<number> {
  if (overrides.install) return overrides.install;
  return () =>
    new Promise<number>((resolve) => {
      let child: ReturnType<typeof spawn>;
      const extra: number[] = [];
      try {
        // The read side is nonblocking, so the installer gets fresh blocking
        // handles: a child reading a nonblocking tty would misbehave on EAGAIN.
        const reopened = terminal.outputFd !== undefined ? openTtyStdio() : null;
        if (reopened) extra.push(...new Set(reopened));
        child = spawn(
          process.platform === "win32" ? "npx.cmd" : "npx",
          [
            "-y",
            "skills",
            "add",
            "spaxe-dev/zen-mcp",
            "--skill",
            "zen-mcp",
            "--global",
            "--yes",
          ],
          {
            stdio: reopened ?? "inherit",
            shell: process.platform === "win32",
            env: installerEnv(),
          }
        );
      } catch {
        for (const fd of extra) closeConsoleFd(fd);
        resolve(1);
        return;
      }
      for (const fd of extra) closeConsoleFd(fd);
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    });
}

function openTtyStdio(): [number, number, number] | null {
  let input: number | undefined;
  let output: number | undefined;
  try {
    input = openSync("/dev/tty", "r");
    output = openSync("/dev/tty", "w");
    return [input, output, output];
  } catch {
    closeConsoleFd(input);
    closeConsoleFd(output);
    return null;
  }
}

/** Asks on a real terminal, with a timeout so a stalled install cannot hang. */
export async function offerOnConsole(
  terminal: OfferConsole,
  overrides: Partial<SkillOfferDeps> = {},
  options: SkillOfferOptions = {}
): Promise<SkillOfferResult> {
  const ask = (question: string): Promise<string> => {
    writeConsole(terminal, question);
    if (terminal.readLine) {
      return Promise.resolve(terminal.readLine(ANSWER_TIMEOUT_MS));
    }
    return new Promise((resolve) => {
      const rl = createInterface({
        input: terminal.input!,
        output: terminal.output!,
        terminal: false,
      });
      const timer = setTimeout(() => {
        rl.close();
        resolve("");
      }, ANSWER_TIMEOUT_MS);
      rl.once("line", (line) => {
        clearTimeout(timer);
        rl.close();
        resolve(line);
      });
    });
  };

  return offerSkillInstall({
    isInteractive: () => true,
    ask,
    print: (line) => {
      writeConsole(terminal, `${line}\n`);
    },
    install: consoleInstall(terminal, overrides),
    ...overrides,
  }, options);
}

// Only prompt when this file is the process entry point. Importing it for
// tests must never start an interactive offer.
const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entry) {
  if (process.platform === "win32") {
    // Node cannot open the console devices, so ask through cmd.exe instead.
    await offerOnWindowsConsole();
  } else {
    const terminal = openConsole();
    if (terminal) {
      try {
        await offerOnConsole(terminal);
      } finally {
        terminal.close();
      }
    }
  }
}

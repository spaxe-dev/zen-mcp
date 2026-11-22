import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  offerSkillInstall,
  type SkillOfferDeps,
  type SkillOfferOptions,
  type SkillOfferResult,
} from "./skill-offer.js";

const ANSWER_TIMEOUT_MS = 30_000;

export interface OfferConsole {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** File descriptors, when backed by a real terminal. */
  inputFd?: number;
  outputFd?: number;
  close(): void;
}

/**
 * npm runs lifecycle scripts with no TTY on stdin/stdout and buffers their
 * output, so process.stdin.isTTY is false even in an interactive shell. Open
 * the controlling terminal directly instead. Returns null when there is no
 * console at all (services, CI, GUI installers), in which case the offer is
 * skipped.
 */
export function openConsole(): OfferConsole | null {
  const paths =
    process.platform === "win32"
      ? { input: "\\\\.\\CONIN$", output: "\\\\.\\CONOUT$" }
      : { input: "/dev/tty", output: "/dev/tty" };
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  try {
    inputFd = openSync(paths.input, "r");
    outputFd = openSync(paths.output, "w");
    // Node ignores the path when fd is supplied; it is only there to satisfy
    // the stream typings, which do not allow a null path with an fd.
    const input = createReadStream(paths.input, {
      fd: inputFd,
      autoClose: false,
    });
    const output = createWriteStream(paths.output, {
      fd: outputFd,
      autoClose: false,
    });
    return {
      input,
      output,
      inputFd,
      outputFd,
      close() {
        input.destroy();
        output.end();
        if (inputFd !== undefined) closeSync(inputFd);
        if (outputFd !== undefined) closeSync(outputFd);
      },
    };
  } catch {
    if (inputFd !== undefined) closeSync(inputFd);
    if (outputFd !== undefined) closeSync(outputFd);
    return null;
  }
}

function consoleInstall(
  terminal: OfferConsole,
  overrides: Partial<SkillOfferDeps>
): () => Promise<number> {
  if (overrides.install) return overrides.install;
  return () =>
    new Promise<number>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          process.platform === "win32" ? "npx.cmd" : "npx",
          ["-y", "skills", "add", "spaxe-dev/zen-mcp", "--skill", "zen-mcp"],
          {
            stdio:
              terminal.inputFd !== undefined && terminal.outputFd !== undefined
                ? [terminal.inputFd, terminal.outputFd, terminal.outputFd]
                : "inherit",
            shell: process.platform === "win32",
          }
        );
      } catch {
        resolve(1);
        return;
      }
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    });
}

/** Asks on a real terminal, with a timeout so a stalled install cannot hang. */
export async function offerOnConsole(
  terminal: OfferConsole,
  overrides: Partial<SkillOfferDeps> = {},
  options: SkillOfferOptions = {}
): Promise<SkillOfferResult> {
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      terminal.output.write(question);
      const rl = createInterface({
        input: terminal.input,
        output: terminal.output,
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

  return offerSkillInstall({
    isInteractive: () => true,
    ask,
    print: (line) => terminal.output.write(`${line}\n`),
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
  const terminal = openConsole();
  if (terminal) {
    try {
      await offerOnConsole(terminal);
    } finally {
      terminal.close();
    }
  }
}

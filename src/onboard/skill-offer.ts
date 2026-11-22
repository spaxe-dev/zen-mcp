import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The documented command, shown when the offer is declined or unavailable. */
export const SKILL_INSTALL_COMMAND =
  "npx skills add spaxe-dev/zen-mcp --skill zen-mcp --global --yes";

export type SkillOfferResult =
  | "installed"
  | "declined"
  | "skipped"
  | "failed";

export interface SkillOfferDeps {
  isInteractive: () => boolean;
  ask: (question: string) => Promise<string>;
  print: (line: string) => void | Promise<void>;
  install: () => Promise<number>;
}

export interface SkillOfferOptions {
  env?: NodeJS.ProcessEnv;
  /** No output at all when there is no terminal (used by install scripts). */
  quietWhenNonInteractive?: boolean;
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
  } finally {
    rl.close();
  }
}

/**
 * npm copies its config into lifecycle scripts, including
 * npm_config_global=true for `npm install -g`. A nested `npx` that inherits it
 * skips the temporary install's bin directory when its cache is cold, fails
 * with `sh: skills: command not found` and exits 127. The installer therefore
 * runs with that one variable removed; everything else is inherited.
 */
export function installerEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== "npm_config_global") clean[key] = value;
  }
  return clean;
}

/** Runs the documented skills CLI. Arguments are fixed; no agent input is shell-quoted. */
function defaultInstall(): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
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
          stdio: "inherit",
          shell: process.platform === "win32",
          env: installerEnv(),
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

/**
 * Offers to install the consumer agent skill. Returns a result rather than
 * throwing: a declined or failed skill install must never fail setup, onboard,
 * an update or a package install.
 */
export async function offerSkillInstall(
  deps: Partial<SkillOfferDeps> = {},
  options: SkillOfferOptions = {}
): Promise<SkillOfferResult> {
  const env = options.env ?? process.env;

  // CI and explicit opt-out never prompt. The OFFERED marker makes the helper
  // idempotent within a process; DEFER suppresses the nested npm postinstall
  // offer while `zen-mcp update` runs the package manager.
  if (
    env.CI ||
    env.ZEN_MCP_NO_SKILL_PROMPT ||
    env.ZEN_MCP_SKILL_OFFERED ||
    env.ZEN_MCP_SKILL_DEFER
  ) {
    return "skipped";
  }
  env.ZEN_MCP_SKILL_OFFERED = "1";

  const resolved: SkillOfferDeps = {
    isInteractive: deps.isInteractive ?? defaultIsInteractive,
    ask: deps.ask ?? defaultAsk,
    print: deps.print ?? ((line: string) => console.log(line)),
    install: deps.install ?? defaultInstall,
  };

  const later = `Install it later with:\n  ${SKILL_INSTALL_COMMAND}`;
  if (!resolved.isInteractive()) {
    if (!options.quietWhenNonInteractive) await resolved.print(later);
    return "skipped";
  }

  const answer = await resolved.ask(
    "Install the zen-mcp skill for your agent? [y/N] "
  );
  if (!/^\s*y(es)?\s*$/i.test(answer)) {
    await resolved.print(`No problem. ${later}`);
    return "declined";
  }

  const code = await resolved.install();
  if (code !== 0) {
    await resolved.print(`Skill install failed (exit ${code}). ${later}`);
    return "failed";
  }
  await resolved.print("Skill installed. Restart your agent so it loads the skill.");
  return "installed";
}

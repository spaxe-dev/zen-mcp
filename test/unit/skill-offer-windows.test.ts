import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILL_INSTALL_COMMAND } from "../../src/onboard/skill-offer.js";
import {
  askScript,
  capturedOutputText,
  escapeCmdEcho,
  offerOnWindowsConsole,
  parseWindowsAnswer,
  printScript,
} from "../../src/onboard/skill-offer-windows.js";

describe("windows install-time prompt scripts", () => {
  it("reads the answer from and writes the prompt to the console", () => {
    const script = askScript("Install the zen-mcp skill for your agent? [y/N] ");
    assert.match(script, /set \/p "ZEN_MCP_SKILL_ANSWER=.*\[y\/N\] " <CON >CON/);
    assert.match(script, /echo\(ANSWER=!ZEN_MCP_SKILL_ANSWER!/);
    assert.match(script, /"answer\.txt"/);
    assert.match(script, /EnableDelayedExpansion/);
    assert.ok(script.includes("\r\n"));
  });

  it("replays captured installer output without escape codes", () => {
    assert.equal(
      capturedOutputText("\x1b[32mInstalled\x1b[0m the skill\r\n\r\nsecond line \r\n"),
      "Installed the skill\nsecond line"
    );
    assert.equal(capturedOutputText(""), "");
  });

  it("bounds the replayed output", () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const text = capturedOutputText(long);
    assert.match(text, /\[output truncated\]/);
    assert.ok(text.length <= 4_000 + "[output truncated]".length + 1);
    assert.ok(text.split("\n").length <= 41);
  });

  it("keeps the documented skills command for manual runs", () => {
    assert.equal(
      SKILL_INSTALL_COMMAND,
      "npx skills add spaxe-dev/zen-mcp --skill zen-mcp --global --yes"
    );
  });

  it("prints message lines through the console, one echo per line", () => {
    const script = printScript("No problem. Install it later with:\n  npx skills add x");
    assert.match(script, /echo\(No problem\. Install it later with: >CON/);
    assert.match(script, /echo\(  npx skills add x >CON/);
  });

  it("escapes cmd metacharacters and strips newlines", () => {
    assert.equal(
      escapeCmdEcho("a & b | c < d > e ^ f %PATH%"),
      "a ^& b ^| c ^< d ^> e ^^ f %%PATH%%"
    );
    assert.equal(escapeCmdEcho("one\ntwo"), "one two");
    assert.equal(escapeCmdEcho("carriage\rreturn\r\nend"), "carriage return end");
  });

  it("parses the answer marker and rejects everything else", () => {
    assert.equal(parseWindowsAnswer("ANSWER=y\r\n"), "y");
    assert.equal(parseWindowsAnswer("ANSWER=  Yes  \r\n"), "Yes");
    assert.equal(parseWindowsAnswer("ANSWER=\r\n"), "");
    assert.equal(parseWindowsAnswer(""), "");
    assert.equal(parseWindowsAnswer("Environment variable X not defined"), "");
  });
});

describe("windows install-time offer", () => {
  function harness() {
    const printed: string[] = [];
    let asks = 0;
    let installs = 0;
    const deps = {
      isInteractive: () => true,
      ask: async () => ((asks += 1), "y"),
      print: (line: string) => {
        printed.push(line);
      },
      install: async () => ((installs += 1), 0),
    };
    return {
      deps,
      printed,
      asks: () => asks,
      installs: () => installs,
    };
  }

  it("offers once per process and installs on yes", async () => {
    const h = harness();
    const env: NodeJS.ProcessEnv = {};
    assert.equal(await offerOnWindowsConsole(h.deps, { env }), "installed");
    assert.equal(await offerOnWindowsConsole(h.deps, { env }), "skipped");
    assert.equal(h.asks(), 1);
    assert.equal(h.installs(), 1);
  });

  it("does not ask in CI", async () => {
    const h = harness();
    assert.equal(
      await offerOnWindowsConsole(h.deps, { env: { CI: "true" } }),
      "skipped"
    );
    assert.equal(h.asks(), 0);
  });

  it("prints the later command when declined", async () => {
    const h = harness();
    h.deps.ask = async () => "n";
    const added: string[] = [];
    h.deps.print = (line: string) => {
      added.push(line);
    };
    assert.equal(await offerOnWindowsConsole(h.deps, { env: {} }), "declined");
    assert.match(added.join("\n"), /Install it later with:/);
  });

  it("reports a failed install without throwing", async () => {
    const h = harness();
    h.deps.install = async () => 3;
    const added: string[] = [];
    h.deps.print = (line: string) => {
      added.push(line);
    };
    assert.equal(await offerOnWindowsConsole(h.deps, { env: {} }), "failed");
    assert.match(added.join("\n"), /failed \(exit 3\)/);
  });
});

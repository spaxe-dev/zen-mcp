import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  offerSkillInstall,
  SKILL_INSTALL_COMMAND,
  type SkillOfferDeps,
} from "../../src/onboard/skill-offer.js";

function harness(
  overrides: Partial<SkillOfferDeps> = {},
  env: NodeJS.ProcessEnv = {}
) {
  const printed: string[] = [];
  let asks = 0;
  let installs = 0;
  const deps: SkillOfferDeps = {
    isInteractive: overrides.isInteractive ?? (() => true),
    print: overrides.print ?? ((line: string) => printed.push(line)),
    ask: async (question) => {
      asks += 1;
      return overrides.ask ? overrides.ask(question) : "n";
    },
    install: async () => {
      installs += 1;
      return overrides.install ? overrides.install() : 0;
    },
  };
  return {
    deps,
    env,
    printed,
    asks: () => asks,
    installs: () => installs,
    offer: (options: Parameters<typeof offerSkillInstall>[1] = {}) =>
      offerSkillInstall(deps, { env, ...options }),
  };
}

describe("skill install offer", () => {
  it("uses the documented skills command", () => {
    assert.equal(
      SKILL_INSTALL_COMMAND,
      "npx skills add spaxe-dev/zen-mcp --skill zen-mcp"
    );
  });

  it("installs the skill when the user answers yes", async () => {
    const h = harness({
      ask: async () => "y",
    });
    assert.equal(await h.offer(), "installed");
    assert.equal(h.installs(), 1);
    assert.match(h.printed.join("\n"), /Skill installed/);
  });

  it("accepts yes in any case and with surrounding space", async () => {
    for (const answer of ["YES", " yes ", "Yes"]) {
      const h = harness({ ask: async () => answer });
      assert.equal(await h.offer(), "installed");
      assert.equal(h.installs(), 1);
    }
  });

  it("prints the later command when declined", async () => {
    const h = harness({ ask: async () => "no" });
    assert.equal(await h.offer(), "declined");
    assert.equal(h.installs(), 0);
    assert.match(h.printed.join("\n"), /Install it later with:/);
    assert.ok(h.printed.join("\n").includes(SKILL_INSTALL_COMMAND));
  });

  it("prints the later command without a terminal", async () => {
    const h = harness({ isInteractive: () => false });
    assert.equal(await h.offer(), "skipped");
    assert.equal(h.asks(), 0);
    assert.ok(h.printed.join("\n").includes(SKILL_INSTALL_COMMAND));
  });

  it("stays silent without a terminal when requested", async () => {
    const h = harness({ isInteractive: () => false });
    assert.equal(await h.offer({ quietWhenNonInteractive: true }), "skipped");
    assert.deepEqual(h.printed, []);
  });

  it("skips in CI", async () => {
    const h = harness({}, { CI: "true" });
    assert.equal(await h.offer(), "skipped");
    assert.equal(h.asks(), 0);
    assert.deepEqual(h.printed, []);
  });

  it("skips on explicit opt-out", async () => {
    const h = harness({}, { ZEN_MCP_NO_SKILL_PROMPT: "1" });
    assert.equal(await h.offer(), "skipped");
    assert.equal(h.asks(), 0);
  });

  it("skips the nested offer while an update runs", async () => {
    const h = harness({}, { ZEN_MCP_SKILL_DEFER: "1" });
    assert.equal(await h.offer(), "skipped");
    assert.equal(h.asks(), 0);
  });

  it("reports a failed skill install with the retry command", async () => {
    const h = harness({ ask: async () => "y", install: async () => 7 });
    assert.equal(await h.offer(), "failed");
    assert.ok(h.printed.join("\n").includes(SKILL_INSTALL_COMMAND));
  });

  it("offers only once per process", async () => {
    const h = harness({ ask: async () => "y" });
    assert.equal(await h.offer(), "installed");
    assert.equal(await h.offer(), "skipped");
    assert.equal(h.asks(), 1);
    assert.equal(h.installs(), 1);
  });
});

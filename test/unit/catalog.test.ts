import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_TOOL_NAMES,
  searchCatalog,
  TOOL_META,
  TOOL_SURFACES,
  toolsForSurface,
  validateCatalog,
} from "../../src/mcp/catalog.js";
import { TOOL_DESCRIPTIONS } from "../../src/mcp/descriptions.js";
import { serverInstructions } from "../../src/mcp/server.js";

describe("capability catalogue", () => {
  it("is internally consistent", () => {
    assert.deepEqual(validateCatalog(), []);
    assert.equal(new Set(ALL_TOOL_NAMES).size, ALL_TOOL_NAMES.length);
  });

  it("keeps research, core and full as nested surfaces", () => {
    const research = toolsForSurface("research");
    const core = toolsForSurface("core");
    const full = toolsForSurface("full");

    assert.ok(research.size >= 16 && research.size <= 19, "research budget");
    assert.equal(core.size, 38);
    assert.equal(full.size, ALL_TOOL_NAMES.length);
    for (const name of research) assert.ok(core.has(name), `${name} missing from core`);
    for (const name of core) assert.ok(full.has(name), `${name} missing from full`);
  });

  it("gives every tool a category, surfaces and a bounded first paragraph", () => {
    for (const name of ALL_TOOL_NAMES) {
      const meta = TOOL_META[name];
      assert.ok(meta, `${name} has no metadata`);
      assert.ok(meta.category, `${name} has no category`);
      assert.ok(meta.surfaces.length > 0, `${name} has no surface`);
      assert.ok(TOOL_DESCRIPTIONS[name], `${name} has no description`);
      const first = TOOL_DESCRIPTIONS[name].split(/\n\s*\n/)[0] ?? "";
      assert.ok(
        first.length <= 400,
        `${name} first paragraph is ${first.length} characters`
      );
    }
  });

  it("keeps server instructions under the always-on budget", () => {
    for (const surface of TOOL_SURFACES) {
      const text = serverInstructions(surface);
      assert.ok(text.length <= 1_500, `${surface} instructions are ${text.length} chars`);
      assert.match(text, /zen_tools_search/);
      assert.match(text, /zen:\/\/capabilities/);
      assert.match(text, /untrusted/);
    }
  });

  it("finds hidden capabilities by keyword and by exact name", () => {
    const audit = searchCatalog("audit");
    assert.ok(audit.some((entry) => entry.name === "zen_tabs_audit"));
    assert.ok(audit.some((entry) => entry.name === "zen_audit_tail"));
    assert.equal(audit[0]?.name.startsWith("zen_audit"), true);

    const exact = searchCatalog("zen_show_evidence");
    assert.equal(exact[0]?.name, "zen_show_evidence");

    const folders = searchCatalog("folders", { category: "organization" });
    assert.ok(folders.length > 0);
    assert.ok(folders.every((entry) => entry.category === "organization"));
  });

  it("keeps summaries short enough for discovery results", () => {
    for (const entry of searchCatalog("", { limit: 50 })) {
      assert.ok(entry.summary.length <= 223, `${entry.name} summary is too long`);
    }
  });
});

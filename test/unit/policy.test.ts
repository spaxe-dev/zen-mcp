import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ALL_TOOL_NAMES } from "../../src/mcp/catalog.js";
import { MUTATING_TOOLS } from "../../src/mcp/guard.js";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  CAPABILITY_BY_BRIDGE_OPERATION,
  CAPABILITY_BY_TOOL,
  INVALID_POLICY_ALLOWED,
  LEGACY_READ_ONLY_CAPABILITIES,
  MODE_MATRIX,
  POLICY_MODES,
  allRegisteredBridgeOperations,
  allRegisteredTools,
  capabilitiesForTool,
  createPolicy,
  evaluate,
  isCapabilityId,
  isPermanentDeny,
  modeAllows,
  policyFromLegacyConfig,
  siteDecision,
  type CapabilityId,
  type CreatePolicyOptions,
  type PolicyMode,
  type PolicySnapshot,
} from "../../src/shared/policy.js";
import { BRIDGE_METHODS } from "../../src/shared/protocol.js";
import { snapshotOfPolicy } from "./policy-fixtures.js";

function snap(
  options: CreatePolicyOptions = {},
  source: PolicySnapshot["source"] = "file"
): PolicySnapshot {
  return snapshotOfPolicy(createPolicy(options), source);
}

function decide(
  options: CreatePolicyOptions,
  capability: string,
  urls?: readonly string[]
) {
  return evaluate(snap(options), { capability, urls });
}

function codeOf(decision: ReturnType<typeof evaluate>): string | undefined {
  return decision.code ?? decision.site?.code;
}

function invalidSnapshot(): PolicySnapshot {
  return {
    ...snap({}, "invalid"),
    source: "invalid",
    revision: 0,
    error: "broken policy",
    errorCode: "invalid_json",
  };
}

const HOME = "https://example.com/page";
const PERMANENT: readonly CapabilityId[] = [
  "browser.internalPages",
  "download.write",
  "cookies.read",
  "password.read",
  "settings.write",
  "extensions.manage",
  "browsingData.write",
  "profileFilesystem.read",
  "devtools.use",
  "upload.write",
  "software.install",
  "screenshot.capture",
];

describe("capability registry", () => {
  it("has unique ids and a definition for each", () => {
    assert.equal(new Set(CAPABILITY_IDS).size, CAPABILITY_IDS.length);
    assert.equal(Object.keys(CAPABILITIES).length, CAPABILITY_IDS.length);
    for (const id of CAPABILITY_IDS) {
      assert.ok(CAPABILITIES[id]);
      assert.ok(POLICY_MODES.includes(CAPABILITIES[id].minMode));
    }
  });

  it("covers every exposed MCP tool exactly once", () => {
    assert.equal(allRegisteredTools().length, ALL_TOOL_NAMES.length);
    for (const tool of ALL_TOOL_NAMES) {
      assert.ok(CAPABILITY_BY_TOOL.has(tool), `${tool} has no capability`);
      const caps = capabilitiesForTool(tool);
      assert.ok(caps.length >= 1, tool);
      assert.equal(new Set(caps).size, caps.length, tool);
    }
    assert.deepEqual(
      [...CAPABILITY_BY_TOOL.keys()].sort(),
      [...ALL_TOOL_NAMES].sort()
    );
  });

  it("covers every bridge operation exactly once", () => {
    assert.equal(BRIDGE_METHODS.length, 30);
    assert.deepEqual(allRegisteredBridgeOperations(), [...BRIDGE_METHODS].sort());
    for (const operation of BRIDGE_METHODS) {
      assert.ok(
        CAPABILITY_BY_BRIDGE_OPERATION.has(operation),
        `${operation} has no capability`
      );
    }
  });

  it("marks the expected capabilities permanent and nothing else", () => {
    const permanent = CAPABILITY_IDS.filter(isPermanentDeny);
    assert.deepEqual(permanent.sort(), [...PERMANENT].sort());
    for (const id of permanent) {
      assert.equal(CAPABILITIES[id].tools.length, 0, id);
      assert.equal(MODE_MATRIX.full[id], false, id);
    }
  });

  it("keeps capabilities that only guard write paths non-permanent", () => {
    assert.equal(isPermanentDeny("download.write"), true);
    assert.equal(isPermanentDeny("page.evidenceClear"), false);
    assert.equal(isPermanentDeny("ui.answers"), false);
  });

  it("requires window focus only for calls that request it", () => {
    assert.deepEqual(capabilitiesForTool("zen_tab_select", {}), ["tab.select"]);
    assert.deepEqual(capabilitiesForTool("zen_tab_select", { focusWindow: true }), [
      "tab.select",
      "window.focus",
    ]);
    assert.deepEqual(capabilitiesForTool("zen_split_view", { activate: false }), [
      "layout.split",
    ]);
    assert.deepEqual(capabilitiesForTool("zen_split_view", {}), [
      "layout.split",
      "window.focus",
    ]);
  });

  it("offers no agent-facing way to write policy", () => {
    for (const tool of ALL_TOOL_NAMES) {
      assert.doesNotMatch(tool, /policy/i, tool);
    }
    assert.equal(MUTATING_TOOLS.has("zen_config"), false);

    const mcpDir = join(process.cwd(), "src", "mcp");
    for (const file of readdirSync(mcpDir)) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(mcpDir, file), "utf8");
      // The read-only watcher is allowed; writer imports are not.
      assert.doesNotMatch(
        text,
        /import\s+\*\s+as\s+\w+\s+from\s+".*policy-file/,
        file
      );
      assert.doesNotMatch(
        text,
        /\b(savePolicyFile|updatePolicyFile|initPolicyFile)\b/,
        file
      );
    }
  });
});

describe("mode matrix", () => {
  it("matches the expected effective capability counts", () => {
    assert.deepEqual(
      Object.fromEntries(
        POLICY_MODES.map((mode) => [
          mode,
          CAPABILITY_IDS.filter((id) => MODE_MATRIX[mode][id]).length,
        ])
      ),
      { restricted: 5, normal: 34, permissive: 42, full: 42 }
    );
  });

  it("promotes tab close, clicking, typing and questions at normal", () => {
    for (const id of ["tab.close", "page.click", "page.type", "ui.ask"] as const) {
      assert.equal(MODE_MATRIX.restricted[id], false, id);
      assert.equal(MODE_MATRIX.normal[id], true, id);
    }
  });

  it("denies every capability outside its minimum mode", () => {
    for (const mode of POLICY_MODES) {
      for (const id of CAPABILITY_IDS) {
        const decision = decide({ mode }, id, [HOME]);
        assert.equal(
          decision.allowed,
          MODE_MATRIX[mode][id] && !isPermanentDeny(id),
          `${mode}/${id}`
        );
      }
    }
  });

  it("keeps a missing policy restricted", () => {
    const snapshot = snap();
    assert.equal(snapshot.policy.mode, "restricted");
    assert.equal(snapshot.source, "file");
    assert.equal(
      evaluate(snapshot, { capability: "browser.status" }).allowed,
      true
    );
    assert.equal(
      evaluate(snapshot, { capability: "tools.discover" }).allowed,
      true
    );
    assert.equal(
      evaluate(snapshot, { capability: "page.read" }).allowed,
      false
    );
    assert.equal(
      evaluate(snapshot, { capability: "tab.list" }).allowed,
      false
    );
  });

  it("exposes the matrix through modeAllows", () => {
    for (const mode of POLICY_MODES) {
      for (const id of CAPABILITY_IDS) {
        assert.equal(MODE_MATRIX[mode][id], modeAllows(mode, id));
      }
    }
  });
});

describe("deny precedence", () => {
  it("denies permanent capabilities even in full mode and with allow", () => {
    for (const id of PERMANENT) {
      assert.equal(decide({ mode: "full" }, id).code, "permanently_denied");
      assert.equal(
        decide({ mode: "full", capabilities: { [id]: "allow" } }, id).code,
        "permanently_denied"
      );
    }
    assert.equal(decide({ mode: "full" }, "download.write", [HOME]).allowed, false);
  });

  it("lets a restriction override an explicit allow", () => {
    const decision = decide(
      {
        mode: "full",
        capabilities: { "page.click": "allow" },
        restrictions: { "page.click": "deny" },
      },
      "page.click",
      [HOME]
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "restricted");
  });

  it("lets an explicit deny override the mode", () => {
    const decision = decide(
      { mode: "full", capabilities: { "nav.open": "deny" } },
      "nav.open",
      [HOME]
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "capability_denied");
  });

  it("denies unknown and inherited capability names", () => {
    for (const name of [
      "unknown.capability",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      assert.equal(isCapabilityId(name), false, name);
      const decision = evaluate(snap({ mode: "full" }), {
        capability: name,
        urls: [HOME],
      });
      assert.equal(decision.allowed, false, name);
      assert.equal(decision.code, "unknown_capability", name);
    }
  });

  it("denies everything but diagnostics while the policy is invalid", () => {
    for (const id of CAPABILITY_IDS) {
      const decision = evaluate(invalidSnapshot(), {
        capability: id,
        urls: [HOME],
      });
      assert.equal(decision.allowed, INVALID_POLICY_ALLOWED.has(id), id);
    }
    assert.equal(
      evaluate(invalidSnapshot(), { capability: "browser.status" }).allowed,
      false
    );
  });

  it("never lets a website rule grant a capability the mode denies", () => {
    const decision = decide(
      {
        mode: "restricted",
        websites: {
          rules: [{ host: "example.com", capabilities: { "page.click": "allow" } }],
        },
      },
      "page.click",
      [HOME]
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "mode_denied");
  });
});

describe("website matching", () => {
  it("matches a bare host exactly and on label boundaries", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: { default: "deny", allow: ["example.com"] },
    };
    assert.equal(decide(options, "nav.open", ["https://example.com/"]).allowed, true);
    assert.equal(
      decide(options, "nav.open", ["https://docs.example.com/"]).allowed,
      true
    );
    assert.equal(
      codeOf(decide(options, "nav.open", ["https://notexample.com/"])),
      "site_default_denied"
    );
    assert.equal(
      codeOf(decide(options, "nav.open", ["https://example.com.evil.test/"])),
      "site_default_denied"
    );
  });

  it("matches a wildcard only on real subdomains", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: { default: "deny", allow: ["*.example.com"] },
    };
    assert.equal(
      decide(options, "nav.open", ["https://docs.example.com/"]).allowed,
      true
    );
    assert.equal(
      codeOf(decide(options, "nav.open", ["https://example.com/"])),
      "site_default_denied"
    );
  });

  it("is case-insensitive and ignores a trailing dot", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: { default: "deny", allow: ["EXAMPLE.com"] },
    };
    assert.equal(
      decide(options, "nav.open", ["https://Docs.Example.COM./"]).allowed,
      true
    );
  });

  it("lets a block override an allow entry and a rule allow", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: {
        default: "allow",
        allow: ["example.com"],
        block: ["example.com"],
        rules: [{ host: "example.com", capabilities: { "nav.open": "allow" } }],
      },
    };
    const decision = decide(options, "nav.open", [HOME]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.site?.code, "site_blocked");
  });

  it("lets a rule deny override a rule allow and the allow list", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: {
        default: "allow",
        allow: ["example.com"],
        rules: [
          { host: "example.com", capabilities: { "nav.open": "allow" } },
          { host: "docs.example.com", capabilities: { "nav.open": "deny" } },
        ],
      },
    };
    assert.equal(
      codeOf(decide(options, "nav.open", ["https://docs.example.com/"])),
      "site_rule_denied"
    );
  });

  it("applies a rule only to the named capability", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: {
        default: "allow",
        rules: [{ host: "example.com", capabilities: { "page.click": "deny" } }],
      },
    };
    assert.equal(decide(options, "page.click", [HOME]).allowed, false);
    assert.equal(decide(options, "page.read", [HOME]).allowed, true);
  });

  it("denies a site missing from an allowlist by default", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: { default: "deny", allow: ["allowed.test"] },
    };
    assert.equal(
      codeOf(decide(options, "nav.open", ["https://other.test/"])),
      "site_default_denied"
    );
  });

  it("checks every URL and denies the call if any fails", () => {
    const options: CreatePolicyOptions = {
      mode: "full",
      websites: { default: "allow", block: ["bad.test"] },
    };
    assert.equal(
      codeOf(decide(options, "nav.open", ["https://good.test/", "https://bad.test/"])),
      "site_blocked"
    );
  });

  it("allows about:blank only for nav.open", () => {
    const options: CreatePolicyOptions = { mode: "full" };
    assert.equal(decide(options, "nav.open", ["about:blank"]).allowed, true);
    assert.equal(codeOf(decide(options, "nav.glance", ["about:blank"])), "internal_page");
    assert.equal(
      codeOf(decide(options, "nav.open", ["chrome://settings"])),
      "internal_page"
    );
    assert.equal(
      decide(options, "nav.open", ["https://example.com"]).allowed,
      true
    );
  });

  it("requires a URL for capabilities that cannot be site-filtered", () => {
    assert.equal(decide({ mode: "full" }, "page.evidence").code, "unscoped_url");
    assert.equal(
      decide({ mode: "full" }, "page.evidence", [HOME]).allowed,
      true
    );
    assert.equal(
      decide({ mode: "full" }, "page.evidenceClear").allowed,
      true
    );
    assert.equal(decide({ mode: "full" }, "page.read").allowed, true);
  });

  it("returns a deterministic site decision for no URL", () => {
    const websites = createPolicy().websites;
    assert.equal(siteDecision(websites, "", "page.read").code, "internal_page");
  });
});

describe("legacy migration", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("turns a default config into restricted, never normal", () => {
    const policy = policyFromLegacyConfig({}, now);
    assert.equal(policy.mode, "restricted");
    assert.equal(policy.revision, 1);
    assert.deepEqual(policy.restrictions, {});
    assert.equal(policy.websites.default, "allow");
  });

  it("keeps readOnly behaviour with deny-only restrictions", () => {
    const policy = policyFromLegacyConfig({ readOnly: true }, now);
    assert.equal(policy.mode, "permissive");
    for (const id of LEGACY_READ_ONLY_CAPABILITIES) {
      assert.equal(policy.restrictions[id], "deny", id);
      assert.equal(
        evaluate(snapshotOfPolicy(policy), { capability: id, urls: [HOME] })
          .allowed,
        false,
        id
      );
    }
    for (const id of CAPABILITY_IDS) {
      if (policy.restrictions[id] === "deny" || isPermanentDeny(id)) continue;
      assert.equal(
        evaluate(snapshotOfPolicy(policy), { capability: id, urls: [HOME] })
          .allowed,
        true,
        `${id} should stay available`
      );
    }
  });

  it("keeps every mutating tool blocked under readOnly", () => {
    const snapshot = snapshotOfPolicy(
      policyFromLegacyConfig({ readOnly: true }, now)
    );
    for (const tool of MUTATING_TOOLS) {
      const decisions = capabilitiesForTool(tool, {}).map((capability) =>
        evaluate(snapshot, { capability, urls: [HOME] })
      );
      assert.ok(
        decisions.some((decision) => !decision.allowed),
        `${tool} is not blocked by the migrated policy`
      );
    }
  });

  it("keeps the legacy allowlist as a website allowlist", () => {
    const policy = policyFromLegacyConfig(
      { allowedDomains: ["Example.com", "*.docs.test", " .trail.test "] },
      now
    );
    assert.equal(policy.mode, "permissive");
    assert.equal(policy.websites.default, "deny");
    assert.deepEqual(policy.websites.allow, [
      "example.com",
      "docs.test",
      "trail.test",
    ]);
    const snapshot = snapshotOfPolicy(policy);
    assert.equal(
      evaluate(snapshot, {
        capability: "nav.open",
        urls: ["https://example.com/"],
      }).allowed,
      true
    );
    assert.equal(
      codeOf(
        evaluate(snapshot, {
          capability: "nav.open",
          urls: ["https://elsewhere.test/"],
        })
      ),
      "site_default_denied"
    );
  });

  it("combines readOnly and an allowlist without gaining access", () => {
    const policy = policyFromLegacyConfig(
      { readOnly: true, allowedDomains: ["example.com"] },
      now
    );
    assert.equal(policy.mode, "permissive");
    assert.equal(policy.websites.default, "deny");
    assert.equal(policy.restrictions["nav.open"], "deny");
    assert.equal(policy.restrictions["page.evidenceClear"], "deny");
  });

  it("preserves reads that were available under readOnly", () => {
    const snapshot = snapshotOfPolicy(
      policyFromLegacyConfig({ readOnly: true }, now)
    );
    for (const tool of [
      "zen_status",
      "zen_tabs_list",
      "zen_read_page",
      "zen_find_text",
      "zen_history_search",
      "zen_bookmarks_search",
      "zen_session_list",
      "zen_answers",
      "zen_audit_tail",
    ]) {
      const decisions = capabilitiesForTool(tool, {}).map((capability) =>
        evaluate(snapshot, { capability, urls: [HOME] })
      );
      assert.ok(
        decisions.every((decision) => decision.allowed),
        `${tool} should stay available`
      );
    }
  });
});

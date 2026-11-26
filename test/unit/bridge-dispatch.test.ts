import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOps } from "../../src/bridge/ops.js";
import {
  BridgePolicyGate,
  type PolicyFileObservation,
} from "../../src/bridge/policy-gate.js";
import { policyDigest } from "../../src/shared/policy-digest.js";
import { createPolicy } from "../../src/shared/policy.js";
import { serializePolicy } from "../../src/shared/policy-schema.js";
import { testGate } from "./policy-gate-fixture.js";

/**
 * The bridge operation map is fixed. Names inherited from Object.prototype are
 * not operations and must never be invoked.
 */
describe("bridge dispatch", () => {
  const ops = createOps({} as never, "win-test", testGate());

  for (const method of [
    "constructor",
    "__proto__",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "dispatch",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    it(`rejects inherited or unknown name "${method}"`, async () => {
      await assert.rejects(
        async () => ops.dispatch(method, {}),
        (error: { code?: string }) => error.code === "unknown_method",
        `${method} must not resolve to a callable`
      );
    });
  }

  it("does not let a __proto__ call pollute Object.prototype", async () => {
    await assert.rejects(
      async () => ops.dispatch("__proto__", { polluted: true })
    );
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("refreshes policy after a read before returning tab metadata", async () => {
    const initial = createPolicy({ mode: "permissive", revision: 1 });
    const revoked = createPolicy({
      mode: "permissive",
      revision: 2,
      websites: { block: ["example.test"] },
    });
    const observations: PolicyFileObservation[] = [
      { status: "unchanged" },
      { status: "changed", text: serializePolicy(revoked) },
    ];
    const gate = new BridgePolicyGate({
      initial: {
        policy: initial,
        source: "file",
        revision: initial.revision,
        digest: policyDigest(initial),
        updatedAt: initial.updatedAt,
        warnings: [],
      },
      readFile: async () => observations.shift() ?? { status: "unchanged" },
    });
    const tab = {
      isConnected: true,
      closing: false,
      label: "Signed-in page",
      linkedBrowser: { currentURI: { spec: "https://example.test/account" } },
      hasAttribute: () => false,
      getAttribute: () => null,
    };
    const win = {
      document: {
        hasFocus: () => true,
        querySelectorAll: () => [],
      },
      gBrowser: { tabs: [tab], selectedTab: tab },
    } as never;
    const previousServices = (globalThis as any).Services;
    (globalThis as any).Services = {
      appinfo: {
        name: "Zen",
        version: "test",
        appBuildID: "test",
        OS: "WINNT",
      },
    };
    try {
      const result = (await createOps(win, "win-test", gate).dispatch(
        "status",
        {}
      )) as { activeTab: { title: string; url: string } | null };
      assert.equal(result.activeTab?.title, "(restricted by policy)");
      assert.equal(result.activeTab?.url, "");
      assert.equal(gate.snapshot().revision, 2);
    } finally {
      if (previousServices === undefined) delete (globalThis as any).Services;
      else (globalThis as any).Services = previousServices;
    }
  });
});

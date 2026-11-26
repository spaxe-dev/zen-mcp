import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOps } from "../../src/bridge/ops.js";
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
    await assert.rejects(async () => ops.dispatch("__proto__", { polluted: true }));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

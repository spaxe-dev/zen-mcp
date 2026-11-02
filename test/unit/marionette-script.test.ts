import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapScript } from "../../src/zen/marionette.js";

interface WrappedResult {
  __zenMcpOk?: boolean;
  value?: unknown;
  error?: string;
}

function run(body: string): Promise<WrappedResult> {
  const script = wrapScript(body);
  return new Promise((resolve) => {
    const evaluate = new Function(script) as (
      done: (result: WrappedResult) => void
    ) => void;
    evaluate((result) => resolve(result));
  });
}

describe("Marionette script wrapper", () => {
  it("returns the script value", async () => {
    const result = await run("return { count: 2 };");
    assert.deepEqual(result, { __zenMcpOk: true, value: { count: 2 } });
  });

  it("reports the error name and message before the stack", async () => {
    const result = await run('throw new TypeError("bad script");');
    assert.equal(result.__zenMcpOk, false);
    assert.ok(
      result.error?.startsWith("TypeError: bad script\n"),
      `unexpected error text: ${result.error}`
    );
  });

  it("reports thrown values that are not Error objects", async () => {
    const result = await run('throw "plain failure";');
    assert.equal(result.__zenMcpOk, false);
    assert.equal(result.error, "plain failure");
  });
});

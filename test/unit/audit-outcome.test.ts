import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditOutcomeForResult } from "../../src/mcp/guard.js";

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    total: 2,
    matched: 2,
    verified: 2,
    failed: 0,
    openedTabs: 0,
    reusedTabs: 0,
    focused: false,
    results: [],
    ...overrides,
  };
}

describe("auditOutcomeForResult", () => {
  it("records a fully successful batch as success", () => {
    assert.deepEqual(
      auditOutcomeForResult("zen_show_evidence_batch", batch()),
      {
        ok: true,
        executed: true,
        citationsVerified: 2,
        citationsFailed: 0,
        outcome: "success",
      }
    );
  });

  it("records a partial batch when one of two citations fails", () => {
    assert.deepEqual(
      auditOutcomeForResult(
        "zen_show_evidence_batch",
        batch({ ok: false, matched: 1, verified: 1, failed: 1 })
      ),
      {
        ok: false,
        executed: true,
        citationsVerified: 1,
        citationsFailed: 1,
        outcome: "partial",
      }
    );
  });

  it("records a total batch failure as failed", () => {
    assert.deepEqual(
      auditOutcomeForResult(
        "zen_show_evidence_batch",
        batch({ ok: false, matched: 0, verified: 0, failed: 2 })
      ),
      {
        ok: false,
        executed: true,
        citationsVerified: 0,
        citationsFailed: 2,
        outcome: "failed",
      }
    );
  });

  it("uses batch counts from any tool result that carries them", () => {
    const outcome = auditOutcomeForResult("zen_custom_batch", {
      ok: false,
      total: 1,
      verified: 0,
      failed: 1,
    });
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.citationsVerified, 0);
    assert.equal(outcome.citationsFailed, 1);
  });

  it("keeps returned non-batch results as plain successes", () => {
    const values: unknown[] = [
      { ok: true, tabId: "42" },
      { status: "ok" },
      "done",
      [1, 2, 3],
      null,
      undefined,
    ];
    for (const value of values) {
      assert.deepEqual(auditOutcomeForResult("zen_status", value), {
        ok: true,
        executed: true,
      });
    }
  });

  it("records a returned ok:false without throwing", () => {
    assert.deepEqual(
      auditOutcomeForResult("zen_show_evidence", { ok: false }),
      { ok: false, executed: true }
    );
  });

  it("serializes without undefined fields", () => {
    const nonBatch = JSON.stringify(
      auditOutcomeForResult("zen_status", { ok: true })
    );
    assert.deepEqual(JSON.parse(nonBatch), { ok: true, executed: true });

    const failed = JSON.stringify(
      auditOutcomeForResult(
        "zen_show_evidence_batch",
        batch({ ok: false, verified: 0, failed: 2 })
      )
    );
    assert.equal(failed.includes("undefined"), false);
    assert.deepEqual(JSON.parse(failed), {
      ok: false,
      executed: true,
      citationsVerified: 0,
      citationsFailed: 2,
      outcome: "failed",
    });
  });
});

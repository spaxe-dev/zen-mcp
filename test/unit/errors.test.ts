import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorMetadata } from "../../src/shared/errors.js";

describe("structured error metadata", () => {
  it("keeps legacy element_not_found but exposes a stale category", () => {
    const meta = errorMetadata("element_not_found", {
      category: "stale_reference",
      reason: "document_replaced",
    });
    assert.equal(meta.category, "stale_reference");
    assert.equal(meta.retryable, true);
    assert.equal(meta.stateChanged, false);
  });

  it("maps ambiguity to a non-retryable, unchanged result", () => {
    const meta = errorMetadata("target_ambiguous");
    assert.deepEqual(meta, {
      category: "ambiguous",
      retryable: false,
      stateChanged: false,
      recovery: "Use a ref or a more specific target.",
    });
  });

  it("marks failed actions as unknown state", () => {
    assert.equal(errorMetadata("click_failed").stateChanged, null);
    assert.equal(errorMetadata("type_failed").stateChanged, null);
    assert.equal(errorMetadata("click_failed").retryable, false);
  });

  it("maps policy and browser failures without inventing success", () => {
    assert.equal(errorMetadata("read_only").category, "permission");
    assert.equal(errorMetadata("domain_not_allowed").category, "permission");
    assert.equal(errorMetadata("bridge_timeout").category, "browser");
    assert.equal(errorMetadata("target_not_actionable").category, "not_actionable");
    assert.equal(errorMetadata("unsupported_operation").category, "unsupported");
    assert.equal(errorMetadata("something_new").category, "internal");
  });
});

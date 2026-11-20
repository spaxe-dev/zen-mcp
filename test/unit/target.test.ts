import test from "node:test";
import assert from "node:assert/strict";
import {
  TargetInputError,
  normalizeTargetInput,
  targetTextMatches,
} from "../../src/shared/target.js";

function invalid(input: Parameters<typeof normalizeTargetInput>[0]): TargetInputError {
  try {
    normalizeTargetInput(input);
  } catch (error) {
    assert.ok(error instanceof TargetInputError);
    return error;
  }
  assert.fail("expected invalid_target");
}

test("keeps legacy ref and selector behavior", () => {
  assert.deepEqual(normalizeTargetInput({ ref: " e3 " }), {
    kind: "ref",
    ref: "e3",
    legacy: true,
  });
  assert.deepEqual(normalizeTargetInput({ selector: " #go " }), {
    kind: "selector",
    selector: "#go",
    legacy: true,
  });
});

test("normalizes each semantic target form", () => {
  assert.deepEqual(
    normalizeTargetInput({ target: { role: "Button", name: "Sign  in" } }),
    {
      kind: "role",
      role: "button",
      name: "Sign in",
      match: "exact",
      legacy: false,
    }
  );
  assert.deepEqual(
    normalizeTargetInput({ target: { text: "Continue", match: "contains" } }),
    { kind: "text", text: "Continue", match: "contains", legacy: false }
  );
  assert.deepEqual(normalizeTargetInput({ target: { label: "Email" } }), {
    kind: "label",
    label: "Email",
    legacy: false,
  });
  assert.deepEqual(
    normalizeTargetInput({ target: { placeholder: "Search" } }),
    { kind: "placeholder", placeholder: "Search", legacy: false }
  );
  assert.deepEqual(normalizeTargetInput({ target: { ref: "f0-e2" } }), {
    kind: "ref",
    ref: "f0-e2",
    legacy: false,
  });
});

test("rejects mixing target with legacy fields", () => {
  assert.equal(
    invalid({ ref: "e1", target: { text: "Go" } }).message,
    "Provide target or a top-level ref/selector, not both."
  );
  invalid({ selector: "#go", target: { label: "Go" } });
});

test("requires exactly one target strategy", () => {
  invalid({});
  invalid({ ref: "e1", selector: "#go" });
  invalid({ target: {} });
  invalid({ target: { role: "button", name: "Go", text: "Go" } });
  invalid({ target: { role: "button" } });
  invalid({ target: { name: "Go" } });
});

test("bounds every target input", () => {
  assert.equal(invalid({ ref: "x".repeat(21) }).details?.field, "ref");
  assert.equal(
    invalid({ target: { text: "x".repeat(501) } }).details?.field,
    "target.text"
  );
  assert.equal(
    invalid({ target: { selector: "x".repeat(501) } }).details?.field,
    "target.selector"
  );
  assert.equal(invalid({ target: { role: "button", name: "x".repeat(201) } }).details?.field, "target.name");
});

test("restricts match to role+name and text", () => {
  invalid({ target: { ref: "e1", match: "contains" } });
  invalid({ target: { selector: "#go", match: "contains" } });
  invalid({ target: { label: "Go", match: "contains" } });
  invalid({ target: { placeholder: "Go", match: "contains" } });
  assert.equal(
    invalid({ target: { text: "Go", match: "fuzzy" as never } }).message,
    'match must be "exact" or "contains".'
  );
});

test("keeps selector whitespace that can be significant", () => {
  const normalized = normalizeTargetInput({ selector: '[title="a  b"]' });
  assert.equal(
    normalized.kind === "selector" ? normalized.selector : "",
    '[title="a  b"]'
  );
});

test("compares normalized text exactly or as a substring", () => {
  assert.equal(targetTextMatches(" Sign  In ", "sign in", "exact"), true);
  assert.equal(targetTextMatches("Sign in now", "sign in", "exact"), false);
  assert.equal(targetTextMatches("Sign in now", "sign in", "contains"), true);
  assert.equal(targetTextMatches("anything", "   ", "contains"), false);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInspectElementScript,
  buildSemanticTargetScript,
  coerceSemanticTarget,
} from "../../src/shared/read-script.js";
import type { NormalizedTarget } from "../../src/shared/target.js";

describe("semantic target script", () => {
  it("embeds one normalized strategy and a bounded node scan", () => {
    const target: NormalizedTarget = {
      kind: "role",
      role: "button",
      name: "Sign in",
      match: "exact",
      legacy: false,
    };
    const script = buildSemanticTargetScript(target);
    assert.match(script, /"kind":"role"/);
    assert.match(script, /"name":"Sign in"/);
    assert.match(script, /MAX_NODES = 6000/);
    assert.match(script, /MAX_MATCHES = 6/);
    assert.match(script, /interactiveElement/);
    assert.doesNotMatch(script, /agent|eval\(/);
  });

  it("coerces a unique probe without dropping the element handle", () => {
    const element = { id: "element-handle" };
    const probe = coerceSemanticTarget({
      found: true,
      ambiguous: false,
      count: 1,
      truncated: false,
      element,
      tag: "button",
      role: "button",
      name: "Sign in",
      label: "Sign in",
      visible: true,
      disabled: false,
      editable: false,
      sensitive: false,
      checked: null,
      selected: null,
    });
    assert.equal(probe?.found, true);
    assert.equal(probe?.element, element);
    assert.equal(probe?.name, "Sign in");
  });

  it("keeps at most five bounded candidates", () => {
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      tag: "button",
      role: "button",
      name: `Continue ${index}`,
      type: null,
      sensitive: false,
      visible: true,
      disabled: false,
    }));
    const probe = coerceSemanticTarget({
      found: true,
      ambiguous: true,
      count: 6,
      truncated: false,
      candidates,
    });
    assert.equal(probe?.candidates?.length, 5);
    assert.equal(probe?.candidates?.[0].name, "Continue 0");
  });

  it("reports invalid selectors separately from a missing element", () => {
    assert.deepEqual(coerceSemanticTarget({ invalidSelector: true }), {
      found: false,
      ambiguous: false,
      count: 0,
      truncated: false,
      invalidSelector: true,
    });
  });

  it("returns visibility from the ref freshness probe", () => {
    const script = buildInspectElementScript();
    assert.match(script, /visible: elementVisible\(element\)/);
    assert.match(script, /element: element/);
  });
});

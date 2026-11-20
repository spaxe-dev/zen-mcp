import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPageDelta, deltaHasChanges } from "../../src/shared/delta.js";
import type {
  PageControlSignature,
  PageSignature,
} from "../../src/shared/read-script.js";

function control(
  key: string,
  state: Partial<PageControlSignature["state"]> = {}
): PageControlSignature {
  return {
    key,
    role: "button",
    name: `Button ${key}`,
    type: null,
    state: {
      visible: true,
      disabled: false,
      readOnly: false,
      checked: null,
      selected: null,
      valuePresent: false,
      ...state,
    },
  };
}

function signature(overrides: Partial<PageSignature> = {}): PageSignature {
  return {
    url: "https://example.com/",
    title: "Example",
    readyState: "complete",
    textLength: 10,
    textHash: 1,
    elementCount: 5,
    valueHash: 1,
    controls: [],
    headings: [],
    alerts: [],
    ...overrides,
  };
}

test("delta reports control state changes without calling them additions", () => {
  const before = signature({ controls: [control("a"), control("b")] });
  const after = signature({
    controls: [control("a", { checked: true, valuePresent: true }), control("b")],
  });
  const delta = buildPageDelta(before, after, { documentReplaced: false });
  assert.deepEqual(delta.addedControls, []);
  assert.deepEqual(delta.removedControls, []);
  assert.equal(delta.changedControls.length, 1);
  assert.deepEqual(delta.changedControls[0].changes, [
    "checked",
    "valuePresent",
  ]);
  assert.equal(deltaHasChanges(delta), true);
});

test("delta reports added and removed controls by role and name", () => {
  const before = signature({ controls: [control("a"), control("b")] });
  const after = signature({ controls: [control("b"), control("c")] });
  const delta = buildPageDelta(before, after, { documentReplaced: false });
  assert.deepEqual(delta.addedControls, [
    { role: "button", name: "Button c", type: null },
  ]);
  assert.deepEqual(delta.removedControls, [
    { role: "button", name: "Button a", type: null },
  ]);
  assert.deepEqual(delta.changedControls, []);
});

test("delta treats headings and alerts as multisets", () => {
  const before = signature({
    headings: [{ key: "h:1", text: "Title" }],
    alerts: [{ key: "a:1", text: "Saved" }],
  });
  const after = signature({
    headings: [
      { key: "h:1", text: "Title" },
      { key: "h2:1", text: "Dynamic heading" },
    ],
    alerts: [
      { key: "a:1", text: "Saved" },
      { key: "a2:1", text: "Saved" },
    ],
  });
  const delta = buildPageDelta(before, after, { documentReplaced: false });
  assert.deepEqual(delta.addedHeadings, ["Dynamic heading"]);
  assert.deepEqual(delta.addedAlerts, ["Saved"]);
  assert.deepEqual(delta.removedAlerts, []);
});

test("delta caps list output", () => {
  const before = signature();
  const after = signature({
    controls: Array.from({ length: 20 }, (_, index) => control(`c${index}`)),
    headings: Array.from({ length: 12 }, (_, index) => ({
      key: `h${index}`,
      text: `Heading ${index}`,
    })),
    alerts: Array.from({ length: 12 }, (_, index) => ({
      key: `a${index}`,
      text: `Alert ${index}`,
    })),
  });
  const delta = buildPageDelta(before, after, { documentReplaced: false });
  assert.equal(delta.addedControls.length, 10);
  assert.equal(delta.addedHeadings.length, 5);
  assert.equal(delta.addedAlerts.length, 5);
});

test("delta reports text growth and length delta", () => {
  const before = signature({ textLength: 10, textHash: 1 });
  const after = signature({ textLength: 40, textHash: 2 });
  const delta = buildPageDelta(before, after, { documentReplaced: false });
  assert.equal(delta.textChanged, true);
  assert.equal(delta.textLengthDelta, 30);
});

test("delta refuses to diff a replaced document", () => {
  const before = signature({
    controls: [control("a")],
    headings: [{ key: "h:1", text: "Old" }],
  });
  const after = signature({
    controls: [control("z")],
    headings: [{ key: "h:1", text: "New" }],
    readyState: "complete",
  });
  const delta = buildPageDelta(before, after, { documentReplaced: true });
  assert.deepEqual(delta.addedControls, []);
  assert.deepEqual(delta.removedControls, []);
  assert.deepEqual(delta.changedControls, []);
  assert.deepEqual(delta.addedHeadings, []);
  assert.equal(delta.textChanged, false);
  assert.equal(delta.textLengthDelta, 0);
  assert.equal(delta.readyState, "complete");
  assert.match(String(delta.limitation), /document was replaced/);
  assert.equal(deltaHasChanges(delta), false);
});

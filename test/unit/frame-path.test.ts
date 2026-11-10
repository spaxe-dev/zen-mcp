import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  frameRefPrefix,
  normalizeFramePath,
  parseFrameRef,
} from "../../src/shared/frame-path.js";

describe("frame paths", () => {
  it("parses top-document refs", () => {
    assert.deepEqual(parseFrameRef("e1"), { path: [], ref: "e1" });
    assert.deepEqual(parseFrameRef("e1234"), { path: [], ref: "e1234" });
  });

  it("parses frame and nested frame refs", () => {
    assert.deepEqual(parseFrameRef("f0-e3"), { path: [0], ref: "e3" });
    assert.deepEqual(parseFrameRef("f2.1-e12"), {
      path: [2, 1],
      ref: "e12",
    });
    assert.deepEqual(parseFrameRef("f0.1.2-e1"), {
      path: [0, 1, 2],
      ref: "e1",
    });
  });

  it("rejects malformed refs", () => {
    for (const value of [
      "",
      "e",
      "e0x",
      "e12345",
      "f-e1",
      "f0e1",
      "f0.1.2.3-e1",
      "g0-e1",
      "f0-e1 ",
      "f-1-e1",
    ]) {
      assert.equal(parseFrameRef(value), null, value);
    }
  });

  it("formats prefixes that match the parsed path", () => {
    assert.equal(frameRefPrefix([]), "");
    assert.equal(frameRefPrefix([0]), "f0-");
    assert.equal(frameRefPrefix([0, 1]), "f0.1-");
    assert.equal(frameRefPrefix([12, 3, 4]), "f12.3.4-");
  });

  it("normalizes frame path input", () => {
    assert.deepEqual(normalizeFramePath(undefined), []);
    assert.deepEqual(normalizeFramePath(null), []);
    assert.deepEqual(normalizeFramePath([]), []);
    assert.deepEqual(normalizeFramePath([0, 1, 2]), [0, 1, 2]);
    assert.deepEqual(normalizeFramePath(["1", "0"]), [1, 0]);
  });

  it("rejects malformed frame path input", () => {
    assert.equal(normalizeFramePath("0"), null);
    assert.equal(normalizeFramePath([0, 1, 2, 3]), null);
    assert.equal(normalizeFramePath([-1]), null);
    assert.equal(normalizeFramePath([1.5]), null);
    assert.equal(normalizeFramePath(["x"]), null);
  });
});

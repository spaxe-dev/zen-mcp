import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RefRegistry,
  documentChanged,
  elementDigest,
  webElementId,
} from "../../src/bridge/ref-registry.js";

const ref = (id: string) => ({ "element-6066-11e4-a52e-4f735466cecf": id });

const descriptor = {
  ref: "e1",
  tag: "button",
  role: "button",
  type: null,
  label: "Save",
  href: null,
  element: ref("node-1"),
};

describe("element identity helpers", () => {
  it("reads a WebElement id without interpreting it", () => {
    assert.equal(
      webElementId({ "element-6066-11e4-a52e-4f735466cecf": "abc" }),
      "abc"
    );
    assert.equal(webElementId({ element: "x" }), null);
    assert.equal(webElementId({ "element-x": "" }), null);
    assert.equal(webElementId(null), null);
    assert.equal(webElementId("node"), null);
  });

  it("only reports a document change when both ids are known", () => {
    assert.equal(documentChanged(ref("a"), ref("b")), true);
    assert.equal(documentChanged(ref("a"), ref("a")), false);
    assert.equal(documentChanged(ref("a"), null), false);
    assert.equal(documentChanged(null, ref("b")), false);
    assert.equal(documentChanged(null, null), false);
  });

  it("keeps a stable semantic digest and ignores values", () => {
    const digest = elementDigest(descriptor);
    assert.equal(digest, elementDigest({ ...descriptor }));
    assert.match(digest, /^[0-9a-f]{8}$/);

    assert.notEqual(digest, elementDigest({ ...descriptor, label: "Delete" }));
    assert.notEqual(digest, elementDigest({ ...descriptor, role: "link" }));
    assert.notEqual(digest, elementDigest({ ...descriptor, href: "/next" }));
    assert.notEqual(digest, elementDigest({ ...descriptor, type: "submit" }));
  });
});

describe("ref registry", () => {
  it("stores and resolves refs by tab and frame path", () => {
    const registry = new RefRegistry();
    const stored = registry.beginSnapshot("tab-1", [], "snap-a", ref("root"), [
      descriptor,
    ]);
    assert.equal(stored, 1);
    assert.equal(registry.documentCount, 1);

    const resolved = registry.resolve("tab-1", [], "e1");
    assert.ok(resolved);
    assert.equal(resolved.ref, "e1");
    assert.equal(resolved.snapshotId, "snap-a");
    assert.deepEqual(resolved.framePath, []);
    assert.deepEqual(resolved.root, ref("root"));
    assert.equal(resolved.digest, elementDigest(descriptor));

    assert.equal(registry.resolve("tab-2", [], "e1"), null);
    assert.equal(registry.resolve("tab-1", [0], "e1"), null);
    assert.equal(registry.resolve("tab-1", [], "e9"), null);
  });

  it("keeps frames independent and clears every frame of a tab", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot("tab-1", [], "snap-a", ref("root"), [descriptor]);
    registry.beginSnapshot("tab-1", [0], "snap-a", ref("root-0"), [
      { ...descriptor, ref: "f0-e1", element: ref("frame-node") },
    ]);
    registry.beginSnapshot("tab-2", [], "snap-b", ref("root-2"), [descriptor]);

    assert.ok(registry.resolve("tab-1", [0], "f0-e1"));
    assert.equal(registry.refCount("tab-1", [0]), 1);

    registry.clearTab("tab-1");
    assert.equal(registry.resolve("tab-1", [], "e1"), null);
    assert.equal(registry.resolve("tab-1", [0], "f0-e1"), null);
    assert.ok(registry.resolve("tab-2", [], "e1"));

    registry.clearAll();
    assert.equal(registry.documentCount, 0);
  });

  it("replaces one document's refs on the next read", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot("tab-1", [], "snap-a", ref("root"), [
      { ...descriptor, ref: "e1" },
      { ...descriptor, ref: "e2", element: ref("node-2") },
    ]);
    registry.beginSnapshot("tab-1", [], "snap-b", ref("root"), [
      { ...descriptor, ref: "e1", element: ref("node-3"), label: "Send" },
    ]);

    const resolved = registry.resolve("tab-1", [], "e1");
    assert.ok(resolved);
    assert.equal(resolved.snapshotId, "snap-b");
    assert.equal(resolved.descriptor.label, "Send");
    assert.equal(registry.resolve("tab-1", [], "e2"), null);
  });

  it("skips elements without a ref, tag or WebElement", () => {
    const registry = new RefRegistry();
    const stored = registry.beginSnapshot("tab-1", [], "snap-a", ref("root"), [
      { ...descriptor, ref: "" },
      { ...descriptor, tag: "" },
      { ...descriptor, element: undefined },
      { ...descriptor, element: null },
      descriptor,
    ]);
    assert.equal(stored, 1);
  });

  it("caps refs per document", () => {
    const registry = new RefRegistry({ maxRefsPerDocument: 3 });
    const elements = Array.from({ length: 10 }, (_, index) => ({
      ...descriptor,
      ref: `e${index + 1}`,
      element: ref(`node-${index + 1}`),
    }));
    assert.equal(registry.beginSnapshot("tab-1", [], "snap-a", ref("root"), elements), 3);
    assert.ok(registry.resolve("tab-1", [], "e3"));
    assert.equal(registry.resolve("tab-1", [], "e4"), null);
  });

  it("evicts the least recently used document", () => {
    const registry = new RefRegistry({ maxDocuments: 2 });
    registry.beginSnapshot("tab-1", [], "snap-a", ref("root"), [descriptor]);
    registry.beginSnapshot("tab-2", [], "snap-b", ref("root"), [descriptor]);

    // Touch tab-1 so tab-2 becomes the oldest entry.
    assert.ok(registry.resolve("tab-1", [], "e1"));
    registry.beginSnapshot("tab-3", [], "snap-c", ref("root"), [descriptor]);

    assert.equal(registry.documentCount, 2);
    assert.ok(registry.resolve("tab-1", [], "e1"));
    assert.ok(registry.resolve("tab-3", [], "e1"));
    assert.equal(registry.resolve("tab-2", [], "e1"), null);
  });

  it("normalizes frame paths and ignores invalid tab ids", () => {
    const registry = new RefRegistry();
    registry.beginSnapshot("tab-1", [0.9, -1, 2], "snap-a", ref("root"), [
      { ...descriptor, ref: "e1" },
    ]);
    assert.ok(registry.resolve("tab-1", [0, 0, 2], "e1"));
    assert.equal(registry.resolve("tab-1", [], "e1"), null);
    assert.equal(registry.beginSnapshot("", [], "snap", ref("root"), [descriptor]), 0);
    assert.equal(registry.documentCount, 1);
  });
});

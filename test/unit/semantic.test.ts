import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coerceSemanticPage,
  leanSemanticPage,
  SEMANTIC_MAX_COLLECTIONS,
  SEMANTIC_MAX_DIALOGS,
  SEMANTIC_MAX_HEADINGS_LIST,
  SEMANTIC_MAX_LIMITATIONS,
  SEMANTIC_MAX_REGIONS,
  SEMANTIC_MAX_SAMPLES,
  SEMANTIC_MAX_SIGNALS,
} from "../../src/shared/semantic.js";

const region = (overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  role: "main",
  label: "Main",
  labelSource: "aria",
  heading: "Docs",
  parent: null,
  ref: "e1",
  controls: 2,
  links: 3,
  items: null,
  itemKind: null,
  ...overrides,
});

describe("semantic page coercion", () => {
  it("rejects values that are not semantic pages", () => {
    for (const value of [null, undefined, "page", 42, [], true]) {
      assert.equal(coerceSemanticPage(value), undefined);
    }
  });

  it("fills a bounded model for an empty payload", () => {
    const page = coerceSemanticPage({});
    assert.ok(page);
    assert.equal(page.classification, "generic");
    assert.equal(page.confidence, 0);
    assert.deepEqual(page.regions, []);
    assert.deepEqual(page.headings, []);
    assert.deepEqual(page.collections, []);
    assert.deepEqual(page.dialogs, []);
    assert.deepEqual(page.signals, []);
    assert.deepEqual(page.limitations, []);
    assert.equal(page.primaryRegion, null);
    assert.equal(page.coverage.complete, false);
    assert.equal(page.coverage.nodes, 0);
  });

  it("keeps only known classifications and clamps confidence", () => {
    assert.equal(
      coerceSemanticPage({ classification: "search-results" })?.classification,
      "search-results"
    );
    assert.equal(
      coerceSemanticPage({ classification: "shopping" })?.classification,
      "generic"
    );
    assert.equal(coerceSemanticPage({ confidence: 3 })?.confidence, 1);
    assert.equal(coerceSemanticPage({ confidence: -2 })?.confidence, 0);
    assert.equal(coerceSemanticPage({ confidence: "high" })?.confidence, 0);
    assert.equal(coerceSemanticPage({ confidence: 0.4 })?.confidence, 0.4);
  });

  it("clamps regions and resolves their stable fields", () => {
    const page = coerceSemanticPage({
      regions: [
        region(),
        region({ id: "", role: "unknown", labelSource: "guess", items: 4, itemKind: "cards" }),
      ],
    });
    assert.ok(page);
    assert.equal(page.regions.length, 2);
    assert.deepEqual(page.regions[0], {
      id: "r1",
      role: "main",
      label: "Main",
      labelSource: "aria",
      heading: "Docs",
      parent: null,
      ref: "e1",
      controls: 2,
      links: 3,
      items: null,
      itemKind: null,
    });
    assert.equal(page.regions[1]?.id, "r2");
    assert.equal(page.regions[1]?.role, "section");
    assert.equal(page.regions[1]?.labelSource, "inferred");
    assert.equal(page.regions[1]?.items, 4);
    assert.equal(page.regions[1]?.itemKind, "cards");
  });

  it("leans regions without mutating the coerced model", () => {
    const page = coerceSemanticPage({
      regions: [
        region(),
        region({
          id: "r2",
          role: "section",
          label: "Intro",
          labelSource: "aria",
          heading: "Introduction",
          parent: "r1",
          ref: null,
          controls: 2,
          links: 0,
          items: 4,
          itemKind: "cards",
        }),
        region({
          id: "r3",
          role: "navigation",
          label: null,
          labelSource: "inferred",
          heading: null,
          parent: null,
          ref: null,
          controls: 0,
          links: 0,
          items: 0,
          itemKind: null,
        }),
      ],
    });
    assert.ok(page);

    const lean = leanSemanticPage(page);
    assert.deepEqual(lean.regions[0], {
      id: "r1",
      role: "main",
      label: "Main",
      labelSource: "aria",
      heading: "Docs",
      ref: "e1",
      controls: 2,
      links: 3,
    });
    assert.deepEqual(lean.regions[1], {
      id: "r2",
      role: "section",
      label: "Intro",
      labelSource: "aria",
      heading: "Introduction",
      parent: "r1",
      controls: 2,
      items: 4,
      itemKind: "cards",
    });
    assert.deepEqual(lean.regions[2], { id: "r3", role: "navigation" });

    assert.equal(page.regions[0]?.label, "Main");
    assert.equal(page.regions[0]?.items, null);
    assert.equal(page.regions[2]?.controls, 0);
  });

  it("keeps a label that differs from the heading", () => {
    const page = coerceSemanticPage({
      regions: [
        region({ label: "Search results", heading: "Results", labelSource: "aria" }),
      ],
    });
    assert.ok(page);
    const lean = leanSemanticPage(page);
    assert.equal(lean.regions[0]?.label, "Search results");
    assert.equal(lean.regions[0]?.labelSource, "aria");
    assert.equal(lean.regions[0]?.heading, "Results");
  });

  it("caps regions at the semantic limit", () => {    const regions = Array.from({ length: SEMANTIC_MAX_REGIONS + 5 }, (_, index) =>
      region({ id: `r${index + 1}` })
    );
    const page = coerceSemanticPage({
      regions,
      coverage: { regionsTruncated: true },
    });
    assert.equal(page?.regions.length, SEMANTIC_MAX_REGIONS);
    assert.equal(page?.coverage.regionsTruncated, true);
  });

  it("keeps ordered headings and drops empty or out-of-range levels", () => {
    const page = coerceSemanticPage({
      headings: [
        { level: 1, text: "Title", ref: "e2" },
        { level: 7, text: "Deep", ref: null },
        { level: 0, text: "Zero", ref: null },
        { level: 2, text: "   ", ref: null },
        { text: "No level" },
      ],
    });
    assert.deepEqual(page?.headings, [
      { level: 1, text: "Title", ref: "e2" },
      { level: 6, text: "Deep", ref: null },
      { level: 2, text: "Zero", ref: null },
      { level: 2, text: "No level", ref: null },
    ]);
  });

  it("caps the heading list and truncates long heading text", () => {
    const headings = Array.from(
      { length: SEMANTIC_MAX_HEADINGS_LIST - 1 },
      (_, index) => ({ level: 2, text: `Heading ${index}` })
    );
    headings.push({ level: 1, text: "x".repeat(500) });
    const page = coerceSemanticPage({
      headings: [...headings, { level: 2, text: "dropped" }],
    });
    assert.equal(page?.headings.length, SEMANTIC_MAX_HEADINGS_LIST);
    const last = page?.headings[SEMANTIC_MAX_HEADINGS_LIST - 1];
    assert.equal(last?.text.length, 160);
    assert.equal(page?.headings.some((entry) => entry.text === "dropped"), false);
  });

  it("keeps collections with bounded samples and required refs", () => {
    const page = coerceSemanticPage({
      collections: [
        {
          regionId: "r1",
          kind: "cards",
          count: 24,
          sample: [
            { ref: "e3", label: "First" },
            { ref: "", label: "No ref" },
            { ref: "e4", label: "Second" },
            { ref: "e5", label: "Third" },
            { ref: "e6", label: "Fourth" },
          ],
        },
        { regionId: "", kind: "cards", count: 1, sample: [] },
        { regionId: "r2", kind: "unknown", count: 2, sample: [] },
      ],
    });
    assert.equal(page?.collections.length, 2);
    assert.equal(page?.collections[0]?.kind, "cards");
    assert.equal(page?.collections[0]?.count, 24);
    assert.deepEqual(
      page?.collections[0]?.sample.map((entry) => entry.ref),
      ["e3", "e4"]
    );
    assert.equal(page?.collections[0]?.sample.length, SEMANTIC_MAX_SAMPLES - 1);
    assert.equal(page?.collections[1]?.kind, "items");
  });

  it("caps collections and dialogs", () => {
    const collections = Array.from(
      { length: SEMANTIC_MAX_COLLECTIONS + 2 },
      (_, index) => ({
        regionId: `r${index + 1}`,
        kind: "links",
        count: 3,
        sample: [],
      })
    );
    const dialogs = Array.from({ length: SEMANTIC_MAX_DIALOGS + 2 }, (_, index) => ({
      ref: `e${index + 1}`,
      label: `Dialog ${index + 1}`,
      modal: index === 0,
    }));
    const page = coerceSemanticPage({ collections, dialogs });
    assert.equal(page?.collections.length, SEMANTIC_MAX_COLLECTIONS);
    assert.equal(page?.dialogs.length, SEMANTIC_MAX_DIALOGS);
    assert.deepEqual(page?.dialogs[0], {
      ref: "e1",
      label: "Dialog 1",
      modal: true,
    });
  });

  it("applies a dialog fallback label and drops a dialog without a ref", () => {
    const page = coerceSemanticPage({
      dialogs: [{ ref: "", label: "ignored" }, { ref: "e9", label: "" }],
    });
    assert.deepEqual(page?.dialogs, [
      { ref: "e9", label: "dialog", modal: false },
    ]);
  });

  it("bounds signals and limitations", () => {
    const signals = Array.from({ length: SEMANTIC_MAX_SIGNALS + 3 }, (_, index) =>
      `signal ${index}`
    );
    const limitations = Array.from(
      { length: SEMANTIC_MAX_LIMITATIONS + 2 },
      (_, index) => `limitation ${index}`
    );
    const page = coerceSemanticPage({ signals, limitations });
    assert.equal(page?.signals.length, SEMANTIC_MAX_SIGNALS);
    assert.equal(page?.limitations.length, SEMANTIC_MAX_LIMITATIONS);
  });

  it("defaults coverage to incomplete unless the payload says otherwise", () => {
    const absent = coerceSemanticPage({});
    assert.equal(absent?.coverage.complete, false);

    const complete = coerceSemanticPage({
      coverage: {
        complete: true,
        nodes: 120,
        regions: 4,
        controls: 10,
        links: 7,
        headings: 5,
        tables: 2,
        images: 3,
        missingAlt: 1,
        shadowRoots: 2,
      },
    });
    assert.deepEqual(complete?.coverage, {
      complete: true,
      nodes: 120,
      regions: 4,
      regionsTruncated: false,
      controls: 10,
      links: 7,
      headings: 5,
      tables: 2,
      images: 3,
      missingAlt: 1,
      shadowRoots: 2,
    });
  });

  it("never carries field values or hidden text through the model", () => {
    const page = coerceSemanticPage({
      classification: "login",
      selectedText: "secret selection",
      regions: [region({ value: "hunter2", selectedText: "secret" })],
      headings: [{ level: 1, text: "Sign in", ref: "e2", value: "hunter2" }],
      collections: [
        {
          regionId: "r1",
          kind: "items",
          count: 1,
          sample: [{ ref: "e3", label: "Email", value: "someone@example.com" }],
        },
      ],
      coverage: { complete: true, nodes: 10 },
    });
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("someone@example.com"), false);
    assert.equal(serialized.includes("secret selection"), false);
    assert.equal("selectedText" in (page as object), false);
  });
});

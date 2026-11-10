import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReadFormat } from "../../src/shared/protocol.js";
import {
  buildPageSignatureScript,
  buildReadScript,
  buildResolveTargetScript,
  buildWaitProbeScript,
  coercePageSignature,
  coercePageSnapshot,
  coerceWaitProbe,
  comparePageSignatures,
  toPageReadResult,
  type PageSignature,
} from "../../src/shared/read-script.js";

const FORMATS: ReadFormat[] = [
  "text",
  "markdown",
  "links",
  "tables",
  "metadata",
  "outline",
  "interactive",
];

describe("page read script", () => {
  it("embeds the character limit", () => {
    assert.match(
      buildReadScript({ maxChars: 1234 }),
      /const maxChars = 1234;/
    );
    assert.match(
      buildReadScript({ maxChars: 1234, format: "markdown" }),
      /const maxChars = 1234;/
    );
  });

  it("embeds the selector as JSON", () => {
    const selector = 'article[data-test="a"]';
    const script = buildReadScript({ maxChars: 500, selector });
    assert.ok(script.includes(`const selector = ${JSON.stringify(selector)};`));

    const plain = buildReadScript({ maxChars: 500 });
    assert.match(plain, /const selector = null;/);
  });

  it("embeds a non-negative offset", () => {
    assert.match(
      buildReadScript({ maxChars: 500, offset: 12_000 }),
      /const offset = 12000;/
    );
    assert.match(buildReadScript({ maxChars: 500 }), /const offset = 0;/);
    assert.match(
      buildReadScript({ maxChars: 500, offset: -50 }),
      /const offset = 0;/
    );
  });

  it("embeds every format name", () => {
    for (const format of FORMATS) {
      const script = buildReadScript({ maxChars: 100, format });
      assert.ok(script.includes(`const format = "${format}";`), format);
    }
  });

  it("falls back to the text format for unknown values", () => {
    const script = buildReadScript({
      maxChars: 100,
      format: "bogus" as ReadFormat,
    });
    assert.ok(script.includes('const format = "text";'));
  });

  it("produces a syntactically valid plain JavaScript script", () => {
    for (const format of FORMATS) {
      const script = buildReadScript({
        maxChars: 4_000,
        format,
        selector: format === "text" ? undefined : "main",
      });
      assert.doesNotThrow(() => new Function(script), format);
    }
  });

  it("contains the format builders and scope query", () => {
    const script = buildReadScript({ maxChars: 500 });
    assert.match(script, /function buildMarkdown/);
    assert.match(script, /function buildLinks/);
    assert.match(script, /function buildTables/);
    assert.match(script, /function buildMetadata/);
    assert.match(script, /function buildOutline/);
    assert.match(script, /function tableData/);
    assert.match(script, /article, main, \[role='main'\]/);
    assert.match(script, /querySelectorAll\("table"\)/);
    assert.match(script, /querySelectorAll\("h1, h2, h3, h4, h5, h6"\)/);
    assert.match(script, /String\.fromCharCode\(96, 96, 96\)/);
    assert.match(script, /function metaRecord/);
    assert.match(script, /document\.contentType/);
    assert.match(script, /selectorMatched/);
  });

  it("contains the interactive scan and excludes hidden inputs", () => {
    const script = buildReadScript({ maxChars: 500, format: "interactive" });
    assert.match(script, /const REF_ATTR = "data-zen-mcp-ref";/);
    assert.match(script, /const MAX_ELEMENTS = 200;/);
    assert.match(script, /function collectInteractive/);
    assert.match(script, /function describeElement/);
    assert.match(script, /input:not\(\[type='hidden'\]\)/);
    assert.match(script, /\[contenteditable='true'\]/);
    assert.match(script, /\[role='textbox'\]/);
    assert.match(script, /shadowRoot/);
    assert.match(script, /var ref = refPrefix \+ "e"/);
  });

  it("embeds a frame ref prefix and ignores malformed ones", () => {
    const framed = buildReadScript({
      maxChars: 500,
      format: "interactive",
      refPrefix: "f0.1-",
    });
    assert.ok(framed.includes('const refPrefix = "f0.1-";'));

    for (const invalid of ["f0", "f0.1", "x-", "f0.1.2.3-"]) {
      const script = buildReadScript({
        maxChars: 500,
        format: "interactive",
        refPrefix: invalid,
      });
      assert.ok(script.includes('const refPrefix = "";'), invalid);
    }
  });

  it("copies frame metadata on interactive elements", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "interactive",
      elements: [
        {
          ref: "f0.1-e2",
          tag: "button",
          label: "Pay",
          framePath: [0, 1],
          frameUrl: "https://frame.example/checkout",
        },
      ],
    });
    assert.ok(page);

    const result = toPageReadResult(page);
    assert.equal(result.elements?.[0].ref, "f0.1-e2");
    assert.deepEqual(result.elements?.[0].framePath, [0, 1]);
    assert.equal(
      result.elements?.[0].frameUrl,
      "https://frame.example/checkout"
    );
  });

  it("coerces interactive elements and clamps the list", () => {
    const many = Array.from({ length: 205 }, (_, index) => ({
      ref: `e${index + 1}`,
      tag: "button",
      role: "button",
      type: null,
      label: `Button ${index}`,
      value: null,
      placeholder: null,
      href: null,
      disabled: false,
      checked: null,
      readOnly: false,
      sensitive: false,
      editable: false,
    }));

    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "interactive",
      elements: [
        ...many,
        { ref: "bad", tag: "" },
        { tag: "input", label: "no ref" },
        "not an element",
      ],
      elementsTruncated: true,
    });
    assert.ok(page);
    assert.equal(page.format, "interactive");
    assert.equal(page.elements?.length, 200);
    assert.equal(page.elements?.[0].ref, "e1");
    assert.equal(page.elements?.[0].role, "button");
    assert.equal(page.elementsTruncated, true);
  });

  it("fills missing interactive element fields with safe defaults", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "interactive",
      elements: [{ ref: "e1", tag: "input", sensitive: true }],
    });
    assert.ok(page);
    assert.deepEqual(page.elements, [
      {
        ref: "e1",
        tag: "input",
        role: "generic",
        type: null,
        label: "",
        value: null,
        placeholder: null,
        href: null,
        disabled: false,
        checked: null,
        readOnly: false,
        sensitive: true,
        editable: false,
      },
    ]);
    assert.equal(page.elementsTruncated, false);
  });

  it("copies interactive elements into the read result", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "interactive",
      elements: [
        {
          ref: "e2",
          tag: "button",
          role: "button",
          label: "Save",
        },
      ],
    });
    assert.ok(page);

    const result = toPageReadResult(page, { maxChars: 4_000 });
    assert.equal(result.format, "interactive");
    assert.equal(result.text, "");
    assert.equal(result.length, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.elements?.length, 1);
    assert.equal(result.elements?.[0].label, "Save");
  });

  it("marks a capped interactive scan and explains it", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "interactive",
      elements: [
        {
          ref: "e1",
          tag: "button",
          role: "button",
          label: "Save",
        },
      ],
      elementsTruncated: true,
    });
    assert.ok(page);

    const result = toPageReadResult(page);
    assert.equal(result.truncated, true);
    assert.equal(result.elementsTruncated, true);
    assert.match(result.limitation ?? "", /element cap/);
  });

  it("builds a target resolver with only the requested target", () => {
    const byRef = buildResolveTargetScript({ ref: "e12" });
    assert.ok(byRef.includes(`const ref = "e12";`));
    assert.ok(byRef.includes("const selector = null;"));
    assert.match(byRef, /function findByRef/);
    assert.match(byRef, /return \{ found: false \};/);

    const bySelector = buildResolveTargetScript({
      selector: 'button[data-test="a"]',
    });
    assert.ok(bySelector.includes(`const ref = null;`));
    assert.ok(
      bySelector.includes(
        `const selector = ${JSON.stringify('button[data-test="a"]')};`
      )
    );
    assert.doesNotThrow(() => new Function(byRef));
    assert.doesNotThrow(() => new Function(bySelector));
  });

  it("rejects values that are not page snapshots", () => {
    assert.equal(coercePageSnapshot(null), null);
    assert.equal(coercePageSnapshot("page"), null);
    assert.equal(coercePageSnapshot({ title: "no url" }), null);
    assert.equal(coercePageSnapshot({ url: 42 }), null);
  });

  it("fills missing fields with safe defaults", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "hello",
      fullLength: 10,
    });
    assert.deepEqual(page, {
      title: "",
      url: "https://example.com/",
      selectedText: "",
      text: "hello",
      fullLength: 10,
      offset: 0,
      readyState: "",
      description: null,
      format: "text",
      selector: null,
      selectorMatched: false,
      contentType: "",
    });
  });

  it("derives full length from the text when it is missing", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "hello",
      fullLength: "not a number",
    });
    assert.equal(page?.fullLength, 5);
  });

  it("normalizes unknown formats and keeps format fields", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "hello",
      format: "bogus",
      selector: "main",
      selectorMatched: true,
      contentType: "text/html",
    });
    assert.ok(page);
    assert.equal(page.format, "text");
    assert.equal(page.selector, "main");
    assert.equal(page.selectorMatched, true);
    assert.equal(page.contentType, "text/html");
  });

  it("keeps an explicit selectorMatched and defaults it when absent", () => {
    const explicit = coercePageSnapshot({
      url: "https://example.com/",
      selector: "#missing",
      selectorMatched: false,
    });
    assert.equal(explicit?.selectorMatched, false);

    const absent = coercePageSnapshot({
      url: "https://example.com/",
      selector: "#missing",
    });
    assert.equal(absent?.selectorMatched, false);

    const stringValue = coercePageSnapshot({
      url: "https://example.com/",
      selectorMatched: "true",
    });
    assert.equal(stringValue?.selectorMatched, true);
  });

  it("coerces links and clamps the list", () => {
    const many = Array.from({ length: 301 }, (_, index) => ({
      text: `link ${index}`,
      url: `https://example.com/${index}`,
    }));

    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "links",
      links: [
        ...many,
        { text: "", url: "https://example.com/fallback" },
        { text: "broken" },
        "not a link",
      ],
    });
    assert.ok(page);
    assert.equal(page.format, "links");
    assert.equal(page.links?.length, 300);
    assert.deepEqual(page.links?.[0], {
      text: "link 0",
      url: "https://example.com/0",
    });
  });

  it("falls back to the URL when link text is empty", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      links: [{ text: "", url: "https://example.com/x" }],
    });
    assert.deepEqual(page?.links, [
      { text: "https://example.com/x", url: "https://example.com/x" },
    ]);
  });

  it("coerces tables and clamps cells, columns and rows", () => {
    const rows = Array.from({ length: 120 }, () =>
      Array.from({ length: 20 }, () => "cell")
    );
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "tables",
      tables: [
        {
          caption: "Pricing",
          headers: Array.from({ length: 20 }, (_, index) => `h${index}`),
          rows,
        },
        "not a table",
      ],
    });
    assert.ok(page);
    assert.equal(page.tables?.length, 1);
    const table = page.tables?.[0];
    assert.equal(table?.caption, "Pricing");
    assert.equal(table?.headers.length, 12);
    assert.equal(table?.rows.length, 100);
    assert.equal(table?.rows[0].length, 12);
  });

  it("coerces metadata records", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "metadata",
      metadata: {
        title: "Example",
        description: "Desc",
        author: undefined,
        og: {
          "og:Title": "OG Title",
          "og:image": "https://example.com/a.png",
          empty: "",
        },
        twitter: { "twitter:card": "summary" },
      },
    });
    assert.ok(page);
    assert.equal(page.metadata?.title, "Example");
    assert.equal(page.metadata?.description, "Desc");
    assert.equal(page.metadata?.canonical, null);
    assert.equal(page.metadata?.author, null);
    assert.deepEqual(page.metadata?.og, {
      "og:title": "OG Title",
      "og:image": "https://example.com/a.png",
    });
    assert.deepEqual(page.metadata?.twitter, { "twitter:card": "summary" });
  });

  it("coerces and clamps outline headings", () => {
    const headings = Array.from({ length: 205 }, (_, index) => ({
      level: (index % 9) + 1,
      text: `Heading ${index}`,
    }));
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "outline",
      outline: [...headings, { level: "x", text: "bad" }, { level: 2 }],
    });
    assert.ok(page);
    assert.equal(page.outline?.length, 200);
    assert.equal(page.outline?.[0].level, 1);
    assert.equal(page.outline?.[7].level, 6);
    assert.equal(page.outline?.[8].level, 6);
  });

  it("keeps markdown content", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "markdown",
      text: "fallback",
      fullLength: 42,
      markdown: "# Title\n\nBody",
    });
    assert.ok(page);
    assert.equal(page.format, "markdown");
    assert.equal(page.markdown, "# Title\n\nBody");
    assert.equal(page.description, null);
  });

  it("reports truncation against the requested limit", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      title: "Example",
      selectedText: "pick",
      text: "x".repeat(50),
      fullLength: 100,
      offset: 0,
      readyState: "complete",
      description: "A description",
    });
    assert.ok(page);

    const short = toPageReadResult(page, { maxChars: 50 });
    assert.equal(short.truncated, true);
    assert.equal(short.length, 100);
    assert.equal(short.title, "Example");
    assert.equal(short.description, "A description");

    const widePage = coercePageSnapshot({
      url: "https://example.com/",
      text: "x".repeat(100),
      fullLength: 100,
      offset: 0,
    });
    assert.ok(widePage);
    const wide = toPageReadResult(widePage, { maxChars: 5_000 });
    assert.equal(wide.truncated, false);
    assert.equal(wide.nextOffset, null);
  });

  it("copies format fields into the read result", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      title: "Example",
      text: "fallback",
      format: "links",
      selector: "main",
      selectorMatched: true,
      contentType: "text/html",
      links: [{ text: "Example", url: "https://example.com/x" }],
    });
    assert.ok(page);

    const result = toPageReadResult(page);
    assert.equal(result.format, "links");
    assert.equal(result.selector, "main");
    assert.equal(result.contentType, "text/html");
    assert.deepEqual(result.links, [
      { text: "Example", url: "https://example.com/x" },
    ]);
    assert.equal(result.markdown, undefined);
    assert.equal(result.tables, undefined);
    assert.equal(result.metadata, undefined);
    assert.equal(result.outline, undefined);
  });

  it("lets an explicit content type win over the snapshot", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "x",
      contentType: "text/html",
    });
    assert.ok(page);

    assert.equal(
      toPageReadResult(page, { contentType: "application/pdf" }).contentType,
      "application/pdf"
    );
    assert.equal(
      toPageReadResult(page, { contentType: null }).contentType,
      null
    );
    assert.equal(toPageReadResult(page).contentType, "text/html");
  });

  it("uses markdown length as the primary length for markdown reads", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "markdown",
      text: "fallback text",
      fullLength: 500,
      markdown: "# Title",
    });
    assert.ok(page);

    const result = toPageReadResult(page, { maxChars: 100 });
    assert.equal(result.length, 500);
    assert.equal(result.truncated, true);
    assert.equal(result.markdown, "# Title");
    assert.equal(result.text, "fallback text");
  });

  it("passes metadata and outline through", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "outline",
      text: "body",
      metadata: { title: "Example" },
      outline: [{ level: 2, text: "Section" }],
    });
    assert.ok(page);

    const result = toPageReadResult(page, { maxChars: 10 });
    assert.equal(result.metadata?.title, "Example");
    assert.deepEqual(result.outline, [{ level: 2, text: "Section" }]);
  });

  it("reports offset and nextOffset for text reads", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "0123456789",
      fullLength: 100,
      offset: 0,
    });
    assert.ok(page);

    const first = toPageReadResult(page, { maxChars: 10 });
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 10);
    assert.equal(first.truncated, true);
    assert.equal(first.length, 100);

    const second = coercePageSnapshot({
      url: "https://example.com/",
      text: "abcdefghij",
      fullLength: 100,
      offset: 80,
    });
    assert.ok(second);
    const rest = toPageReadResult(second, { maxChars: 10 });
    assert.equal(rest.offset, 80);
    assert.equal(rest.nextOffset, 90);
    assert.equal(rest.truncated, true);
  });

  it("returns an empty final chunk at the end of a page", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "",
      fullLength: 100,
      offset: 100,
    });
    assert.ok(page);

    const result = toPageReadResult(page, { maxChars: 10, offset: 100 });
    assert.equal(result.text, "");
    assert.equal(result.offset, 100);
    assert.equal(result.nextOffset, null);
    assert.equal(result.truncated, false);
  });

  it("clamps offsets beyond the page length", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      text: "",
      fullLength: 100,
      offset: 999,
    });
    assert.equal(page?.offset, 100);

    const result = toPageReadResult(page!, { maxChars: 10, offset: 999 });
    assert.equal(result.offset, 100);
    assert.equal(result.nextOffset, null);
  });

  it("uses the markdown stream for the next offset", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "markdown",
      text: "plain preview",
      fullLength: 50,
      offset: 20,
      markdown: "0123456789",
    });
    assert.ok(page);

    const result = toPageReadResult(page);
    assert.equal(result.length, 50);
    assert.equal(result.offset, 20);
    assert.equal(result.nextOffset, 30);
    assert.equal(result.markdown, "0123456789");
  });

  it("ignores offset for structured reads and explains why", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      format: "links",
      text: "x".repeat(50),
      fullLength: 100,
      offset: 0,
      links: [{ text: "Example", url: "https://example.com/x" }],
    });
    assert.ok(page);

    const result = toPageReadResult(page, { maxChars: 50, offset: 25 });
    assert.equal(result.offset, 0);
    assert.equal(result.nextOffset, null);
    assert.match(result.limitation ?? "", /ignored offset=25/);
    assert.equal(result.links?.length, 1);
  });
});

describe("wait probes and action signatures", () => {
  it("embeds only the requested wait condition", () => {
    const script = buildWaitProbeScript({
      selector: 'button[data-test="a"]',
    });
    assert.ok(script.includes(`const selector = "button[data-test=\\"a\\"]";`));
    assert.ok(script.includes("const text = null;"));
    assert.ok(script.includes("const urlContains = null;"));
    assert.ok(script.includes("const titleContains = null;"));
    assert.doesNotThrow(() => new Function(script));
  });

  it("keeps hostile condition text as data", () => {
    const hostile = '"); location = "https://evil.example"; //';
    const script = buildWaitProbeScript({ text: hostile });
    assert.ok(script.includes(JSON.stringify(hostile)));
    assert.doesNotThrow(() => new Function(script));
  });

  it("builds a probe with no condition when the options are empty", () => {
    const script = buildWaitProbeScript();
    assert.ok(script.includes("const selector = null;"));
    assert.ok(script.includes("var matched = false;"));
    assert.doesNotThrow(() => new Function(script));
  });

  it("rejects values that are not wait probes", () => {
    assert.equal(coerceWaitProbe(null), null);
    assert.equal(coerceWaitProbe("probe"), null);
    assert.equal(coerceWaitProbe({ title: "no url" }), null);
  });

  it("normalizes wait probe fields", () => {
    const probe = coerceWaitProbe({
      url: "https://example.com/",
      title: 42,
      readyState: "complete",
    });
    assert.ok(probe);
    assert.equal(probe.title, "42");
    assert.equal(probe.readyState, "complete");
    assert.equal(probe.matched, false);
  });

  it("builds a valid signature script that returns no page text", () => {
    const script = buildPageSignatureScript();
    assert.match(script, /function hashString/);
    assert.doesNotThrow(() => new Function(script));
    assert.ok(!script.includes("location ="));
  });

  it("rejects values that are not signatures", () => {
    assert.equal(coercePageSignature(null), null);
    assert.equal(coercePageSignature({ title: "no url" }), null);
  });

  it("clamps signature numbers to non-negative integers", () => {
    const signature = coercePageSignature({
      url: "https://example.com/",
      textLength: -5,
      textHash: 12.9,
      elementCount: "7",
      valueHash: Number.NaN,
    });
    assert.ok(signature);
    assert.equal(signature.textLength, 0);
    assert.equal(signature.textHash, 12);
    assert.equal(signature.elementCount, 7);
    assert.equal(signature.valueHash, 0);
  });

  const base: PageSignature = {
    url: "https://example.com/",
    title: "Example",
    readyState: "complete",
    textLength: 100,
    textHash: 11,
    elementCount: 20,
    valueHash: 33,
  };

  it("reports no change for identical signatures", () => {
    const diff = comparePageSignatures(base, { ...base });
    assert.equal(diff.changed, false);
    assert.equal(diff.domChanged, false);
  });

  it("detects URL, title, DOM, and value changes", () => {
    assert.equal(
      comparePageSignatures(base, { ...base, url: "https://example.com/next" })
        .urlChanged,
      true
    );
    assert.equal(
      comparePageSignatures(base, { ...base, title: "Done" }).titleChanged,
      true
    );
    assert.equal(
      comparePageSignatures(base, { ...base, textHash: 12 }).domChanged,
      true
    );
    assert.equal(
      comparePageSignatures(base, { ...base, elementCount: 21 }).changed,
      true
    );
    assert.equal(
      comparePageSignatures(base, { ...base, valueHash: 34 }).valueChanged,
      true
    );
  });
});

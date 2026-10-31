import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeEvidenceText,
  decodeHtmlEntities,
  findEvidenceQuote,
} from "../../src/shared/evidence.js";
import {
  buildEvidenceClearScript,
  buildEvidenceHighlightScript,
  buildEvidenceIndexScript,
  buildEvidenceStateScript,
  coerceEvidenceClear,
  coerceEvidenceHighlight,
  coerceEvidenceIndex,
  coerceEvidenceState,
  createEvidenceMarker,
  isEvidenceMarker,
} from "../../src/shared/evidence-script.js";

const TEST_MARKER = "data-zen-0123456789abcdef";

describe("evidence quote matching", () => {
  it("matches an exact quote and reports its raw offsets", () => {
    const page = "The quick brown fox jumps over the lazy dog.";
    const outcome = findEvidenceQuote(page, { quote: "quick brown" });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "exact");
    assert.equal(outcome.candidate.confidence, 1);
    assert.equal(outcome.occurrences, 1);
    assert.equal(page.slice(outcome.candidate.start, outcome.candidate.end), "quick brown");
  });

  it("decodes HTML entities before matching", () => {
    const page = "Tom & Jerry \u00a9 2026";
    const outcome = findEvidenceQuote(page, { quote: "Tom &amp; Jerry &copy; 2026" });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "exact");
  });

  it("still matches a page that literally contains an entity", () => {
    const page = "Write &amp; to escape an ampersand.";
    const outcome = findEvidenceQuote(page, { quote: "Write &amp; to escape" });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "exact");
    assert.equal(
      page.slice(outcome.candidate.start, outcome.candidate.end),
      "Write &amp; to escape"
    );
  });

  it("matches across whitespace and line-break differences", () => {
    const page = "The\n  quick   brown\nfox jumps.";
    const outcome = findEvidenceQuote(page, { quote: "The quick brown fox" });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "normalized");
    assert.deepEqual(
      [outcome.candidate.start, outcome.candidate.end],
      [0, page.indexOf("fox") + 3]
    );
  });

  it("matches typographic punctuation, accents and unicode quotes", () => {
    const page = "\u201cCaf\u00e9 \u2014 d\u00e9j\u00e0 vu\u201d said the fox.";
    const outcome = findEvidenceQuote(page, {
      quote: '"Cafe - deja vu" said the fox.',
    });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "normalized");
    assert.equal(
      page.slice(outcome.candidate.start, outcome.candidate.end),
      page
    );
  });

  it("normalizes composed and decomposed accents identically", () => {
    const composed = canonicalizeEvidenceText("caf\u00e9");
    const decomposed = canonicalizeEvidenceText("cafe\u0301");
    assert.equal(composed.text, "cafe");
    assert.equal(decomposed.text, "cafe");
  });

  it("reports every occurrence instead of picking one", () => {
    const page = "The passage repeats. Filler. The passage repeats.";
    const outcome = findEvidenceQuote(page, { quote: "The passage repeats." });
    assert.equal(outcome.status, "ambiguous");
    if (outcome.status !== "ambiguous") return;
    assert.equal(outcome.candidates.length, 2);
    assert.match(outcome.message, /no context/i);
  });

  it("uses context to choose between far-apart occurrences", () => {
    const filler = "filler ".repeat(300);
    const page =
      "Alpha section. The shared passage is here. " +
      filler +
      "Omega section. The shared passage is here.";
    const outcome = findEvidenceQuote(page, {
      quote: "The shared passage is here.",
      context: "Omega section",
    });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "context");
    assert.equal(outcome.candidate.confidence, 0.95);
    assert.equal(outcome.occurrences, 2);
    assert.ok(outcome.candidate.start > page.indexOf("Omega"));
  });

  it("stays ambiguous when the context fits every occurrence", () => {
    const page =
      "Alpha. The shared passage is here. Alpha. The shared passage is here.";
    const outcome = findEvidenceQuote(page, {
      quote: "The shared passage is here.",
      context: "Alpha",
    });
    assert.equal(outcome.status, "ambiguous");
  });

  it("falls back to fuzzy matching for a minor wording difference", () => {
    const page = "The quick brown fox jumps over the lazy dog.";
    const outcome = findEvidenceQuote(page, {
      quote: "The quick brown fox jumped over a lazy dog.",
    });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "fuzzy");
    assert.ok(outcome.candidate.confidence >= 0.85);
    assert.equal(
      page.slice(outcome.candidate.start, outcome.candidate.end),
      "The quick brown fox jumps over the lazy dog"
    );
  });

  it("does not fuzz a changed number", () => {
    const page = "Revenue increased by 75% this year.";
    const outcome = findEvidenceQuote(page, {
      quote: "Revenue increased by 15% this year.",
    });
    assert.notEqual(outcome.status, "matched");
  });

  it("does not fuzz a dropped negation", () => {
    const page = "The treatment did reduce mortality in all groups.";
    const outcome = findEvidenceQuote(page, {
      quote: "The treatment did not reduce mortality in all groups.",
    });
    assert.notEqual(outcome.status, "matched");
  });

  it("does not fuzz a changed script diacritic", () => {
    const page = "\u304b\u3093";
    const outcome = findEvidenceQuote(page, { quote: "\u304c\u3093" });
    assert.notEqual(outcome.status, "matched");
  });

  it("reports when the occurrence scan hit its cap", () => {
    const page = "repeat text. ".repeat(60);
    const outcome = findEvidenceQuote(page, { quote: "repeat text." });
    assert.equal(outcome.status, "ambiguous");
    if (outcome.status !== "ambiguous") return;
    assert.equal(outcome.occurrences, 50);
    assert.equal(outcome.occurrencesTruncated, true);
    assert.match(outcome.message, /at least 50/i);
  });

  it("honours a raised confidence threshold", () => {
    const page = "The quick brown fox jumps over the lazy dog.";
    const outcome = findEvidenceQuote(page, {
      quote: "The quick brown fox jumped over a lazy dog.",
      minConfidence: 0.95,
    });
    assert.equal(outcome.status, "low_confidence");
    if (outcome.status !== "low_confidence") return;
    assert.equal(outcome.threshold, 0.95);
    assert.ok(outcome.candidate.confidence < 0.95);
  });

  it("returns not_found for missing and unrelated quotes", () => {
    const page = "A page about lighthouses and their keepers.";
    const missing = findEvidenceQuote(page, {
      quote: "completely unrelated text about rockets",
    });
    assert.equal(missing.status, "not_found");

    const empty = findEvidenceQuote(page, { quote: "   " });
    assert.equal(empty.status, "not_found");
  });

  it("does not fuzz long quotes past the fuzzy limit", () => {
    const page = "short page";
    const outcome = findEvidenceQuote(page, { quote: "word ".repeat(100) });
    assert.equal(outcome.status, "not_found");
    if (outcome.status !== "not_found") return;
    assert.match(outcome.message, /fuzzy matching limit/i);
  });
});

describe("evidence text canonicalization", () => {
  it("decodes named and numeric entities", () => {
    assert.equal(decodeHtmlEntities("&amp; &#65; &#x42; &nbsp;"), "& A B  ");
    assert.equal(decodeHtmlEntities("&unknown; &amp"), "&unknown; &amp");
    assert.equal(
      decodeHtmlEntities("&#0; &#x7f; &#x1b;"),
      "&#0; &#x7f; &#x1b;"
    );
  });

  it("maps dashes, ellipses and zero-width characters", () => {
    assert.equal(
      canonicalizeEvidenceText("a\u2014b\u2026c\u200bd").text,
      "a-b...cd"
    );
  });

  it("folds Latin diacritics but keeps other scripts distinct", () => {
    const latin = canonicalizeEvidenceText("Caf\u00e9 r\u00e9sum\u00e9");
    assert.equal(latin.text, "cafe resume");
    assert.ok(latin.folds.some((fold) => fold === 2));

    assert.equal(canonicalizeEvidenceText("\u304c\u3093").text, "\u304c\u3093");
    assert.notEqual(
      canonicalizeEvidenceText("\u304b\u3093").text,
      canonicalizeEvidenceText("\u304c\u3093").text
    );
    assert.notEqual(
      canonicalizeEvidenceText("\u0915\u0924\u093e\u092c").text,
      canonicalizeEvidenceText("\u0915\u093f\u0924\u093e\u092c").text
    );
  });

  it("drops bidi overrides and control characters", () => {
    assert.equal(
      canonicalizeEvidenceText("a\u202eb\u0000c\u2066d").text,
      "abcd"
    );
  });

  it("reports a lower confidence when normalization folded accents", () => {
    const page = "The r\u00e9sum\u00e9 is attached.";
    const outcome = findEvidenceQuote(page, { quote: "The resume is attached." });
    assert.equal(outcome.status, "matched");
    if (outcome.status !== "matched") return;
    assert.equal(outcome.candidate.method, "normalized");
    assert.ok(outcome.candidate.confidence < 0.99);
  });

  it("keeps a raw offset for every canonical character", () => {
    const text = "A  caf\u00e9\n";
    const canonical = canonicalizeEvidenceText(text);
    assert.equal(canonical.text, "a cafe");
    assert.equal(canonical.starts.length, canonical.text.length);
    assert.equal(canonical.ends.length, canonical.text.length);
    assert.equal(text.slice(canonical.starts[0], canonical.ends[0]), "A");
    assert.equal(
      text.slice(canonical.starts[5], canonical.ends[5]),
      "\u00e9"
    );
  });
});

describe("evidence page scripts", () => {
  it("builds syntactically valid scripts", () => {
    const scripts = [
      buildEvidenceIndexScript({ maxChars: 50_000 }),
      buildEvidenceStateScript(),
      buildEvidenceHighlightScript({
        start: 10,
        end: 20,
        expectedText: "alpha",
        ttlMs: 8_000,
        scroll: true,
        marker: TEST_MARKER,
      }),
      buildEvidenceClearScript({ markers: [TEST_MARKER] }),
    ];
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script));
    }
  });

  it("embeds clamped highlight options and a per-call marker", () => {
    const script = buildEvidenceHighlightScript({
      start: -4,
      end: 12,
      expectedText: 'a "quoted" line',
      ttlMs: 500,
      scroll: false,
      marker: TEST_MARKER,
      clearMarkers: [TEST_MARKER, "not a marker]"],
    });
    assert.match(script, /const start = 0;/);
    assert.match(script, /const end = 12;/);
    assert.match(script, /const ttlMs = 1000;/);
    assert.match(script, /const shouldScroll = false;/);
    assert.ok(script.includes(JSON.stringify('a "quoted" line')));
    assert.ok(script.includes(TEST_MARKER));
    assert.ok(!script.includes("not a marker"));
    assert.ok(!script.includes("data-zen-mcp-evidence"));
    assert.doesNotThrow(() => new Function(script));
  });

  it("requires a valid marker for highlighting", () => {
    assert.throws(() =>
      buildEvidenceHighlightScript({
        start: 0,
        end: 1,
        expectedText: "a",
        ttlMs: 1_000,
        scroll: true,
        marker: 'x"]; document.body.remove(); //',
      })
    );
  });

  it("creates unpredictable markers and validates them", () => {
    const first = createEvidenceMarker();
    const second = createEvidenceMarker();
    assert.ok(isEvidenceMarker(first));
    assert.ok(isEvidenceMarker(second));
    assert.notEqual(first, second);
    assert.equal(isEvidenceMarker("data-zen-mcp-evidence"), false);
    assert.equal(isEvidenceMarker("data-zen-short"), false);
  });

  it("only clears markers that pass validation", () => {
    const script = buildEvidenceClearScript({
      markers: [TEST_MARKER, "plain-attribute", "data-zen-ok-but]bad"],
    });
    assert.ok(script.includes(TEST_MARKER));
    assert.ok(!script.includes("plain-attribute"));
    assert.doesNotThrow(() => new Function(script));
  });

  it("clamps the evidence index size", () => {
    assert.match(buildEvidenceIndexScript({ maxChars: 1 }), /const maxChars = 1000;/);
    assert.match(
      buildEvidenceIndexScript({ maxChars: 5_000_000 }),
      /const maxChars = 1000000;/
    );
  });

  it("coerces page snapshots defensively", () => {
    assert.equal(coerceEvidenceIndex(null), null);
    assert.equal(coerceEvidenceIndex({ title: "no text" }), null);
    const snapshot = coerceEvidenceIndex({
      title: "Title",
      url: "https://example.com/",
      readyState: "complete",
      contentType: "text/html",
      text: "hello",
      truncated: true,
      textLength: 5,
    });
    assert.ok(snapshot);
    assert.equal(snapshot.text, "hello");
    assert.equal(snapshot.truncated, true);

    const state = coerceEvidenceState({
      title: "Title",
      url: "https://example.com/",
      readyState: "interactive",
      contentType: "text/html",
    });
    assert.equal(state?.readyState, "interactive");
    assert.equal(coerceEvidenceState("nope"), null);
  });

  it("coerces highlight and clear reports", () => {
    const report = coerceEvidenceHighlight({
      ok: true,
      stale: false,
      highlighted: true,
      scrolled: true,
      inView: true,
      rects: 2,
      scrollY: 120,
    });
    assert.deepEqual(report, {
      ok: true,
      stale: false,
      highlighted: true,
      scrolled: true,
      inView: true,
      rects: 2,
      scrollY: 120,
      reason: undefined,
    });
    assert.equal(coerceEvidenceHighlight(null).ok, false);
    assert.equal(coerceEvidenceHighlight(null).inView, false);
    assert.deepEqual(coerceEvidenceClear({ cleared: true, removed: 3 }), {
      cleared: true,
      removed: 3,
    });
    assert.deepEqual(coerceEvidenceClear(undefined), {
      cleared: false,
      removed: 0,
    });
  });
});

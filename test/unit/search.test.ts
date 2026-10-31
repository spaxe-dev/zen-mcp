import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findLiteralMatches } from "../../src/shared/search.js";

describe("findLiteralMatches", () => {
  it("finds literal text and returns raw offsets", () => {
    const page = "The keeper checked the lamp at dawn.";
    const result = findLiteralMatches(page, { query: "lamp" });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches.length, 1);
    const match = result.matches[0]!;
    assert.equal(page.slice(match.start, match.end), "lamp");
    assert.equal(match.text, "lamp");
    assert.equal(result.scanStopped, false);
  });

  it("finds every occurrence in order", () => {
    const page = "one two one two one";
    const result = findLiteralMatches(page, { query: "one" });
    assert.equal(result.totalMatches, 3);
    assert.deepEqual(
      result.matches.map((match) => match.start),
      [0, 8, 16]
    );
  });

  it("ignores case, typographic quotes, and diacritics by default", () => {
    const page = 'Café said “HELLO” — then left.';
    const result = findLiteralMatches(page, { query: '"hello"' });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0]!.text, '“HELLO”');

    const folded = findLiteralMatches(page, { query: "cafe" });
    assert.equal(folded.totalMatches, 1);
    assert.equal(folded.matches[0]!.text, "Café");
  });

  it("keeps exact matching when caseSensitive is set", () => {
    const page = "Lamp lamp LAMP";
    const result = findLiteralMatches(page, {
      query: "lamp",
      caseSensitive: true,
    });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.matches[0]!.start, 5);

    const folded = findLiteralMatches("Café", {
      query: "cafe",
      caseSensitive: true,
    });
    assert.equal(folded.totalMatches, 0);
  });

  it("matches across whitespace differences in folded mode only", () => {
    const page = "alpha\n\n   beta";
    const folded = findLiteralMatches(page, { query: "alpha beta" });
    assert.equal(folded.totalMatches, 1);
    assert.equal(folded.matches[0]!.text, "alpha\n\n   beta");

    const exact = findLiteralMatches(page, {
      query: "alpha beta",
      caseSensitive: true,
    });
    assert.equal(exact.totalMatches, 0);
  });

  it("returns excerpts with context and ellipses", () => {
    const page = `${"a".repeat(40)}needle${"b".repeat(40)}`;
    const result = findLiteralMatches(page, {
      query: "needle",
      contextChars: 5,
    });
    const excerpt = result.matches[0]!.excerpt;
    assert.equal(excerpt, `...${"a".repeat(5)}needle${"b".repeat(5)}...`);

    const wide = findLiteralMatches("needle", { query: "needle" });
    assert.equal(wide.matches[0]!.excerpt, "needle");
  });

  it("collapses whitespace inside excerpts", () => {
    const result = findLiteralMatches("a   needle\nhere", {
      query: "needle",
      contextChars: 5,
    });
    assert.equal(result.matches[0]!.excerpt, "a needle here");
  });

  it("caps returned matches but reports the total", () => {
    const page = "x ".repeat(100);
    const result = findLiteralMatches(page, { query: "x", maxMatches: 3 });
    assert.equal(result.matches.length, 3);
    assert.equal(result.totalMatches, 100);
    assert.equal(result.scanStopped, false);
  });

  it("stops scanning at the safety limit", () => {
    const page = "a".repeat(6_000);
    const result = findLiteralMatches(page, {
      query: "a",
      maxMatches: 50,
    });
    assert.equal(result.matches.length, 50);
    assert.equal(result.totalMatches, 5_000);
    assert.equal(result.scanStopped, true);
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(findLiteralMatches("", { query: "x" }), {
      matches: [],
      totalMatches: 0,
      scanStopped: false,
    });
    assert.deepEqual(findLiteralMatches("text", { query: "   " }), {
      matches: [],
      totalMatches: 0,
      scanStopped: false,
    });
    assert.deepEqual(findLiteralMatches("text", { query: "missing" }), {
      matches: [],
      totalMatches: 0,
      scanStopped: false,
    });
  });
});

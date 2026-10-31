import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReadScript,
  coercePageSnapshot,
  toPageReadResult,
} from "../../src/shared/read-script.js";

describe("page read script", () => {
  it("embeds the character limit", () => {
    assert.match(buildReadScript(1234), /const maxChars = 1234;/);
  });

  it("rejects values that are not page snapshots", () => {
    assert.equal(coercePageSnapshot(null), null);
    assert.equal(coercePageSnapshot("page"), null);
    assert.equal(coercePageSnapshot({ title: "no url" }), null);
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
      readyState: "",
      description: null,
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

  it("reports truncation against the requested limit", () => {
    const page = coercePageSnapshot({
      url: "https://example.com/",
      title: "Example",
      selectedText: "pick",
      text: "x".repeat(50),
      fullLength: 100,
      readyState: "complete",
      description: "A description",
    });
    assert.ok(page);

    const short = toPageReadResult(page, 50);
    assert.equal(short.truncated, true);
    assert.equal(short.length, 100);
    assert.equal(short.title, "Example");
    assert.equal(short.description, "A description");

    const wide = toPageReadResult(page, 5_000);
    assert.equal(wide.truncated, false);
  });
});

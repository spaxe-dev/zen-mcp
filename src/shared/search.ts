/**
 * Literal page search. Like the evidence matcher this module is pure and runs
 * in Node and inside the browser bridge. The query is always data: there are
 * no regular expressions and no page-supplied code.
 */

import type { TextMatch } from "./protocol.js";
import { canonicalizeEvidenceText } from "./evidence.js";

export interface LiteralSearchOptions {
  query: string;
  caseSensitive?: boolean;
  /** Matches returned to the caller. Defaults to 20, capped at 50. */
  maxMatches?: number;
  /** Characters of context on each side. Defaults to 120, capped at 300. */
  contextChars?: number;
}

export interface LiteralSearchOutcome {
  matches: TextMatch[];
  totalMatches: number;
  /** True when the scan stopped before reaching the end of the page. */
  scanStopped: boolean;
}

const DEFAULT_MAX_MATCHES = 20;
const MAX_MATCHES = 50;
const DEFAULT_CONTEXT_CHARS = 120;
const MAX_CONTEXT_CHARS = 300;
const MAX_SCAN = 5_000;

export function findLiteralMatches(
  pageText: string,
  options: LiteralSearchOptions
): LiteralSearchOutcome {
  const page = String(pageText ?? "");
  const query = String(options.query ?? "").trim();
  if (!page || !query) {
    return { matches: [], totalMatches: 0, scanStopped: false };
  }

  const maxMatches = clamp(
    options.maxMatches ?? DEFAULT_MAX_MATCHES,
    1,
    MAX_MATCHES
  );
  const contextChars = clamp(
    options.contextChars ?? DEFAULT_CONTEXT_CHARS,
    0,
    MAX_CONTEXT_CHARS
  );

  const spans = options.caseSensitive
    ? exactSpans(page, query)
    : foldedSpans(page, query);

  const matches = spans.slice(0, maxMatches).map((span) =>
    matchFor(page, span.start, span.end, contextChars)
  );

  return {
    matches,
    totalMatches: spans.length,
    scanStopped: spans.length >= MAX_SCAN,
  };
}

function exactSpans(
  page: string,
  query: string
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (spans.length < MAX_SCAN) {
    const index = page.indexOf(query, from);
    if (index === -1) break;
    spans.push({ start: index, end: index + query.length });
    from = index + Math.max(1, query.length);
  }
  return spans;
}

function foldedSpans(
  page: string,
  query: string
): Array<{ start: number; end: number }> {
  const canonicalPage = canonicalizeEvidenceText(page);
  const canonicalQuery = canonicalizeEvidenceText(query).text;
  if (!canonicalQuery) return [];

  const spans: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  let from = 0;
  while (spans.length < MAX_SCAN) {
    const index = canonicalPage.text.indexOf(canonicalQuery, from);
    if (index === -1) break;
    from = index + Math.max(1, canonicalQuery.length);
    const start = canonicalPage.starts[index];
    const end = canonicalPage.ends[index + canonicalQuery.length - 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({ start, end });
  }
  return spans;
}

function matchFor(
  page: string,
  start: number,
  end: number,
  contextChars: number
): TextMatch {
  return {
    start,
    end,
    text: page.slice(start, end),
    excerpt: excerptAt(page, start, end, contextChars),
  };
}

function excerptAt(
  page: string,
  start: number,
  end: number,
  contextChars: number
): string {
  const from = Math.max(0, start - contextChars);
  const to = Math.min(page.length, end + contextChars);
  const prefix = from > 0 ? "..." : "";
  const suffix = to < page.length ? "..." : "";
  const body = collapse(page.slice(from, to));
  return `${prefix}${body}${suffix}`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

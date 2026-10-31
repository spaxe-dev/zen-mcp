/**
 * Evidence quote matching. This module is pure: it runs both in Node (tests)
 * and inside the browser bridge, so it must not import platform APIs.
 *
 * Matching order is exact, whitespace/punctuation normalized, context assisted
 * and finally fuzzy. A repeated quote is never picked arbitrarily: callers get
 * an ambiguity or low-confidence result instead of a wrong highlight.
 */

export type EvidenceMatchMethod = "exact" | "normalized" | "context" | "fuzzy";

export interface EvidenceMatchCandidate {
  /** Raw page text offsets. */
  start: number;
  end: number;
  method: EvidenceMatchMethod;
  confidence: number;
  /** Compact page text at the match, with whitespace collapsed. */
  excerpt: string;
  /** Overlap between the supplied context and the surrounding page text. */
  contextScore: number;
}

export type EvidenceMatchOutcome =
  | {
      status: "matched";
      candidate: EvidenceMatchCandidate;
      occurrences: number;
      occurrencesTruncated?: boolean;
    }
  | { status: "not_found"; message: string }
  | {
      status: "ambiguous";
      candidates: EvidenceMatchCandidate[];
      occurrences: number;
      occurrencesTruncated?: boolean;
      message: string;
    }
  | {
      status: "low_confidence";
      candidate: EvidenceMatchCandidate;
      threshold: number;
      message: string;
    };

export interface EvidenceMatchOptions {
  quote: string;
  context?: string;
  /** Fuzzy acceptance threshold, 0.5 to 1. Defaults to 0.85. */
  minConfidence?: number;
  /** Maximum candidate passages returned with an ambiguity result. */
  maxCandidates?: number;
}

interface CanonicalText {
  text: string;
  /** For each canonical UTF-16 unit, the raw start offset it came from. */
  starts: number[];
  /** For each canonical UTF-16 unit, the raw end offset it came from. */
  ends: number[];
  /**
   * 0 = only case changed, 1 = punctuation or whitespace changed,
   * 2 = diacritics or compatibility characters were folded.
   */
  folds: number[];
}

interface Token {
  text: string;
  start: number;
  end: number;
}

interface CandidateSpan {
  start: number;
  end: number;
  confidence?: number;
}

interface CriticalProfile {
  numbers: Map<string, number>;
  negations: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.85;
const MAX_CANDIDATES = 5;
const CONTEXT_WINDOW = 800;
const CONTEXT_MIN_SCORE = 0.2;
const CONTEXT_MIN_MARGIN = 0.1;
const MAX_OCCURRENCES = 50;
const MAX_FUZZY_QUOTE = 300;
const MAX_FUZZY_WINDOWS = 160;
const MIN_FUZZY_SIMILARITY = 0.45;

/** Confidence for normalized matches by the deepest fold they required. */
const NORMALIZED_CONFIDENCE = [0.99, 0.97, 0.93] as const;

/** Words that reverse or cancel a claim; fuzzy matching must not drop them. */
const NEGATION_WORDS = new Set([
  "no",
  "not",
  "never",
  "none",
  "nobody",
  "nothing",
  "neither",
  "nor",
  "cannot",
  "without",
  "lack",
  "lacks",
  "lacking",
  "denied",
  "denies",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  plusmn: "\u00b1",
  times: "\u00d7",
  divide: "\u00f7",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
};

const CHARACTER_MAP: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u2032": "'",
  "\u00b4": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u201f": '"',
  "\u2033": '"',
  "\u00ab": '"',
  "\u00bb": '"',
  "\u2039": "'",
  "\u203a": "'",
  "\u300c": '"',
  "\u300d": '"',
  "\u300e": '"',
  "\u300f": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u00ad": "",
  "\u2026": "...",
  "\u22ef": "...",
  "\u00a0": " ",
};

/**
 * Zero-width and bidirectional control characters are invisible but can
 * reorder or disguise text. They never belong in a matched passage.
 */
const INVISIBLE = /^[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]$/u;
const WHITESPACE = /^\s$/u;
const MARK = /^\p{M}$/u;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/** Decodes the common HTML entities an agent may copy out of page source. */
export function decodeHtmlEntities(input: string): string {
  return String(input ?? "").replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1]?.toLowerCase() === "x";
        const digits = hex ? body.slice(2) : body.slice(1);
        const value = Number.parseInt(digits, hex ? 16 : 10);
        if (
          !Number.isFinite(value) ||
          value <= 0 ||
          value > 0x10ffff ||
          (value >= 0xd800 && value <= 0xdfff) ||
          isDisallowedControl(value)
        ) {
          return match;
        }
        return String.fromCodePoint(value);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    }
  );
}

/**
 * Lowercases, applies NFKC, folds Latin diacritics, maps typographic
 * punctuation to ASCII and collapses whitespace. Every canonical unit keeps
 * the raw span it came from so a match can be highlighted in the real DOM.
 *
 * Diacritics are stripped only from Latin base letters. Folding them from
 * other scripts would turn distinct words into matches (Japanese dakuten,
 * Devanagari matras, Arabic and Hebrew points).
 */
export function canonicalizeEvidenceText(input: string): CanonicalText {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const folds: number[] = [];

  const push = (
    value: string,
    rawStart: number,
    rawEnd: number,
    fold: number
  ): void => {
    for (let index = 0; index < value.length; index += 1) {
      out.push(value.charAt(index));
      starts.push(rawStart);
      ends.push(rawEnd);
      folds.push(fold);
    }
  };

  let rawIndex = 0;
  while (rawIndex < input.length) {
    const codePoint = input.codePointAt(rawIndex);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const rawStart = rawIndex;
    const rawEnd = rawIndex + character.length;
    rawIndex = rawEnd;

    if (INVISIBLE.test(character)) continue;
    if (WHITESPACE.test(character)) {
      if (out.length === 0 || out[out.length - 1] === " ") continue;
      push(" ", rawStart, rawEnd, 1);
      continue;
    }
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;

    const mapped = CHARACTER_MAP[character];
    if (mapped !== undefined) {
      if (mapped) push(mapped, rawStart, rawEnd, 1);
      continue;
    }

    const compatibility = character.normalize("NFKC");
    const lowered = compatibility.toLowerCase();
    let fold = compatibility === character ? 0 : 2;
    let folded = "";
    let base = "";
    for (const unit of lowered.normalize("NFD")) {
      if (MARK.test(unit)) {
        if (/^[a-z]$/.test(base)) {
          fold = 2;
        } else {
          const lastIndex = out.length - 1;
          if (lastIndex >= 0 && /^[a-z]$/.test(out[lastIndex])) {
            // A combining mark on its own code point still belongs to the
            // preceding Latin letter: "cafe\u0301" must canonicalize to "cafe".
            folds[lastIndex] = 2;
            ends[lastIndex] = rawEnd;
            continue;
          }
          folded += unit;
        }
        continue;
      }
      folded += unit;
      base = unit;
    }
    folded = folded.normalize("NFC");
    if (folded) push(folded, rawStart, rawEnd, fold);
  }

  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    starts.pop();
    ends.pop();
    folds.pop();
  }

  return { text: out.join(""), starts, ends, folds };
}

function isDisallowedControl(value: number): boolean {
  if (value === 0x09 || value === 0x0a || value === 0x0d) return false;
  return value < 0x20 || (value >= 0x7f && value <= 0x9f);
}

/** Finds every quote candidate and applies the documented match priority. */
export function findEvidenceQuote(
  pageText: string,
  options: EvidenceMatchOptions
): EvidenceMatchOutcome {
  const page = String(pageText ?? "");
  const rawQuote = String(options.quote ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!rawQuote) {
    return { status: "not_found", message: "The quote is empty." };
  }
  const decodedQuote = decodeHtmlEntities(rawQuote).trim();
  // Try the quote literally first. A page can legitimately display text such
  // as "&amp;", and decoding it up front would make that passage unquotable.
  const quoteVariants =
    decodedQuote && decodedQuote !== rawQuote
      ? [rawQuote, decodedQuote]
      : [rawQuote];

  const context = decodeHtmlEntities(options.context ?? "").trim();
  const minConfidence = clamp(
    options.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    0.5,
    0.99
  );
  const maxCandidates = Math.max(
    1,
    Math.min(10, Math.trunc(options.maxCandidates ?? MAX_CANDIDATES))
  );

  for (const variant of quoteVariants) {
    const exact = exactCandidates(page, variant);
    if (exact.starts.length > 0) {
      return resolveOccurrences(
        page,
        exact.starts.map((start) => ({
          start,
          end: start + variant.length,
        })),
        "exact",
        1,
        context,
        maxCandidates,
        exact.truncated
      );
    }
  }

  const pageCanonical = canonicalizeEvidenceText(page);
  const normalizedSpans: CandidateSpan[] = [];
  let normalizedTruncated = false;
  for (const variant of quoteVariants) {
    const quoteCanonical = canonicalizeEvidenceText(variant);
    if (!quoteCanonical.text) continue;
    const found = normalizedCandidates(page, pageCanonical, quoteCanonical);
    normalizedTruncated = normalizedTruncated || found.truncated;
    normalizedSpans.push(...found.spans);
  }
  const normalized = dedupeSpans(normalizedSpans);
  if (normalized.length > 0) {
    const outcome = resolveOccurrences(
      page,
      normalized,
      "normalized",
      0.99,
      context,
      maxCandidates,
      normalizedTruncated
    );
    if (outcome.status !== "not_found") return outcome;
  }

  const fuzzyQuote = decodedQuote || rawQuote;
  const quoteCanonical = canonicalizeEvidenceText(fuzzyQuote);
  if (!quoteCanonical.text) {
    return { status: "not_found", message: "The quote has no readable text." };
  }

  return fuzzyOutcome(
    page,
    pageCanonical,
    quoteCanonical,
    minConfidence,
    maxCandidates
  );
}

function exactCandidates(
  page: string,
  quote: string
): { starts: number[]; truncated: boolean } {
  return findAll(page, quote, MAX_OCCURRENCES);
}

function normalizedCandidates(
  page: string,
  canonical: CanonicalText,
  quoteCanonical: CanonicalText
): { spans: CandidateSpan[]; truncated: boolean } {
  const quoteLength = quoteCanonical.text.length;
  const found = findAll(canonical.text, quoteCanonical.text, MAX_OCCURRENCES);
  const quoteFold = maxFold(quoteCanonical, 0, quoteLength);
  const seen = new Map<string, CandidateSpan>();
  for (const canonicalStart of found.starts) {
    const canonicalEnd = canonicalStart + quoteLength;
    const start = canonical.starts[canonicalStart];
    const end = canonical.ends[canonicalEnd - 1];
    if (
      start === undefined ||
      end === undefined ||
      end <= start ||
      end > page.length
    ) {
      continue;
    }
    const fold = Math.max(quoteFold, maxFold(canonical, canonicalStart, canonicalEnd));
    const confidence = NORMALIZED_CONFIDENCE[Math.min(fold, 2)];
    const key = `${start}:${end}`;
    const existing = seen.get(key);
    if (!existing || confidence > (existing.confidence ?? 0)) {
      seen.set(key, { start, end, confidence });
    }
  }
  return { spans: [...seen.values()], truncated: found.truncated };
}

function maxFold(
  canonical: CanonicalText,
  start: number,
  end: number
): number {
  let fold = 0;
  for (let index = start; index < end; index += 1) {
    fold = Math.max(fold, canonical.folds[index] ?? 0);
  }
  return fold;
}

function dedupeSpans(spans: CandidateSpan[]): CandidateSpan[] {
  const seen = new Map<string, CandidateSpan>();
  for (const span of spans) {
    const key = `${span.start}:${span.end}`;
    const existing = seen.get(key);
    if (!existing || (span.confidence ?? 0) > (existing.confidence ?? 0)) {
      seen.set(key, span);
    }
  }
  return [...seen.values()];
}

function resolveOccurrences(
  page: string,
  spans: CandidateSpan[],
  method: "exact" | "normalized",
  confidence: number,
  context: string,
  maxCandidates: number,
  occurrencesTruncated = false
): EvidenceMatchOutcome {
  const candidates = spans.map((span) =>
    candidateFor(
      page,
      span.start,
      span.end,
      method,
      span.confidence ?? confidence
    )
  );
  if (candidates.length === 1) {
    return { status: "matched", candidate: candidates[0], occurrences: 1 };
  }

  if (occurrencesTruncated) {
    return ambiguousOutcome(
      candidates,
      maxCandidates,
      `Found at least ${MAX_OCCURRENCES} matching passages and stopped counting at ${MAX_OCCURRENCES}. Supply a longer, more distinctive quote; no passage was highlighted.`,
      MAX_OCCURRENCES,
      true
    );
  }

  if (!context) {
    return ambiguousOutcome(
      candidates,
      maxCandidates,
      `Found ${candidates.length} matching passages and no context was supplied to choose one. No passage was highlighted.`,
      candidates.length
    );
  }

  scoreContexts(page, candidates, context);
  const ranked = [...candidates].sort(
    (left, right) =>
      right.contextScore - left.contextScore ||
      left.start - right.start
  );
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = best.contextScore - (runnerUp?.contextScore ?? 0);
  if (best.contextScore >= CONTEXT_MIN_SCORE && margin >= CONTEXT_MIN_MARGIN) {
    return {
      status: "matched",
      candidate: {
        ...best,
        method: "context",
        confidence: Math.min(0.95, best.confidence),
      },
      occurrences: candidates.length,
    };
  }

  return ambiguousOutcome(
    ranked,
    maxCandidates,
    `Found ${candidates.length} matching passages and the supplied context did not clearly select one. No passage was highlighted.`,
    candidates.length
  );
}

function ambiguousOutcome(
  candidates: EvidenceMatchCandidate[],
  maxCandidates: number,
  message: string,
  occurrences: number,
  occurrencesTruncated = false
): EvidenceMatchOutcome {
  const ranked = [...candidates].sort(
    (left, right) =>
      right.contextScore - left.contextScore ||
      left.start - right.start
  );
  return {
    status: "ambiguous",
    candidates: ranked.slice(0, maxCandidates),
    occurrences,
    ...(occurrencesTruncated ? { occurrencesTruncated: true } : {}),
    message,
  };
}

function candidateFor(
  page: string,
  start: number,
  end: number,
  method: EvidenceMatchMethod,
  confidence: number,
  contextScore = 0
): EvidenceMatchCandidate {
  return {
    start,
    end,
    method,
    confidence,
    excerpt: excerptAt(page, start, end),
    contextScore,
  };
}

function fuzzyOutcome(
  page: string,
  canonical: CanonicalText,
  quoteCanonical: CanonicalText,
  threshold: number,
  maxCandidates: number
): EvidenceMatchOutcome {
  if (quoteCanonical.text.length > MAX_FUZZY_QUOTE) {
    return {
      status: "not_found",
      message:
        `The quote is ${quoteCanonical.text.length} characters long, beyond the ` +
        `fuzzy matching limit of ${MAX_FUZZY_QUOTE}. Supply an exact excerpt or ` +
        "a shorter quote; no passage was highlighted.",
    };
  }

  const quoteTokens = tokensOf(quoteCanonical.text);
  if (quoteTokens.length === 0) {
    return {
      status: "not_found",
      message: "The quote has no readable words to match.",
    };
  }
  const quoteProfile = criticalProfile(quoteTokens);

  const windows = fuzzyWindows(
    canonical,
    quoteCanonical.text,
    quoteTokens
  );
  const candidates: EvidenceMatchCandidate[] = [];
  for (const window of windows) {
    const windowText = canonical.text.slice(window.start, window.end);
    const windowTokens = tokensOf(windowText);
    // A character-level match must not silently change a number or drop a
    // negation; those are the words that reverse the meaning of a claim.
    if (!criticalTokensMatch(quoteProfile, windowTokens)) continue;
    const similarity = similarityOf(windowText, quoteCanonical.text);
    if (similarity < MIN_FUZZY_SIMILARITY) continue;
    const start = canonical.starts[window.start];
    const end = canonical.ends[window.end - 1];
    if (start === undefined || end === undefined || end <= start) continue;
    candidates.push(
      candidateFor(page, start, end, "fuzzy", round(similarity))
    );
  }

  if (candidates.length === 0) {
    return {
      status: "not_found",
      message:
        "No passage matching the quote was found on the page. No passage was highlighted.",
    };
  }

  const distinct = dedupeCandidates(candidates);
  const best = distinct[0];

  if (best.confidence < threshold) {
    if (best.confidence >= Math.min(MIN_FUZZY_SIMILARITY, threshold)) {
      return {
        status: "low_confidence",
        candidate: best,
        threshold,
        message:
          `The closest passage matched at ${Math.round(
            best.confidence * 100
          )}%, below the required ${Math.round(
            threshold * 100
          )}%. No passage was highlighted.`,
      };
    }
    return {
      status: "not_found",
      message:
        "No passage matching the quote was found on the page. No passage was highlighted.",
    };
  }

  const runnerUp = distinct.find(
    (candidate) => overlapRatio(candidate, best) < 0.4
  );
  if (
    runnerUp &&
    runnerUp.confidence >= threshold &&
    best.confidence - runnerUp.confidence < 0.04
  ) {
    return ambiguousOutcome(
      distinct,
      maxCandidates,
      "Several similar passages matched equally well. Supply a context string with nearby text so one can be chosen; no passage was highlighted.",
      distinct.length
    );
  }

  return {
    status: "matched",
    candidate: best,
    occurrences: distinct.length,
  };
}

function fuzzyWindows(
  canonical: CanonicalText,
  quoteCanonical: string,
  quoteTokens: Token[]
): Array<{ start: number; end: number }> {
  const pageTokens = tokensOf(canonical.text);
  if (pageTokens.length === 0) return [];

  const seedSet = new Set(
    [...new Set(quoteTokens.map((token) => token.text))]
      .filter((token) => token.length >= 3)
      .sort((left, right) => right.length - left.length)
      .slice(0, 10)
  );
  if (seedSet.size === 0) return [];

  const positions = new Map<string, number[]>();
  for (let index = 0; index < pageTokens.length; index += 1) {
    const token = pageTokens[index].text;
    if (!seedSet.has(token)) continue;
    const list = positions.get(token);
    if (list) {
      if (list.length < 25) list.push(index);
    } else {
      positions.set(token, [index]);
    }
  }
  if (positions.size === 0) return [];

  const quoteLength = quoteCanonical.length;
  const seen = new Set<string>();
  const windows: Array<{ start: number; end: number }> = [];

  for (let quoteIndex = 0; quoteIndex < quoteTokens.length; quoteIndex += 1) {
    const token = quoteTokens[quoteIndex].text;
    if (!seedSet.has(token)) continue;
    for (const pageIndex of positions.get(token) ?? []) {
      const base = pageIndex - quoteIndex;
      for (const padding of [0, 1]) {
        const from = base - padding;
        const to = base + quoteTokens.length - 1 + padding;
        if (from < 0 || to >= pageTokens.length) continue;
        if (to - from + 1 > quoteTokens.length * 2 + 2) continue;
        const start = pageTokens[from].start;
        const end = pageTokens[to].end;
        if (end - start > quoteLength * 1.8 + 32) continue;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push({ start, end });
        if (windows.length >= MAX_FUZZY_WINDOWS) return windows;
      }
    }
  }

  return windows;
}

function criticalProfile(tokens: Token[]): CriticalProfile {
  const numbers = new Map<string, number>();
  let negations = 0;
  for (const token of tokens) {
    if (/\d/.test(token.text)) {
      numbers.set(token.text, (numbers.get(token.text) ?? 0) + 1);
    }
    if (NEGATION_WORDS.has(token.text)) negations += 1;
  }
  return { numbers, negations };
}

function criticalTokensMatch(
  quote: CriticalProfile,
  candidateTokens: Token[]
): boolean {
  const candidate = criticalProfile(candidateTokens);
  if (candidate.negations !== quote.negations) return false;
  if (candidate.numbers.size !== quote.numbers.size) return false;
  for (const [token, count] of quote.numbers) {
    if (candidate.numbers.get(token) !== count) return false;
  }
  return true;
}

function similarityOf(candidate: string, quote: string): number {
  const longest = Math.max(candidate.length, quote.length);
  if (longest === 0) return 1;
  const limit = Math.ceil(longest * (1 - MIN_FUZZY_SIMILARITY));
  const distance = boundedLevenshtein(candidate, quote, limit);
  if (distance > limit) return 0;
  return Math.max(0, 1 - distance / longest);
}

function boundedLevenshtein(
  left: string,
  right: string,
  limit: number
): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) {
    previous[index] = index;
  }
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let rowMinimum = row;
    const code = left.charCodeAt(row - 1);
    for (let column = 1; column <= right.length; column += 1) {
      const cost = code === right.charCodeAt(column - 1) ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost
      );
      current[column] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > limit) return limit + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length] > limit ? limit + 1 : previous[right.length];
}

function dedupeCandidates(
  candidates: EvidenceMatchCandidate[]
): EvidenceMatchCandidate[] {
  const sorted = [...candidates].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.end - left.start - (right.end - right.start) ||
      left.start - right.start
  );
  const kept: EvidenceMatchCandidate[] = [];
  for (const candidate of sorted) {
    if (kept.some((existing) => overlapRatio(existing, candidate) > 0.6)) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

function overlapRatio(
  left: { start: number; end: number },
  right: { start: number; end: number }
): number {
  const overlap = Math.min(left.end, right.end) - Math.max(left.start, right.start);
  if (overlap <= 0) return 0;
  const shortest = Math.min(
    left.end - left.start,
    right.end - right.start
  );
  return shortest > 0 ? overlap / shortest : 0;
}

function scoreContexts(
  page: string,
  candidates: EvidenceMatchCandidate[],
  context: string
): void {
  const contextTokens = tokensOf(
    canonicalizeEvidenceText(context).text
  ).map((token) => token.text);
  const uniqueContext = [...new Set(contextTokens)];
  const contextBigrams = bigramsOf(contextTokens);

  for (const candidate of candidates) {
    const from = Math.max(0, candidate.start - CONTEXT_WINDOW);
    const to = Math.min(page.length, candidate.end + CONTEXT_WINDOW);
    const windowText = canonicalizeEvidenceText(
      page.slice(from, to)
    ).text;
    const windowTokens = tokensOf(windowText).map((token) => token.text);
    const windowSet = new Set(windowTokens);

    let tokenHits = 0;
    for (const token of uniqueContext) {
      if (windowSet.has(token)) tokenHits += 1;
    }
    const tokenScore = uniqueContext.length
      ? tokenHits / uniqueContext.length
      : 0;

    const windowBigrams = bigramsOf(windowTokens);
    let bigramHits = 0;
    for (const bigram of contextBigrams) {
      if (windowBigrams.has(bigram)) bigramHits += 1;
    }
    const bigramScore = contextBigrams.size
      ? bigramHits / contextBigrams.size
      : 0;

    candidate.contextScore = round(tokenScore * 0.65 + bigramScore * 0.35);
  }
}

function bigramsOf(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    bigrams.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
}

function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = new RegExp(TOKEN_PATTERN.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
    if (tokens.length >= 200_000) break;
  }
  return tokens;
}

function findAll(
  haystack: string,
  needle: string,
  limit: number
): { starts: number[]; truncated: boolean } {
  const starts: number[] = [];
  if (!needle) return { starts, truncated: false };
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return { starts, truncated: false };
    // One hit past the cap proves the reported occurrences are a lower bound.
    if (starts.length >= limit) return { starts, truncated: true };
    starts.push(index);
    from = index + Math.max(1, needle.length);
  }
}

function excerptAt(page: string, start: number, end: number): string {
  const compact = page
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= 300) return compact;
  return `${compact.slice(0, 297)}...`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

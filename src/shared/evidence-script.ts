/**
 * Fixed scripts executed inside the inspected page through the Marionette
 * content actor. Agents never supply JavaScript: only the quote, its offsets
 * and a duration are embedded, and every script is built here on the server.
 *
 * The index and highlight scripts must walk the DOM identically. They share
 * the helper below so a match offset maps back to the same text nodes.
 */

export interface EvidenceIndexSnapshot {
  title: string;
  url: string;
  readyState: string;
  contentType: string;
  text: string;
  truncated: boolean;
  textLength: number;
}

/** Lightweight readiness probe used while a freshly opened tab loads. */
export interface EvidenceStateSnapshot {
  title: string;
  url: string;
  readyState: string;
  contentType: string;
}

export interface EvidenceHighlightReport {
  ok: boolean;
  stale: boolean;
  highlighted: boolean;
  scrolled: boolean;
  /** True when the marked range has a rectangle inside the viewport. */
  inView: boolean;
  rects: number;
  scrollY: number;
  reason?: string;
}

export interface EvidenceClearReport {
  cleared: boolean;
  removed: number;
}

export interface EvidenceIndexOptions {
  /** Maximum characters returned to the bridge. */
  maxChars: number;
}

export interface EvidenceHighlightOptions {
  start: number;
  end: number;
  /** Raw page text the caller expects between start and end. */
  expectedText: string;
  ttlMs: number;
  scroll: boolean;
  /** Random attribute for this overlay host; never a fixed page-visible name. */
  marker: string;
  /** Markers from earlier highlights in this tab, removed before painting. */
  clearMarkers?: string[];
}

export interface EvidenceClearOptions {
  /** Markers tracked by the bridge for this tab. */
  markers?: string[];
}

const MARKER_PATTERN = /^data-zen-[a-f0-9]{16,64}$/;

/**
 * Per-call overlay attribute. A constant marker lets a page forge, style or
 * delete Zen MCP's marks, and lets `zen_clear_evidence` delete page nodes that
 * merely happen to carry the attribute.
 */
export function createEvidenceMarker(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    throw new Error(
      "A cryptographically secure random source is not available for evidence markers."
    );
  }
  return `data-zen-${uuid.replace(/-/g, "")}`;
}

export function isEvidenceMarker(value: unknown): value is string {
  return typeof value === "string" && MARKER_PATTERN.test(value);
}

function normalizeMarkers(markers: unknown): string[] {
  const list = Array.isArray(markers) ? markers : [];
  const kept: string[] = [];
  for (const marker of list) {
    if (!isEvidenceMarker(marker) || kept.includes(marker)) continue;
    kept.push(marker);
    if (kept.length >= 50) break;
  }
  return kept;
}

/** Shared by the index and highlight scripts; keep both call sites in sync. */
const DOM_HELPERS = String.raw`
const MAX_COLLECT = 2000000;
const MAX_WALKS = 300000;

const SKIP_TAGS = {
  SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1,
  IFRAME: 1, OBJECT: 1, EMBED: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1,
  INPUT: 1, HEAD: 1, META: 1, LINK: 1
};

const BLOCK_TAGS = {
  ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, CAPTION: 1,
  DD: 1, DETAILS: 1, DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1,
  FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1,
  H4: 1, H5: 1, H6: 1, HEADER: 1, HGROUP: 1, HR: 1, LI: 1, MAIN: 1,
  NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1,
  TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1, TR: 1, UL: 1
};

function styleOf(element) {
  try {
    var view = document.defaultView;
    if (view && view.getComputedStyle) return view.getComputedStyle(element);
  } catch (error) {
    // Detached or cross-origin elements can throw.
  }
  return null;
}

function transparentColor(value) {
  if (!value) return false;
  var color = String(value).replace(/\s+/g, "").toLowerCase();
  if (color === "transparent") return true;
  var match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (!match) return false;
  var parts = match[1].split(",");
  return parts.length === 4 && parseFloat(parts[3]) === 0;
}

function hiddenByStyle(style) {
  if (!style) return false;
  if (style.display === "none") return true;
  if (style.visibility === "hidden" || style.visibility === "collapse") {
    return true;
  }
  if (style.contentVisibility === "hidden") return true;
  if (style.opacity !== undefined && parseFloat(style.opacity) === 0) {
    return true;
  }
  if (style.fontSize && parseFloat(style.fontSize) === 0) return true;
  if (transparentColor(style.color)) return true;
  if (style.textIndent && parseFloat(style.textIndent) <= -1000) return true;
  if (
    style.transform &&
    /^matrix\(\s*0(\.0+)?\s*,\s*0(\.0+)?\s*,\s*0(\.0+)?\s*,\s*0(\.0+)?\s*,/.test(
      style.transform
    )
  ) {
    return true;
  }
  var clip = String(style.clip || "").replace(/\s+/g, "");
  if (/^rect\(0(px)?,0(px)?,0(px)?,0(px)?\)$/.test(clip)) return true;
  var clipPath = String(style.clipPath || "").replace(/\s+/g, "");
  if (clipPath.indexOf("inset(50%") === 0) return true;
  if (/^circle\(0(px|%)?\)$/.test(clipPath)) return true;
  return false;
}

function offscreenOrEmpty(element, style) {
  if (!style) return false;
  if (style.position !== "absolute" && style.position !== "fixed") return false;
  var rects = null;
  try {
    rects = element.getClientRects();
  } catch (error) {
    return false;
  }
  if (!rects || rects.length === 0) return true;
  for (var index = 0; index < rects.length; index += 1) {
    var rect = rects[index];
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right <= -8 || rect.bottom <= -8) continue;
    if (rect.left >= 1000000 || rect.top >= 1000000) continue;
    return false;
  }
  return true;
}

function isHiddenElement(element, style) {
  if (!element || !element.hasAttribute) return false;
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if (hiddenByStyle(style)) return true;
  if (
    style &&
    style.overflow === "hidden" &&
    style.display !== "inline" &&
    (element.clientWidth === 0 || element.clientHeight === 0)
  ) {
    return true;
  }
  return offscreenOrEmpty(element, style);
}

function collectEvidenceText(root) {
  var chunks = [];
  var nodes = [];
  var length = 0;
  var lastChar = "";
  var capped = false;
  var stopped = false;
  var walks = 0;

  function append(value) {
    if (!value) return;
    chunks.push(value);
    length += value.length;
    lastChar = value.charAt(value.length - 1);
  }

  function newline() {
    if (length === 0 || lastChar === "\n") return;
    if (length >= MAX_COLLECT) {
      capped = true;
      stopped = true;
      return;
    }
    append("\n");
  }

  function addText(node) {
    if (stopped) return;
    if (length >= MAX_COLLECT) {
      capped = true;
      stopped = true;
      return;
    }
    var value = node.nodeValue;
    if (!value) return;
    if (length + value.length > MAX_COLLECT) {
      value = value.slice(0, MAX_COLLECT - length);
      capped = true;
      stopped = true;
    }
    nodes.push({ node: node, start: length, end: length + value.length });
    append(value);
  }

  // Iterative walk: a script-built page with very deep nesting must not blow
  // the content process's stack.
  function visit(rootNode) {
    var stack = [{ node: rootNode, newline: false }];
    while (stack.length > 0 && !stopped) {
      var frame = stack.pop();
      if (frame.newline) {
        newline();
        continue;
      }
      var node = frame.node;
      if (!node) continue;
      walks += 1;
      if (walks > MAX_WALKS) {
        capped = true;
        stopped = true;
        break;
      }
      if (node.nodeType === 3) {
        addText(node);
        continue;
      }
      if (node.nodeType !== 1) continue;

      var tag = String(node.tagName || "").toUpperCase();
      if (SKIP_TAGS[tag]) continue;
      if (tag === "BR") {
        newline();
        continue;
      }
      var style = styleOf(node);
      if (isHiddenElement(node, style)) continue;

      var display = style ? String(style.display || "") : "";
      var block =
        BLOCK_TAGS[tag] === 1 ||
        /^(block|flex|grid|list-item|table|flow-root)$/.test(display);
      if (block) newline();
      if (block) stack.push({ newline: true });

      if (tag === "DETAILS" && !node.open) {
        var summary = null;
        for (
          var summaryChild = node.firstElementChild;
          summaryChild;
          summaryChild = summaryChild.nextElementSibling
        ) {
          if (String(summaryChild.tagName || "").toUpperCase() === "SUMMARY") {
            summary = summaryChild;
            break;
          }
        }
        if (summary) stack.push({ node: summary, newline: false });
        continue;
      }

      var children = [];
      for (var child = node.firstChild; child; child = child.nextSibling) {
        children.push(child);
      }
      for (var index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index], newline: false });
      }
    }
  }

  visit(root);
  return { text: chunks.join(""), nodes: nodes, truncated: capped };
}

function removeMarkedLayers(markers) {
  var removed = 0;
  for (var markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    var found = document.querySelectorAll("[" + markers[markerIndex] + "]");
    for (var index = found.length - 1; index >= 0; index -= 1) {
      var node = found[index];
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
        removed += 1;
      }
    }
  }
  return removed;
}
`;

/** Returns the readable page text plus a safe snapshot of the page. */
export function buildEvidenceIndexScript(
  options: EvidenceIndexOptions
): string {
  const requested = Number(options?.maxChars);
  const maxChars = Number.isFinite(requested)
    ? Math.max(1_000, Math.min(1_000_000, Math.trunc(requested)))
    : 500_000;

  return String.raw`
const maxChars = ${JSON.stringify(maxChars)};
${DOM_HELPERS}
const collected = collectEvidenceText(document.body || document.documentElement);
var text = collected.text;
var truncated = collected.truncated;
if (text.length > maxChars) {
  text = text.slice(0, maxChars);
  truncated = true;
}
return {
  title: String(document.title || "").slice(0, 1000),
  url: String(location.href || "").slice(0, 8000),
  readyState: String(document.readyState || "").slice(0, 40),
  contentType: String(document.contentType || "").slice(0, 200),
  text: text,
  truncated: truncated,
  textLength: text.length
};
`;
}

/**
 * A small, fixed probe for load state. Running the full index script while a
 * page is loading would be needlessly expensive and could race navigation.
 */
export function buildEvidenceStateScript(): string {
  return String.raw`
return {
  title: String(document.title || "").slice(0, 1000),
  url: String(location.href || "").slice(0, 8000),
  readyState: String(document.readyState || "").slice(0, 40),
  contentType: String(document.contentType || "").slice(0, 200)
};
`;
}

export function coerceEvidenceState(
  raw: unknown
): EvidenceStateSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return {
    title: asText(value.title, 1_000),
    url: asText(value.url, 8_000),
    readyState: asText(value.readyState, 40),
    contentType: asText(value.contentType, 200),
  };
}

/**
 * Re-walks the page, verifies the raw text at the offsets still matches, then
 * scrolls to it and paints non-destructive overlay rectangles inside a closed
 * shadow root. The page's own text and styles are never modified, and the
 * overlay cannot be queried or styled from page script.
 */
export function buildEvidenceHighlightScript(
  options: EvidenceHighlightOptions
): string {
  const requestedStart = Number(options?.start);
  const requestedEnd = Number(options?.end);
  const start = Number.isFinite(requestedStart)
    ? Math.max(0, Math.trunc(requestedStart))
    : 0;
  const end = Number.isFinite(requestedEnd)
    ? Math.max(start, Math.trunc(requestedEnd))
    : start;
  const expectedText =
    typeof options?.expectedText === "string" ? options.expectedText : "";
  const ttlMs = Number.isFinite(Number(options?.ttlMs))
    ? Math.max(1_000, Math.min(120_000, Math.trunc(Number(options.ttlMs))))
    : 20_000;
  const scroll = options?.scroll !== false;
  const marker = options?.marker;
  if (!isEvidenceMarker(marker)) {
    throw new Error("buildEvidenceHighlightScript requires a valid marker.");
  }
  const clearMarkers = normalizeMarkers(options?.clearMarkers);

  return String.raw`
const start = ${JSON.stringify(start)};
const end = ${JSON.stringify(end)};
const expectedText = ${JSON.stringify(expectedText)};
const ttlMs = ${JSON.stringify(ttlMs)};
const shouldScroll = ${JSON.stringify(scroll)};
const marker = ${JSON.stringify(marker)};
const clearMarkers = ${JSON.stringify(clearMarkers)};
${DOM_HELPERS}

function emptyReport(ok, stale, reason) {
  return {
    ok: ok,
    stale: stale,
    highlighted: false,
    scrolled: false,
    inView: false,
    rects: 0,
    scrollY: Number(window.scrollY) || 0,
    reason: reason
  };
}

const collected = collectEvidenceText(document.body || document.documentElement);
if (
  end > collected.text.length ||
  collected.text.slice(start, end) !== expectedText
) {
  return emptyReport(false, true, "stale");
}

var first = -1;
var last = -1;
for (var index = 0; index < collected.nodes.length; index += 1) {
  var entry = collected.nodes[index];
  if (entry.end <= start) continue;
  if (entry.start >= end) break;
  if (first < 0) first = index;
  last = index;
}
if (first < 0 || last < 0) {
  return emptyReport(false, false, "no_text");
}

var firstEntry = collected.nodes[first];
var lastEntry = collected.nodes[last];
var range = document.createRange();
range.setStart(firstEntry.node, Math.max(0, start - firstEntry.start));
range.setEnd(
  lastEntry.node,
  Math.min(lastEntry.end - lastEntry.start, end - lastEntry.start)
);

if (shouldScroll) {
  var container = range.startContainer;
  var element =
    container && container.nodeType === 3 ? container.parentElement : container;
  if (element && element.scrollIntoView) {
    try {
      element.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (error) {
      try {
        element.scrollIntoView();
      } catch (fallbackError) {
        // The mark can still be painted where the range sits.
      }
    }
  }
}

var rects = [];
try {
  rects = Array.prototype.slice.call(range.getClientRects());
} catch (error) {
  rects = [];
}

var viewportWidth = Number(window.innerWidth) || 0;
var viewportHeight = Number(window.innerHeight) || 0;
var inView = false;
for (var rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
  var rect = rects[rectIndex];
  if (rect.width <= 0 || rect.height <= 0) continue;
  if (
    rect.bottom > 0 &&
    rect.top < viewportHeight &&
    rect.right > 0 &&
    rect.left < viewportWidth
  ) {
    inView = true;
    break;
  }
}

removeMarkedLayers(clearMarkers.concat([marker]));

var scrollX = Number(window.scrollX) || 0;
var scrollY = Number(window.scrollY) || 0;
var layer = document.createElement("div");
layer.setAttribute(marker, "layer");
layer.setAttribute("aria-hidden", "true");
layer.style.cssText =
  "all:initial !important;position:absolute !important;" +
  "left:0 !important;top:0 !important;width:0 !important;" +
  "height:0 !important;margin:0 !important;padding:0 !important;" +
  "border:0 !important;pointer-events:none !important;" +
  "z-index:2147483647 !important;display:block !important;";

// A closed shadow root keeps marks out of page CSS and page script. The host
// itself remains in the DOM so the marks can be positioned and later removed.
var paintRoot = layer;
try {
  if (layer.attachShadow) {
    paintRoot = layer.attachShadow({ mode: "closed" });
  }
} catch (error) {
  paintRoot = layer;
}

var marks = 0;
for (var paintIndex = 0; paintIndex < rects.length; paintIndex += 1) {
  var paintRect = rects[paintIndex];
  if (paintRect.width <= 0 || paintRect.height <= 0) continue;
  if (marks >= 200) break;
  var box = document.createElement("div");
  box.style.cssText =
    "position:absolute !important;box-sizing:border-box !important;" +
    "pointer-events:none !important;margin:0 !important;padding:0 !important;" +
    "border:0 !important;border-radius:2px !important;" +
    "background-color:rgba(255,214,64,0.42) !important;" +
    "box-shadow:0 0 0 2px rgba(206,132,0,0.62) !important;" +
    "display:block !important;";
  box.style.left = paintRect.left + scrollX + "px";
  box.style.top = paintRect.top + scrollY + "px";
  box.style.width = paintRect.width + "px";
  box.style.height = paintRect.height + "px";
  paintRoot.appendChild(box);
  try {
    if (box.animate) {
      box.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        {
          delay: Math.max(0, ttlMs - 900),
          duration: Math.min(900, ttlMs),
          fill: "forwards"
        }
      );
    }
  } catch (error) {
    // Animation is best effort; the timeout below still removes the layer.
  }
  marks += 1;
}

if (marks === 0) {
  return emptyReport(false, false, "no_visible_rects");
}

(document.documentElement || document.body).appendChild(layer);
window.setTimeout(function () {
  if (layer.parentNode) layer.parentNode.removeChild(layer);
}, ttlMs);

return {
  ok: true,
  stale: false,
  highlighted: true,
  scrolled: shouldScroll ? inView : false,
  inView: inView,
  rects: marks,
  scrollY: scrollY,
  reason: ""
};
`;
}

/** Removes only the overlay hosts this bridge recorded for the tab. */
export function buildEvidenceClearScript(
  options?: EvidenceClearOptions
): string {
  const markers = normalizeMarkers(options?.markers);
  return String.raw`
const markers = ${JSON.stringify(markers)};
var removed = 0;
for (var markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
  var found = document.querySelectorAll("[" + markers[markerIndex] + "]");
  for (var index = found.length - 1; index >= 0; index -= 1) {
    var node = found[index];
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
      removed += 1;
    }
  }
}
return { cleared: removed > 0, removed: removed };
`;
}

export function coerceEvidenceIndex(
  raw: unknown
): EvidenceIndexSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== "string") return null;
  const textLength = Number(value.textLength);
  return {
    title: asText(value.title, 1_000),
    url: asText(value.url, 8_000),
    readyState: asText(value.readyState, 40),
    contentType: asText(value.contentType, 200),
    text: value.text.slice(0, 2_000_000),
    truncated: value.truncated === true,
    textLength: Number.isFinite(textLength)
      ? Math.max(0, Math.trunc(textLength))
      : value.text.length,
  };
}

export function coerceEvidenceHighlight(
  raw: unknown
): EvidenceHighlightReport {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      stale: false,
      highlighted: false,
      scrolled: false,
      inView: false,
      rects: 0,
      scrollY: 0,
      reason: "no_result",
    };
  }
  const value = raw as Record<string, unknown>;
  const rects = Number(value.rects);
  const scrollY = Number(value.scrollY);
  return {
    ok: value.ok === true,
    stale: value.stale === true,
    highlighted: value.highlighted === true,
    scrolled: value.scrolled === true,
    inView: value.inView === true,
    rects: Number.isFinite(rects) ? Math.max(0, Math.trunc(rects)) : 0,
    scrollY: Number.isFinite(scrollY) ? scrollY : 0,
    reason:
      typeof value.reason === "string" && value.reason
        ? value.reason.slice(0, 200)
        : undefined,
  };
}

export function coerceEvidenceClear(raw: unknown): EvidenceClearReport {
  if (!raw || typeof raw !== "object") {
    return { cleared: false, removed: 0 };
  }
  const value = raw as Record<string, unknown>;
  const removed = Number(value.removed);
  return {
    cleared: value.cleared === true,
    removed: Number.isFinite(removed) ? Math.max(0, Math.trunc(removed)) : 0,
  };
}

function asText(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, max);
}

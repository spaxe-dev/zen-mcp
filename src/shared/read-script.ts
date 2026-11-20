import type {
  PageClassification,
  PageElement,
  PageHeading,
  PageLink,
  PageMetadata,
  PageReadResult,
  PageTable,
  ReadFormat,
  SemanticPage,
  WaitElementState,
} from "./protocol.js";
import {
  PAGE_CLASSIFICATIONS,
  SEMANTIC_HEADING_CHARS,
  SEMANTIC_LABEL_CHARS,
  SEMANTIC_MAX_COLLECTIONS,
  SEMANTIC_MAX_CONTROLS,
  SEMANTIC_MAX_DEPTH,
  SEMANTIC_MAX_DIALOGS,
  SEMANTIC_MAX_HEADINGS_LIST,
  SEMANTIC_MAX_LIMITATIONS,
  SEMANTIC_MAX_NODES,
  SEMANTIC_MAX_REGIONS,
  SEMANTIC_MAX_SAMPLES,
  SEMANTIC_MAX_SHADOW_ROOTS,
  SEMANTIC_MAX_SIGNALS,
  SEMANTIC_REGION_ROLES,
  coerceSemanticPage,
  leanSemanticPage,
} from "./semantic.js";
import {
  SENSITIVE_AUTOCOMPLETE_SOURCE,
  SENSITIVE_HINT_SOURCE,
} from "./sensitive.js";
import {
  SNAPSHOT_HEADING_CHARS,
  SNAPSHOT_MAX_HEADINGS,
  SNAPSHOT_MAX_LIMITATIONS,
  SNAPSHOT_TEXT_CHARS,
  clampSnapshotElements,
} from "./snapshot.js";
import type { NormalizedTarget } from "./target.js";

export interface ReadScriptOptions {
  maxChars: number;
  /** Character offset into the text or markdown stream. */
  offset?: number;
  format?: ReadFormat;
  selector?: string;
  /** Snapshot control cap. Other formats use their own fixed cap. */
  maxElements?: number;
  /**
   * Prefix for interactive and snapshot refs, used when the script runs inside
   * a frame. Shape: "f0-", "f0.1-". The main document uses an empty prefix.
   */
  refPrefix?: string;
}

/** Internal element shape: the WebElement never crosses the MCP boundary. */
export interface ReadScriptElement extends PageElement {
  element?: unknown;
}

export interface PageSnapshot {
  title: string;
  url: string;
  selectedText: string;
  text: string;
  fullLength: number;
  /** Character offset the script applied to the primary stream. */
  offset: number;
  readyState: string;
  description: string | null;
  format: ReadFormat;
  selector: string | null;
  selectorMatched: boolean;
  contentType: string;
  markdown?: string;
  links?: PageLink[];
  tables?: PageTable[];
  metadata?: PageMetadata;
  outline?: PageHeading[];
  outlineTruncated?: boolean;
  elements?: ReadScriptElement[];
  elementsTruncated?: boolean;
  elementsTotal?: number;
  snapshotComplete?: boolean;
  framesComplete?: boolean;
  limitations?: string[];
  semantic?: SemanticPage;
  /** Region and collection anchors, stored as refs but never returned twice. */
  semanticAnchors?: ReadScriptElement[];
  /** documentElement WebElement, used to prove the document did not change. */
  root?: unknown;
}

const READ_FORMATS: ReadFormat[] = [
  "text",
  "markdown",
  "links",
  "tables",
  "metadata",
  "outline",
  "interactive",
  "snapshot",
  "semantic",
];

const MAX_TEXT = 200_000;
const MAX_SELECTED = 4_000;
const MAX_LINKS = 300;
const MAX_TABLES = 20;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 12;
const MAX_CELL = 300;
const MAX_HEADINGS = 200;
/** Total controls returned by one interactive read, across frames. */
export const MAX_PAGE_ELEMENTS = 200;

const REF_PREFIX_PATTERN = /^(?:f[0-9]+(?:\.[0-9]+){0,2}-)?$/;

function normalizeFormat(value: unknown): ReadFormat {
  return typeof value === "string" &&
    (READ_FORMATS as string[]).includes(value)
    ? (value as ReadFormat)
    : "text";
}

function asString(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, max);
}

function asNullableString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = asString(value, max);
  return text ? text : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return fallback;
}

function coerceLinks(value: unknown): PageLink[] {
  if (!Array.isArray(value)) return [];
  const links: PageLink[] = [];
  for (const entry of value.slice(0, MAX_LINKS)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<PageLink>;
    const url = asString(raw.url, 8_000);
    if (!url) continue;
    const text = asString(raw.text, MAX_CELL);
    links.push({ text: text || url, url });
  }
  return links;
}

function coerceTables(value: unknown): PageTable[] {
  if (!Array.isArray(value)) return [];
  const tables: PageTable[] = [];
  for (const entry of value.slice(0, MAX_TABLES)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<PageTable>;
    const headers = Array.isArray(raw.headers)
      ? raw.headers
          .slice(0, MAX_TABLE_COLUMNS)
          .map((cell) => asString(cell, MAX_CELL))
      : [];
    const rows = Array.isArray(raw.rows)
      ? raw.rows.slice(0, MAX_TABLE_ROWS).map((row) =>
          Array.isArray(row)
            ? row
                .slice(0, MAX_TABLE_COLUMNS)
                .map((cell) => asString(cell, MAX_CELL))
            : []
        )
      : [];
    tables.push({
      caption: asNullableString(raw.caption, 500),
      headers,
      rows,
    });
  }
  return tables;
}

function coerceHeadings(value: unknown): PageHeading[] {
  if (!Array.isArray(value)) return [];
  const headings: PageHeading[] = [];
  for (const entry of value.slice(0, MAX_HEADINGS)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<PageHeading>;
    const level = Number(raw.level);
    if (!Number.isFinite(level)) continue;
    const text = asString(raw.text, 500);
    if (!text) continue;
    headings.push({
      level: Math.min(6, Math.max(1, Math.floor(level))),
      text,
    });
  }
  return headings;
}

function coerceElements(value: unknown): ReadScriptElement[] {
  if (!Array.isArray(value)) return [];
  const elements: ReadScriptElement[] = [];
  for (const entry of value.slice(0, MAX_PAGE_ELEMENTS)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<ReadScriptElement>;
    const ref = asString(raw.ref, 24);
    const tag = asString(raw.tag, 40);
    if (!ref || !tag) continue;
    elements.push({
      ref,
      tag,
      role: asString(raw.role, 40) || "generic",
      type: asNullableString(raw.type, 40),
      label: asString(raw.label, 300),
      value: asNullableString(raw.value, 300),
      placeholder: asNullableString(raw.placeholder, 300),
      href: asNullableString(raw.href, 8_000),
      disabled: asBoolean(raw.disabled, false),
      checked: typeof raw.checked === "boolean" ? raw.checked : null,
      readOnly: asBoolean(raw.readOnly, false),
      sensitive: asBoolean(raw.sensitive, false),
      editable: asBoolean(raw.editable, false),
      ...(typeof raw.valuePresent === "boolean"
        ? { valuePresent: raw.valuePresent }
        : {}),
      ...(raw.autocomplete !== undefined
        ? { autocomplete: asNullableString(raw.autocomplete, 120) }
        : {}),
      ...(typeof raw.selected === "boolean" || raw.selected === null
        ? { selected: raw.selected }
        : {}),
      ...(raw.form !== undefined
        ? { form: asNullableString(raw.form, 120) }
        : {}),
      ...(raw.element !== undefined ? { element: raw.element } : {}),
      ...(Array.isArray(raw.framePath)
        ? {
            framePath: raw.framePath
              .slice(0, 3)
              .map((index: unknown) =>
                Math.max(0, Math.floor(Number(index) || 0))
              ),
          }
        : {}),
      ...(raw.frameUrl !== undefined
        ? {
            frameUrl:
              raw.frameUrl === null ? null : asString(raw.frameUrl, 8_000),
          }
        : {}),
    });
  }
  return elements;
}

function coerceRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (!value || typeof value !== "object") return record;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (count >= 40) break;
    const key = rawKey.toLowerCase();
    if (!key || key === "__proto__") continue;
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      continue;
    }
    const text = String(rawValue).slice(0, 500);
    if (!text) continue;
    record[key] = text;
    count += 1;
  }
  return record;
}

function coerceMetadata(value: unknown): PageMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<PageMetadata>;
  return {
    title: asString(raw.title, 1_000),
    description: asNullableString(raw.description, 2_000),
    canonical: asNullableString(raw.canonical, 8_000),
    lang: asNullableString(raw.lang, 40),
    author: asNullableString(raw.author, 500),
    published: asNullableString(raw.published, 100),
    siteName: asNullableString(raw.siteName, 500),
    image: asNullableString(raw.image, 8_000),
    og: coerceRecord(raw.og),
    twitter: coerceRecord(raw.twitter),
  };
}

/**
 * Fixed element helpers shared by the read, selector and freshness scripts.
 * One source keeps labels, roles and sensitivity identical across reads and
 * actions. None of these functions writes to the page.
 */
const ELEMENT_HELPERS = String.raw`
const SENSITIVE_HINT = new RegExp(${JSON.stringify(SENSITIVE_HINT_SOURCE)}, "i");
const SENSITIVE_AUTOCOMPLETE = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_SOURCE)}, "i");

function normalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function elementText(el) {
  var text = "";
  try {
    text = el.innerText || el.textContent || "";
  } catch (e) {}
  return normalizeText(text).replace(/\n+/g, " ").slice(0, 200);
}

function elementVisible(el) {
  try {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    var style = view ? view.getComputedStyle(el) : null;
    if (!style) return true;
    return !(
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    );
  } catch (e) {
    return false;
  }
}

function elementLabel(el, tag, type) {
  var label = "";
  try {
    label = String(el.getAttribute("aria-label") || "");
    if (!label) {
      var ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/);
      var root = el.getRootNode ? el.getRootNode() : document;
      for (var i = 0; i < ids.length && i < 4; i += 1) {
        if (!ids[i]) continue;
        var peer = null;
        try {
          peer = root.getElementById ? root.getElementById(ids[i]) : null;
        } catch (e) {}
        if (!peer) {
          try {
            peer = document.getElementById(ids[i]);
          } catch (e2) {}
        }
        if (peer) label += " " + String(peer.innerText || peer.textContent || "");
      }
    }
  } catch (e) {}
  label = normalizeText(label);
  if (!label) {
    try {
      if (el.labels && el.labels.length) {
        var parts = [];
        for (var l = 0; l < el.labels.length && l < 3; l += 1) {
          parts.push(String(el.labels[l].innerText || el.labels[l].textContent || ""));
        }
        label = normalizeText(parts.join(" "));
      }
    } catch (e) {}
  }
  if (!label) {
    if (tag === "input" && /^(submit|button|reset)$/.test(type || "")) {
      label = String(el.value || "");
    } else if (tag === "button" || tag === "a" || tag === "summary") {
      label = elementText(el);
    }
  }
  if (!label) {
    label =
      String(el.getAttribute("placeholder") || "") ||
      String(el.getAttribute("title") || "") ||
      String(el.getAttribute("alt") || "") ||
      String(el.getAttribute("name") || "");
  }
  return normalizeText(label).slice(0, 200);
}

function elementRole(el, tag, type) {
  var explicit = "";
  try {
    explicit = String(el.getAttribute("role") || "").trim().toLowerCase();
  } catch (e) {}
  if (explicit) return explicit;
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return el.multiple ? "listbox" : "combobox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (
      type === "submit" ||
      type === "button" ||
      type === "reset" ||
      type === "image"
    ) {
      return "button";
    }
    if (type === "search") return "searchbox";
    if (type === "number") return "spinbutton";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return "generic";
}

function elementHref(el) {
  try {
    var raw = el.getAttribute("href");
    if (!raw) return null;
    var url = new URL(raw, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch (e) {}
  return null;
}

function autocompleteValue(el) {
  try {
    var value = String(el.getAttribute("autocomplete") || "").trim().toLowerCase();
    return value ? value.slice(0, 120) : null;
  } catch (e) {}
  return null;
}

function formRef(el) {
  try {
    var form = el.form || (el.closest ? el.closest("form") : null);
    if (!form) return null;
    var id = String(form.getAttribute("id") || "").trim();
    if (id) return id.slice(0, 120);
    var name = String(form.getAttribute("name") || "").trim();
    if (name) return name.slice(0, 120);
  } catch (e) {}
  return null;
}

function selectedState(el, tag, type) {
  try {
    if (tag === "option") return !!el.selected;
    if (type === "checkbox" || type === "radio") return !!el.checked;
    var aria = el.getAttribute("aria-selected");
    if (aria === "true") return true;
    if (aria === "false") return false;
  } catch (e) {}
  return null;
}

function valueIsPresent(el, tag, type) {
  try {
    if (tag === "input" && type === "file") {
      return !!(el.files && el.files.length);
    }
    if (tag === "select" || tag === "textarea") {
      return String(el.value == null ? "" : el.value).length > 0;
    }
    if (tag === "input") {
      if (type === "checkbox" || type === "radio") return false;
      return String(el.value == null ? "" : el.value).length > 0;
    }
    if (el.isContentEditable) {
      return normalizeText(el.textContent || "").length > 0;
    }
  } catch (e) {}
  return false;
}

function isSensitiveField(el, tag, type, label, autocomplete) {
  if (type === "password" || type === "file" || type === "email" || type === "tel") {
    return true;
  }
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;
  try {
    var inputMode = String(el.getAttribute("inputmode") || "").toLowerCase();
    if (inputMode === "email" || inputMode === "tel") return true;
  } catch (e) {}
  var haystack = [
    String(el.getAttribute("name") || ""),
    String(el.getAttribute("id") || ""),
    String(el.getAttribute("placeholder") || ""),
    String(label || "")
  ].join(" ");
  return SENSITIVE_HINT.test(haystack);
}

function describeElementFields(el) {
  var tag = String(el.tagName || "").toLowerCase();
  var type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
  var label = elementLabel(el, tag, type);
  var autocomplete = autocompleteValue(el);
  var placeholder = null;
  try {
    placeholder = el.getAttribute("placeholder") || null;
  } catch (e) {}
  var editable = false;
  if (tag === "textarea") {
    editable = true;
  } else if (tag === "input") {
    editable = !/^(button|submit|reset|checkbox|radio|range|file|image|color|hidden)$/.test(
      type || ""
    );
  } else if (el.isContentEditable) {
    editable = true;
  }
  return {
    tag: tag,
    role: elementRole(el, tag, type),
    type: type,
    label: label,
    placeholder: placeholder,
    href: elementHref(el),
    disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    checked: type === "checkbox" || type === "radio" ? !!el.checked : null,
    readOnly: !!(el.readOnly || el.getAttribute("aria-readonly") === "true"),
    sensitive: isSensitiveField(el, tag, type, label, autocomplete),
    editable: editable,
    valuePresent: valueIsPresent(el, tag, type),
    autocomplete: autocomplete,
    selected: selectedState(el, tag, type),
    form: formRef(el)
  };
}
`;

/**
 * The script used for every page read. It is intentionally synchronous so it
 * can run both through Marionette's async wrapper and through the browser's
 * MarionetteCommands actor for background tabs.
 */
export function buildReadScript(options: ReadScriptOptions): string {
  const format = normalizeFormat(options?.format);
  const isSnapshot = format === "snapshot";
  const isSemantic = format === "semantic";
  // Compact views are value-free: they share snapshot privacy and text caps.
  const compactView = isSnapshot || isSemantic;
  const requested = Number(options?.maxChars);
  const maxChars = compactView
    ? SNAPSHOT_TEXT_CHARS
    : Number.isFinite(requested)
      ? Math.max(0, Math.floor(requested))
      : 24_000;
  const requestedOffset = Number(options?.offset);
  const offset = compactView
    ? 0
    : Number.isFinite(requestedOffset)
      ? Math.max(0, Math.floor(requestedOffset))
      : 0;
  const elementCap = compactView
    ? isSemantic
      ? Math.min(SEMANTIC_MAX_CONTROLS, clampSnapshotElements(options?.maxElements))
      : clampSnapshotElements(options?.maxElements)
    : MAX_PAGE_ELEMENTS;
  const outlineLimit = compactView ? SNAPSHOT_MAX_HEADINGS : MAX_HEADINGS;
  const outlineChars = compactView ? SNAPSHOT_HEADING_CHARS : 500;
  const selector =
    typeof options?.selector === "string" && options.selector.trim()
      ? options.selector.trim()
      : null;
  const refPrefix =
    typeof options?.refPrefix === "string" &&
    REF_PREFIX_PATTERN.test(options.refPrefix)
      ? options.refPrefix
      : "";

  return String.raw`
const maxChars = ${JSON.stringify(maxChars)};
const offset = ${JSON.stringify(offset)};
const format = ${JSON.stringify(format)};
const selector = ${JSON.stringify(selector)};
const refPrefix = ${JSON.stringify(refPrefix)};
const isSemantic = ${JSON.stringify(isSemantic)};
const privateView = ${JSON.stringify(compactView)};
const MAX_ELEMENTS = ${JSON.stringify(elementCap)};
const OUTLINE_LIMIT = ${JSON.stringify(outlineLimit)};
const OUTLINE_CHARS = ${JSON.stringify(outlineChars)};
const SEM_MAX_REGIONS = ${JSON.stringify(SEMANTIC_MAX_REGIONS)};
const SEM_MAX_COLLECTIONS = ${JSON.stringify(SEMANTIC_MAX_COLLECTIONS)};
const SEM_MAX_DIALOGS = ${JSON.stringify(SEMANTIC_MAX_DIALOGS)};
const SEM_MAX_HEADINGS_LIST = ${JSON.stringify(SEMANTIC_MAX_HEADINGS_LIST)};
const SEM_MAX_SAMPLES = ${JSON.stringify(SEMANTIC_MAX_SAMPLES)};
const SEM_MAX_SIGNALS = ${JSON.stringify(SEMANTIC_MAX_SIGNALS)};
const SEM_MAX_NODES = ${JSON.stringify(SEMANTIC_MAX_NODES)};
const SEM_MAX_SHADOW_ROOTS = ${JSON.stringify(SEMANTIC_MAX_SHADOW_ROOTS)};
const SEM_MAX_DEPTH = ${JSON.stringify(SEMANTIC_MAX_DEPTH)};
const SEM_LABEL_CHARS = ${JSON.stringify(SEMANTIC_LABEL_CHARS)};
const SEM_HEADING_CHARS = ${JSON.stringify(SEMANTIC_HEADING_CHARS)};
const SEM_MAX_LIMITATIONS = ${JSON.stringify(SEMANTIC_MAX_LIMITATIONS)};
const PAGE_CLASSIFICATIONS = ${JSON.stringify(PAGE_CLASSIFICATIONS)};
const FENCE = String.fromCharCode(96, 96, 96);
const SENTINEL = "\u0000";
${ELEMENT_HELPERS}

const SKIP_TAGS = {
  SCRIPT: 1,
  STYLE: 1,
  NOSCRIPT: 1,
  SVG: 1,
  NAV: 1,
  FOOTER: 1,
  ASIDE: 1,
  TEMPLATE: 1
};

const BLOCK_TAGS = {
  ADDRESS: 1,
  ARTICLE: 1,
  BLOCKQUOTE: 1,
  BODY: 1,
  DD: 1,
  DIV: 1,
  DL: 1,
  DT: 1,
  FIELDSET: 1,
  FIGCAPTION: 1,
  FIGURE: 1,
  FORM: 1,
  H1: 1,
  H2: 1,
  H3: 1,
  H4: 1,
  H5: 1,
  H6: 1,
  HEADER: 1,
  HR: 1,
  HTML: 1,
  LI: 1,
  MAIN: 1,
  OL: 1,
  P: 1,
  PRE: 1,
  SECTION: 1,
  TABLE: 1,
  UL: 1
};

function tidy(value) {
  return String(value == null ? "" : value)
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absoluteUrl(raw) {
  var value = String(raw == null ? "" : raw).trim();
  if (!value || value.charAt(0) === "#") return null;
  var lower = value.toLowerCase();
  if (
    lower.indexOf("javascript:") === 0 ||
    lower.indexOf("data:") === 0 ||
    lower.indexOf("vbscript:") === 0
  ) {
    return null;
  }
  try {
    var url = new URL(value, location.href);
    var protocol = url.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      return url.href;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function escapeInline(value) {
  var text = String(value == null ? "" : value);
  var out = "";
  var backtick = String.fromCharCode(96);
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (
      ch === "\\" ||
      ch === backtick ||
      ch === "*" ||
      ch === "_" ||
      ch === "[" ||
      ch === "]" ||
      ch === "|"
    ) {
      out += "\\" + ch;
    } else if (ch === "\n" || ch === "\r") {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

function finishInline(value) {
  return tidy(value).split(SENTINEL).join("  \n");
}

function inline(node) {
  var out = "";
  if (!node) return out;
  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i += 1) {
    var child = kids[i];
    if (child.nodeType === 3) {
      out += escapeInline(String(child.nodeValue || ""));
      continue;
    }
    if (child.nodeType !== 1) continue;
    var tag = String(child.tagName || "").toUpperCase();
    if (SKIP_TAGS[tag]) continue;
    if (tag === "BR") {
      out += SENTINEL;
      continue;
    }
    if (tag === "IMG") {
      var src = absoluteUrl(child.getAttribute("src"));
      if (src) {
        out += "![" + tidy(child.getAttribute("alt") || "") + "](" + src + ")";
      }
      continue;
    }
    var inner = inline(child);
    if (tag === "A") {
      var href = absoluteUrl(child.getAttribute("href"));
      var label = tidy(inner);
      if (href) {
        out += "[" + (label || href) + "](" + href + ")";
      } else {
        out += label;
      }
      continue;
    }
    if (tag === "STRONG" || tag === "B") {
      var bold = tidy(inner);
      if (bold) out += "**" + bold + "**";
      continue;
    }
    if (tag === "EM" || tag === "I") {
      var em = tidy(inner);
      if (em) out += "*" + em + "*";
      continue;
    }
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") {
      var strike = tidy(inner);
      if (strike) out += "~~" + strike + "~~";
      continue;
    }
    if (tag === "CODE") {
      var backtick = String.fromCharCode(96);
      var code = tidy(inner).split(backtick).join("'");
      if (code) out += backtick + code + backtick;
      continue;
    }
    if (tag === "PRE") {
      out += inner;
      continue;
    }
    if (BLOCK_TAGS[tag]) {
      out += " " + inner + " ";
      continue;
    }
    out += inner;
  }
  return out;
}

function pushParagraph(value, blocks) {
  var text = finishInline(value);
  if (text) blocks.push(text);
}

function cellsOf(row) {
  var cells = [];
  var children = row.children || [];
  for (var i = 0; i < children.length; i += 1) {
    var tag = String(children[i].tagName || "").toUpperCase();
    if (tag === "TD" || tag === "TH") cells.push(children[i]);
  }
  return cells;
}

function cellText(cell) {
  return normalizeText(String(cell.textContent || ""))
    .replace(/\n+/g, " ")
    .slice(0, 300);
}

function tableData(table) {
  if (!table) return null;
  var caption = null;
  try {
    var cap = table.querySelector ? table.querySelector("caption") : null;
    if (cap && (!cap.closest || cap.closest("table") === table)) {
      var capText = normalizeText(cap.textContent || "");
      if (capText) caption = capText.slice(0, 500);
    }
  } catch (e) {}

  var all = [];
  var rows = table.querySelectorAll ? table.querySelectorAll("tr") : [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var owner = row.closest ? row.closest("table") : table;
    if (owner && owner !== table) continue;
    all.push(row);
  }
  if (!all.length) return null;

  var headerRow = null;
  for (var h = 0; h < all.length; h += 1) {
    var parent = all[h].parentNode;
    if (parent && String(parent.tagName || "").toUpperCase() === "THEAD") {
      headerRow = all[h];
      break;
    }
  }
  if (!headerRow) {
    var firstCells = cellsOf(all[0]);
    var allTh = firstCells.length > 0;
    for (var f = 0; f < firstCells.length; f += 1) {
      if (String(firstCells[f].tagName || "").toUpperCase() !== "TH") {
        allTh = false;
      }
    }
    if (allTh) headerRow = all[0];
  }

  var headers = [];
  if (headerRow) {
    var headerCells = cellsOf(headerRow);
    for (var hc = 0; hc < headerCells.length && headers.length < 12; hc += 1) {
      headers.push(cellText(headerCells[hc]));
    }
  }

  var body = [];
  for (var r = 0; r < all.length && body.length < 100; r += 1) {
    if (all[r] === headerRow) continue;
    var cells = cellsOf(all[r]);
    if (!cells.length) continue;
    var values = [];
    for (var c = 0; c < cells.length && values.length < 12; c += 1) {
      values.push(cellText(cells[c]));
    }
    body.push(values);
  }
  if (!headers.length && !body.length) return null;

  var width = headers.length;
  if (!width) {
    for (var w = 0; w < body.length; w += 1) {
      if (body[w].length > width) width = body[w].length;
    }
  }
  if (width > 12) width = 12;
  while (headers.length < width) headers.push("");
  headers = headers.slice(0, width);

  var normalized = [];
  for (var b = 0; b < body.length; b += 1) {
    var line = body[b].slice(0, width);
    while (line.length < width) line.push("");
    normalized.push(line);
  }
  return { caption: caption, headers: headers, rows: normalized };
}

function tableMarkdown(data) {
  var lines = [];
  var header = [];
  for (var i = 0; i < data.headers.length; i += 1) {
    header.push(cellPipe(data.headers[i]));
  }
  lines.push("| " + header.join(" | ") + " |");
  var sep = [];
  for (var s = 0; s < header.length; s += 1) sep.push("---");
  lines.push("| " + sep.join(" | ") + " |");
  for (var r = 0; r < data.rows.length; r += 1) {
    var cells = [];
    for (var c = 0; c < data.rows[r].length; c += 1) {
      cells.push(cellPipe(data.rows[r][c]));
    }
    lines.push("| " + cells.join(" | ") + " |");
  }
  return lines.join("\n");
}

function cellPipe(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function renderList(list, ordered, depth, blocks) {
  var items = [];
  var children = list.children || [];
  for (var i = 0; i < children.length; i += 1) {
    if (String(children[i].tagName || "").toUpperCase() === "LI") {
      items.push(children[i]);
    }
  }
  var start = 1;
  if (ordered) {
    var raw = Number(list.getAttribute("start"));
    if (isFinite(raw) && raw > 0) start = Math.floor(raw);
  }
  var indent = new Array(depth + 1).join("  ");
  var lines = [];
  for (var n = 0; n < items.length; n += 1) {
    var li = items[n];
    var parts = [];
    var nested = [];
    var nodes = li.childNodes || [];
    for (var c = 0; c < nodes.length; c += 1) {
      var node = nodes[c];
      if (node.nodeType === 3) {
        parts.push(escapeInline(String(node.nodeValue || "")));
        continue;
      }
      if (node.nodeType !== 1) continue;
      var tag = String(node.tagName || "").toUpperCase();
      if (tag === "UL" || tag === "OL") {
        nested.push(node);
        continue;
      }
      if (SKIP_TAGS[tag]) continue;
      if (BLOCK_TAGS[tag] && tag !== "P") {
        var tmp = [];
        renderBlocks(node, tmp);
        for (var t = 0; t < tmp.length; t += 1) parts.push(tmp[t]);
        continue;
      }
      parts.push(inline(node));
    }
    var label = finishInline(parts.join(" ")).replace(/\n+/g, " ");
    var marker = ordered ? start + n + ". " : "- ";
    lines.push((indent + marker + label).trimEnd());
    for (var d = 0; d < nested.length; d += 1) {
      var nestedBlocks = [];
      renderList(
        nested[d],
        String(nested[d].tagName || "").toUpperCase() === "OL",
        depth + 1,
        nestedBlocks
      );
      for (var nb = 0; nb < nestedBlocks.length; nb += 1) {
        lines.push(nestedBlocks[nb]);
      }
    }
  }
  if (lines.length) blocks.push(lines.join("\n"));
}

function renderBlock(el, blocks) {
  var tag = String(el.tagName || "").toUpperCase();
  if (SKIP_TAGS[tag]) return;

  var heading = /^H([1-6])$/.exec(tag);
  if (heading) {
    var level = Number(heading[1]);
    var title = finishInline(inline(el)).replace(/\n+/g, " ");
    if (title) {
      blocks.push(new Array(level + 1).join("#") + " " + title);
    }
    return;
  }
  if (tag === "P") {
    pushParagraph(inline(el), blocks);
    return;
  }
  if (tag === "PRE") {
    var code = String(el.textContent || "")
      .replace(/\r\n?/g, "\n")
      .trimEnd();
    if (!code) return;
    var lang = "";
    var match = /(?:^|\s)language-([\w-]+)/.exec(
      String(el.getAttribute("class") || "")
    );
    if (match) lang = match[1];
    blocks.push(FENCE + lang + "\n" + code + "\n" + FENCE);
    return;
  }
  if (tag === "UL" || tag === "OL") {
    renderList(el, tag === "OL", 0, blocks);
    return;
  }
  if (tag === "BLOCKQUOTE") {
    var inner = [];
    renderBlocks(el, inner);
    var quoted = [];
    for (var q = 0; q < inner.length; q += 1) {
      var lines = String(inner[q]).split("\n");
      var prefixed = [];
      for (var l = 0; l < lines.length; l += 1) {
        prefixed.push(lines[l] ? "> " + lines[l] : ">");
      }
      quoted.push(prefixed.join("\n"));
    }
    if (quoted.length) blocks.push(quoted.join("\n>\n"));
    return;
  }
  if (tag === "TABLE") {
    var data = tableData(el);
    if (data) blocks.push(tableMarkdown(data));
    return;
  }
  if (tag === "HR") {
    blocks.push("---");
    return;
  }
  if (tag === "IMG") {
    var src = absoluteUrl(el.getAttribute("src"));
    if (src) {
      blocks.push("![" + tidy(el.getAttribute("alt") || "") + "](" + src + ")");
    }
    return;
  }
  if (BLOCK_TAGS[tag]) {
    renderBlocks(el, blocks);
    return;
  }
  pushParagraph(inline(el), blocks);
}

function renderBlocks(node, blocks) {
  if (!node) return blocks;
  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i += 1) {
    var child = kids[i];
    if (child.nodeType === 3) {
      var raw = tidy(escapeInline(String(child.nodeValue || "")));
      if (raw) blocks.push(raw);
      continue;
    }
    if (child.nodeType !== 1) continue;
    renderBlock(child, blocks);
  }
  return blocks;
}

function buildMarkdown(root) {
  if (!root) return "";
  var tag = String(root.tagName || "").toUpperCase();
  if (
    tag === "SCRIPT" ||
    tag === "STYLE" ||
    tag === "NOSCRIPT" ||
    tag === "SVG" ||
    tag === "TEMPLATE"
  ) {
    return "";
  }
  var blocks = [];
  if (SKIP_TAGS[tag]) {
    renderBlocks(root, blocks);
  } else {
    renderBlock(root, blocks);
  }
  return blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildLinks(root) {
  var result = [];
  if (!root || !root.querySelectorAll) return result;
  var anchors = root.querySelectorAll("a[href]");
  var seen = {};
  for (var i = 0; i < anchors.length && result.length < 300; i += 1) {
    var anchor = anchors[i];
    if (String(anchor.tagName || "").toUpperCase() !== "A") continue;
    var href = absoluteUrl(anchor.getAttribute("href"));
    if (!href || !/^https?:/i.test(href)) continue;
    if (seen[href]) continue;
    seen[href] = true;
    var text = normalizeText(anchor.textContent || "").replace(/\n+/g, " ");
    if (!text) text = href;
    result.push({ text: text.slice(0, 300), url: href });
  }
  return result;
}

function buildTables(root) {
  var result = [];
  if (!root || !root.querySelectorAll) return result;
  var tables = root.querySelectorAll("table");
  for (var i = 0; i < tables.length && result.length < 20; i += 1) {
    var table = tables[i];
    var nested = false;
    var parent = table.parentNode;
    while (parent && parent !== root) {
      if (String(parent.tagName || "").toUpperCase() === "TABLE") {
        nested = true;
        break;
      }
      parent = parent.parentNode;
    }
    if (nested) continue;
    var data = tableData(table);
    if (data) result.push(data);
  }
  return result;
}

function buildOutline(root) {
  var result = [];
  var total = 0;
  if (!root || !root.querySelectorAll) return { headings: result, total: total };
  var nodes = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (var i = 0; i < nodes.length; i += 1) {
    var level = Number(String(nodes[i].tagName || "").charAt(1));
    if (!isFinite(level) || level < 1 || level > 6) continue;
    var text = normalizeText(nodes[i].textContent || "").replace(/\n+/g, " ");
    if (!text) continue;
    total += 1;
    if (result.length >= OUTLINE_LIMIT) continue;
    result.push({ level: level, text: text.slice(0, OUTLINE_CHARS) });
  }
  return { headings: result, total: total };
}

function firstMeta(query) {
  try {
    var node = document.querySelector(query);
    if (!node) return "";
    return normalizeText(node.getAttribute("content") || "");
  } catch (e) {
    return "";
  }
}

function firstLinkUrl(query) {
  try {
    var node = document.querySelector(query);
    if (!node) return "";
    var url = absoluteUrl(node.getAttribute("href"));
    return url && /^https?:/i.test(url) ? url : "";
  } catch (e) {
    return "";
  }
}

function metaRecord(attribute, prefix) {
  var record = {};
  var count = 0;
  try {
    var nodes = document.querySelectorAll(
      "meta[" + attribute + '^="' + prefix + '"]'
    );
    for (var i = 0; i < nodes.length && count < 40; i += 1) {
      var key = normalizeText(nodes[i].getAttribute(attribute) || "").toLowerCase();
      if (!key) continue;
      var value = normalizeText(nodes[i].getAttribute("content") || "").slice(0, 500);
      if (!value) continue;
      if (Object.prototype.hasOwnProperty.call(record, key)) continue;
      record[key] = value;
      count += 1;
    }
  } catch (e) {}
  return record;
}

function buildMetadata() {
  var description =
    firstMeta('meta[name="description"]') ||
    firstMeta('meta[property="og:description"]');
  var author =
    firstMeta('meta[name="author"]') ||
    firstMeta('meta[property="article:author"]');
  var published =
    firstMeta('meta[property="article:published_time"]') ||
    firstMeta('meta[itemprop="datePublished"]') ||
    firstMeta('meta[name="date"]') ||
    firstMeta('meta[property="og:article:published_time"]');
  var siteName = firstMeta('meta[property="og:site_name"]');
  var imageUrl = absoluteUrl(firstMeta('meta[property="og:image"]'));
  if (imageUrl && !/^https?:/i.test(imageUrl)) imageUrl = null;
  var canonical =
    firstLinkUrl('link[rel="canonical"]') ||
    firstLinkUrl('link[rel~="canonical"]');
  var lang = "";
  try {
    var langNode = document.documentElement;
    if (langNode) {
      lang = normalizeText(
        langNode.lang ||
          (langNode.getAttribute ? langNode.getAttribute("lang") : "") ||
          ""
      );
    }
  } catch (e) {}

  return {
    title: String(document.title || "").slice(0, 1000),
    description: description || null,
    canonical: canonical || null,
    lang: lang || null,
    author: author || null,
    published: published || null,
    siteName: siteName || null,
    image: imageUrl || null,
    og: metaRecord("property", "og:"),
    twitter: metaRecord("name", "twitter:")
  };
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

function isElementVisible(el) {
  try {
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return true;
    var style = view.getComputedStyle(el);
    if (
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse")
    ) {
      return false;
    }
    var rect = el.getBoundingClientRect();
    if (rect && rect.width <= 0 && rect.height <= 0) return false;
  } catch (e) {}
  return true;
}

function describeElement(el, ref) {
  var fields = describeElementFields(el);
  var value = null;
  if (!privateView && !fields.sensitive) {
    try {
      if (fields.tag === "select") {
        var option = el.options && el.options[el.selectedIndex];
        if (option) value = String(option.text || option.value || "").slice(0, 200);
      } else if (fields.tag === "input" && fields.type !== "file") {
        value = String(el.value || "").slice(0, 200);
      }
    } catch (e) {}
  }

  var out = {
    ref: ref,
    tag: fields.tag,
    role: fields.role,
    type: fields.type,
    label: fields.label,
    value: value,
    placeholder: fields.placeholder,
    href: fields.href,
    disabled: fields.disabled,
    checked: fields.checked,
    readOnly: fields.readOnly,
    sensitive: fields.sensitive,
    editable: fields.editable,
    element: el
  };
  if (privateView) {
    out.valuePresent = fields.valuePresent;
    out.autocomplete = fields.autocomplete;
    out.selected = fields.selected;
    out.form = fields.form;
  }
  return out;
}

var INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='combobox']",
  "[role='textbox']",
  "[role='searchbox']"
].join(",");

function findCandidates(root, out) {
  if (!root || !root.querySelectorAll) return;
  var found = [];
  try {
    found = root.querySelectorAll(INTERACTIVE_SELECTOR);
  } catch (e) {}
  for (var i = 0; i < found.length; i += 1) {
    out.push(found[i]);
  }
  var all = [];
  try {
    all = root.querySelectorAll("*");
  } catch (e) {}
  for (var n = 0; n < all.length; n += 1) {
    if (all[n].shadowRoot) findCandidates(all[n].shadowRoot, out);
  }
}

function collectElements(root) {
  var candidates = [];
  findCandidates(root || document.body, candidates);
  var elements = [];
  var eligible = 0;
  var capped = false;
  for (var i = 0; i < candidates.length; i += 1) {
    var el = candidates[i];
    if (!el || !el.isConnected) continue;
    if (!isElementVisible(el)) continue;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" && String(el.type || "").toLowerCase() === "hidden") {
      continue;
    }
    eligible += 1;
    if (elements.length >= MAX_ELEMENTS) {
      capped = true;
      continue;
    }
    try {
      elements.push(describeElement(el, refPrefix + "e" + (elements.length + 1)));
    } catch (e) {}
  }
  return { elements: elements, truncated: capped, total: eligible };
}

function semanticText(el, max) {
  var text = "";
  try {
    text = el.innerText || el.textContent || "";
  } catch (e) {}
  return normalizeText(text).replace(/\n+/g, " ").slice(0, max);
}

function composedParent(node) {
  var parent = null;
  try {
    parent = node.parentElement;
  } catch (e) {}
  if (parent) return parent;
  try {
    var rootNode = node.getRootNode ? node.getRootNode() : null;
    if (rootNode && rootNode.host) return rootNode.host;
  } catch (e2) {}
  return null;
}

function composedContains(ancestor, node) {
  var current = node;
  while (current) {
    if (current === ancestor) return true;
    current = composedParent(current);
  }
  return false;
}

function ariaHidden(el) {
  var node = el;
  while (node) {
    try {
      if (
        node.nodeType === 1 &&
        node.getAttribute &&
        node.getAttribute("aria-hidden") === "true"
      ) {
        return true;
      }
    } catch (e) {}
    node = composedParent(node);
  }
  return false;
}

function landmarkNode(node) {
  var tag = String(node.tagName || "").toLowerCase();
  if (
    tag === "article" ||
    tag === "aside" ||
    tag === "main" ||
    tag === "nav" ||
    tag === "section" ||
    tag === "dialog" ||
    tag === "form" ||
    tag === "table"
  ) {
    return true;
  }
  var role = "";
  try {
    role = String(node.getAttribute("role") || "").trim().toLowerCase();
  } catch (e) {}
  return (
    role === "article" ||
    role === "complementary" ||
    role === "main" ||
    role === "navigation" ||
    role === "region" ||
    role === "form" ||
    role === "dialog" ||
    role === "table" ||
    role === "search"
  );
}

function semanticHeading(el) {
  var headings = [];
  try {
    headings = el.querySelectorAll("h1, h2, h3, h4, h5, h6");
  } catch (e) {
    return "";
  }
  for (var i = 0; i < headings.length; i += 1) {
    var heading = headings[i];
    if (!isElementVisible(heading) || ariaHidden(heading)) continue;
    // A nested landmark owns its own heading; only a heading this region
    // actually introduces can label it.
    var nested = false;
    var node = null;
    try {
      node = heading.parentElement;
    } catch (e2) {}
    while (node && node !== el) {
      if (landmarkNode(node)) {
        nested = true;
        break;
      }
      node = node.parentElement;
    }
    if (nested) continue;
    return semanticText(heading, SEM_HEADING_CHARS);
  }
  return "";
}

function semanticAriaLabel(el) {
  var label = "";
  try {
    label = String(el.getAttribute("aria-label") || "");
    if (!label) {
      var ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/);
      var root = el.getRootNode ? el.getRootNode() : document;
      for (var i = 0; i < ids.length && i < 4; i += 1) {
        if (!ids[i]) continue;
        var peer = null;
        try {
          peer = root.getElementById ? root.getElementById(ids[i]) : null;
        } catch (e) {}
        if (!peer) {
          try {
            peer = document.getElementById(ids[i]);
          } catch (e2) {}
        }
        if (peer) label += " " + String(peer.innerText || peer.textContent || "");
      }
    }
  } catch (e) {}
  return normalizeText(label).slice(0, SEM_LABEL_CHARS);
}

function hasSectioningAncestor(el) {
  var node = null;
  try {
    node = el.parentElement;
  } catch (e) {}
  while (node) {
    var tag = String(node.tagName || "").toLowerCase();
    if (
      tag === "article" ||
      tag === "aside" ||
      tag === "main" ||
      tag === "nav" ||
      tag === "section"
    ) {
      return true;
    }
    var role = "";
    try {
      role = String(node.getAttribute("role") || "").trim().toLowerCase();
    } catch (e2) {}
    if (
      role === "article" ||
      role === "complementary" ||
      role === "main" ||
      role === "navigation" ||
      role === "region"
    ) {
      return true;
    }
    try {
      node = node.parentElement;
    } catch (e3) {
      node = null;
    }
  }
  return false;
}

function hasHtmlName(el, tag) {
  try {
    if (tag === "form") return !!el.querySelector("legend");
    if (tag === "table") return !!el.querySelector("caption");
  } catch (e) {}
  return false;
}

function semanticRole(el, tag, explicit) {
  if (
    explicit === "banner" ||
    explicit === "navigation" ||
    explicit === "main" ||
    explicit === "complementary" ||
    explicit === "contentinfo" ||
    explicit === "search" ||
    explicit === "form" ||
    explicit === "article" ||
    explicit === "dialog" ||
    explicit === "table" ||
    explicit === "list"
  ) {
    return explicit;
  }
  if (
    explicit === "tablist" ||
    explicit === "menu" ||
    explicit === "menubar" ||
    explicit === "listbox" ||
    explicit === "grid" ||
    explicit === "tree"
  ) {
    return "list";
  }
  if (explicit === "region") return "section";
  if (tag === "header") {
    return hasSectioningAncestor(el) ? null : "banner";
  }
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "aside") return "complementary";
  if (tag === "footer") {
    return hasSectioningAncestor(el) ? null : "contentinfo";
  }
  if (tag === "search") return "search";
  // HTML-AAM exposes form and table landmarks only when they carry a name.
  if (tag === "form") {
    return semanticAriaLabel(el) || hasHtmlName(el, "form") ? "form" : null;
  }
  if (tag === "article") return "article";
  if (tag === "dialog") return "dialog";
  if (tag === "table") {
    return semanticAriaLabel(el) || hasHtmlName(el, "table") ? "table" : null;
  }
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "section") return "section";
  return null;
}

function semanticLabel(el, tag, role, heading) {
  var aria = semanticAriaLabel(el);
  if (aria) return { label: aria, source: "aria" };
  var html = "";
  try {
    if (tag === "form") {
      var legend = el.querySelector("legend");
      if (legend) html = semanticText(legend, SEM_LABEL_CHARS);
    } else if (tag === "table") {
      var caption = el.querySelector("caption");
      if (caption) html = semanticText(caption, SEM_LABEL_CHARS);
    }
  } catch (e) {}
  if (html) return { label: html, source: "html" };
  if (heading) return { label: heading, source: "heading" };
  var inferred =
    role === "banner"
      ? "Header"
      : role === "navigation"
        ? "Navigation"
        : role === "main"
          ? "Main"
          : role === "complementary"
            ? "Sidebar"
            : role === "contentinfo"
              ? "Footer"
              : role === "search"
                ? "Search"
                : role === "form"
                  ? "Form"
                  : role === "table"
                    ? "Table"
                    : role === "list"
                      ? "List"
                      : role === "dialog"
                        ? "Dialog"
                        : "Section";
  return { label: inferred, source: "inferred" };
}

function looksLikePrice(el) {
  // No leading \b: a currency sign after a space is not at a word boundary.
  return /(?:[$€£¥]\s?\d|\d[\d,.]*\s?(?:usd|eur|gbp|jpy)\b)/i.test(
    semanticText(el, 500)
  );
}

function directSemanticItems(el) {
  var children = [];
  try {
    for (var i = 0; i < el.children.length; i += 1) {
      var child = el.children[i];
      if (!isElementVisible(child) || ariaHidden(child)) continue;
      var tag = String(child.tagName || "").toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") continue;
      children.push(child);
    }
  } catch (e) {
    return null;
  }
  if (children.length < 3) return null;
  // Group by tag and take the largest group, so one leading ad or wrapper does
  // not hide the repeated structure behind it.
  var groups = {};
  var order = [];
  for (var c = 0; c < children.length; c += 1) {
    var key = String(children[c].tagName || "");
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(children[c]);
  }
  var same = [];
  for (var g = 0; g < order.length; g += 1) {
    if (groups[order[g]].length > same.length) same = groups[order[g]];
  }
  if (same.length < 3) return null;
  var rich = 0;
  var withLink = 0;
  var withMedia = 0;
  var price = false;
  for (var r = 0; r < same.length && r < 40; r += 1) {
    var item = same[r];
    var link = safeCall(function () { return item.querySelector("a, button"); }, null);
    var media = safeCall(function () {
      return item.querySelector("h1, h2, h3, h4, h5, h6, img");
    }, null);
    if (link || media) rich += 1;
    if (link) withLink += 1;
    if (media) withMedia += 1;
    if (looksLikePrice(item)) price = true;
  }
  if (rich < 3) return null;
  var kind = "items";
  if (price || withMedia > 0) kind = "cards";
  else if (withLink === same.length) kind = "links";
  return { items: same.slice(0, 40), count: same.length, kind: kind };
}

function tableRowItems(table) {
  var rows = [];
  try {
    rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"), 0, 40);
  } catch (e) {
    return null;
  }
  if (rows.length < 3) return null;
  var count = 0;
  try {
    count = table.querySelectorAll("tbody tr").length;
  } catch (e2) {
    count = rows.length;
  }
  return { items: rows, count: count, kind: "results" };
}

function buildSemantic(root, startRefIndex, elementsTotal, elementsTruncated) {
  var regions = [];
  var headings = [];
  var collections = [];
  var dialogs = [];
  var anchors = [];
  var stack = [];
  var nodes = 0;
  var shadowRoots = 0;
  var nodesTruncated = false;
  var shadowTruncated = false;
  var regionsTruncated = false;
  var headingsTruncated = false;
  var collectionsTruncated = false;
  var refIndex = startRefIndex;
  var counts = {
    controls: 0,
    links: 0,
    headings: 0,
    tables: 0,
    forms: 0,
    articles: 0,
    passwords: 0,
    searchControls: 0,
    codeBlocks: 0,
    images: 0,
    missingAlt: 0,
    cards: 0,
    prices: false,
    addToCart: false
  };
  var collectionOwners = {};

  function nextRef() {
    refIndex += 1;
    return refPrefix + "e" + refIndex;
  }

  function anchorFor(el) {
    var fields = describeElementFields(el);
    var anchor = {
      ref: nextRef(),
      tag: fields.tag,
      role: fields.role,
      type: fields.type,
      label: fields.label,
      href: fields.href,
      placeholder: fields.placeholder,
      element: el
    };
    anchors.push(anchor);
    return anchor;
  }

  function nearestRegion() {
    while (stack.length > 0) {
      var top = stack[stack.length - 1];
      // Node.contains stops at a shadow boundary; the composed ancestor chain
      // keeps a region open across an open shadow root.
      if (top && top.el && composedContains(top.el, current)) return top;
      stack.pop();
    }
    return null;
  }

  var current = null;

  function countItems(items) {
    if (items.kind === "cards") counts.cards += 1;
    if (items.kind === "links") return;
    for (var p = 0; p < items.items.length && p < 20; p += 1) {
      if (looksLikePrice(items.items[p])) {
        counts.prices = true;
        break;
      }
    }
  }

  function addCollection(ownerId, items) {
    countItems(items);
    if (collections.length >= SEM_MAX_COLLECTIONS) {
      collectionsTruncated = true;
      return;
    }
    var sample = [];
    for (var i = 0; i < items.items.length && sample.length < SEM_MAX_SAMPLES; i += 1) {
      var item = items.items[i];
      var anchor = anchorFor(item);
      var tag = String(item.tagName || "").toLowerCase();
      var type = tag === "input" ? String(item.type || "text").toLowerCase() : null;
      sample.push({
        ref: anchor.ref,
        label: elementLabel(item, tag, type).slice(0, SEM_LABEL_CHARS)
      });
    }
    collections.push({
      regionId: ownerId,
      kind: items.kind,
      count: items.count,
      sample: sample
    });
  }

  function addRegion(el, role, items) {
    if (regions.length >= SEM_MAX_REGIONS) {
      regionsTruncated = true;
      return null;
    }
    var tag = String(el.tagName || "").toLowerCase();
    var heading = semanticHeading(el);
    var label = semanticLabel(el, tag, role, heading);
    var parent = nearestRegion();
    var id = "r" + (regions.length + 1);
    var anchor = anchorFor(el);
    var region = {
      id: id,
      role: role,
      label: label.label.slice(0, SEM_LABEL_CHARS) || null,
      labelSource: label.source,
      heading: heading || null,
      parent: parent ? parent.id : null,
      ref: anchor.ref,
      controls: safeCall(function () {
        return el.querySelectorAll(INTERACTIVE_SELECTOR).length;
      }, 0),
      links: safeCall(function () {
        return el.querySelectorAll("a[href]").length;
      }, 0),
      items: items ? items.count : null,
      itemKind: items ? items.kind : null
    };
    regions.push(region);
    stack.push({ el: el, id: id });
    if (items) addCollection(id, items);
    if (role === "dialog") {
      if (dialogs.length < SEM_MAX_DIALOGS) {
        var modal = false;
        // showModal() sets the :modal state but no aria-modal attribute.
        try {
          modal = el.matches(":modal") === true;
        } catch (e) {}
        if (!modal) {
          try {
            modal = el.getAttribute("aria-modal") === "true";
          } catch (e2) {}
        }
        dialogs.push({
          ref: anchor.ref,
          label: label.label.slice(0, SEM_LABEL_CHARS) || "Dialog",
          modal: modal
        });
      }
    }
    return region;
  }

  function consider(el) {
    current = el;
    var tag = String(el.tagName || "").toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "template" ||
      tag === "svg" ||
      tag === "noscript"
    ) {
      return;
    }
    if (!isElementVisible(el) || ariaHidden(el)) return;

    nodes += 1;
    if (nodes > SEM_MAX_NODES) {
      nodesTruncated = true;
      return;
    }

    try {
      if (el.matches && el.matches(INTERACTIVE_SELECTOR)) counts.controls += 1;
    } catch (e) {}
    if (tag === "a" && el.hasAttribute("href")) counts.links += 1;
    if (/^h[1-6]$/.test(tag)) {
      counts.headings += 1;
      if (headings.length < SEM_MAX_HEADINGS_LIST) {
        var headingText = semanticText(el, SEM_HEADING_CHARS);
        if (headingText) {
          var headingAnchor = anchorFor(el);
          headings.push({
            level: Number(tag.slice(1)),
            text: headingText,
            ref: headingAnchor.ref
          });
        }
      } else {
        headingsTruncated = true;
      }
    }
    if (tag === "table") counts.tables += 1;
    if (tag === "form") counts.forms += 1;
    if (tag === "article") counts.articles += 1;
    if (tag === "pre" || tag === "code") counts.codeBlocks += 1;
    if (tag === "img") {
      counts.images += 1;
      if (!el.hasAttribute("alt")) counts.missingAlt += 1;
    }
    if (tag === "input" && String(el.type || "").toLowerCase() === "password") {
      counts.passwords += 1;
    }
    if (
      (tag === "input" && String(el.type || "").toLowerCase() === "search") ||
      el.getAttribute("role") === "searchbox"
    ) {
      counts.searchControls += 1;
    }
    if (tag === "button" || tag === "a") {
      var actionLabel = elementLabel(el, tag, null);
      if (/add to (?:cart|bag|basket)|buy now/i.test(actionLabel)) {
        counts.addToCart = true;
      }
    }

    var explicit = "";
    try {
      explicit = String(el.getAttribute("role") || "").trim().toLowerCase();
    } catch (e) {}
    var role = semanticRole(el, tag, explicit);
    var items = null;
    if (tag === "ul" || tag === "ol") {
      items = directSemanticItems(el);
      if (!items && !explicit) role = null;
    } else if (tag === "table") {
      items = tableRowItems(el);
    } else if (tag === "div" || tag === "section" || tag === "main" || tag === "article") {
      items = directSemanticItems(el);
    }
    if (role === "section" && !items) {
      var name =
        semanticAriaLabel(el) ||
        semanticHeading(el);
      if (!name) role = null;
    }
    var region = null;
    if (role) region = addRegion(el, role, items);
    if (items && !region) {
      var owner = nearestRegion();
      if (!owner && items.count >= 4) {
        region = addRegion(el, "section", items);
        if (region) region.label = "Collection";
      } else if (owner) {
        // One collection per region keeps regionId unique; later lists still
        // feed classification without overwriting the first count.
        if (collectionOwners[owner.id]) {
          countItems(items);
        } else {
          collectionOwners[owner.id] = true;
          addCollection(owner.id, items);
          owner.items = items.count;
          owner.itemKind = items.kind;
        }
      }
    }
  }

  function walk(rootNode, depth) {
    if (!rootNode || !rootNode.querySelectorAll) return;
    var all = [];
    try {
      all = rootNode.querySelectorAll("*");
    } catch (e) {
      return;
    }
    for (var i = 0; i < all.length; i += 1) {
      if (nodes > SEM_MAX_NODES) {
        nodesTruncated = true;
        return;
      }
      var el = all[i];
      consider(el);
      if (
        depth < SEM_MAX_DEPTH &&
        el.shadowRoot &&
        shadowRoots < SEM_MAX_SHADOW_ROOTS
      ) {
        shadowRoots += 1;
        walk(el.shadowRoot, depth + 1);
      } else if (el.shadowRoot) {
        shadowTruncated = true;
      }
    }
  }

  if (root) {
    consider(root);
    walk(root, 0);
  }

  var scores = {};
  var evidence = [];
  function add(category, points, signal) {
    scores[category] = (scores[category] || 0) + points;
    if (evidence.indexOf(signal) < 0) evidence.push(signal);
  }
  // Region ids under main, used to keep results scoring out of nav lists and
  // other peripheral repeated structures.
  var underMain = {};
  for (var rm = 0; rm < regions.length; rm += 1) {
    var regionEntry = regions[rm];
    if (regionEntry.role === "main") underMain[regionEntry.id] = true;
    else if (regionEntry.parent && underMain[regionEntry.parent]) {
      underMain[regionEntry.id] = true;
    }
  }
  var resultsCollection = false;
  for (var rc = 0; rc < collections.length; rc += 1) {
    if (collections[rc].kind === "cards" && underMain[collections[rc].regionId]) {
      resultsCollection = true;
      break;
    }
  }
  if (counts.passwords > 0) add("login", 5, "password field");
  if (counts.searchControls > 0) add("search-results", 2, "search control");
  if (counts.forms > 0) add("form", 2, "form landmark");
  if (counts.articles >= 3) add("discussion", 2, "repeated articles");
  if (counts.articles > 0 && counts.headings >= 3) add("article", 2, "article structure");
  if (counts.codeBlocks >= 3) add("documentation", 3, "code blocks");
  if (counts.tables >= 2 && regions.length >= 4) add("dashboard", 2, "tables with landmarks");
  if (counts.cards > 0) add("listing", 2, "repeated cards");
  if (counts.cards > 0 && counts.prices) add("product", 3, "price cards");
  if (counts.addToCart) add("product", 4, "add-to-cart control");
  if (counts.searchControls > 0 && resultsCollection) {
    add("search-results", 3, "results collection");
  }
  var ordered = [
    "login",
    "search-results",
    "product",
    "documentation",
    "discussion",
    "dashboard",
    "article",
    "form",
    "listing"
  ];
  var best = "generic";
  var bestScore = 0;
  var second = 0;
  for (var c = 0; c < ordered.length; c += 1) {
    var score = scores[ordered[c]] || 0;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = ordered[c];
    } else if (score > second) {
      second = score;
    }
  }
  if (bestScore < 2) best = "generic";
  var margin = Math.max(0, bestScore - second);
  var confidence =
    best === "generic"
      ? 0.35
      : Math.min(0.95, 0.5 + 0.08 * bestScore + 0.04 * margin);
  // A near-tie is a hint, not a result; keep the disclosure modest.
  if (best !== "generic" && margin < 2) confidence = Math.min(confidence, 0.6);
  var primary = null;
  var primaryRoles = ["main", "article", "search", "dialog", "form"];
  for (var p = 0; p < primaryRoles.length && !primary; p += 1) {
    for (var q = 0; q < regions.length; q += 1) {
      if (regions[q].role === primaryRoles[p]) {
        primary = regions[q].id;
        break;
      }
    }
  }
  if (!primary && regions.length > 0) primary = regions[0].id;

  var limitations = [];
  if (nodesTruncated) {
    limitations.push("The semantic scan hit its node cap; later landmarks were not inspected.");
  }
  if (shadowTruncated) {
    limitations.push("The semantic scan hit its open shadow-root cap.");
  }
  if (regionsTruncated) {
    limitations.push("The landmark list hit its cap.");
  }
  if (headingsTruncated) {
    limitations.push("The heading list hit its cap.");
  }
  if (collectionsTruncated) {
    limitations.push("The repeated-structure list hit its cap.");
  }

  return {
    model: {
      classification: PAGE_CLASSIFICATIONS.indexOf(best) >= 0 ? best : "generic",
      confidence: Math.round(confidence * 100) / 100,
      signals: evidence.slice(0, SEM_MAX_SIGNALS),
      primaryRegion: primary,
      regions: regions,
      headings: headings,
      collections: collections,
      dialogs: dialogs,
      coverage: {
        complete:
          !nodesTruncated &&
          !shadowTruncated &&
          !regionsTruncated &&
          !headingsTruncated &&
          !collectionsTruncated &&
          !elementsTruncated,
        nodes: nodes,
        regions: regions.length,
        regionsTruncated: regionsTruncated,
        controls: elementsTotal || counts.controls,
        links: counts.links,
        headings: counts.headings,
        tables: counts.tables,
        images: counts.images,
        missingAlt: counts.missingAlt,
        shadowRoots: shadowRoots
      },
      limitations: limitations.slice(0, SEM_MAX_LIMITATIONS)
    },
    anchors: anchors
  };
}

var selectorMatched = true;
var root = null;
try {
  if (selector) {
    root = document.querySelector(selector);
    if (!root) selectorMatched = false;
  } else if (
    format === "interactive" ||
    format === "snapshot" ||
    format === "semantic"
  ) {
    root = document.body;
  } else {
    root = document.querySelector("article, main, [role='main']");
  }
} catch (e) {
  root = null;
  selectorMatched = false;
}
if (!root) {
  if (selector) {
    selectorMatched = false;
  } else {
    root = document.body;
  }
}

var text = "";
if (root) {
  text = safeCall(function () {
    return normalizeText(String(root.innerText || root.textContent || ""));
  }, "");
}
var primaryLength = text.length;
var primarySource = text;

var markdown = "";
if (format === "markdown") {
  var rawMarkdown = safeCall(function () {
    return buildMarkdown(root);
  }, null);
  if (rawMarkdown !== null) {
    primarySource = String(rawMarkdown);
    primaryLength = primarySource.length;
  }
}

// Paging applies to the text and markdown streams only. Structured formats
// keep returning their complete lists so a character offset never silently
// drops items.
var appliedOffset = 0;
if (format === "text" || format === "markdown") {
  appliedOffset = Math.min(offset, primaryLength);
}
var visibleText = text.slice(appliedOffset, appliedOffset + maxChars);
if (format === "markdown") {
  markdown = primarySource.slice(appliedOffset, appliedOffset + maxChars);
}
if (format === "interactive") {
  visibleText = "";
}

var selectedText = "";
if (!privateView) {
  try {
    if (typeof window !== "undefined" && window.getSelection) {
      selectedText = String(window.getSelection().toString() || "").slice(0, 4000);
    }
  } catch (e) {}
}

var description = safeCall(function () {
  return (
    firstMeta('meta[name="description"]') ||
    firstMeta('meta[property="og:description"]')
  );
}, "");

var out = {
  title: String(document.title || ""),
  url: String(location.href || ""),
  selectedText: selectedText,
  text: visibleText,
  fullLength: format === "interactive" ? 0 : primaryLength,
  offset: format === "interactive" ? 0 : appliedOffset,
  readyState: String(document.readyState || ""),
  description: description || null,
  format: format,
  selector: selector,
  selectorMatched: selectorMatched,
  contentType: String(document.contentType || "")
};

if (format === "markdown") {
  out.markdown = markdown;
} else if (format === "links") {
  var links = safeCall(function () {
    return buildLinks(root);
  }, []);
  if (links) out.links = links;
} else if (format === "tables") {
  var tables = safeCall(function () {
    return buildTables(root);
  }, []);
  if (tables) out.tables = tables;
} else if (format === "metadata") {
  var metadata = safeCall(function () {
    return buildMetadata();
  }, null);
  if (metadata) {
    out.metadata = metadata;
    out.description = metadata.description;
  }
} else if (format === "outline") {
  var outline = safeCall(function () {
    return buildOutline(root);
  }, { headings: [], total: 0 });
  if (outline) out.outline = outline.headings;
} else if (
  format === "interactive" ||
  format === "snapshot" ||
  format === "semantic"
) {
  var collected = safeCall(function () {
    return collectElements(root);
  }, null);
  if (collected) {
    out.elements = collected.elements;
    out.elementsTruncated = collected.truncated;
    out.elementsTotal = collected.total;
  }
  if (format === "snapshot" || format === "semantic") {
    var snapshotOutline = safeCall(function () {
      return buildOutline(root);
    }, { headings: [], total: 0 });
    if (snapshotOutline) {
      out.outline = snapshotOutline.headings;
      out.outlineTruncated =
        snapshotOutline.total > snapshotOutline.headings.length;
    }
  }
  if (format === "semantic") {
    var semantic = safeCall(function () {
      return buildSemantic(
        root,
        collected ? collected.elements.length : 0,
        collected ? collected.total : 0,
        collected ? collected.truncated === true : false
      );
    }, null);
    if (semantic) {
      out.semantic = semantic.model;
      out.semanticAnchors = semantic.anchors;
    }
  }
  try {
    out.root = document.documentElement || null;
  } catch (e) {
    out.root = null;
  }
}

return out;
`;
}

export interface SemanticTargetProbe {
  found: boolean;
  ambiguous: boolean;
  count: number;
  /** The search stopped at its node or match cap. */
  truncated: boolean;
  invalidSelector?: boolean;
  root?: unknown;
  element?: unknown;
  tag?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string | null;
  type?: string | null;
  href?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  sensitive?: boolean;
  visible?: boolean;
  valuePresent?: boolean;
  checked?: boolean | null;
  selected?: boolean | null;
  candidates?: Array<{
    tag: string;
    role: string;
    name: string;
    type: string | null;
    sensitive: boolean;
    visible: boolean;
    disabled: boolean;
  }>;
}

const TARGET_MAX_NODES = 6_000;
const TARGET_MAX_SHADOW_ROOTS = 100;
const TARGET_MAX_DEPTH = 6;
const TARGET_MAX_MATCHES = 6;

/**
 * Resolves one semantic target in the document and its open shadow roots.
 * The script never selects arbitrarily: a second match stops the scan and is
 * reported with bounded candidates.
 */
export function buildSemanticTargetScript(
  target: NormalizedTarget,
  maxCandidates = 5
): string {
  const options = {
    kind: target.kind,
    role: target.kind === "role" ? target.role : null,
    name: target.kind === "role" ? target.name : null,
    match:
      target.kind === "role" || target.kind === "text"
        ? target.match
        : "exact",
    text: target.kind === "text" ? target.text : null,
    label: target.kind === "label" ? target.label : null,
    placeholder: target.kind === "placeholder" ? target.placeholder : null,
    selector: target.kind === "selector" ? target.selector : null,
    maxCandidates: Math.min(5, Math.max(1, maxCandidates)),
  };

  return String.raw`
const options = ${JSON.stringify(options)};
const MAX_NODES = ${TARGET_MAX_NODES};
const MAX_SHADOW_ROOTS = ${TARGET_MAX_SHADOW_ROOTS};
const MAX_DEPTH = ${TARGET_MAX_DEPTH};
const MAX_MATCHES = ${TARGET_MAX_MATCHES};
${ELEMENT_HELPERS}

function fullText(el) {
  var text = "";
  try {
    text = el.innerText || el.textContent || "";
  } catch (e) {}
  return normalizeText(text).replace(/\n+/g, " ").slice(0, 2_000);
}

function associatedLabel(el) {
  var parts = [];
  try {
    var aria = String(el.getAttribute("aria-label") || "");
    if (aria) parts.push(aria);
    var ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/);
    var root = el.getRootNode ? el.getRootNode() : document;
    for (var i = 0; i < ids.length && i < 4; i += 1) {
      if (!ids[i]) continue;
      var peer = null;
      try {
        peer = root.getElementById ? root.getElementById(ids[i]) : null;
      } catch (e) {}
      if (!peer) {
        try {
          peer = document.getElementById(ids[i]);
        } catch (e2) {}
      }
      if (peer) parts.push(String(peer.innerText || peer.textContent || ""));
    }
    if (!parts.length && el.labels && el.labels.length) {
      for (var l = 0; l < el.labels.length && l < 3; l += 1) {
        parts.push(String(el.labels[l].innerText || el.labels[l].textContent || ""));
      }
    }
  } catch (e) {}
  return normalizeText(parts.join(" ")).slice(0, 200);
}

function compareText(candidate, wanted, mode) {
  var haystack = normalizeText(candidate).toLowerCase();
  var needle = normalizeText(wanted).toLowerCase();
  if (!needle) return false;
  return mode === "contains" ? haystack.indexOf(needle) >= 0 : haystack === needle;
}

function targetDescriptor(el) {
  var fields = describeElementFields(el);
  return {
    tag: fields.tag,
    role: fields.role,
    name: fields.label.slice(0, 120),
    label: fields.label,
    placeholder: fields.placeholder,
    type: fields.type,
    href: fields.href,
    disabled: fields.disabled,
    readOnly: fields.readOnly,
    editable: fields.editable,
    sensitive: fields.sensitive,
    visible: elementVisible(el),
    valuePresent: fields.valuePresent,
    checked: fields.checked,
    selected: fields.selected
  };
}

function interactiveElement(el, tag, role) {
  if (tag === "input" && String(el.type || "").toLowerCase() === "hidden") return false;
  if (tag === "a" && el.hasAttribute("href")) return true;
  if (tag === "button" || tag === "summary" || tag === "select" || tag === "textarea" || tag === "input" || tag === "option") {
    return true;
  }
  if (el.isContentEditable) return true;
  return /^(button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|spinbutton|treeitem)$/.test(role);
}

function matchesTarget(el, tag, type, role) {
  if (options.kind === "role") {
    return role === options.role &&
      compareText(elementLabel(el, tag, type), options.name, options.match);
  }
  if (options.kind === "text") {
    return interactiveElement(el, tag, role) &&
      compareText(fullText(el), options.text, options.match);
  }
  if (options.kind === "label") {
    return compareText(associatedLabel(el), options.label, "exact");
  }
  if (options.kind === "placeholder") {
    var placeholder = "";
    try {
      placeholder = String(el.getAttribute("placeholder") || "");
    } catch (e) {}
    return compareText(placeholder, options.placeholder, "exact");
  }
  return false;
}

if (options.kind === "selector") {
  var selected = [];
  try {
    var list = document.querySelectorAll(options.selector);
    for (var s = 0; s < list.length && s < MAX_MATCHES; s += 1) {
      selected.push(list[s]);
    }
  } catch (e) {
    return { found: false, ambiguous: false, count: 0, truncated: false, invalidSelector: true };
  }
  var root = null;
  try { root = document.documentElement || null; } catch (e3) {}
  if (selected.length === 1) {
    var one = targetDescriptor(selected[0]);
    one.element = selected[0];
    one.root = root;
    one.found = true;
    one.ambiguous = false;
    one.count = 1;
    one.truncated = false;
    return one;
  }
  return {
    found: selected.length > 0,
    ambiguous: selected.length > 1,
    count: selected.length,
    truncated: false,
    root: root,
    candidates: selected.slice(0, options.maxCandidates).map(function (el) {
      var d = targetDescriptor(el);
      return {
        tag: d.tag,
        role: d.role,
        name: d.name,
        type: d.type,
        sensitive: d.sensitive,
        visible: d.visible,
        disabled: d.disabled
      };
    })
  };
}

var matches = [];
var nodes = 0;
var shadowRoots = 0;
var truncated = false;
var stopped = false;

function scan(root, depth) {
  if (stopped || truncated) return;
  var all;
  try {
    all = root.querySelectorAll("*");
  } catch (e) {
    return;
  }
  for (var i = 0; i < all.length; i += 1) {
    if (stopped || truncated) return;
    nodes += 1;
    if (nodes > MAX_NODES) {
      truncated = true;
      return;
    }
    var el = all[i];
    var elTag = String(el.tagName || "").toLowerCase();
    var elType = elTag === "input" ? String(el.type || "text").toLowerCase() : null;
    var elRole = elementRole(el, elTag, elType);
    if (matchesTarget(el, elTag, elType, elRole)) {
      matches.push(el);
      if (matches.length >= MAX_MATCHES) {
        stopped = true;
        return;
      }
    }
    if (depth < MAX_DEPTH && el.shadowRoot && shadowRoots < MAX_SHADOW_ROOTS) {
      shadowRoots += 1;
      scan(el.shadowRoot, depth + 1);
    }
  }
}

var probeRoot = null;
try { probeRoot = document.documentElement || null; } catch (e4) {}
if (!probeRoot) {
  return { found: false, ambiguous: false, count: 0, truncated: false, root: null };
}
scan(document, 0);

if (matches.length === 1 && !truncated) {
  var descriptor = targetDescriptor(matches[0]);
  descriptor.element = matches[0];
  descriptor.root = probeRoot;
  descriptor.found = true;
  descriptor.ambiguous = false;
  descriptor.count = 1;
  descriptor.truncated = false;
  return descriptor;
}

return {
  found: matches.length > 0,
  ambiguous: matches.length > 1,
  count: matches.length,
  truncated: truncated,
  root: probeRoot,
  candidates: matches.slice(0, options.maxCandidates).map(function (el) {
    var d = targetDescriptor(el);
    return {
      tag: d.tag,
      role: d.role,
      name: d.name,
      type: d.type,
      sensitive: d.sensitive,
      visible: d.visible,
      disabled: d.disabled
    };
  })
};
`;
}

/**
 * Freshness probe for a stored WebElement. Marionette rejects a detached or
 * replaced node while deserializing the argument, before this script runs. If
 * it does run, the descriptor and documentElement let the bridge prove it is
 * still the same node in the same document.
 */
export function buildInspectElementScript(): string {  return String.raw`
${ELEMENT_HELPERS}

var element = arguments.length ? arguments[0] : null;
var root = null;
try {
  root = document.documentElement || null;
} catch (e) {}
if (!element) {
  return { found: false, root: root };
}

var fields = describeElementFields(element);
return {
  found: true,
  root: root,
  element: element,
  tag: fields.tag,
  role: fields.role,
  type: fields.type,
  label: fields.label,
  href: fields.href,
  disabled: fields.disabled,
  readOnly: fields.readOnly,
  sensitive: fields.sensitive,
  editable: fields.editable,
  visible: elementVisible(element)
};
`;
}

export interface WaitProbeOptions {
  selector?: string;
  state?: WaitElementState;
  text?: string;
  urlContains?: string;
  titleContains?: string;
}

export interface WaitProbe {
  url: string;
  title: string;
  readyState: string;
  /** True when the requested condition currently holds. */
  matched: boolean;
}

/**
 * A fixed probe for zen_wait_for. It never returns page text, only whether the
 * requested condition holds and the document's URL and title.
 */
export function buildWaitProbeScript(
  options: WaitProbeOptions = {}
): string {
  const selector =
    typeof options.selector === "string" && options.selector.trim()
      ? options.selector.trim()
      : null;
  const text =
    typeof options.text === "string" && options.text.trim()
      ? options.text.trim()
      : null;
  const urlContains =
    typeof options.urlContains === "string" && options.urlContains.trim()
      ? options.urlContains.trim()
      : null;
  const titleContains =
    typeof options.titleContains === "string" && options.titleContains.trim()
      ? options.titleContains.trim()
      : null;
  const state =
    options.state === "visible" || options.state === "enabled"
      ? options.state
      : "present";

  return String.raw`
const selector = ${JSON.stringify(selector)};
const state = ${JSON.stringify(state)};
const text = ${JSON.stringify(text)};
const urlContains = ${JSON.stringify(urlContains)};
const titleContains = ${JSON.stringify(titleContains)};
${ELEMENT_HELPERS}

var url = "";
try {
  url = String(location.href || "");
} catch (e) {}
var title = "";
try {
  title = String(document.title || "");
} catch (e) {}
var readyState = "";
try {
  readyState = String(document.readyState || "");
} catch (e) {}

var matched = false;
if (selector) {
  try {
    var element = document.querySelector(selector);
    if (!element) {
      matched = false;
    } else if (state === "visible") {
      matched = elementVisible(element);
    } else if (state === "enabled") {
      matched =
        !element.disabled && element.getAttribute("aria-disabled") !== "true";
    } else {
      matched = true;
    }
  } catch (e) {
    matched = false;
  }
} else if (text) {
  var needle = text.toLowerCase();
  try {
    var body = document.body;
    var haystack = body
      ? String(body.innerText || body.textContent || "")
      : "";
    matched = haystack.toLowerCase().indexOf(needle) >= 0;
  } catch (e) {
    matched = false;
  }
} else if (urlContains) {
  matched = url.toLowerCase().indexOf(urlContains.toLowerCase()) >= 0;
} else if (titleContains) {
  matched = title.toLowerCase().indexOf(titleContains.toLowerCase()) >= 0;
}

return {
  url: url,
  title: title,
  readyState: readyState,
  matched: matched
};
`;
}

export function coerceWaitProbe(value: unknown): WaitProbe | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WaitProbe>;
  if (typeof raw.url !== "string") return null;
  return {
    url: raw.url.slice(0, 8_000),
    title: asString(raw.title, 1_000),
    readyState: asString(raw.readyState, 40),
    matched: raw.matched === true,
  };
}

export function coerceSemanticTarget(value: unknown): SemanticTargetProbe | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.invalidSelector === true) {
    return {
      found: false,
      ambiguous: false,
      count: 0,
      truncated: false,
      invalidSelector: true,
    };
  }
  const bool = (input: unknown): boolean => input === true;
  const count =
    typeof raw.count === "number" && Number.isFinite(raw.count)
      ? Math.max(0, Math.min(6, Math.floor(raw.count)))
      : 0;
  const probe: SemanticTargetProbe = {
    found: bool(raw.found),
    ambiguous: bool(raw.ambiguous),
    count,
    truncated: bool(raw.truncated),
  };
  if (raw.root) probe.root = raw.root;
  if (raw.element) probe.element = raw.element;
  if (typeof raw.tag === "string") probe.tag = raw.tag.slice(0, 40);
  if (typeof raw.role === "string") probe.role = raw.role.slice(0, 80);
  if (typeof raw.name === "string") probe.name = raw.name.slice(0, 200);
  if (typeof raw.label === "string") probe.label = raw.label.slice(0, 200);
  probe.placeholder = typeof raw.placeholder === "string"
    ? raw.placeholder.slice(0, 200)
    : null;
  probe.type = typeof raw.type === "string" ? raw.type.slice(0, 40) : null;
  probe.href = typeof raw.href === "string" ? raw.href.slice(0, 8_000) : null;
  probe.disabled = bool(raw.disabled);
  probe.readOnly = bool(raw.readOnly);
  probe.editable = bool(raw.editable);
  probe.sensitive = bool(raw.sensitive);
  probe.visible = bool(raw.visible);
  probe.valuePresent = bool(raw.valuePresent);
  probe.checked = typeof raw.checked === "boolean" ? raw.checked : null;
  probe.selected = typeof raw.selected === "boolean" ? raw.selected : null;
  if (Array.isArray(raw.candidates)) {
    probe.candidates = raw.candidates
      .slice(0, 5)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          tag: asString(item.tag, 40),
          role: asString(item.role, 80),
          name: asString(item.name, 120),
          type: typeof item.type === "string" ? item.type.slice(0, 40) : null,
          sensitive: item.sensitive === true,
          visible: item.visible === true,
          disabled: item.disabled === true,
        };
      });
  }
  return probe;
}

export interface TypedValueProbe {
  compared: boolean;
  matchesInput: boolean | null;
  sensitive: boolean;
}

/**
 * Compares a typed field with the supplied text without returning the value.
 * Sensitive fields are never read back, even for comparison.
 */
export function buildVerifyTypedValueScript(): string {
  return String.raw`
${ELEMENT_HELPERS}

var element = arguments.length ? arguments[0] : null;
var expected = arguments.length > 1 ? String(arguments[1] == null ? "" : arguments[1]) : "";
var mode = arguments.length > 2 ? String(arguments[2]) : "suffix";
if (!element) {
  return { compared: false, matchesInput: null, sensitive: false };
}

var tag = String(element.tagName || "").toLowerCase();
var type = tag === "input" ? String(element.type || "text").toLowerCase() : null;
var fields = describeElementFields(element);
if (fields.sensitive || type === "password" || type === "file") {
  return { compared: false, matchesInput: null, sensitive: true };
}

var current = null;
if (tag === "input" || tag === "textarea" || tag === "select") {
  current = String(element.value == null ? "" : element.value);
} else if (element.isContentEditable) {
  current = String(element.innerText || element.textContent || "");
}
if (current === null) {
  return { compared: false, matchesInput: null, sensitive: false };
}

var matches = mode === "exact"
  ? current === expected
  : current.slice(Math.max(0, current.length - expected.length)) === expected;
return { compared: true, matchesInput: matches, sensitive: false };
`;
}

export function coerceTypedValueProbe(value: unknown): TypedValueProbe {
  if (!value || typeof value !== "object") {
    return { compared: false, matchesInput: null, sensitive: false };
  }
  const raw = value as Partial<TypedValueProbe>;
  return {
    compared: raw.compared === true,
    matchesInput:
      typeof raw.matchesInput === "boolean" ? raw.matchesInput : null,
    sensitive: raw.sensitive === true,
  };
}

export interface PageControlSignature {
  key: string;
  role: string;
  name: string;
  type: string | null;
  state: {
    visible: boolean;
    disabled: boolean;
    readOnly: boolean;
    checked: boolean | null;
    selected: boolean | null;
    valuePresent: boolean;
  };
}

export interface PageHeadingSignature {
  key: string;
  text: string;
}

export interface PageAlertSignature {
  key: string;
  text: string;
}

export interface PageSignature {
  url: string;
  title: string;
  readyState: string;
  textLength: number;
  textHash: number;
  elementCount: number;
  valueHash: number;
  root?: unknown;
  controls?: PageControlSignature[];
  headings?: PageHeadingSignature[];
  alerts?: PageAlertSignature[];
}

export interface PageSignatureDiff {
  changed: boolean;
  urlChanged: boolean;
  titleChanged: boolean;
  domChanged: boolean;
  valueChanged: boolean;
}

/**
 * Fixed signature used to verify that a click or type changed anything. It
 * hashes rendered text and form values instead of returning them, and keeps
 * bounded structural descriptors for the action delta.
 */
export function buildPageSignatureScript(): string {
  return String.raw`
const MAX_TEXT = 100000;
const MAX_CONTROLS = 120;
const MAX_HEADINGS = 80;
const MAX_ALERTS = 20;
${ELEMENT_HELPERS}

function hashString(value) {
  var hash = 2166136261;
  var text = String(value == null ? "" : value);
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function controlKey(el, tag, type, fields) {
  var text = "";
  try {
    text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  } catch (e) {}
  return hashString([
    tag,
    type || "",
    String(el.id || ""),
    String(el.getAttribute("name") || ""),
    String(el.getAttribute("aria-label") || ""),
    String(el.getAttribute("placeholder") || ""),
    text
  ].join("|")).toString(36);
}

var body = null;
try {
  body = document.body;
} catch (e) {}
var rawText = body ? String(body.textContent || "") : "";
var values = [];
try {
  var valueControls = document.querySelectorAll("input, textarea, select");
  for (var i = 0; i < valueControls.length && i < 200; i += 1) {
    var control = valueControls[i];
    var type = String(control.type || "").toLowerCase();
    if (type === "password" || type === "file") continue;
    values.push(
      String(control.name || control.id || "") +
        "=" +
        String(control.value == null ? "" : control.value)
    );
  }
} catch (e) {}

var controls = [];
try {
  var controlNodes = document.querySelectorAll(
    "input:not([type=hidden]),textarea,select,button,a[href]," +
      "[role=button],[role=link],[role=checkbox],[role=radio],[role=switch]," +
      "[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]," +
      "[role=option],[contenteditable=true]"
  );
  var controlSeen = {};
  for (var c = 0; c < controlNodes.length && controls.length < MAX_CONTROLS; c += 1) {
    var node = controlNodes[c];
    var nodeTag = String(node.tagName || "").toLowerCase();
    var nodeType = nodeTag === "input" ? String(node.type || "text").toLowerCase() : null;
    var fields = describeElementFields(node);
    var base = controlKey(node, nodeTag, nodeType, fields);
    controlSeen[base] = (controlSeen[base] || 0) + 1;
    controls.push({
      key: base + ":" + controlSeen[base],
      role: fields.role,
      name: fields.label.slice(0, 120),
      type: nodeType,
      state: {
        visible: elementVisible(node),
        disabled: fields.disabled,
        readOnly: fields.readOnly,
        checked: fields.checked,
        selected: fields.selected,
        valuePresent: fields.valuePresent
      }
    });
  }
} catch (e) {}

var headings = [];
try {
  var headingNodes = document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]");
  var headingSeen = {};
  for (var h = 0; h < headingNodes.length && headings.length < MAX_HEADINGS; h += 1) {
    var heading = headingNodes[h];
    var level = String(
      heading.getAttribute("aria-level") ||
        heading.tagName ||
        heading.getAttribute("role") ||
        ""
    ).toLowerCase();
    var text = "";
    try {
      text = String(heading.innerText || heading.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    } catch (e) {}
    if (!text) continue;
    var headingKey = hashString(level + "|" + text).toString(36);
    headingSeen[headingKey] = (headingSeen[headingKey] || 0) + 1;
    headings.push({ key: headingKey + ":" + headingSeen[headingKey], text: text });
  }
} catch (e) {}

var alerts = [];
try {
  var alertNodes = document.querySelectorAll("[role=alert],[role=status],[aria-live]");
  var alertSeen = {};
  for (var a = 0; a < alertNodes.length && alerts.length < MAX_ALERTS; a += 1) {
    var alert = alertNodes[a];
    // A live region that wraps real alert nodes is a container, not an
    // alert; counting both would hide repeated identical messages.
    var nested = false;
    try {
      nested = !!alert.querySelector("[role=alert],[role=status],[aria-live]");
    } catch (e) {}
    if (nested) continue;
    var alertText = "";
    try {
      alertText = String(alert.innerText || alert.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    } catch (e) {}
    if (!alertText) continue;
    var alertKey = hashString(alertText).toString(36);
    alertSeen[alertKey] = (alertSeen[alertKey] || 0) + 1;
    alerts.push({ key: alertKey + ":" + alertSeen[alertKey], text: alertText });
  }
} catch (e) {}

var root = null;
try {
  root = document.documentElement || null;
} catch (e) {}

return {
  url: String(location.href || ""),
  title: String(document.title || ""),
  readyState: String(document.readyState || ""),
  textLength: rawText.length,
  textHash: hashString(rawText.slice(0, MAX_TEXT)),
  elementCount: document.querySelectorAll("*").length,
  valueHash: hashString(values.join("\u0001")),
  root: root,
  controls: controls,
  headings: headings,
  alerts: alerts
};
`;
}

export function coercePageSignature(value: unknown): PageSignature | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PageSignature>;
  if (typeof raw.url !== "string") return null;
  const number = (input: unknown): number =>
    typeof input === "number" && Number.isFinite(input)
      ? Math.max(0, Math.floor(input))
      : Number(input) || 0;
  const text = (input: unknown, max: number): string =>
    typeof input === "string" ? input.slice(0, max) : "";
  const signature: PageSignature = {
    url: raw.url.slice(0, 8_000),
    title: asString(raw.title, 1_000),
    readyState: asString(raw.readyState, 40),
    textLength: number(raw.textLength),
    textHash: number(raw.textHash),
    elementCount: number(raw.elementCount),
    valueHash: number(raw.valueHash),
  };
  if (raw.root) signature.root = raw.root;
  if (Array.isArray(raw.controls)) {
    const entries = raw.controls as unknown[];
    signature.controls = entries
      .slice(0, 120)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const item = entry as Record<string, unknown>;
        const state =
          item.state && typeof item.state === "object"
            ? (item.state as Record<string, unknown>)
            : {};
        return {
          key: text(item.key, 80),
          role: text(item.role, 80),
          name: text(item.name, 120),
          type: typeof item.type === "string" ? item.type.slice(0, 40) : null,
          state: {
            visible: state.visible === true,
            disabled: state.disabled === true,
            readOnly: state.readOnly === true,
            checked:
              typeof state.checked === "boolean" ? state.checked : null,
            selected:
              typeof state.selected === "boolean" ? state.selected : null,
            valuePresent: state.valuePresent === true,
          },
        };
      });
  }
  if (Array.isArray(raw.headings)) {
    const entries = raw.headings as unknown[];
    signature.headings = entries
      .slice(0, 80)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const item = entry as Record<string, unknown>;
        return { key: text(item.key, 80), text: text(item.text, 160) };
      });
  }
  if (Array.isArray(raw.alerts)) {
    const entries = raw.alerts as unknown[];
    signature.alerts = entries
      .slice(0, 20)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const item = entry as Record<string, unknown>;
        return { key: text(item.key, 80), text: text(item.text, 200) };
      });
  }
  return signature;
}

export function comparePageSignatures(
  before: PageSignature,
  after: PageSignature
): PageSignatureDiff {
  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const valueChanged = before.valueHash !== after.valueHash;
  const domChanged =
    before.textLength !== after.textLength ||
    before.textHash !== after.textHash ||
    before.elementCount !== after.elementCount ||
    before.readyState !== after.readyState;
  return {
    changed: urlChanged || titleChanged || domChanged || valueChanged,
    urlChanged,
    titleChanged,
    domChanged,
    valueChanged,
  };
}

export function coercePageSnapshot(value: unknown): PageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PageSnapshot>;
  if (typeof raw.url !== "string") return null;

  const text = asString(raw.text, MAX_TEXT);
  const numeric =
    typeof raw.fullLength === "number"
      ? raw.fullLength
      : raw.fullLength === null ||
          raw.fullLength === undefined ||
          raw.fullLength === ""
        ? Number.NaN
        : Number(raw.fullLength);
  const fullLength = Number.isFinite(numeric)
    ? Math.max(0, Math.floor(numeric))
    : text.length;
  const numericOffset =
    typeof raw.offset === "number"
      ? raw.offset
      : raw.offset === null ||
          raw.offset === undefined ||
          raw.offset === ""
        ? Number.NaN
        : Number(raw.offset);
  const offset = Number.isFinite(numericOffset)
    ? Math.min(fullLength, Math.max(0, Math.floor(numericOffset)))
    : 0;

  const snapshot: PageSnapshot = {
    title: asString(raw.title, 1_000),
    url: raw.url.slice(0, 8_000),
    selectedText: asString(raw.selectedText, MAX_SELECTED),
    text,
    fullLength,
    offset,
    readyState: asString(raw.readyState, 40),
    description: asNullableString(raw.description, 2_000),
    format: normalizeFormat(raw.format),
    selector: asNullableString(raw.selector, 2_000),
    selectorMatched:
      raw.selectorMatched === undefined
        ? false
        : asBoolean(raw.selectorMatched, false),
    contentType: asString(raw.contentType, 200),
  };

  if (typeof raw.markdown === "string") {
    snapshot.markdown = raw.markdown.slice(0, MAX_TEXT);
  }
  if (Array.isArray(raw.links)) {
    snapshot.links = coerceLinks(raw.links);
  }
  if (Array.isArray(raw.tables)) {
    snapshot.tables = coerceTables(raw.tables);
  }
  if (raw.metadata !== undefined && raw.metadata !== null) {
    const metadata = coerceMetadata(raw.metadata);
    if (metadata) snapshot.metadata = metadata;
  }
  if (Array.isArray(raw.outline)) {
    snapshot.outline = coerceHeadings(raw.outline);
    snapshot.outlineTruncated = raw.outlineTruncated === true;
  }
  if (Array.isArray(raw.elements)) {
    snapshot.elements = coerceElements(raw.elements);
    snapshot.elementsTruncated = raw.elementsTruncated === true;
    if (snapshot.format === "snapshot" || snapshot.format === "semantic") {
      // Defense in depth: the script omits values, and coercion drops any that
      // an older or unexpected script might have sent.
      for (const element of snapshot.elements) element.value = null;
    }
    const total = Number(raw.elementsTotal);
    snapshot.elementsTotal = Number.isFinite(total)
      ? Math.max(0, Math.floor(total))
      : snapshot.elements.length;
  }
  if (raw.semantic !== undefined && raw.semantic !== null) {
    const semantic = coerceSemanticPage(raw.semantic);
    if (semantic) snapshot.semantic = semantic;
  }
  if (Array.isArray(raw.semanticAnchors)) {
    snapshot.semanticAnchors = coerceElements(raw.semanticAnchors);
    for (const element of snapshot.semanticAnchors) element.value = null;
  }
  if (typeof raw.snapshotComplete === "boolean") {
    snapshot.snapshotComplete = raw.snapshotComplete;
  }
  if (typeof raw.framesComplete === "boolean") {
    snapshot.framesComplete = raw.framesComplete;
  }
  if (Array.isArray(raw.limitations)) {
    snapshot.limitations = raw.limitations
      .slice(0, SNAPSHOT_MAX_LIMITATIONS)
      .map((limitation) => asString(limitation, 300))
      .filter((limitation) => limitation.length > 0);
  }
  if (raw.root !== undefined) {
    snapshot.root = raw.root;
  }

  return snapshot;
}

function joinLimitations(
  existing: string | undefined,
  addition: string
): string {
  return existing ? `${existing} ${addition}` : addition;
}

export function toPageReadResult(
  page: PageSnapshot,
  options: {
    maxChars?: number;
    contentType?: string | null;
    /** Original offset requested, used to report ignored offsets. */
    offset?: number;
    /** Generated by the bridge for snapshot and interactive reads. */
    snapshotId?: string;
  } = {}
): PageReadResult {
  const format = normalizeFormat(page?.format);
  const isSnapshot = format === "snapshot";
  const isSemantic = format === "semantic";
  const privateView = isSnapshot || isSemantic;
  const structured = format !== "text" && format !== "markdown";
  const limit = Number(options?.maxChars);
  const hasLimit = options?.maxChars !== undefined && Number.isFinite(limit);
  const maxChars = hasLimit ? Math.max(0, Math.floor(limit)) : null;

  const text = typeof page?.text === "string" ? page.text : "";
  const rawLength = page?.fullLength as unknown;
  const numericLength =
    typeof rawLength === "number"
      ? rawLength
      : rawLength === null || rawLength === undefined || rawLength === ""
        ? Number.NaN
        : Number(rawLength);
  const fullLength = Number.isFinite(numericLength)
    ? Math.max(0, Math.floor(numericLength))
    : text.length;
  const primary =
    format === "markdown" && typeof page.markdown === "string"
      ? page.markdown.length
      : text.length;
  const rawOffset = Number(page?.offset);
  const appliedOffset =
    structured
      ? 0
      : Number.isFinite(rawOffset)
        ? Math.min(fullLength, Math.max(0, Math.floor(rawOffset)))
        : 0;
  const nextOffset =
    !structured && primary > 0 && appliedOffset + primary < fullLength
      ? appliedOffset + primary
      : null;
  const elementsTruncated = page?.elementsTruncated === true;
  const semanticTruncated =
    isSemantic &&
    (page?.semantic?.coverage.regionsTruncated === true ||
      page?.semantic?.coverage.complete === false);
  const textTruncated = privateView && fullLength > text.length;
  const outlineTruncated = privateView && page?.outlineTruncated === true;
  const truncated = privateView
    ? textTruncated || elementsTruncated || outlineTruncated || semanticTruncated
    : (structured
        ? maxChars !== null
          ? fullLength > maxChars
          : fullLength > primary
        : nextOffset !== null) || elementsTruncated;
  const requestedOffset = Math.max(
    0,
    Math.floor(Number(options?.offset) || 0)
  );

  const result: PageReadResult = {
    title: typeof page?.title === "string" ? page.title : "",
    url: typeof page?.url === "string" ? page.url : "",
    selectedText:
      !privateView && typeof page?.selectedText === "string"
        ? page.selectedText
        : "",
    text,
    truncated,
    length: fullLength,
    offset: appliedOffset,
    nextOffset: isSnapshot ? null : nextOffset,
    description:
      page?.description === null || page?.description === undefined
        ? null
        : String(page.description) || null,
    format,
    selector:
      page?.selector === null || page?.selector === undefined
        ? null
        : String(page.selector) || null,
    contentType:
      options?.contentType !== undefined
        ? options.contentType
        : (page?.contentType ?? null),
  };

  if (typeof page?.markdown === "string") {
    result.markdown = page.markdown;
  }
  if (Array.isArray(page?.links)) {
    result.links = page.links.map((link) => ({
      text: String(link?.text ?? ""),
      url: String(link?.url ?? ""),
    }));
  }
  if (Array.isArray(page?.tables)) {
    result.tables = page.tables.map((table) => ({
      caption: table?.caption ?? null,
      headers: Array.isArray(table?.headers)
        ? table.headers.map((cell) => String(cell ?? ""))
        : [],
      rows: Array.isArray(table?.rows)
        ? table.rows.map((row) =>
            Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []
          )
        : [],
    }));
  }
  if (page?.metadata) {
    result.metadata = page.metadata;
  }
  if (privateView) {
    // A semantic read already carries headings in semantic.headings; repeating
    // them in the outline doubles the payload without adding information.
    if (!isSemantic) {
      result.outline = Array.isArray(page?.outline)
        ? page.outline.map((heading) => ({
            level: Number(heading?.level) || 1,
            text: String(heading?.text ?? ""),
          }))
        : [];
    }
  } else if (Array.isArray(page?.outline)) {
    result.outline = page.outline.map((heading) => ({
      level: Number(heading?.level) || 1,
      text: String(heading?.text ?? ""),
    }));
  }

  const elements = Array.isArray(page?.elements) ? page.elements : null;
  if (elements) {
    result.elements = elements.map((element) => {
      const mapped: PageElement = {
        ref: String(element?.ref ?? ""),
        tag: String(element?.tag ?? ""),
        role: String(element?.role ?? "generic"),
        type: element?.type ?? null,
        label: String(element?.label ?? ""),
        placeholder: element?.placeholder ?? null,
        href: element?.href ?? null,
        disabled: element?.disabled === true,
        checked:
          typeof element?.checked === "boolean" ? element.checked : null,
        readOnly: element?.readOnly === true,
        sensitive: element?.sensitive === true,
        editable: element?.editable === true,
      };
      if (!privateView) {
        mapped.value = element?.value ?? null;
      } else {
        // A snapshot or semantic read never carries values; state that is
        // absent is omitted rather than serialized as null or false.
        if (element?.valuePresent === true) mapped.valuePresent = true;
        if (element?.autocomplete) mapped.autocomplete = element.autocomplete;
        if (typeof element?.selected === "boolean") {
          mapped.selected = element.selected;
        }
        if (element?.form) mapped.form = element.form;
      }
      if (Array.isArray(element?.framePath)) {
        mapped.framePath = element.framePath.map((index) =>
          Math.max(0, Math.floor(Number(index) || 0))
        );
      }
      if (element?.frameUrl !== undefined) {
        mapped.frameUrl =
          element.frameUrl === null ? null : String(element.frameUrl);
      }
      return mapped;
    });
  } else if (privateView) {
    result.elements = [];
  }

  if (elementsTruncated) {
    result.elementsTruncated = true;
  }

  if (isSemantic && page?.semantic) {
    result.semantic = leanSemanticPage(page.semantic);
  }

  if (privateView) {
    const limitations: string[] = [];
    if (Array.isArray(page.limitations)) {
      for (const limitation of page.limitations) {
        if (typeof limitation === "string" && limitation) {
          limitations.push(limitation);
        }
      }
    }
    if (textTruncated) {
      limitations.push(
        `Text preview is limited to ${SNAPSHOT_TEXT_CHARS} characters. Use ` +
          'format="text" with offset to page through the full text.'
      );
    }
    if (elementsTruncated) {
      limitations.push(
        format === "semantic"
          ? `The semantic control list is capped at ${SEMANTIC_MAX_CONTROLS} controls; ` +
              "narrow it with selector."
          : "The snapshot control list reached its cap. Narrow it with " +
              "selector or raise maxElements."
      );
    }
    if (outlineTruncated && !isSemantic) {
      limitations.push(
        `The snapshot outline is limited to ${SNAPSHOT_MAX_HEADINGS} headings.`
      );
    }
    if (requestedOffset > 0) {
      limitations.push(
        `offset is ignored for ${format} reads; the preview always starts at ` +
          "the beginning."
      );
    }
    if (isSemantic && page.semantic) {
      for (const limitation of page.semantic.limitations) {
        if (typeof limitation === "string" && limitation) {
          limitations.push(limitation);
        }
      }
    }
    result.snapshotId = options.snapshotId;
    result.elementsTotal = Number.isFinite(Number(page.elementsTotal))
      ? Math.max(0, Math.floor(Number(page.elementsTotal)))
      : (elements?.length ?? 0);
    result.elementsTruncated = elementsTruncated;
    result.textTruncated = textTruncated;
    if (!isSemantic) {
      result.outlineTruncated = outlineTruncated;
    }
    if (isSnapshot) {
      result.framesComplete = page.framesComplete !== false;
      result.snapshotComplete = page.snapshotComplete !== false;
    }
    result.limitations = Array.from(new Set(limitations)).slice(
      0,
      SNAPSHOT_MAX_LIMITATIONS
    );
    return result;
  }

  if (elementsTruncated) {
    result.limitation = joinLimitations(
      result.limitation,
      "The interactive scan reached its element cap. Narrow it with " +
        "selector to see the rest."
    );
  }

  if (structured && requestedOffset > 0) {
    result.limitation = joinLimitations(
      result.limitation,
      `offset is only supported for text and markdown reads. This ${format} ` +
        `read ignored offset=${requestedOffset} and returned the complete ` +
        `${format} data.`
    );
  }

  return result;
}

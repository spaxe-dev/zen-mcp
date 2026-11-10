import type {
  PageElement,
  PageHeading,
  PageLink,
  PageMetadata,
  PageReadResult,
  PageTable,
  ReadFormat,
} from "./protocol.js";

export interface ReadScriptOptions {
  maxChars: number;
  /** Character offset into the text or markdown stream. */
  offset?: number;
  format?: ReadFormat;
  selector?: string;
  /**
   * Prefix for interactive refs, used when the script runs inside a frame.
   * Shape: "f0-", "f0.1-". The main document uses an empty prefix.
   */
  refPrefix?: string;
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
  elements?: PageElement[];
  elementsTruncated?: boolean;
}

const READ_FORMATS: ReadFormat[] = [
  "text",
  "markdown",
  "links",
  "tables",
  "metadata",
  "outline",
  "interactive",
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

function coerceElements(value: unknown): PageElement[] {
  if (!Array.isArray(value)) return [];
  const elements: PageElement[] = [];
  for (const entry of value.slice(0, MAX_PAGE_ELEMENTS)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<PageElement>;
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
 * The script used for every page read. It is intentionally synchronous so it
 * can run both through Marionette's async wrapper and through the browser's
 * MarionetteCommands actor for background tabs.
 */
export function buildReadScript(options: ReadScriptOptions): string {
  const requested = Number(options?.maxChars);
  const maxChars = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : 24_000;
  const requestedOffset = Number(options?.offset);
  const offset = Number.isFinite(requestedOffset)
    ? Math.max(0, Math.floor(requestedOffset))
    : 0;
  const format = normalizeFormat(options?.format);
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
const REF_ATTR = "data-zen-mcp-ref";
const MAX_ELEMENTS = ${MAX_PAGE_ELEMENTS};
const FENCE = String.fromCharCode(96, 96, 96);
const SENTINEL = "\u0000";

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

function normalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
  if (!root || !root.querySelectorAll) return result;
  var nodes = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (var i = 0; i < nodes.length && result.length < 200; i += 1) {
    var level = Number(String(nodes[i].tagName || "").charAt(1));
    if (!isFinite(level) || level < 1 || level > 6) continue;
    var text = normalizeText(nodes[i].textContent || "").replace(/\n+/g, " ");
    if (!text) continue;
    result.push({ level: level, text: text.slice(0, 500) });
  }
  return result;
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

function elementText(el) {
  var text = "";
  try {
    text = el.innerText || el.textContent || "";
  } catch (e) {}
  return normalizeText(text).replace(/\n+/g, " ").slice(0, 200);
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
  return normalizeText(label).replace(/\n+/g, " ").slice(0, 200);
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

function elementHref(el) {
  try {
    var raw = el.getAttribute("href");
    if (!raw) return null;
    var url = new URL(raw, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch (e) {}
  return null;
}

function describeElement(el, ref) {
  var tag = String(el.tagName || "").toLowerCase();
  var type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
  var sensitive = tag === "input" && type === "password";
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

  var value = null;
  if (!sensitive) {
    try {
      if (tag === "select") {
        var option = el.options && el.options[el.selectedIndex];
        if (option) value = String(option.text || option.value || "").slice(0, 200);
      } else if (tag === "input" && type !== "file") {
        value = String(el.value || "").slice(0, 200);
      }
    } catch (e) {}
  }

  return {
    ref: ref,
    tag: tag,
    role: elementRole(el, tag, type),
    type: type,
    label: elementLabel(el, tag, type),
    value: value,
    placeholder: safeCall(function () {
      return el.getAttribute("placeholder") || null;
    }, null),
    href: elementHref(el),
    disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    checked: type === "checkbox" || type === "radio" ? !!el.checked : null,
    readOnly: !!(el.readOnly || el.getAttribute("aria-readonly") === "true"),
    sensitive: sensitive,
    editable: editable
  };
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

function clearElementRefs(root) {
  if (!root || !root.querySelectorAll) return;
  var tagged = [];
  try {
    tagged = root.querySelectorAll("[" + REF_ATTR + "]");
  } catch (e) {}
  for (var i = 0; i < tagged.length; i += 1) {
    try {
      tagged[i].removeAttribute(REF_ATTR);
    } catch (e) {}
  }
  var all = [];
  try {
    all = root.querySelectorAll("*");
  } catch (e) {}
  for (var n = 0; n < all.length; n += 1) {
    if (all[n].shadowRoot) clearElementRefs(all[n].shadowRoot);
  }
}

function collectInteractive(root) {
  clearElementRefs(document);
  var candidates = [];
  findCandidates(root || document.body, candidates);
  var elements = [];
  var eligible = 0;
  for (var i = 0; i < candidates.length; i += 1) {
    var el = candidates[i];
    if (!el || !el.isConnected) continue;
    if (!isElementVisible(el)) continue;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" && String(el.type || "").toLowerCase() === "hidden") {
      continue;
    }
    eligible += 1;
    if (elements.length >= MAX_ELEMENTS) continue;
    var ref = refPrefix + "e" + (elements.length + 1);
    try {
      el.setAttribute(REF_ATTR, ref);
    } catch (e) {
      continue;
    }
    elements.push(describeElement(el, ref));
  }
  return { elements: elements, truncated: eligible > elements.length };
}

var selectorMatched = true;
var root = null;
try {
  if (selector) {
    root = document.querySelector(selector);
    if (!root) selectorMatched = false;
  } else if (format === "interactive") {
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
try {
  if (typeof window !== "undefined" && window.getSelection) {
    selectedText = String(window.getSelection().toString() || "").slice(0, 4000);
  }
} catch (e) {}

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
  }, []);
  if (outline) out.outline = outline;
} else if (format === "interactive") {
  var interactive = safeCall(function () {
    return collectInteractive(root);
  }, null);
  if (interactive) {
    out.elements = interactive.elements;
    out.elementsTruncated = interactive.truncated;
  }
}

return out;
`;
}

export interface ResolveTargetOptions {
  ref?: string;
  selector?: string;
}

/**
 * Resolves an interactive-read ref, including refs inside open shadow roots, or
 * a CSS selector in the light DOM. It returns the element itself so the caller
 * can hand it back to Marionette's click and sendKeys commands, plus a summary
 * that is safe to return to the agent.
 */
export function buildResolveTargetScript(options: ResolveTargetOptions = {}): string {
  const ref =
    typeof options.ref === "string" && options.ref.trim()
      ? options.ref.trim()
      : null;
  const selector =
    typeof options.selector === "string" && options.selector.trim()
      ? options.selector.trim()
      : null;

  return String.raw`
const REF_ATTR = "data-zen-mcp-ref";
const ref = ${JSON.stringify(ref)};
const selector = ${JSON.stringify(selector)};

function normalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function findByRef(root) {
  var match = null;
  try {
    match = root.querySelector("[" + REF_ATTR + "='" + ref + "']");
  } catch (e) {}
  if (match) return match;
  var all = [];
  try {
    all = root.querySelectorAll("*");
  } catch (e) {}
  for (var i = 0; i < all.length; i += 1) {
    var shadow = all[i].shadowRoot;
    if (!shadow) continue;
    var nested = findByRef(shadow);
    if (nested) return nested;
  }
  return null;
}

function elementText(el) {
  var text = "";
  try {
    text = el.innerText || el.textContent || "";
  } catch (e) {}
  return normalizeText(text).slice(0, 200);
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

var found = null;
try {
  found = ref ? findByRef(document) : selector ? document.querySelector(selector) : null;
} catch (e) {
  found = null;
}
if (!found) {
  return { found: false };
}

var tag = String(found.tagName || "").toLowerCase();
var type = tag === "input" ? String(found.type || "text").toLowerCase() : null;
var editable = false;
if (tag === "textarea") {
  editable = true;
} else if (tag === "input") {
  editable = !/^(button|submit|reset|checkbox|radio|range|file|image|color|hidden)$/.test(
    type || ""
  );
} else if (found.isContentEditable) {
  editable = true;
}

return {
  found: true,
  element: found,
  tag: tag,
  role: elementRole(found, tag, type),
  type: type,
  label: elementLabel(found, tag, type),
  href: elementHref(found),
  disabled: !!found.disabled || found.getAttribute("aria-disabled") === "true",
  readOnly: !!(
    found.readOnly || found.getAttribute("aria-readonly") === "true"
  ),
  sensitive: tag === "input" && type === "password",
  editable: editable
};
`;
}

export interface WaitProbeOptions {
  selector?: string;
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

  return String.raw`
const selector = ${JSON.stringify(selector)};
const text = ${JSON.stringify(text)};
const urlContains = ${JSON.stringify(urlContains)};
const titleContains = ${JSON.stringify(titleContains)};

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
    matched = !!document.querySelector(selector);
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

export interface PageSignature {
  url: string;
  title: string;
  readyState: string;
  textLength: number;
  textHash: number;
  elementCount: number;
  valueHash: number;
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
 * hashes rendered text and form values instead of returning them.
 */
export function buildPageSignatureScript(): string {
  return String.raw`
const MAX_TEXT = 200000;

function hashString(value) {
  var hash = 2166136261;
  var text = String(value == null ? "" : value);
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

var body = null;
try {
  body = document.body;
} catch (e) {}
var rawText = body ? String(body.textContent || "") : "";
var values = [];
try {
  var controls = document.querySelectorAll("input, textarea, select");
  for (var i = 0; i < controls.length && i < 200; i += 1) {
    var control = controls[i];
    var type = String(control.type || "").toLowerCase();
    if (type === "password" || type === "file") continue;
    values.push(
      String(control.name || control.id || "") +
        "=" +
        String(control.value == null ? "" : control.value)
    );
  }
} catch (e) {}

return {
  url: String(location.href || ""),
  title: String(document.title || ""),
  readyState: String(document.readyState || ""),
  textLength: rawText.length,
  textHash: hashString(rawText.slice(0, MAX_TEXT)),
  elementCount: document.querySelectorAll("*").length,
  valueHash: hashString(values.join("\u0001"))
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
  return {
    url: raw.url.slice(0, 8_000),
    title: asString(raw.title, 1_000),
    readyState: asString(raw.readyState, 40),
    textLength: number(raw.textLength),
    textHash: number(raw.textHash),
    elementCount: number(raw.elementCount),
    valueHash: number(raw.valueHash),
  };
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
  }
  if (Array.isArray(raw.elements)) {
    snapshot.elements = coerceElements(raw.elements);
    snapshot.elementsTruncated = raw.elementsTruncated === true;
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
  } = {}
): PageReadResult {
  const format = normalizeFormat(page?.format);
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
  const truncated =
    (structured
      ? maxChars !== null
        ? fullLength > maxChars
        : fullLength > primary
      : nextOffset !== null) || page?.elementsTruncated === true;
  const requestedOffset = Math.max(
    0,
    Math.floor(Number(options?.offset) || 0)
  );

  const result: PageReadResult = {
    title: typeof page?.title === "string" ? page.title : "",
    url: typeof page?.url === "string" ? page.url : "",
    selectedText:
      typeof page?.selectedText === "string" ? page.selectedText : "",
    text,
    truncated,
    length: fullLength,
    offset: appliedOffset,
    nextOffset,
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
  if (Array.isArray(page?.outline)) {
    result.outline = page.outline.map((heading) => ({
      level: Number(heading?.level) || 1,
      text: String(heading?.text ?? ""),
    }));
  }
  if (Array.isArray(page?.elements)) {
    result.elements = page.elements.map((element) => ({
      ref: String(element?.ref ?? ""),
      tag: String(element?.tag ?? ""),
      role: String(element?.role ?? "generic"),
      type: element?.type ?? null,
      label: String(element?.label ?? ""),
      value: element?.value ?? null,
      placeholder: element?.placeholder ?? null,
      href: element?.href ?? null,
      disabled: element?.disabled === true,
      checked:
        typeof element?.checked === "boolean" ? element.checked : null,
      readOnly: element?.readOnly === true,
      sensitive: element?.sensitive === true,
      editable: element?.editable === true,
      ...(Array.isArray(element?.framePath)
        ? {
            framePath: element.framePath.map((index) =>
              Math.max(0, Math.floor(Number(index) || 0))
            ),
          }
        : {}),
      ...(element?.frameUrl !== undefined
        ? {
            frameUrl:
              element.frameUrl === null ? null : String(element.frameUrl),
          }
        : {}),
    }));
    if (page.elementsTruncated === true) {
      result.elementsTruncated = true;
      result.limitation = joinLimitations(
        result.limitation,
        "The interactive scan reached its element cap. Narrow it with " +
          "selector to see the rest."
      );
    }
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

import type { PageReadResult } from "./protocol.js";

export interface PageSnapshot {
  title: string;
  url: string;
  selectedText: string;
  text: string;
  fullLength: number;
  readyState: string;
  description: string | null;
}

/**
 * The script used for every page read. It is intentionally synchronous so it
 * can run both through Marionette's async wrapper and through the browser's
 * MarionetteCommands actor for background tabs.
 */
export function buildReadScript(maxChars: number): string {
  return `
const maxChars = ${JSON.stringify(maxChars)};
const body = document.body;
let text = "";
let description = null;
try {
  const meta = document.querySelector(
    'meta[name="description"], meta[property="og:description"]'
  );
  description = meta ? String(meta.getAttribute("content") || "") || null : null;
} catch (e) {}

try {
  let root = document.querySelector("article, main, [role='main']");
  if (!root) root = body;
  if (root) {
    text = String(root.innerText || root.textContent || "");
  }
} catch (e) {
  text = "";
}
text = text
  .replace(/\\r\\n/g, "\\n")
  .replace(/[\\t\\u00a0]/g, " ")
  .replace(/[ ]{2,}/g, " ")
  .replace(/\\n{3,}/g, "\\n\\n")
  .trim();
const fullLength = text.length;
const selectedText = String(
  window.getSelection ? window.getSelection().toString() : ""
).slice(0, 4000);
return {
  title: String(document.title || ""),
  url: String(location.href || ""),
  selectedText,
  text: text.slice(0, maxChars),
  fullLength,
  readyState: String(document.readyState || ""),
  description,
};
`;
}

export function coercePageSnapshot(value: unknown): PageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PageSnapshot>;
  if (typeof raw.url !== "string") return null;
  const text = String(raw.text ?? "");
  return {
    title: String(raw.title ?? ""),
    url: raw.url,
    selectedText: String(raw.selectedText ?? "").slice(0, 4000),
    text,
    fullLength: Number.isFinite(Number(raw.fullLength))
      ? Number(raw.fullLength)
      : text.length,
    readyState: String(raw.readyState ?? ""),
    description:
      raw.description === null || raw.description === undefined
        ? null
        : String(raw.description) || null,
  };
}

export function toPageReadResult(
  page: PageSnapshot,
  maxChars: number
): PageReadResult {
  return {
    title: page.title,
    url: page.url,
    selectedText: page.selectedText,
    text: page.text,
    truncated: page.fullLength > maxChars,
    length: page.fullLength,
    description: page.description,
  };
}

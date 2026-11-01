import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isUrlAllowed,
  normalizeDomainList,
  normalizeWebUrl,
} from "../shared/url-policy.js";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
} from "../utils/safe-file.js";

export type ToolGuardErrorCode =
  | "read_only"
  | "domain_not_allowed"
  | "invalid_args";

export class ToolGuardError extends Error {
  readonly code: ToolGuardErrorCode;

  constructor(code: ToolGuardErrorCode, message: string) {
    super(message);
    this.name = "ToolGuardError";
    this.code = code;
  }
}

/**
 * Tools that change browser, server or persisted state. Everything else
 * (status, lists, reads, history, bookmarks, containers, answers, events,
 * audit, ask, notify, progress) stays available in read-only mode.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "zen_launch",
  "zen_space_create",
  "zen_space_switch",
  "zen_space_delete",
  "zen_tabs_open",
  "zen_tabs_close",
  "zen_tab_select",
  "zen_folder_create",
  "zen_folder_add_tabs",
  "zen_pin_tabs",
  "zen_essentials",
  "zen_glance",
  "zen_split_view",
  "zen_split_close",
  "zen_clipboard_write",
  "zen_watch_add",
  "zen_watch_remove",
  "zen_session_save",
  "zen_session_restore",
  "zen_session_delete",
  "zen_template_save",
  "zen_template_delete",
  "zen_template_apply",
  "zen_tabs_group",
  "zen_show_evidence",
  "zen_show_evidence_batch",
  "zen_clear_evidence",
]);

/** Verification outcome of an evidence batch, when the result carries counts. */
export type AuditOutcome = "success" | "partial" | "failed";

/** Outcome fields derived from a handler result and stored on the audit line. */
export interface AuditOutcomeFields {
  /** True when the tool's structured result succeeded. */
  ok: boolean;
  /** True when the handler returned a result rather than being blocked or throwing. */
  executed: boolean;
  /** Citations that verified, for evidence batch results. */
  citationsVerified?: number;
  /** Citations that failed, for evidence batch results. */
  citationsFailed?: number;
  /** Batch verification outcome when citation counts are present. */
  outcome?: AuditOutcome;
}

export interface AuditRecord extends AuditOutcomeFields {
  /** ISO timestamp of when the call finished. */
  at: string;
  tool: string;
  durationMs: number;
  args?: unknown;
  error?: { code?: string; message: string };
  urls?: string[];
}

/**
 * Derives the audit flags for a handler result without inspecting page text or
 * quote content. Tools that return no structured `ok` field keep the previous
 * behavior: a returned result is a success. Evidence batch results add the
 * verified and failed citation counts and a coarse outcome.
 */
export function auditOutcomeForResult(
  tool: string,
  value: unknown
): AuditOutcomeFields {
  const result =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  const structuredOk =
    result && typeof result.ok === "boolean" ? result.ok : undefined;
  const fields: AuditOutcomeFields = {
    ok: structuredOk ?? true,
    executed: true,
  };
  if (!result) {
    return fields;
  }

  const total = result.total;
  const verified = result.verified;
  const failed = result.failed;
  const batchShaped =
    tool === "zen_show_evidence_batch" ||
    total !== undefined ||
    verified !== undefined ||
    failed !== undefined;
  if (
    !batchShaped ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    typeof verified !== "number" ||
    !Number.isFinite(verified) ||
    typeof failed !== "number" ||
    !Number.isFinite(failed)
  ) {
    return fields;
  }

  fields.citationsVerified = verified;
  fields.citationsFailed = failed;
  fields.outcome =
    fields.ok && failed === 0
      ? "success"
      : verified > 0
        ? "partial"
        : "failed";
  return fields;
}

export interface GuardOptions {
  readOnly: boolean;
  allowedDomains: string[];
  auditLog: boolean;
  dataDir: string;
}

const MAX_STRING_CHARS = 500;
const MAX_ARRAY_ENTRIES = 20;
const MAX_DEPTH = 3;
const MAX_ARGS_JSON = 2048;
const MAX_AUDIT_URLS = 30;
const MAX_AUDIT_URL_CHARS = 300;
const MAX_AUDIT_LINE_BYTES = 16 * 1024;
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const AUDIT_TAIL_BYTES = 4 * 1024 * 1024;
const AUDIT_BACKUP = ".1";

/**
 * Arguments that routinely carry user secrets or page text. They are stored as
 * a length and digest so the log stays useful without retaining the content.
 */
const SENSITIVE_ARG_KEYS = new Set([
  "answer",
  "citations",
  "claim",
  "context",
  "freeform",
  "options",
  "query",
  "question",
  "quote",
  "sourceTitle",
  "source_title",
  "text",
]);

/**
 * Pulls the URLs a tool is about to touch. Every URL is normalized the same
 * way the opener normalizes it. Only tools that open or preview a URL
 * contribute; session, template and space tools return [].
 */
export function extractToolUrls(
  tool: string,
  args: Record<string, unknown> | undefined
): string[] {
  if (!args) {
    return [];
  }
  const collected: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const normalized = normalizeWebUrl(value);
    collected.push(normalized ? normalized.href : value.trim());
  };

  if (tool === "zen_tabs_open") {
    const urls = args.urls;
    if (Array.isArray(urls)) {
      for (const entry of urls) {
        push(entry);
      }
    } else {
      push(urls);
    }
  } else if (tool === "zen_glance") {
    push(args.url);
  } else if (tool === "zen_show_evidence") {
    push(args.url);
  } else if (tool === "zen_show_evidence_batch") {
    const citations = args.citations;
    if (Array.isArray(citations)) {
      for (const entry of citations) {
        if (!entry || typeof entry !== "object") continue;
        push((entry as Record<string, unknown>).url);
      }
    }
  }

  return collected;
}

/** Absolute path of the append-only audit log. */
export function auditFilePath(dataDir: string): string {
  return join(dataDir, "audit.jsonl");
}

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Removes userinfo, the query string and the fragment from a URL. Audit lines
 * should identify a destination, not retain tokens, searches or credentials.
 */
export function redactUrlForAudit(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const candidates = [value];
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    candidates.push(`https://${value}`);
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return `${url.protocol.replace(/:$/, "")}:<redacted>`;
      }
      const path =
        url.pathname.length > MAX_AUDIT_URL_CHARS
          ? `${url.pathname.slice(0, MAX_AUDIT_URL_CHARS)}...`
          : url.pathname;
      return path && path !== "/"
        ? `${url.protocol}//${url.host}${path}`
        : `${url.protocol}//${url.host}`;
    } catch {
      // Try the next candidate.
    }
  }
  return `<unparseable url: ${value.length} chars>`;
}

function redactUrlsInText(text: string): string {
  return text.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi,
    (match) => redactUrlForAudit(match)
  );
}

function redactValue(value: unknown, digest: string): string {
  let text: string;
  try {
    text =
      typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    text = "";
  }
  return `<redacted ${text.length} chars sha256:${digest}>`;
}

function summarizeValue(
  value: unknown,
  depth: number,
  sensitive = false
): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    if (sensitive) return redactValue(value, digestOf(value));
    return value.length > MAX_STRING_CHARS
      ? `sha256:${digestOf(value)} (${value.length} chars)`
      : value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    return { name: value.name, message: truncateString(value.message) };
  }
  if (depth >= MAX_DEPTH) {
    return "[max depth]";
  }
  if (sensitive) {
    return redactValue(value, digestOf(JSON.stringify(value) ?? ""));
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ENTRIES)
      .map((entry) => summarizeValue(entry, depth + 1));
    if (value.length > MAX_ARRAY_ENTRIES) {
      items.push(`<${value.length - MAX_ARRAY_ENTRIES} more>`);
    }
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_ARG_KEYS.has(key)) {
      out[key] =
        typeof entry === "string"
          ? redactValue(entry, digestOf(entry))
          : redactValue(entry, digestOf(JSON.stringify(entry) ?? ""));
      continue;
    }
    const summarized =
      key === "url" && typeof entry === "string"
        ? redactUrlForAudit(entry)
        : key === "urls" && Array.isArray(entry)
          ? entry
              .slice(0, MAX_ARRAY_ENTRIES)
              .map((item) => summarizeValue(redactUrlForAudit(String(item)), depth + 1))
          : summarizeValue(entry, depth + 1);
    if (summarized !== undefined) {
      out[key] = summarized;
    }
  }
  return out;
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `sha256:${digestOf(value)} (${value.length} chars)`;
}

/** Keeps the audit line small: short strings, bounded arrays and depth. */
export function summarizeArgs(args: unknown): unknown {
  if (args === undefined) {
    return undefined;
  }
  try {
    const summarized = summarizeValue(args, 0);
    const text = JSON.stringify(summarized);
    if (text !== undefined && text.length > MAX_ARGS_JSON) {
      return {
        truncated: true,
        size: text.length,
        preview: text.slice(0, MAX_ARGS_JSON - 96),
      };
    }
    return summarized;
  } catch {
    return { truncated: true, error: "unserializable arguments" };
  }
}

function describeError(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

export class ToolGuard {
  readonly auditPath: string;
  private readonly options: GuardOptions;
  private warnedWriteFailure = false;

  constructor(options: GuardOptions) {
    this.options = {
      ...options,
      allowedDomains: [...(options.allowedDomains ?? [])],
    };
    this.auditPath = auditFilePath(options.dataDir);
  }

  /** Throws when read-only or a URL is outside the allowlist. */
  check(
    tool: string,
    args?: Record<string, unknown>,
    urls?: string[]
  ): void {
    if (this.options.readOnly && MUTATING_TOOLS.has(tool)) {
      throw new ToolGuardError(
        "read_only",
        `Tool "${tool}" changes browser or server state and is disabled in ` +
          "read-only mode. " +
          `Set readOnly to false to allow it.`
      );
    }

    const allowedDomains = this.options.allowedDomains;
    if (allowedDomains.length === 0) {
      return;
    }

    const list = normalizeDomainList(allowedDomains).join(", ") || "(none)";
    const candidates = urls ?? extractToolUrls(tool, args);
    for (const candidate of candidates) {
      const raw = String(candidate ?? "").trim();
      const normalized = normalizeWebUrl(raw);
      if (!normalized) {
        let scheme = "";
        try {
          scheme = new URL(raw).protocol;
        } catch {
          scheme = "";
        }
        if (scheme) {
          throw new ToolGuardError(
            "domain_not_allowed",
            `Blocked by domain allowlist: "${raw}" uses the "${scheme}" ` +
              `scheme, which is not http(s). Allowed domains: ${list}.`
          );
        }
        throw new ToolGuardError(
          "domain_not_allowed",
          `Blocked by domain allowlist: "${raw}" is not a valid http(s) URL ` +
            `for "${tool}". Allowed domains: ${list}.`
        );
      }
      if (isUrlAllowed(normalized.href, allowedDomains)) {
        continue;
      }
      throw new ToolGuardError(
        "domain_not_allowed",
        `Blocked by domain allowlist: domain "${normalized.hostname}" is not ` +
          `allowed for "${tool}". Allowed domains: ${list}.`
      );
    }
  }

  /**
   * Appends one JSON line to the audit log. Never throws; a write failure is
   * reported to stderr once and then stays silent.
   */
  audit(record: AuditRecord): void {
    if (!this.options.auditLog) {
      return;
    }
    try {
      const next: AuditRecord = { ...record };
      if (next.args !== undefined) {
        next.args = summarizeArgs(next.args);
      }
      if (next.urls !== undefined) {
        next.urls = [
          ...new Set(
            next.urls
              .slice(0, MAX_AUDIT_URLS)
              .map((url) => redactUrlForAudit(url))
              .filter(Boolean)
          ),
        ];
      }
      if (next.error) {
        next.error = {
          ...next.error,
          message: truncateString(redactUrlsInText(next.error.message)),
        };
      }
      let line = `${JSON.stringify(next)}\n`;
      if (Buffer.byteLength(line, "utf8") > MAX_AUDIT_LINE_BYTES) {
        line = `${JSON.stringify({
          at: next.at,
          tool: next.tool,
          ok: next.ok,
          executed: next.executed,
          durationMs: next.durationMs,
          ...(next.citationsVerified !== undefined
            ? { citationsVerified: next.citationsVerified }
            : {}),
          ...(next.citationsFailed !== undefined
            ? { citationsFailed: next.citationsFailed }
            : {}),
          ...(next.outcome !== undefined ? { outcome: next.outcome } : {}),
          urls: next.urls,
          args: { truncated: true },
          ...(next.error ? { error: next.error } : {}),
        })}\n`;
      }
      ensurePrivateDir(dirname(this.auditPath));
      this.#rotateFor(Buffer.byteLength(line, "utf8"));
      appendFileSync(this.auditPath, line, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
      try {
        chmodSync(this.auditPath, PRIVATE_FILE_MODE);
      } catch {
        // Windows does not apply POSIX mode bits the same way.
      }
    } catch (error) {
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        console.error(
          `zen-mcp: could not write the audit log at ${this.auditPath}: ${describeError(error)}`
        );
      }
    }
  }

  /**
   * Keeps the active log under MAX_AUDIT_BYTES by moving it to a single
   * `.1` backup before the next append.
   */
  #rotateFor(incoming: number): void {
    try {
      const stat = statSync(this.auditPath);
      if (stat.size + incoming <= MAX_AUDIT_BYTES) return;
      const backup = `${this.auditPath}${AUDIT_BACKUP}`;
      try {
        unlinkSync(backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      renameSync(this.auditPath, backup);
      try {
        chmodSync(backup, PRIVATE_FILE_MODE);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  /** Returns the last `limit` valid records in chronological order. */
  tail(limit = 50): AuditRecord[] {
    const capped = Math.max(0, Math.floor(limit));
    if (capped === 0 || !existsSync(this.auditPath)) {
      return [];
    }
    let text: string;
    try {
      const fd = openSync(this.auditPath, "r");
      try {
        const { size } = fstatSync(fd);
        const start = Math.max(0, size - AUDIT_TAIL_BYTES);
        const length = size - start;
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const bytes = readSync(fd, buffer, read, length - read, start + read);
          if (bytes <= 0) break;
          read += bytes;
        }
        text = buffer.subarray(0, read).toString("utf8");
        if (start > 0) {
          // The window can start mid-record; drop that partial first line.
          const firstNewline = text.indexOf("\n");
          text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }
    const lines = text.split(/\r?\n/);
    const records: AuditRecord[] = [];
    for (let index = lines.length - 1; index >= 0 && records.length < capped; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          typeof (parsed as AuditRecord).tool === "string" &&
          typeof (parsed as AuditRecord).at === "string"
        ) {
          records.push(parsed as AuditRecord);
        }
      } catch {
        // Skip corrupt lines rather than failing the whole tail.
      }
    }
    return records.reverse();
  }
}

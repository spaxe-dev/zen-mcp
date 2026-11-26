import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  MUTATING_TOOLS,
  ToolGuard,
  ToolGuardError,
  auditFilePath,
  extractToolUrls,
  type AuditRecord,
  type GuardOptions,
} from "../../src/mcp/guard.js";
import { hostOf, isUrlAllowed } from "../../src/shared/url-policy.js";
import { createPolicy } from "../../src/shared/policy.js";
import {
  fullPolicySnapshot,
  legacyPolicySnapshot,
  snapshotOfPolicy,
} from "./policy-fixtures.js";

const BASE_TMP = existsSync("D:/tmp") || existsSync("D:\\tmp") ? "D:/tmp" : tmpdir();

function options(overrides: Partial<GuardOptions> = {}): GuardOptions {
  return {
    policy: fullPolicySnapshot(),
    auditLog: true,
    dataDir: BASE_TMP,
    ...overrides,
  };
}

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    at: new Date().toISOString(),
    tool: "zen_status",
    ok: true,
    executed: true,
    durationMs: 3,
    ...overrides,
  };
}

describe("hostOf", () => {
  it("returns a lowercase hostname and ignores ports", () => {
    assert.equal(hostOf("https://API.GitHub.com:8443/x"), "api.github.com");
    assert.equal(hostOf("http://example.com"), "example.com");
    assert.equal(hostOf("github.com/path"), "github.com");
  });

  it("returns null for non-http(s) and unparseable input", () => {
    assert.equal(hostOf("about:blank"), null);
    assert.equal(hostOf("file:///C:/secret.txt"), null);
    assert.equal(hostOf("data:text/plain,hi"), null);
    assert.equal(hostOf("not a url"), null);
    assert.equal(hostOf(""), null);
  });
});

describe("isUrlAllowed", () => {
  it("allows everything when the list is empty", () => {
    assert.equal(isUrlAllowed("https://anything.example/x", []), true);
    assert.equal(isUrlAllowed("about:blank", []), true);
    assert.equal(isUrlAllowed("dangling", []), true);
  });

  it("fails closed when every entry normalizes to empty", () => {
    for (const list of [[""], ["."], ["*."], [" "]]) {
      assert.equal(isUrlAllowed("https://github.com", list), false, list.join());
    }
  });

  it("matches the host and subdomains on label boundaries", () => {
    const allowed = ["github.com"];
    assert.equal(isUrlAllowed("https://github.com/a", allowed), true);
    assert.equal(isUrlAllowed("https://api.github.com/a", allowed), true);
    assert.equal(isUrlAllowed("https://notgithub.com/a", allowed), false);
    assert.equal(isUrlAllowed("https://github.com.evil.com/a", allowed), false);
    assert.equal(isUrlAllowed("https://GitHub.com:443/a", allowed), true);
    assert.equal(isUrlAllowed("github.com/a", allowed), true);
  });

  it("normalizes wildcards, leading dots, whitespace and case", () => {
    assert.equal(isUrlAllowed("https://api.github.com", [" *.GitHub.com "]), true);
    assert.equal(isUrlAllowed("https://github.com", [".github.com"]), true);
    assert.equal(isUrlAllowed("https://github.com", ["github.com."]), true);
    assert.equal(isUrlAllowed("https://example.com", ["github.com"]), false);
  });

  it("blocks non-http(s) URLs once a list is set", () => {
    assert.equal(isUrlAllowed("about:blank", ["github.com"]), false);
    assert.equal(isUrlAllowed("file:///C:/x", ["github.com"]), false);
  });
});

describe("MUTATING_TOOLS", () => {
  it("contains the full mutation set", () => {
    const expected = [
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
      "zen_click",
      "zen_type",
      "zen_show_evidence",
      "zen_show_evidence_batch",
      "zen_clear_evidence",
      "zen_progress",
      "zen_ask",
      "zen_notify",
    ];
    assert.equal(MUTATING_TOOLS.size, expected.length);
    for (const tool of expected) {
      assert.equal(MUTATING_TOOLS.has(tool), true, tool);
    }
  });
});

describe("extractToolUrls", () => {
  it("reads urls from zen_tabs_open and url from zen_glance", () => {
    assert.deepEqual(
      extractToolUrls("zen_tabs_open", {
        urls: ["https://a.example", 7, "https://b.example"],
        space: "Work",
      }),
      ["https://a.example/", "https://b.example/"]
    );
    assert.deepEqual(extractToolUrls("zen_glance", { url: "https://c.example" }), [
      "https://c.example/",
    ]);
  });

  it("normalizes scheme-less URLs the same way the opener does", () => {
    assert.deepEqual(
      extractToolUrls("zen_show_evidence", {
        url: "example.com/article",
        quote: "text",
      }),
      ["https://example.com/article"]
    );
    assert.deepEqual(
      extractToolUrls("zen_show_evidence", { url: "http://example.com/a" }),
      ["http://example.com/a"]
    );
    assert.deepEqual(
      extractToolUrls("zen_tabs_open", { urls: ["github.com/a"] }),
      ["https://github.com/a"]
    );
    assert.deepEqual(extractToolUrls("zen_show_evidence", {}), []);
  });

  it("keeps unparseable input so the guard can reject it", () => {
    assert.deepEqual(
      extractToolUrls("zen_tabs_open", { urls: ["not a url", ""] }),
      ["not a url", ""]
    );
  });

  it("normalizes every batch citation URL for the allowlist", () => {
    assert.deepEqual(
      extractToolUrls("zen_show_evidence_batch", {
        citations: [
          { url: "example.com/a", quote: "one" },
          { url: "https://example.com/b", quote: "two" },
          { url: 7, quote: "ignored" },
          "not-an-object",
        ],
      }),
      ["https://example.com/a", "https://example.com/b"]
    );
    assert.deepEqual(extractToolUrls("zen_show_evidence_batch", {}), []);
  });

  it("returns every URL and ignores other tools", () => {
    const urls = Array.from({ length: 40 }, (_, index) => `https://e${index}.example`);
    assert.equal(extractToolUrls("zen_tabs_open", { urls }).length, 40);
    assert.deepEqual(extractToolUrls("zen_template_apply", { urls }), []);
    assert.deepEqual(extractToolUrls("zen_session_restore", { url: "https://x" }), []);
    assert.deepEqual(extractToolUrls("zen_tabs_open", undefined), []);
    assert.deepEqual(extractToolUrls("zen_status", { url: "https://x" }), []);
  });
});

describe("ToolGuard.check", () => {
  const tempDir = mkdtempSync(join(BASE_TMP, "zen-guard-check-"));

  after(() => rmSync(tempDir, { recursive: true, force: true }));

  it("blocks legacy read-only restrictions and names the tool", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ readOnly: true }),
        dataDir: tempDir,
      })
    );
    try {
      guard.check("zen_tabs_open", { urls: ["https://example.com"] });
      assert.fail("expected a restricted capability");
    } catch (error) {
      assert.equal(error instanceof ToolGuardError, true);
      const guardError = error as ToolGuardError;
      assert.equal(guardError.code, "restricted");
      assert.equal(guardError.capability, "nav.open");
      assert.match(guardError.message, /zen_tabs_open/);
      assert.match(guardError.message, /permanently restricted/);
    }
  });

  it("keeps reads, status and diagnostics available under legacy read-only", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ readOnly: true }),
        dataDir: tempDir,
      })
    );
    for (const tool of [
      "zen_status",
      "zen_tabs_list",
      "zen_read_page",
      "zen_history_search",
      "zen_bookmarks_search",
      "zen_containers_list",
      "zen_answers",
      "zen_events",
      "zen_audit_tail",
      "zen_watch_list",
    ]) {
      assert.doesNotThrow(() => guard.check(tool), tool);
    }
  });

  it("blocks on-screen cards and watch changes under legacy read-only", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ readOnly: true }),
        dataDir: tempDir,
      })
    );
    for (const tool of [
      "zen_progress",
      "zen_ask",
      "zen_notify",
      "zen_watch_add",
      "zen_watch_remove",
    ]) {
      assert.throws(
        () => guard.check(tool),
        (error: unknown) =>
          error instanceof ToolGuardError && error.code === "restricted",
        tool
      );
    }
  });

  it("allows every mapped tool in full mode", () => {
    const guard = new ToolGuard(options({ dataDir: tempDir }));
    assert.doesNotThrow(() =>
      guard.check("zen_tabs_close", { tabIds: ["1"] })
    );
    assert.doesNotThrow(() =>
      guard.check("zen_tabs_open", { urls: ["https://example.com"] })
    );
  });

  it("denies capabilities above the mode", () => {
    const guard = new ToolGuard(
      options({
        policy: fullPolicySnapshot({ mode: "normal" }),
        dataDir: tempDir,
      })
    );
    assert.throws(
      () => guard.check("zen_history_search", { query: "x" }),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "mode_denied"
    );
  });

  it("lets an explicit allow override the mode, but not a site rule", () => {
    const allowed = new ToolGuard(
      options({
        policy: fullPolicySnapshot({
          mode: "normal",
          capabilities: { "history.read": "allow" },
        }),
        dataDir: tempDir,
      })
    );
    assert.doesNotThrow(() =>
      allowed.check("zen_history_search", { query: "x" })
    );

    const siteBlocked = new ToolGuard(
      options({
        policy: fullPolicySnapshot({
          mode: "normal",
          capabilities: { "history.read": "allow" },
          websites: {
            default: "allow",
            allow: [],
            block: ["example.com"],
            rules: [],
          },
        }),
        dataDir: tempDir,
      })
    );
    assert.throws(
      () =>
        siteBlocked.check("zen_read_page", undefined, ["https://example.com"]),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "site_blocked"
    );
  });

  it("denies unknown tools instead of allowing them", () => {
    const guard = new ToolGuard(options({ dataDir: tempDir }));
    assert.throws(
      () => guard.check("zen_not_a_real_tool"),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "unknown_capability"
    );
  });

  it("denies browser tools when the policy is invalid", () => {
    const guard = new ToolGuard(
      options({
        policy: {
          ...fullPolicySnapshot(),
          source: "invalid",
          revision: 0,
          error: "The policy file is not valid JSON.",
        },
        dataDir: tempDir,
      })
    );
    assert.throws(
      () => guard.check("zen_status"),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "policy_invalid"
    );
    assert.doesNotThrow(() => guard.check("zen_config"));
    assert.doesNotThrow(() => guard.check("zen_audit_tail"));
  });

  it("rejects URLs outside the allowed website list", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: ["github.com"] }),
        dataDir: tempDir,
      })
    );
    assert.doesNotThrow(() =>
      guard.check("zen_tabs_open", { urls: ["https://api.github.com/x"] })
    );
    try {
      guard.check("zen_tabs_open", { urls: ["https://evil.com/x"] });
      assert.fail("expected a site rejection");
    } catch (error) {
      const guardError = error as ToolGuardError;
      assert.equal(guardError.code, "site_default_denied");
      assert.match(guardError.message, /evil\.com/);
      assert.match(guardError.message, /zen_tabs_open/);
      assert.doesNotMatch(guardError.message, /github\.com/);
    }
  });

  it("checks glance urls and explicit urls", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: ["example.com"] }),
        dataDir: tempDir,
      })
    );
    assert.throws(
      () => guard.check("zen_glance", { url: "https://evil.com" }),
      (error: unknown) =>
        error instanceof ToolGuardError &&
        error.code === "site_default_denied"
    );
    assert.throws(
      () => guard.check("zen_read_page", undefined, ["https://evil.com"]),
      (error: unknown) =>
        error instanceof ToolGuardError &&
        error.code === "site_default_denied"
    );
  });

  it("denies non-http(s) URLs, including internal pages", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: ["example.com"] }),
        dataDir: tempDir,
      })
    );
    assert.throws(
      () => guard.check("zen_glance", { url: "about:preferences" }),
      (error: unknown) => {
        const guardError = error as ToolGuardError;
        return (
          guardError.code === "internal_page" &&
          /internal browser pages/.test(guardError.message)
        );
      }
    );
    assert.throws(
      () => guard.check("zen_glance", { url: "file:///C:/secret" }),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "internal_page"
    );
  });

  it("allows about:blank only for navigation", () => {
    const guard = new ToolGuard(options({ dataDir: tempDir }));
    assert.doesNotThrow(() =>
      guard.check("zen_tabs_open", { urls: ["about:blank"] })
    );
    assert.throws(
      () => guard.check("zen_glance", { url: "about:blank" }),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "internal_page"
    );
  });

  it("rejects unparseable and empty URLs instead of skipping them", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: ["example.com"] }),
        dataDir: tempDir,
      })
    );
    for (const invalid of ["not a url", "", "   "]) {
      assert.throws(
        () => guard.check("zen_tabs_open", { urls: [invalid] }),
        (error: unknown) =>
          error instanceof ToolGuardError && error.code === "internal_page",
        invalid
      );
    }
  });

  it("checks every URL, not just the first 30", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: ["example.com"] }),
        dataDir: tempDir,
      })
    );
    const urls = Array.from(
      { length: 40 },
      (_, index) => `https://example.com/${index}`
    );
    urls[39] = "https://evil.com/last";
    assert.throws(
      () => guard.check("zen_tabs_open", { urls }),
      (error: unknown) =>
        error instanceof ToolGuardError &&
        error.code === "site_default_denied" &&
        /evil\.com/.test(error.message)
    );
  });

  it("allows scheme-less URLs on an allowed host", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: ["example.com"] }),
        dataDir: tempDir,
      })
    );
    assert.doesNotThrow(() =>
      guard.check("zen_tabs_open", { urls: ["example.com/scheme-less"] })
    );
  });

  it("fails closed when the allowlist has no usable entries", () => {
    const guard = new ToolGuard(
      options({
        policy: legacyPolicySnapshot({ allowedDomains: [""] }),
        dataDir: tempDir,
      })
    );
    assert.throws(
      () => guard.check("zen_tabs_open", { urls: ["https://example.com"] }),
      (error: unknown) =>
        error instanceof ToolGuardError &&
        error.code === "site_default_denied"
    );
  });

  it("requires a URL for navigation and evidence", () => {
    const guard = new ToolGuard(options({ dataDir: tempDir }));
    assert.throws(
      () => guard.check("zen_show_evidence", { quote: "x" }),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "unscoped_url"
    );
    assert.throws(
      () => guard.check("zen_tabs_open", { urls: [] }),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "unscoped_url"
    );
  });

  it("evaluates conditional window focus", () => {
    const guard = new ToolGuard(
      options({
        policy: snapshotOfPolicy(
          createPolicy({
            mode: "normal",
            now: new Date("2026-01-01T00:00:00.000Z"),
            restrictions: { "window.focus": "deny" },
          })
        ),
        dataDir: tempDir,
      })
    );
    assert.doesNotThrow(() =>
      guard.check("zen_tab_select", { tabId: "1" })
    );
    assert.throws(
      () => guard.check("zen_tab_select", { tabId: "1", focusWindow: true }),
      (error: unknown) =>
        error instanceof ToolGuardError && error.code === "restricted"
    );
  });
});

describe("ToolGuard.audit", () => {
  let tempDir = "";

  before(() => {
    tempDir = mkdtempSync(join(BASE_TMP, "zen-guard-audit-"));
  });

  after(() => rmSync(tempDir, { recursive: true, force: true }));

  it("resolves the audit path under the data directory", () => {
    const guard = new ToolGuard(options({ dataDir: join(tempDir, "nested") }));
    assert.equal(guard.auditPath, auditFilePath(join(tempDir, "nested")));
    assert.equal(guard.auditPath, join(tempDir, "nested", "audit.jsonl"));
  });

  it("returns an empty tail when the file does not exist", () => {
    const guard = new ToolGuard(options({ dataDir: join(tempDir, "missing") }));
    assert.deepEqual(guard.tail(), []);
  });

  it("appends JSON lines and tails them chronologically", () => {
    const dataDir = join(tempDir, "write");
    const guard = new ToolGuard(options({ dataDir }));
    guard.audit(record({ at: "2026-01-01T00:00:00.000Z", tool: "zen_status" }));
    guard.audit(
      record({
        at: "2026-01-01T00:00:01.000Z",
        tool: "zen_tabs_open",
        urls: ["https://example.com"],
      })
    );
    const raw = readFileSync(guard.auditPath, "utf8").trim().split("\n");
    assert.equal(raw.length, 2);
    assert.equal(JSON.parse(raw[0] as string).tool, "zen_status");

    const tail = guard.tail(1);
    assert.equal(tail.length, 1);
    assert.equal(tail[0]?.tool, "zen_tabs_open");
    assert.deepEqual(tail[0]?.urls, ["https://example.com"]);

    const all = guard.tail();
    assert.deepEqual(
      all.map((entry) => entry.at),
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z"]
    );
    assert.equal(guard.tail(0).length, 0);
  });

  it("keeps concurrent process writes as complete JSON lines", async () => {
    const dataDir = join(tempDir, "concurrent");
    const guardUrl = pathToFileURL(
      join(process.cwd(), "src", "mcp", "guard.ts")
    ).href;
    const policyUrl = pathToFileURL(
      join(process.cwd(), "src", "shared", "policy.ts")
    ).href;
    const source =
      `const { ToolGuard } = await import(${JSON.stringify(guardUrl)});\n` +
      `const { createPolicy } = await import(${JSON.stringify(policyUrl)});\n` +
      "const policy = createPolicy({ mode: 'full' });\n" +
      "const guard = new ToolGuard({ policy: { policy, source: 'file', revision: 1, digest: 'test', updatedAt: policy.updatedAt, warnings: [] }, auditLog: true, dataDir: process.env.TEST_AUDIT_DIR });\n" +
      "for (let i = 0; i < 50; i++) guard.audit({ at: new Date().toISOString(), tool: process.env.TEST_WRITER, ok: true, executed: true, durationMs: 1 });\n";
    const write = (writer: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", source],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              TEST_AUDIT_DIR: dataDir,
              TEST_WRITER: writer,
            },
            stdio: "ignore",
          }
        );
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))
        );
      });

    await Promise.all([write("writer-a"), write("writer-b"), write("writer-c")]);
    const lines = readFileSync(auditFilePath(dataDir), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 150);
    for (const line of lines) {
      assert.equal(typeof (JSON.parse(line) as AuditRecord).tool, "string");
    }
  });

  it("skips corrupt lines in the tail", () => {
    const dataDir = join(tempDir, "corrupt");
    mkdirSync(dataDir, { recursive: true });
    const path = auditFilePath(dataDir);
    writeFileSync(
      path,
      `${JSON.stringify(record({ at: "2026-01-01T00:00:00.000Z" }))}\n` +
        "not json\n" +
        `${JSON.stringify(record({ at: "2026-01-01T00:00:02.000Z" }))}\n`,
      "utf8"
    );
    const guard = new ToolGuard(options({ dataDir }));
    assert.deepEqual(
      guard.tail(5).map((entry) => entry.at),
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:02.000Z"]
    );
  });

  it("truncates long strings, arrays and deep objects", () => {
    const dataDir = join(tempDir, "truncate");
    const guard = new ToolGuard(options({ dataDir }));
    guard.audit(
      record({
        args: {
          text: "x".repeat(1200),
          body: "y".repeat(1200),
          list: Array.from({ length: 25 }, (_, index) => index),
          nested: { a: { b: { c: { d: 1 } } } },
        },
      })
    );
    const line = readFileSync(guard.auditPath, "utf8").trim();
    const parsed = JSON.parse(line) as AuditRecord & {
      args: {
        text: string;
        body: string;
        list: unknown[];
        nested: { a: { b: unknown } };
      };
    };
    assert.match(
      parsed.args.text,
      /^<redacted 1200 chars sha256:[a-f0-9]{12}>$/
    );
    assert.match(parsed.args.body, /^sha256:[a-f0-9]{12} \(1200 chars\)$/);
    assert.equal(parsed.args.list.length, 21);
    assert.equal(parsed.args.list[20], "<5 more>");
    assert.equal(parsed.args.nested.a.b, "[max depth]");
  });

  it("redacts sensitive arguments and URL secrets", () => {
    const dataDir = join(tempDir, "redact");
    const guard = new ToolGuard(options({ dataDir }));
    guard.audit(
      record({
        tool: "zen_show_evidence",
        args: {
          url: "https://user:pass@example.com/private?token=secret#frag",
          urlContains: "https://user:pass@example.com/private?token=secret#frag",
          quote: "A private quotation",
          context: "Private context",
        },
        urls: [
          "https://user:pass@example.com/private?token=secret#frag",
        ],
      })
    );
    const line = readFileSync(guard.auditPath, "utf8");
    const parsed = JSON.parse(line.trim()) as AuditRecord & {
      args: { url: string; urlContains: string; quote: string; context: string };
    };
    assert.equal(parsed.args.url, "https://example.com/private");
    assert.equal(parsed.args.urlContains, "https://example.com/private");
    assert.match(
      parsed.args.quote,
      /^<redacted \d+ chars sha256:[a-f0-9]{12}>$/
    );
    assert.match(
      parsed.args.context,
      /^<redacted \d+ chars sha256:[a-f0-9]{12}>$/
    );
    assert.deepEqual(parsed.urls, ["https://example.com/private"]);
    assert.doesNotMatch(line, /token=secret|user:pass|private\?/);
  });

  it("redacts URL secrets inside error messages", () => {
    const dataDir = join(tempDir, "redact-error");
    const guard = new ToolGuard(options({ dataDir }));
    guard.audit(
      record({
        ok: false,
        error: {
          code: "domain_not_allowed",
          message:
            'Blocked "https://user:pass@evil.example/x?token=abc" by policy.',
        },
      })
    );
    const parsed = JSON.parse(
      readFileSync(guard.auditPath, "utf8").trim()
    ) as AuditRecord;
    assert.equal(
      parsed.error?.message,
      'Blocked "https://evil.example/x" by policy.'
    );
  });

  it("reads only the tail of a large log", () => {
    const dataDir = join(tempDir, "tail-window");
    mkdirSync(dataDir, { recursive: true });
    const records = Array.from({ length: 60_000 }, (_, index) =>
      JSON.stringify(
        record({
          at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
          tool: `tool-${index}`,
        })
      )
    );
    writeFileSync(
      auditFilePath(dataDir),
      `${records.join("\n")}\n`,
      "utf8"
    );
    const guard = new ToolGuard(options({ dataDir }));
    assert.deepEqual(
      guard.tail(5).map((entry) => entry.tool),
      ["tool-59995", "tool-59996", "tool-59997", "tool-59998", "tool-59999"]
    );
  });

  it("rotates the log into one backup before it grows past the cap", () => {
    const dataDir = join(tempDir, "rotate");
    mkdirSync(dataDir, { recursive: true });
    const filler = `${JSON.stringify(record({ tool: "old" }))}\n`.repeat(
      90_000
    );
    writeFileSync(auditFilePath(dataDir), filler, "utf8");
    const guard = new ToolGuard(options({ dataDir }));
    guard.audit(record({ tool: "zen_status" }));

    assert.equal(existsSync(`${guard.auditPath}.1`), true);
    const current = readFileSync(guard.auditPath, "utf8").trim();
    assert.equal(JSON.parse(current).tool, "zen_status");
  });

  it(
    "creates the log with owner-only permissions",
    { skip: process.platform === "win32" },
    () => {
      const dataDir = join(tempDir, "permissions", "nested");
      const guard = new ToolGuard(options({ dataDir }));
      guard.audit(record());
      assert.equal(statSync(guard.auditPath).mode & 0o777, 0o600);
      assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    }
  );

  it("caps the serialized argument payload at 2 KB", () => {
    const dataDir = join(tempDir, "cap");
    const guard = new ToolGuard(options({ dataDir }));
    guard.audit(
      record({
        args: {
          chunks: Array.from({ length: 20 }, () => "y".repeat(500)),
        },
      })
    );
    const parsed = JSON.parse(
      readFileSync(guard.auditPath, "utf8").trim()
    ) as AuditRecord & { args: { truncated?: boolean; size?: number } };
    assert.equal(parsed.args.truncated, true);
    assert.equal(typeof parsed.args.size, "number");
    assert.ok(JSON.stringify(parsed.args).length <= 2048);
  });

  it("does not write when audit logging is disabled", () => {
    const dataDir = join(tempDir, "disabled");
    const guard = new ToolGuard(options({ dataDir, auditLog: false }));
    guard.audit(record());
    assert.equal(existsSync(guard.auditPath), false);
    assert.deepEqual(guard.tail(), []);
  });

  it(
    "refuses a symlinked audit log and does not append to its target",
    { skip: process.platform === "win32" ? "symlink privileges vary" : false },
    () => {
      const dataDir = join(tempDir, "audit-link");
      mkdirSync(dataDir, { recursive: true });
      const target = join(dataDir, "outside.jsonl");
      const path = auditFilePath(dataDir);
      writeFileSync(target, "outside\n", "utf8");
      symlinkSync(target, path);
      const guard = new ToolGuard(options({ dataDir }));

      const original = console.error;
      console.error = () => undefined;
      try {
        assert.equal(guard.audit(record()), false);
      } finally {
        console.error = original;
      }
      assert.equal(readFileSync(target, "utf8"), "outside\n");
      assert.deepEqual(guard.tail(), []);
    }
  );

  it("warns to stderr at most once when writing fails", () => {
    const blocker = join(tempDir, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    const guard = new ToolGuard(
      options({ dataDir: join(blocker, "data"), auditLog: true })
    );
    const original = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      assert.equal(guard.audit(record()), false);
      assert.equal(guard.audit(record()), false);
    } finally {
      console.error = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /audit log/);

    // A stray append must not have created a file behind the blocker.
    assert.equal(existsSync(guard.auditPath), false);
  });
});

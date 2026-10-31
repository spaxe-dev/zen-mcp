import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  terminateZenProcess,
  waitForProcessExit,
} from "../../src/zen/launcher.js";
import {
  e2eEnabled,
  removeTestProfile,
  startPageServer,
  testProfilePath,
  testServerEnv,
  type PageServer,
} from "./helpers.js";

const EXPECTED_TOOLS = [
  "zen_answers",
  "zen_ask",
  "zen_audit_tail",
  "zen_bookmarks_search",
  "zen_clear_evidence",
  "zen_clipboard_write",
  "zen_config",
  "zen_containers_list",
  "zen_essentials",
  "zen_events",
  "zen_find_text",
  "zen_folder_add_tabs",
  "zen_folder_create",
  "zen_folders_list",
  "zen_glance",
  "zen_history_recently_closed",
  "zen_history_search",
  "zen_launch",
  "zen_notify",
  "zen_pin_tabs",
  "zen_progress",
  "zen_read_page",
  "zen_read_pages",
  "zen_search_tabs",
  "zen_session_delete",
  "zen_session_list",
  "zen_session_restore",
  "zen_session_save",
  "zen_show_evidence",
  "zen_show_evidence_batch",
  "zen_space_create",
  "zen_space_delete",
  "zen_space_switch",
  "zen_space_templates",
  "zen_spaces_list",
  "zen_split_close",
  "zen_split_view",
  "zen_status",
  "zen_tab_select",
  "zen_tabs_audit",
  "zen_tabs_close",
  "zen_tabs_group",
  "zen_tabs_list",
  "zen_tabs_open",
  "zen_template_apply",
  "zen_template_delete",
  "zen_template_save",
  "zen_watch_add",
  "zen_watch_list",
  "zen_watch_remove",
];

const MARKER = "mcp-marker-7";
const EVIDENCE_QUOTE = "The lighthouse keeper checked the lamp at dawn.";
const REPEATED_QUOTE = "The shared lighthouse sentence appears in two places.";
const SCROLL_FILLER = "Spacer text for evidence scrolling. ".repeat(60);

/**
 * The tick is updated in-page every second, so a change watch always sees new
 * text without reloading the tab.
 */
const PAGE = (): string => `<!doctype html><html><head><title>MCP Test Page</title>
<meta name="description" content="Page used by the Zen MCP test.">
</head><body><main>
<h1>MCP heading</h1>
<p>Agent harness end to end. ${MARKER}</p>
<h2>Second heading</h2>
<ul><li>alpha</li><li>beta</li></ul>
<table><caption>Sample table</caption>
<thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>one</td><td>1</td></tr></tbody></table>
<p><a href="https://example.com/one">Example One</a>
<a href="/relative">Relative</a></p>
<section id="scope"><p>SCOPED TEXT</p></section>
<section id="alpha"><h2>Alpha context</h2><p>${REPEATED_QUOTE}</p></section>
<div style="height: 2400px">${SCROLL_FILLER}</div>
<section id="omega"><h2>Omega context</h2><p>${REPEATED_QUOTE}</p></section>
<p id="evidence-target">${EVIDENCE_QUOTE}</p>
<p id="page-owned-mark" data-zen-mcp-evidence="mark">Page-owned lookalike marker.</p>
<div class="tick">tick 0</div>
<script>
let ticks = 0;
setInterval(() => {
  ticks += 1;
  const node = document.querySelector(".tick");
  if (node) node.textContent = "tick " + ticks;
}, 1000);
</script>
</main></body></html>`;

describe(
  "Zen MCP server",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let client: Client | null = null;
    let page: PageServer;
    let spaceId = "";
    let tabId = "";
    let secondTabId = "";

    const call = async (
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<any> => {
      const result = await client!.callTool({ name, arguments: args }, undefined, {
        timeout: 60_000,
      });
      const text =
        (result as any).content?.find((part: any) => part.type === "text")?.text ??
        "";
      if (result.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text);
    };

    before(async () => {
      page = await startPageServer(PAGE);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "dist", "cli.js"), "serve"],
        env: testServerEnv(),
        stderr: "inherit",
      });
      client = new Client({ name: "zen-mcp-test", version: "0.0.0" });
      await client.connect(transport);
    });

    after(async () => {
      if (spaceId && client) {
        try {
          await call("zen_space_delete", { space: spaceId });
        } catch {
          // Best effort.
        }
      }

      // The server owns the browser: closing the transport makes it quit Zen.
      let browserPid: number | null = null;
      if (client) {
        try {
          const config = await call("zen_config");
          browserPid = config.session?.browserPid ?? null;
        } catch {
          // The server may already have stopped.
        }
      }
      await client?.close().catch(() => undefined);
      if (!(await waitForProcessExit(browserPid, 20_000))) {
        terminateZenProcess(browserPid ?? undefined);
      }
      await page?.close();
      removeTestProfile(testProfilePath());
    });

    it("exposes the full tool surface", async () => {
      const tools = await client!.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, EXPECTED_TOOLS);
      const statusTool = tools.tools.find((tool) => tool.name === "zen_status");
      assert.ok(statusTool?.description?.includes("space"));
    });

    it("reports status and creates a background space", async () => {
      const status = await call("zen_status");
      assert.equal(status.appName, "Zen");
      assert.ok(status.bridge.connections >= 1);

      const created = await call("zen_space_create", {
        name: "MCP Test Space",
        icon: "🧪",
      });
      spaceId = created.space.id;
      assert.equal(created.created, true);
      assert.equal(created.switched, false);
    });

    it("opens a background tab and reads it without switching", async () => {
      const before = await call("zen_status");
      const opened = await call("zen_tabs_open", {
        urls: [page.url],
        space: spaceId,
      });
      assert.equal(opened.tabs.length, 1);
      tabId = opened.tabs[0].id;
      assert.equal(opened.tabs[0].spaceId, spaceId);
      assert.equal(opened.tabs[0].active, false);

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const read = await call("zen_read_page", { tabId });
      assert.equal(read.title, "MCP Test Page");
      assert.match(read.text, new RegExp(MARKER));
      assert.equal(read.description, "Page used by the Zen MCP test.");

      const after = await call("zen_status");
      assert.equal(after.activeSpaceId, before.activeSpaceId);
      assert.equal(after.activeTab?.id ?? null, before.activeTab?.id ?? null);
    });

    it("lists tabs, groups them in a folder, and reports counts", async () => {
      const listed = await call("zen_tabs_list", { space: spaceId });
      assert.equal(listed.tabs.length, 1);
      assert.equal(listed.tabs[0].id, tabId);

      const folder = await call("zen_folder_create", {
        label: "MCP Folder",
        tabIds: [tabId],
        space: spaceId,
      });
      assert.equal(folder.created, true);
      assert.ok(folder.folder.tabIds.includes(tabId));

      const folders = await call("zen_folders_list");
      assert.ok(folders.folders.some((entry: any) => entry.id === folder.folder.id));

      const spaces = await call("zen_spaces_list");
      const space = spaces.spaces.find((entry: any) => entry.id === spaceId);
      assert.ok(space);
      assert.ok(space.tabCount >= 1);
      assert.ok(space.folderCount >= 1);
    });

    it("reads markdown, links, tables, metadata, outline and a scoped element", async () => {
      const markdown = await call("zen_read_page", { tabId, format: "markdown" });
      assert.equal(markdown.format, "markdown");
      assert.match(markdown.markdown, /MCP heading/);
      assert.match(markdown.markdown, /alpha/);

      const links = await call("zen_read_page", { tabId, format: "links" });
      assert.equal(links.format, "links");
      assert.ok(
        links.links.some((entry: any) => entry.url === "https://example.com/one")
      );

      const tables = await call("zen_read_page", { tabId, format: "tables" });
      assert.equal(tables.format, "tables");
      assert.deepEqual(tables.tables[0].headers, ["Name", "Value"]);
      assert.deepEqual(tables.tables[0].rows[0], ["one", "1"]);

      const metadata = await call("zen_read_page", { tabId, format: "metadata" });
      assert.equal(metadata.metadata.title, "MCP Test Page");
      assert.equal(metadata.metadata.description, "Page used by the Zen MCP test.");

      const outline = await call("zen_read_page", { tabId, format: "outline" });
      assert.ok(
        outline.outline.some(
          (heading: any) => heading.level === 1 && heading.text === "MCP heading"
        )
      );

      const scoped = await call("zen_read_page", { tabId, selector: "#scope" });
      assert.match(scoped.text, /SCOPED TEXT/);
      assert.doesNotMatch(scoped.text, new RegExp(MARKER));
      assert.equal(scoped.selector, "#scope");
    });

    it("batch-reads several tabs and reports per-tab errors", async () => {
      const opened = await call("zen_tabs_open", {
        urls: [`${page.url}?batch=2`],
        space: spaceId,
      });
      secondTabId = opened.tabs[0].id;

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const batch = await call("zen_read_pages", {
        tabIds: [tabId, secondTabId, "missing-tab-id"],
      });
      assert.equal(batch.pages.length, 3);
      assert.equal(batch.pages[0].ok, true);
      assert.equal(batch.pages[0].page.title, "MCP Test Page");
      assert.equal(batch.pages[1].ok, true);
      assert.equal(batch.pages[2].ok, false);
      assert.match(batch.pages[2].error, /tab|match/i);
    });

    it("pins tabs, lists containers and writes the clipboard", async () => {
      const listed = await call("zen_tabs_list", { space: spaceId });
      const second = listed.tabs.find((tab: any) => tab.id === secondTabId);
      assert.ok(second);
      assert.ok("containerId" in second);
      assert.ok("lastAccessed" in second);
      assert.ok("splitView" in second);

      const pinned = await call("zen_pin_tabs", {
        tabIds: [secondTabId],
        pinned: true,
      });
      assert.equal(pinned.changed, 1);
      const afterPin = await call("zen_tabs_list", { space: spaceId });
      assert.equal(
        afterPin.tabs.find((tab: any) => tab.id === secondTabId).pinned,
        true
      );
      const unpinned = await call("zen_pin_tabs", {
        tabIds: [secondTabId],
        pinned: false,
      });
      assert.equal(unpinned.changed, 1);

      const containers = await call("zen_containers_list");
      assert.ok(Array.isArray(containers.containers));

      const clip = await call("zen_clipboard_write", {
        text: "zen-mcp clipboard check",
      });
      assert.equal(clip.written, true);
      assert.equal(clip.length, 23);
    });

    it("adds a tab to essentials and removes it", async () => {
      const opened = await call("zen_tabs_open", {
        urls: [`${page.url}?essential=1`],
        space: spaceId,
      });
      const essentialTabId = opened.tabs[0].id;

      const added = await call("zen_essentials", {
        action: "add",
        tabIds: [essentialTabId],
      });
      assert.equal(added.changed, 1);

      const listed = await call("zen_tabs_list", {});
      const essential = listed.tabs.find((tab: any) => tab.id === essentialTabId);
      assert.ok(essential);
      assert.equal(essential.essential, true);

      const removed = await call("zen_essentials", {
        action: "remove",
        tabIds: [essentialTabId],
      });
      assert.equal(removed.changed, 1);

      await call("zen_tabs_close", { tabIds: [essentialTabId] });
    });

    it("shows progress, clears it, exposes events, resources and prompts", async () => {
      const started = await call("zen_progress", {
        title: "MCP progress test",
        step: "Stage 1 of 2",
        progress: 0.4,
        stoppable: true,
      });
      assert.equal(started.delivered, true);
      assert.ok(started.progress.id);
      assert.equal(started.progress.step, "Stage 1 of 2");

      const cleared = await call("zen_progress", { done: true });
      assert.equal(cleared.progress.id, started.progress.id);

      const events = await call("zen_events", { waitSeconds: 0 });
      assert.ok(Array.isArray(events.events));
      assert.equal(typeof events.cursor, "number");

      const resources = await client!.listResources();
      const uris = resources.resources.map((resource) => resource.uri);
      for (const uri of [
        "zen://status",
        "zen://spaces",
        "zen://tabs",
        "zen://questions",
        "zen://watches",
      ]) {
        assert.ok(uris.includes(uri), `missing resource ${uri}`);
      }
      const statusResource = await client!.readResource({ uri: "zen://status" });
      assert.match(String((statusResource.contents[0] as any).text), /Zen/);

      const prompts = await client!.listPrompts();
      assert.deepEqual(
        prompts.prompts.map((prompt) => prompt.name).sort(),
        ["zen_clean_tabs", "zen_github_triage", "zen_research_brief"]
      );
      const prompt = await client!.getPrompt({
        name: "zen_research_brief",
        arguments: { topic: "MCP e2e" },
      });
      assert.equal(prompt.messages.length, 1);
      assert.equal(prompt.messages[0].role, "user");

      const audit = await call("zen_audit_tail", { limit: 10 });
      assert.ok(audit.entries.length > 0);
      assert.ok(
        audit.entries.some((entry: any) => entry.tool === "zen_progress")
      );
    });

    it("shows evidence with structured results and clears the marks", async () => {
      const before = await call("zen_status");
      const shown = await call("zen_show_evidence", {
        url: page.url,
        quote: EVIDENCE_QUOTE,
        claim: "The keeper checked the lamp at dawn",
        source_title: "MCP Test Page",
        highlight_ms: 60_000,
      });
      assert.equal(shown.ok, true, JSON.stringify(shown.error));
      assert.equal(shown.tabId, tabId);
      assert.equal(shown.tabReused, true);
      assert.equal(shown.focused, false);
      assert.equal(shown.sourceUrl, page.url);
      assert.equal(shown.title, "MCP Test Page");
      assert.equal(shown.matchMethod, "exact");
      assert.equal(shown.confidence, 1);
      assert.equal(shown.occurrences, 1);
      assert.equal(shown.scrolled, true);
      assert.equal(shown.highlighted, true);
      assert.equal(shown.verified, true);
      assert.equal(shown.limitation, undefined);

      const status = await call("zen_status");
      assert.equal(
        status.activeTab?.id ?? null,
        before.activeTab?.id ?? null,
        "verification stays in the background"
      );

      const focused = await call("zen_show_evidence", {
        url: page.url,
        quote: EVIDENCE_QUOTE,
        focus: true,
        highlight_ms: 60_000,
      });
      assert.equal(focused.ok, true, JSON.stringify(focused.error));
      assert.equal(focused.focused, true);
      const focusedStatus = await call("zen_status");
      assert.equal(
        focusedStatus.activeTab?.id,
        tabId,
        "focus brings the source forward"
      );

      // A page can own a node carrying the old fixed attribute. The overlay
      // must ignore it, and clearing must leave page-owned nodes alone.
      const pageOwned = await call("zen_read_page", {
        tabId,
        selector: '[data-zen-mcp-evidence="mark"]',
      });
      assert.match(pageOwned.text, /Page-owned lookalike marker/);

      const ambiguous = await call("zen_show_evidence", {
        url: page.url,
        quote: REPEATED_QUOTE,
        highlight_ms: 60_000,
      });
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.error.code, "AMBIGUOUS_MATCH");
      assert.equal(ambiguous.highlighted ?? false, false);

      const contextual = await call("zen_show_evidence", {
        url: page.url,
        quote: REPEATED_QUOTE,
        context: "Omega context",
        highlight_ms: 60_000,
      });
      assert.equal(contextual.ok, true, JSON.stringify(contextual.error));
      assert.equal(contextual.matchMethod, "context");
      assert.equal(contextual.occurrences, 2);

      const missing = await call("zen_show_evidence", {
        url: page.url,
        quote: "A sentence that is definitely not in the test page.",
        highlight_ms: 60_000,
      });
      assert.equal(missing.ok, false);
      assert.equal(missing.error.code, "QUOTE_NOT_FOUND");
      assert.equal(missing.highlighted ?? false, false);

      const cleared = await call("zen_clear_evidence", { tab_id: tabId });
      assert.equal(cleared.cleared, true);
      assert.ok(cleared.removed >= 1);

      const again = await call("zen_clear_evidence", { tab_id: tabId });
      assert.equal(again.cleared, false);
      assert.equal(again.removed, 0);

      const survivor = await call("zen_read_page", {
        tabId,
        selector: '[data-zen-mcp-evidence="mark"]',
      });
      assert.match(survivor.text, /Page-owned lookalike marker/);
    });

    it("finds literal text in one tab without changing focus", async () => {
      const before = await call("zen_status");
      const found = await call("zen_find_text", {
        tabId,
        query: "lighthouse KEEPER",
        context_chars: 40,
      });
      assert.equal(found.ok, true, JSON.stringify(found.error));
      assert.equal(found.tabId, tabId);
      assert.equal(found.url, page.url);
      assert.equal(found.title, "MCP Test Page");
      assert.equal(found.totalMatches, 1);
      assert.equal(found.truncated, false);
      const match = found.matches[0];
      assert.equal(match.text, "lighthouse keeper");
      assert.ok(match.start >= 0 && match.end > match.start);
      assert.match(match.excerpt, /lighthouse keeper/);

      const exact = await call("zen_find_text", {
        tabId,
        query: "lighthouse KEEPER",
        case_sensitive: true,
      });
      assert.equal(exact.totalMatches, 0);

      const missing = await call("zen_find_text", {
        tabId: "missing-tab-id",
        query: "lighthouse",
      });
      assert.equal(missing.ok, false);
      assert.equal(missing.error.code, "PAGE_NOT_FOUND");

      const after = await call("zen_status");
      assert.equal(
        after.activeTab?.id ?? null,
        before.activeTab?.id ?? null,
        "search never changes focus"
      );
    });

    it("searches several tabs and reports per-tab results", async () => {
      const found = await call("zen_search_tabs", {
        query: "shared lighthouse sentence",
        space: spaceId,
        max_matches_per_tab: 2,
      });
      assert.equal(found.tabsSearched, 2);
      assert.equal(found.tabsMatched, 2);
      assert.equal(found.totalMatches, 4);
      assert.equal(found.skipped, 0);
      assert.equal(found.truncated, false);
      assert.equal(found.results.length, 2);
      for (const entry of found.results) {
        assert.equal(entry.ok, true, JSON.stringify(entry.error));
        assert.equal(entry.matches.length, 2);
        assert.equal(entry.totalMatches, 2);
        assert.ok(entry.tabId === tabId || entry.tabId === secondTabId);
      }

      const narrowed = await call("zen_search_tabs", {
        query: "lighthouse",
        tab_ids: [tabId, "missing-tab-id"],
      });
      assert.equal(narrowed.tabsSearched, 1, "missing ids are not searched");
      assert.equal(narrowed.results.length, 2);
      const missing = narrowed.results.find(
        (entry: any) => entry.tabId === "missing-tab-id"
      );
      assert.equal(missing.ok, false);
      assert.equal(missing.error.code, "PAGE_NOT_FOUND");
      const present = narrowed.results.find((entry: any) => entry.tabId === tabId);
      assert.equal(present.ok, true);
      assert.ok(present.totalMatches >= 2);
    });

    it("verifies a batch of citations with per-citation results", async () => {
      const newSource = `${page.url}?batch=3`;
      const before = await call("zen_status");
      const batch = await call("zen_show_evidence_batch", {
        citations: [
          {
            url: page.url,
            quote: EVIDENCE_QUOTE,
            claim: "Batch exact match",
            source_title: "MCP Test Page",
          },
          {
            url: page.url,
            quote: REPEATED_QUOTE,
            context: "Omega context",
            claim: "Batch context match",
          },
          {
            url: newSource,
            quote: EVIDENCE_QUOTE,
            claim: "Batch opened source",
          },
          {
            url: page.url,
            quote: "A sentence that is definitely not in the test page.",
            claim: "Batch missing quote",
          },
        ],
        highlight_ms: 60_000,
      });
      assert.equal(batch.total, 4);
      assert.equal(batch.matched, 3);
      assert.equal(batch.failed, 1);
      assert.equal(batch.ok, false);
      assert.equal(batch.focused, false);
      assert.equal(batch.reusedTabs, 1);
      assert.equal(batch.openedTabs, 1);
      assert.equal(batch.results.length, 4);
      assert.equal(batch.results[0].ok, true);
      assert.equal(batch.results[0].tabId, tabId);
      assert.equal(batch.results[0].tabReused, true);
      assert.equal(batch.results[0].matchMethod, "exact");
      assert.equal(batch.results[0].claim, "Batch exact match");
      assert.equal(batch.results[1].ok, true);
      assert.equal(batch.results[1].matchMethod, "context");
      assert.equal(batch.results[2].ok, true);
      assert.equal(batch.results[2].tabReused, false);
      assert.notEqual(batch.results[2].tabId, tabId);
      assert.equal(batch.results[3].ok, false);
      assert.equal(batch.results[3].error.code, "QUOTE_NOT_FOUND");

      const after = await call("zen_status");
      assert.equal(
        after.activeTab?.id ?? null,
        before.activeTab?.id ?? null,
        "batch verification stays in the background"
      );

      const cleared = await call("zen_clear_evidence", {});
      assert.equal(cleared.cleared, true);
    });

    it("watches a changing page and reports a watch event", async () => {
      const watch = await call("zen_watch_add", {
        tabId,
        intervalSeconds: 5,
        maxMinutes: 5,
        notify: false,
        label: "MCP watch",
      });
      assert.ok(watch.id);
      assert.equal(watch.mode, "change");
      assert.equal(watch.intervalSeconds, 5);

      const hit = await call("zen_events", { waitSeconds: 25 });
      assert.ok(
        hit.events.some(
          (event: any) => event.kind === "watch" && event.watchId === watch.id
        ),
        `no watch event in ${JSON.stringify(hit.events)}`
      );

      const watches = await call("zen_watch_list");
      assert.ok(watches.watches.some((entry: any) => entry.id === watch.id));
      const removed = await call("zen_watch_remove", { watchId: watch.id });
      assert.equal(removed.removed, true);
    });

    it("saves, restores and deletes a session snapshot", async () => {
      const saved = await call("zen_session_save", { name: "mcp-e2e-session" });
      assert.ok(saved.spaces >= 1);
      assert.ok(saved.tabs >= 2);

      const list = await call("zen_session_list");
      assert.ok(
        list.sessions.some((entry: any) => entry.name === "mcp-e2e-session")
      );

      const restored = await call("zen_session_restore", {
        name: "mcp-e2e-session",
        newSpaces: true,
      });
      assert.ok(restored.tabsOpened >= 2);

      const spaces = await call("zen_spaces_list");
      const restoredSpace = spaces.spaces.find((entry: any) =>
        entry.name.startsWith("MCP Test Space (restored")
      );
      assert.ok(restoredSpace);
      await call("zen_space_delete", { space: restoredSpace.id });

      const deleted = await call("zen_session_delete", {
        name: "mcp-e2e-session",
      });
      assert.equal(deleted.deleted, true);
      const after = await call("zen_session_list");
      assert.ok(
        !after.sessions.some((entry: any) => entry.name === "mcp-e2e-session")
      );
    });

    it("saves a space as a template, applies it and deletes it", async () => {
      const builtins = await call("zen_space_templates");
      assert.ok(
        builtins.templates.some((entry: any) => entry.name === "research")
      );

      const saved = await call("zen_template_save", {
        space: spaceId,
        name: "mcp-e2e-template",
        description: "End-to-end template",
      });
      assert.equal(saved.builtIn, false);

      const detail = await call("zen_space_templates", {
        name: "mcp-e2e-template",
      });
      assert.equal(detail.template.description, "End-to-end template");
      assert.ok(detail.template.folders.length >= 1);

      const applied = await call("zen_template_apply", {
        template: "mcp-e2e-template",
      });
      assert.ok(applied.tabsOpened >= 1);
      assert.ok(applied.space.id);
      await call("zen_space_delete", { space: applied.space.id });

      const deleted = await call("zen_template_delete", {
        name: "mcp-e2e-template",
      });
      assert.equal(deleted.deleted, true);
    });

    it("reports a recently closed tab", async () => {
      const closed = await call("zen_tabs_close", { tabIds: [secondTabId] });
      assert.equal(closed.closed, 1);
      const recent = await call("zen_history_recently_closed");
      assert.ok(
        recent.entries.some((entry: any) => entry.url.includes("batch=2")),
        `recently closed did not include the test tab: ${JSON.stringify(recent.entries)}`
      );
      secondTabId = "";
    });

    it("notifies and records an in-browser question", async () => {
      const notified = await call("zen_notify", {
        title: "MCP test finished",
        detail: "The test space is ready.",
        tone: "success",
        space: spaceId,
        autoHideMs: 60_000,
      });
      assert.equal(notified.delivered, true);

      const asked = await call("zen_ask", {
        question: "Keep this test space?",
        options: [{ label: "Yes" }, { label: "No" }],
        context: "MCP test",
        waitSeconds: 0,
      });
      assert.equal(asked.status, "pending");

      const answers = await call("zen_answers");
      assert.ok(
        answers.pending.some(
          (entry: any) => entry.question.id === asked.questionId
        )
      );
    });

    it("deletes the space and its tabs", async () => {
      const deleted = await call("zen_space_delete", { space: spaceId });
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.spaceId, spaceId);
      spaceId = "";

      const spaces = await call("zen_spaces_list");
      assert.ok(!spaces.spaces.some((space: any) => space.id === deleted.spaceId));

      const tabs = await call("zen_tabs_list", { query: page.url });
      assert.equal(tabs.total, 0);
    });
  }
);

function textOf(result: any): string {
  return (
    result?.content?.find((part: any) => part.type === "text")?.text ?? ""
  );
}

function policyEnv(
  dir: string,
  overrides: Record<string, string>
): Record<string, string> {
  writeFileSync(
    join(dir, "config.json"),
    `${JSON.stringify({ autoLaunch: false, auditLog: true })}\n`,
    "utf8"
  );
  return {
    ...(process.env as Record<string, string>),
    ZEN_MCP_CONFIG: join(dir, "config.json"),
    ZEN_MCP_DATA_DIR: dir,
    ZEN_MCP_AUDIT_LOG: "1",
    ...overrides,
  };
}

async function connectPolicyServer(
  env: Record<string, string>,
  name: string
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist", "cli.js"), "serve"],
    env,
    stderr: "inherit",
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function policyDir(prefix: string): string {
  const base = process.platform === "win32" ? "D:\\tmp" : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

describe(
  "Zen MCP policy",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let readOnlyClient: Client | null = null;
    let allowlistClient: Client | null = null;
    let readOnlyDir = "";
    let allowlistDir = "";

    before(async () => {
      readOnlyDir = policyDir("zen-mcp-readonly-");
      readOnlyClient = await connectPolicyServer(
        policyEnv(readOnlyDir, {
          ZEN_MCP_READ_ONLY: "1",
          ZEN_MCP_ALLOWED_DOMAINS: "",
        }),
        "zen-mcp-readonly-test"
      );

      allowlistDir = policyDir("zen-mcp-allowlist-");
      allowlistClient = await connectPolicyServer(
        policyEnv(allowlistDir, {
          ZEN_MCP_READ_ONLY: "0",
          ZEN_MCP_ALLOWED_DOMAINS: "allowed.test",
        }),
        "zen-mcp-allowlist-test"
      );
    });

    after(async () => {
      await readOnlyClient?.close().catch(() => undefined);
      await allowlistClient?.close().catch(() => undefined);
    });

    it("blocks mutating tools but allows reads in read-only mode", async () => {
      const launch = await readOnlyClient!.callTool({
        name: "zen_launch",
        arguments: {},
      });
      assert.equal(launch.isError, true);
      assert.match(textOf(launch), /read-only/i);

      const open = await readOnlyClient!.callTool({
        name: "zen_tabs_open",
        arguments: { urls: ["https://example.com/"] },
      });
      assert.equal(open.isError, true);
      assert.match(textOf(open), /read-only/i);

      const evidence = await readOnlyClient!.callTool({
        name: "zen_show_evidence",
        arguments: { url: "https://example.com/", quote: "Example Domain" },
      });
      assert.equal(evidence.isError, true);
      assert.match(textOf(evidence), /read-only/i);

      // A read is not blocked by the policy; it fails later on the missing
      // bridge and must not mention read-only mode.
      const spaces = await readOnlyClient!.callTool({
        name: "zen_spaces_list",
        arguments: {},
      });
      assert.equal(spaces.isError, true);
      assert.doesNotMatch(textOf(spaces), /read-only/i);

      const config = JSON.parse(
        textOf(
          await readOnlyClient!.callTool({ name: "zen_config", arguments: {} })
        )
      );
      assert.equal(config.readOnly, true);
      assert.equal(config.dataDir, readOnlyDir);

      const audit = JSON.parse(
        textOf(
          await readOnlyClient!.callTool({
            name: "zen_audit_tail",
            arguments: { limit: 20 },
          })
        )
      );
      assert.ok(
        audit.entries.some(
          (entry: any) => entry.tool === "zen_launch" && entry.ok === false
        )
      );
      assert.ok(
        audit.entries.some(
          (entry: any) => entry.error?.code === "read_only"
        )
      );
    });

    it("blocks URLs outside the domain allowlist", async () => {
      const blocked = await allowlistClient!.callTool({
        name: "zen_tabs_open",
        arguments: { urls: ["https://blocked.test/page"] },
      });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /allowlist/i);

      const glance = await allowlistClient!.callTool({
        name: "zen_glance",
        arguments: { url: "https://blocked.test/preview" },
      });
      assert.equal(glance.isError, true);
      assert.match(textOf(glance), /allowlist/i);

      const evidence = await allowlistClient!.callTool({
        name: "zen_show_evidence",
        arguments: { url: "https://blocked.test/page", quote: "Quoted text" },
      });
      assert.equal(evidence.isError, true);
      assert.match(textOf(evidence), /allowlist/i);

      const schemeLess = await allowlistClient!.callTool({
        name: "zen_show_evidence",
        arguments: { url: "blocked.test/page", quote: "Quoted text" },
      });
      assert.equal(schemeLess.isError, true);
      assert.match(textOf(schemeLess), /allowlist/i);

      const scheme = await allowlistClient!.callTool({
        name: "zen_tabs_open",
        arguments: { urls: ["file:///etc/passwd"] },
      });
      assert.equal(scheme.isError, true);
      assert.match(textOf(scheme), /scheme/i);

      const config = JSON.parse(
        textOf(
          await allowlistClient!.callTool({ name: "zen_config", arguments: {} })
        )
      );
      assert.deepEqual(config.allowedDomains, ["allowed.test"]);
      assert.equal(config.readOnly, false);

      const audit = JSON.parse(
        textOf(
          await allowlistClient!.callTool({
            name: "zen_audit_tail",
            arguments: { limit: 20 },
          })
        )
      );
      assert.ok(
        audit.entries.some(
          (entry: any) => entry.error?.code === "domain_not_allowed"
        )
      );
    });
  }
);

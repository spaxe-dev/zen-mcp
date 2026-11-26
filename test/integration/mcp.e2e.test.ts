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
  "zen_click",
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
  "zen_tools_search",
  "zen_tools_use",
  "zen_type",
  "zen_wait_for",
  "zen_watch_add",
  "zen_watch_list",
  "zen_watch_remove",
];

const MARKER = "mcp-marker-7";
const TEST_SPACE_NAME = `MCP Test Space ${process.pid}-${Date.now()}`;
const EVIDENCE_QUOTE = "The lighthouse keeper checked the lamp at dawn.";
const REPEATED_QUOTE = "The shared lighthouse sentence appears in two places.";
const SCROLL_FILLER = "Spacer text for evidence scrolling. ".repeat(60);

let FRAME_URL = "";

/** A same-machine, cross-origin page loaded in an iframe by PAGE. */
const FRAME_PAGE = (): string => `<!doctype html><html><head>
<title>Frame Test Page</title>
</head><body>
<p id="frame-text">FRAME TEXT</p>
<input id="frame-input" name="frame-input" value="frame">
<button id="frame-button" type="button">Frame button</button>
<script>
document.querySelector("#frame-button").addEventListener("click", () => {
  document.querySelector("#frame-text").textContent = "FRAME CLICKED";
});
</script>
</body></html>`;

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
<tbody><tr><td>one</td><td>1</td></tr>
<tr><td>two</td><td>2</td></tr>
<tr><td>three</td><td>3</td></tr></tbody></table>
<p><a href="https://example.com/one">Example One</a>
<a href="/relative">Relative</a></p>
<section id="scope"><p>SCOPED TEXT</p></section>
<section id="alpha"><h2>Alpha context</h2><p>${REPEATED_QUOTE}</p></section>
<div style="height: 2400px">${SCROLL_FILLER}</div>
<section id="omega"><h2>Omega context</h2><p>${REPEATED_QUOTE}</p></section>
<p id="evidence-target">${EVIDENCE_QUOTE}</p>
<p id="page-owned-mark" data-zen-mcp-evidence="mark">Page-owned lookalike marker.</p>
<form id="form" aria-label="Contact form">
<label for="name">Name</label>
<input id="name" name="name" value="initial">
<label for="email">Email</label>
<input id="email" name="email" type="email" value="ada@example.com">
<label for="otp">Code</label>
<input id="otp" name="otp" autocomplete="one-time-code" value="123456">
<label for="card">Card number</label>
<input id="card" name="card" autocomplete="cc-number" value="4242 4242 4242 4242">
<label for="notes">Notes</label>
<textarea id="notes" name="notes">draft notes</textarea>
<label for="password">Password</label>
<input id="password" name="password" type="password">
<label for="search">Search</label>
<input id="search" name="search" placeholder="Search files">
<label for="readonly">Read-only</label>
<input id="readonly" name="readonly" readonly value="fixed">
<label for="delta-field">Delta field</label>
<input id="delta-field" name="delta" placeholder="Delta field">
<label><input id="agree" name="agree" type="checkbox" checked> Agree</label>
<label><input id="delta-check" name="delta-check" type="checkbox"> Delta agree</label>
<input id="upload" name="upload" type="file">
<button id="save" type="submit">Save</button>
</form>
<p id="result">idle</p>
<button id="plain" type="button">Plain</button>
<p id="clicked">not clicked</p>
<button id="duplicate-a" type="button">Continue</button>
<button id="duplicate-b" type="button">Continue</button>
<button id="hidden-action" type="button" style="display: none">Hidden action</button>
<button id="disabled-action" type="button" disabled>Disabled action</button>
<button id="alert-action" type="button">Show alert</button>
<div id="alerts" aria-live="polite"></div>
<button id="heading-action" type="button">Add heading</button>
<div id="headings"></div>
<p id="mutation-count">mutations 0</p>
<button id="counter" type="button">Count</button>
<p id="count">count 0</p>
<button id="swap" type="button">Swap clone</button>
<button id="replace-me" type="button">Replace target</button>
<p id="replace-state">original</p>
<a id="navigate" href="?nav=1">Navigate away</a>
<section id="cards" aria-label="Results">
<div><a href="/alpha">Alpha card</a><span>$10</span></div>
<div><a href="/beta">Beta card</a><span>$20</span></div>
<div><a href="/gamma">Gamma card</a><span>$30</span></div>
</section>
<div id="reveal-panel" hidden><button id="reveal-target" type="button">Revealed</button></div>
<button id="reveal-button" type="button">Reveal panel</button>
<button id="enable-target" type="button" disabled>Enable target</button>
<button id="enable-button" type="button">Enable target button</button>
<dialog id="semantic-dialog" aria-label="Semantic dialog" aria-modal="true">
<p>Modal body</p><button id="close-dialog" type="button">Close dialog</button>
</dialog>
<button id="open-dialog" type="button">Open dialog</button>
<div aria-hidden="true"><h2>Hidden heading</h2><p>decorative</p></div>
<div id="shadow-host"></div>
<section aria-label="After shadow"><h2>After shadow</h2><p>visible again</p></section>
<p><iframe id="inner" src="${FRAME_URL}/frame" title="inner frame"></iframe></p>
<div class="tick">tick 0</div>
<script>
let ticks = 0;
setInterval(() => {
  ticks += 1;
  const node = document.querySelector(".tick");
  if (node) node.textContent = "tick " + ticks;
}, 1000);
document.querySelector("#form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#result").textContent =
    "saved " + document.querySelector("#name").value;
});
document.querySelector("#plain").addEventListener("click", () => {
  document.querySelector("#clicked").textContent = "clicked once";
});
document.querySelector("#alert-action").addEventListener("click", () => {
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = "Saved alert";
  document.querySelector("#alerts").append(alert);
});
document.querySelector("#heading-action").addEventListener("click", () => {
  const heading = document.createElement("h2");
  heading.textContent = "Dynamic heading";
  document.querySelector("#headings").append(heading);
});
let count = 0;
document.querySelector("#counter").addEventListener("click", () => {
  count += 1;
  document.querySelector("#count").textContent = "count " + count;
});
document.querySelector("#swap").addEventListener("click", () => {
  const target = document.querySelector("#replace-me");
  const clone = target.cloneNode(true);
  target.replaceWith(clone);
  document.querySelector("#replace-state").textContent = "replaced";
});
document.querySelector("#replace-me").addEventListener("click", () => {
  document.querySelector("#replace-state").textContent = "original clicked";
});
document.querySelector("#reveal-button").addEventListener("click", () => {
  document.querySelector("#reveal-panel").hidden = false;
});
document.querySelector("#enable-button").addEventListener("click", () => {
  document.querySelector("#enable-target").disabled = false;
});
document.querySelector("#open-dialog").addEventListener("click", () => {
  document.querySelector("#semantic-dialog").showModal();
});
document.querySelector("#close-dialog").addEventListener("click", () => {
  document.querySelector("#semantic-dialog").close();
});
// Scoped to the form tree so the ticker cannot inflate the count. A read that
// instruments the page with attributes would be visible here.
window.__zenFormMutations = 0;
new MutationObserver((records) => {
  window.__zenFormMutations += records.length;
  document.querySelector("#mutation-count").textContent =
    "mutations " + window.__zenFormMutations;
}).observe(document.querySelector("#form"), {
  attributes: true,
  childList: true,
  subtree: true,
});
const shadow = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
shadow.innerHTML =
  '<section aria-label="Shadow section"><h2>Shadow heading</h2>' +
  '<label for="shadow-input">Shadow field</label>' +
  '<input id="shadow-input" placeholder="Shadow field">' +
  '<button id="shadow-button" type="button">Shadow button</button></section>';
shadow.querySelector("#shadow-button").addEventListener("click", () => {
  document.querySelector("#clicked").textContent = "shadow clicked";
});
</script>
</main></body></html>`;

describe(
  "Zen MCP server",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let client: Client | null = null;
    let page: PageServer;
    let framePage: PageServer;
    let spaceId = "";
    let tabId = "";
    let secondTabId = "";

    const rawCall = async (
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<any> =>
      client!.callTool({ name, arguments: args }, undefined, {
        timeout: 60_000,
      });

    const call = async (
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<any> => {
      const result = await rawCall(name, args);
      const text =
        (result as any).content?.find((part: any) => part.type === "text")?.text ??
        "";
      if (result.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text);
    };

    const callError = async (
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<{ text: string; error: any; result: any }> => {
      const result = await rawCall(name, args);
      assert.equal(result.isError, true, `${name} should fail`);
      const text =
        (result as any).content?.find((part: any) => part.type === "text")?.text ??
        "";
      return {
        text,
        error: (result as any).structuredContent?.error,
        result,
      };
    };

    /**
     * A new tab starts on about:blank, which the policy denies. Wait for the
     * browser-owned URL to become http(s) and the load to finish before reading.
     */
    const waitForLoadedTab = async (id: string): Promise<any> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const listed = await call("zen_tabs_list");
        const tab = listed.tabs.find((entry: any) => entry.id === id);
        if (tab && !tab.loading && /^https?:/i.test(tab.url)) return tab;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`tab ${id} did not finish loading`);
    };

    before(async () => {
      framePage = await startPageServer(FRAME_PAGE);
      FRAME_URL = framePage.url.replace(/\/page$/, "");
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
      await framePage?.close();
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

      // Use a unique name so a reused profile cannot collide with an older
      // test space. Cleanup never infers ownership from a name or prefix.
      const created = await call("zen_space_create", {
        name: TEST_SPACE_NAME,
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

      await waitForLoadedTab(tabId);
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

      await waitForLoadedTab(secondTabId);
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

    it("waits for page conditions and times out cleanly", async () => {
      const present = await call("zen_wait_for", {
        tabId,
        selector: "#evidence-target",
        timeout_ms: 5_000,
      });
      assert.equal(present.matched, true);
      assert.equal(present.condition, "selector");
      assert.equal(present.until, "present");
      assert.equal(present.query, "#evidence-target");

      const found = await call("zen_wait_for", {
        tabId,
        text: "Agent harness end to end",
        timeout_ms: 5_000,
      });
      assert.equal(found.matched, true);

      const title = await call("zen_wait_for", {
        tabId,
        title_contains: "mcp test",
        timeout_ms: 5_000,
      });
      assert.equal(title.matched, true);

      const absent = await call("zen_wait_for", {
        tabId,
        selector: "#never-here",
        until: "absent",
        timeout_ms: 1_000,
      });
      assert.equal(absent.matched, true);
      assert.equal(absent.until, "absent");

      const missing = await call("zen_wait_for", {
        tabId,
        selector: "#never-here",
        timeout_ms: 300,
        poll_ms: 100,
      });
      assert.equal(missing.matched, false);
      assert.match(missing.limitation, /did not hold/);

      await assert.rejects(
        call("zen_wait_for", { tabId, selector: "#a", text: "b" }),
        /exactly one/
      );
    });

    it("waits for a visible or enabled element", async () => {
      const hidden = await call("zen_wait_for", {
        tabId,
        selector: "#reveal-target",
        state: "visible",
        timeout_ms: 300,
        poll_ms: 100,
      });
      assert.equal(hidden.matched, false);

      const visibleWait = call("zen_wait_for", {
        tabId,
        selector: "#reveal-target",
        state: "visible",
        timeout_ms: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await call("zen_click", {
        tabId,
        target: { selector: "#reveal-button" },
      });
      const visible = await visibleWait;
      assert.equal(visible.matched, true);
      assert.equal(visible.state, "visible");

      const disabled = await call("zen_wait_for", {
        tabId,
        selector: "#enable-target",
        state: "enabled",
        timeout_ms: 300,
        poll_ms: 100,
      });
      assert.equal(disabled.matched, false);

      const enabledWait = call("zen_wait_for", {
        tabId,
        selector: "#enable-target",
        state: "enabled",
        timeout_ms: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await call("zen_click", {
        tabId,
        target: { selector: "#enable-button" },
      });
      const enabled = await enabledWait;
      assert.equal(enabled.matched, true);
      assert.equal(enabled.state, "enabled");
    });

    it("reads a semantic model with landmarks, headings and coverage", async () => {
      const read = await call("zen_read_page", { tabId, format: "semantic" });
      assert.equal(read.format, "semantic");
      // Semantic reads carry no page field values; the fixture selects no text.
      assert.equal(read.selectedText, "");
      const model = read.semantic;
      assert.ok(model);
      assert.ok(
        [
          "article",
          "search-results",
          "product",
          "listing",
          "dashboard",
          "login",
          "form",
          "documentation",
          "discussion",
          "generic",
        ].includes(model.classification)
      );
      assert.ok(model.confidence >= 0 && model.confidence <= 1);
      assert.ok(model.signals.length <= 6);
      assert.ok(model.limitations.length <= 5);

      const roles = model.regions.map((region: any) => region.role);
      assert.ok(roles.includes("main"), JSON.stringify(roles));
      assert.ok(roles.includes("form"), JSON.stringify(roles));
      assert.ok(roles.includes("table"), JSON.stringify(roles));
      assert.ok(model.regions.length <= 40);
      assert.ok(model.headings.length <= 40);
      assert.ok(
        model.headings.some(
          (heading: any) => heading.level === 1 && /MCP heading/.test(heading.text)
        )
      );
      assert.ok(
        model.headings.some(
          (heading: any) =>
            heading.level === 2 && /Second heading/.test(heading.text)
        )
      );

      const cards = model.regions.find((region: any) => region.label === "Results");
      assert.ok(cards, JSON.stringify(model.regions));
      assert.equal(cards.items, 3);
      assert.equal(cards.itemKind, "cards");
      assert.ok(
        model.collections.some(
          (collection: any) =>
            collection.regionId === cards.id &&
            collection.count === 3 &&
            collection.sample.length === 3
        )
      );

      const tableRegion = model.regions.find(
        (region: any) => region.role === "table"
      );
      assert.ok(tableRegion, JSON.stringify(model.regions));
      assert.equal(tableRegion.items, 3);
      assert.equal(tableRegion.itemKind, "results");

      const main = model.regions.find((region: any) => region.role === "main");
      assert.ok(main, JSON.stringify(model.regions));
      const shadowRegion = model.regions.find(
        (region: any) => region.label === "Shadow section"
      );
      assert.ok(shadowRegion, JSON.stringify(model.regions));
      assert.equal(shadowRegion.parent, main.id);
      const afterShadow = model.regions.find(
        (region: any) => (region.label ?? region.heading) === "After shadow"
      );
      assert.ok(afterShadow, JSON.stringify(model.regions));
      assert.equal(afterShadow.parent, main.id);
      assert.ok(
        !model.headings.some((heading: any) => /Hidden heading/.test(heading.text))
      );

      // The fixture contains a child frame, which the semantic model never
      // models, so coverage must not claim completeness. The caveat lives in
      // the read-level limitations, not twice in both lists.
      assert.equal(model.coverage.complete, false);
      assert.ok(
        read.limitations.some((limitation: string) => /frame/i.test(limitation)),
        JSON.stringify(read.limitations)
      );
      assert.ok(
        !model.limitations.some((limitation: string) => /frame/i.test(limitation)),
        "the child-frame caveat is reported once"
      );
      assert.equal(read.outline, undefined, "semantic reads do not repeat headings");
      for (const region of model.regions as any[]) {
        assert.ok(
          region.label === undefined || region.label !== region.heading,
          "duplicate labels are omitted"
        );
        assert.notEqual(region.controls, 0, "zero control counts are omitted");
        assert.notEqual(region.links, 0, "zero link counts are omitted");
      }
      assert.ok(model.coverage.nodes > 0);
      assert.ok(model.coverage.tables >= 1);
      assert.ok(model.coverage.regions <= 40);
      assert.equal(typeof model.coverage.regionsTruncated, "boolean");

      const serialized = JSON.stringify(model);
      assert.equal(serialized.includes("ada@example.com"), false);
      assert.equal(serialized.includes("4242 4242"), false);
      assert.equal(serialized.includes("123456"), false);
      assert.equal(serialized.includes("draft notes"), false);

      const heading = read.semantic.headings.find((entry: any) =>
        /Second heading/.test(entry.text)
      );
      assert.ok(heading?.ref);
      const clicked = await call("zen_click", { tabId, ref: heading.ref });
      assert.equal(clicked.clicked, true);
    });

    it("reports a modal dialog in the semantic model", async () => {
      await call("zen_click", {
        tabId,
        target: { selector: "#open-dialog" },
      });
      try {
        const read = await call("zen_read_page", { tabId, format: "semantic" });
        const dialog = read.semantic.dialogs.find(
          (entry: any) => entry.label === "Semantic dialog"
        );
        assert.ok(dialog, JSON.stringify(read.semantic.dialogs));
        assert.equal(dialog.modal, true);
        assert.ok(
          read.semantic.regions.some((region: any) => region.role === "dialog")
        );
      } finally {
        await call("zen_click", {
          tabId,
          target: { selector: "#close-dialog" },
        });
      }
    });

    it("reports tab and navigation events with document identity", async () => {
      const start = await call("zen_events", { waitSeconds: 0 });
      const opened = await call("zen_tabs_open", {
        urls: [`${page.url}?events=1`],
        space: spaceId,
      });
      const eventTabId = opened.tabs[0].id;
      try {
        const openedEvents = await call("zen_events", {
          after: start.cursor,
          waitSeconds: 10,
        });
        assert.ok(
          openedEvents.events.some(
            (event: any) =>
              event.kind === "tab" &&
              event.phase === "opened" &&
              event.tabId === eventTabId
          ),
          JSON.stringify(openedEvents)
        );
        assert.equal(openedEvents.missed, 0);
        assert.equal(typeof openedEvents.oldestCursor, "number");
        assert.equal(openedEvents.dropped, 0);

        const loaded = await call("zen_wait_for", {
          tabId: eventTabId,
          title_contains: "mcp test",
          timeout_ms: 10_000,
        });
        assert.equal(loaded.matched, true);

        const navigationEvents = await call("zen_events", {
          after: openedEvents.cursor,
          waitSeconds: 10,
        });
        // The committed navigation may already be buffered when the first read
        // runs, so both reads together cover the tab's lifecycle.
        const navigation = [...openedEvents.events, ...navigationEvents.events].find(
          (event: any) =>
            event.kind === "navigation" &&
            (event.phase === "committed" || event.phase === "completed") &&
            event.tabId === eventTabId
        );
        assert.ok(navigation, JSON.stringify(navigationEvents));
        assert.match(String(navigation.documentId), /^doc-\d+$/);
        assert.equal(navigation.source, "browser");
      } finally {
        await call("zen_tabs_close", { tabIds: [eventTabId] });
      }

      const closed = await call("zen_events", { waitSeconds: 10 });
      assert.ok(
        closed.events.some(
          (event: any) =>
            event.kind === "tab" &&
            event.phase === "closed" &&
            event.tabId === eventTabId
        ),
        JSON.stringify(closed)
      );
    });

    it("waits for a new tab and for a tab closing", async () => {
      const newTabWait = call("zen_wait_for", {
        tabId,
        new_tab: true,
        timeout_ms: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const opened = await call("zen_tabs_open", {
        urls: [`${page.url}?wait-new=1`],
        space: spaceId,
      });
      const tempId = opened.tabs[0].id;
      try {
        const newTab = await newTabWait;
        assert.equal(newTab.matched, true);
        assert.equal(newTab.newTabId, tempId);

        // The close wait revalidates the tab's actual URL, so let it leave
        // about:blank first.
        await waitForLoadedTab(tempId);
        const closeWait = call("zen_wait_for", {
          tabId: tempId,
          tab_closed: true,
          timeout_ms: 15_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await call("zen_tabs_close", { tabIds: [tempId] });
        const closed = await closeWait;
        assert.equal(closed.matched, true);
        assert.match(String(closed.limitation), /closed/i);

        const alreadyClosed = await call("zen_wait_for", {
          tabId: tempId,
          tab_closed: true,
          timeout_ms: 500,
        });
        assert.equal(alreadyClosed.matched, true);
      } finally {
        await call("zen_tabs_close", { tabIds: [tempId] }).catch(
          () => undefined
        );
      }
    });

    it("waits for a document change and a specific document identity", async () => {
      const opened = await call("zen_tabs_open", {
        urls: [`${page.url}?identity-wait=1`],
        space: spaceId,
      });
      const navTabId = opened.tabs[0].id;
      try {
        await waitForLoadedTab(navTabId);
        const stable = await call("zen_wait_for", {
          tabId: navTabId,
          document_changed: true,
          timeout_ms: 300,
          poll_ms: 100,
        });
        assert.equal(stable.matched, false);

        const changeWait = call("zen_wait_for", {
          tabId: navTabId,
          document_changed: true,
          timeout_ms: 15_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const snapshot = await call("zen_read_page", {
          tabId: navTabId,
          format: "snapshot",
        });
        const navigate = snapshot.elements.find(
          (element: any) => element.label === "Navigate away"
        );
        assert.ok(navigate?.ref);
        await call("zen_click", { tabId: navTabId, ref: navigate.ref });

        const changed = await changeWait;
        assert.equal(changed.matched, true);
        assert.match(String(changed.documentId), /^doc-\d+$/);

        const identity = await call("zen_wait_for", {
          tabId: navTabId,
          document_id: changed.documentId,
          timeout_ms: 15_000,
        });
        assert.equal(identity.matched, true, JSON.stringify(identity));
        assert.equal(identity.condition, "document");
      } finally {
        await call("zen_tabs_close", { tabIds: [navTabId] }).catch(
          () => undefined
        );
      }
    });

    it("resolves semantic targets and refuses ambiguity", async () => {
      const byRole = await call("zen_click", {
        tabId,
        target: { role: "button", name: "Plain" },
      });
      assert.equal(byRole.clicked, true);
      assert.equal(byRole.target.role, "button");
      assert.equal(byRole.target.label, "Plain");

      const byText = await call("zen_click", {
        tabId,
        target: { text: "Plain" },
      });
      assert.equal(byText.clicked, true);

      const bySelector = await call("zen_click", {
        tabId,
        target: { selector: "#plain" },
      });
      assert.equal(bySelector.clicked, true);

      const ambiguous = await callError("zen_click", {
        tabId,
        target: { role: "button", name: "Continue" },
      });
      assert.match(ambiguous.text, /target_ambiguous/);
      assert.equal(ambiguous.error?.code, "target_ambiguous");
      assert.equal(ambiguous.error?.category, "ambiguous");
      assert.equal(ambiguous.error?.details?.candidates?.length, 2);
      assert.deepEqual(
        ambiguous.error.details.candidates.map((entry: any) => entry.name),
        ["Continue", "Continue"]
      );

      const missing = await callError("zen_click", {
        tabId,
        target: { text: "No such action" },
      });
      assert.equal(missing.error?.code, "target_not_found");
      assert.equal(missing.error?.category, "not_found");

      const hidden = await callError("zen_click", {
        tabId,
        target: { role: "button", name: "Hidden action" },
      });
      assert.equal(hidden.error?.code, "target_not_actionable");
      assert.equal(hidden.error?.details?.reason, "hidden");

      const disabled = await callError("zen_click", {
        tabId,
        target: { role: "button", name: "Disabled action" },
      });
      assert.equal(disabled.error?.code, "target_not_actionable");
      assert.equal(disabled.error?.details?.reason, "disabled");

      const mixed = await callError("zen_type", {
        tabId,
        ref: "e1",
        target: { label: "Notes" },
        text: "x",
      });
      assert.equal(mixed.error?.code, "invalid_target");
    });

    it("types using labels and placeholders without exposing values", async () => {
      const byLabel = await call("zen_type", {
        tabId,
        target: { label: "Notes" },
        text: " more",
      });
      assert.equal(byLabel.typed, 5);
      assert.equal(byLabel.cleared, false);
      assert.equal(byLabel.target.label, "Notes");
      assert.deepEqual(byLabel.observed, {
        compared: true,
        matchesInput: true,
        sensitive: false,
      });
      assert.doesNotMatch(JSON.stringify(byLabel), / more/);

      const byPlaceholder = await call("zen_type", {
        tabId,
        target: { placeholder: "Search files" },
        text: "report",
        clear: true,
      });
      assert.equal(byPlaceholder.typed, 6);
      assert.equal(byPlaceholder.cleared, true);
      assert.deepEqual(byPlaceholder.observed, {
        compared: true,
        matchesInput: true,
        sensitive: false,
      });

      const secret = await call("zen_type", {
        tabId,
        target: { label: "Password" },
        text: "correct horse",
        clear: true,
      });
      assert.equal(secret.typed, 13);
      assert.deepEqual(secret.observed, {
        compared: false,
        matchesInput: null,
        sensitive: true,
      });
      assert.doesNotMatch(JSON.stringify(secret), /correct horse/);

      const readonly = await callError("zen_type", {
        tabId,
        target: { label: "Read-only" },
        text: "x",
      });
      assert.equal(readonly.error?.code, "target_not_actionable");
      assert.equal(readonly.error?.details?.reason, "read_only");

      const file = await callError("zen_type", {
        tabId,
        target: { label: "Agree" },
        text: "x",
      });
      assert.equal(file.error?.code, "target_not_actionable");
      assert.equal(file.error?.details?.reason, "not_editable");
    });

    it("searches open shadow roots with semantic targets only", async () => {
      const clicked = await call("zen_click", {
        tabId,
        target: { role: "button", name: "Shadow button" },
      });
      assert.equal(clicked.clicked, true);
      const read = await call("zen_read_page", { tabId });
      assert.match(read.text, /shadow clicked/);

      const typed = await call("zen_type", {
        tabId,
        target: { placeholder: "Shadow field" },
        text: "shadow",
      });
      assert.equal(typed.observed?.matchesInput, true);

      const bySelector = await callError("zen_click", {
        tabId,
        target: { selector: "#shadow-button" },
      });
      assert.equal(bySelector.error?.code, "target_not_found");

      const inFrame = await callError("zen_click", {
        tabId,
        target: { text: "Frame button" },
      });
      assert.equal(inFrame.error?.code, "target_not_found");
    });

    it("keeps legacy error codes and adds a structured category", async () => {
      const legacy = await callError("zen_click", { tabId, ref: "e9999" });
      assert.equal(legacy.error?.code, "element_not_found");
      assert.equal(legacy.error?.category, "stale_reference");
      assert.match(legacy.text, /element_not_found/);

      const structured = await callError("zen_click", {
        tabId,
        target: { ref: "e9999" },
      });
      assert.equal(structured.error?.code, "stale_reference");
      assert.equal(structured.error?.category, "stale_reference");
      assert.equal(structured.error?.details?.ref, "e9999");
    });

    it("reports bounded deltas after an action", async () => {
      const alert = await call("zen_click", {
        tabId,
        target: { role: "button", name: "Show alert" },
      });
      assert.equal(alert.clicked, true);
      assert.equal(alert.effect.attribution, "observed_after_action_not_proven");
      assert.ok(alert.effect.delta);
      assert.ok(alert.effect.delta.addedAlerts.includes("Saved alert"));

      const again = await call("zen_click", {
        tabId,
        target: { role: "button", name: "Show alert" },
      });
      assert.ok(
        again.effect.delta.addedAlerts.includes("Saved alert"),
        `a repeated identical alert should still be reported: ${JSON.stringify(again.effect.delta)}`
      );

      const heading = await call("zen_click", {
        tabId,
        target: { role: "button", name: "Add heading" },
      });
      assert.ok(heading.effect.delta.addedHeadings.includes("Dynamic heading"));

      const checkbox = await call("zen_click", {
        tabId,
        target: { role: "checkbox", name: "Delta agree" },
      });
      const toggle = checkbox.effect.delta.changedControls.find(
        (control: any) => control.name === "Delta agree"
      );
      assert.ok(toggle, "the toggled checkbox should be in the delta");
      assert.ok(toggle.changes.includes("checked"));

      const typed = await call("zen_type", {
        tabId,
        target: { label: "Delta field" },
        text: "hello",
      });
      assert.equal(typed.observed.matchesInput, true);
      const filled = typed.effect.delta.changedControls.find(
        (control: any) => control.name === "Delta field"
      );
      assert.ok(filled, "the typed field should be in the delta");
      assert.ok(filled.changes.includes("valuePresent"));
      assert.doesNotMatch(JSON.stringify(typed.effect), /hello/);
    });

    it("clicks and types with a visible effect", async () => {
      const interactive = await call("zen_read_page", {
        tabId,
        format: "interactive",
      });
      const name = interactive.elements.find(
        (element: any) => element.tag === "input" && element.value === "initial"
      );
      assert.ok(name?.ref, "the name input should have a ref");

      const typed = await call("zen_type", {
        tabId,
        ref: name.ref,
        text: "Ada",
        clear: true,
      });
      assert.equal(typed.typed, 3);
      assert.equal(typed.cleared, true);
      assert.equal(typed.effect?.valueChanged, true);

      const save = interactive.elements.find(
        (element: any) =>
          element.tag === "button" && /save/i.test(element.label)
      );
      assert.ok(save?.ref, "the save button should have a ref");

      const clicked = await call("zen_click", { tabId, ref: save.ref });
      assert.equal(clicked.clicked, true);
      assert.equal(clicked.effect?.changed, true);

      const saved = await call("zen_wait_for", {
        tabId,
        text: "saved Ada",
        timeout_ms: 5_000,
      });
      assert.equal(saved.matched, true);

      const read = await call("zen_read_page", { tabId });
      assert.match(read.text, /saved Ada/);
    });

    it("keeps snapshots private and leaves the DOM untouched", async () => {
      const mutationCount = (text: string): number =>
        Number(/mutations (\d+)/.exec(text)?.[1] ?? NaN);
      const before = await call("zen_read_page", { tabId });
      const beforeCount = mutationCount(before.text);
      assert.ok(Number.isFinite(beforeCount), before.text);

      const snapshot = await call("zen_read_page", {
        tabId,
        format: "snapshot",
      });
      assert.match(snapshot.snapshotId, /^snap-/);
      assert.equal(snapshot.format, "snapshot");
      assert.equal(snapshot.nextOffset, null);
      assert.equal(snapshot.selectedText, "");
      assert.equal(snapshot.snapshotComplete, true);
      assert.equal(snapshot.framesComplete, true);
      assert.ok(snapshot.elementsTotal >= 6);
      assert.ok(snapshot.elements.length >= 6);
      assert.ok(snapshot.outline.length >= 1);
      assert.ok(snapshot.text.length <= 4_000);

      for (const element of snapshot.elements) {
        assert.ok(
          !("value" in element),
          `${element.ref} serialized a value field`
        );
        assert.ok(!("valueLength" in element));
      }

      const email = snapshot.elements.find(
        (element: any) => element.type === "email"
      );
      assert.ok(email);
      assert.equal(email.sensitive, true);
      assert.equal(email.valuePresent, true);

      const otp = snapshot.elements.find(
        (element: any) => element.autocomplete === "one-time-code"
      );
      assert.ok(otp);
      assert.equal(otp.sensitive, true);
      assert.equal(otp.valuePresent, true);

      const ord = snapshot.elements.find(
        (element: any) => element.tag === "input" && element.label === "Name"
      );
      assert.ok(ord);
      assert.equal(ord.sensitive, false);
      assert.ok(!("value" in ord));

      const password = snapshot.elements.find(
        (element: any) => element.type === "password"
      );
      assert.ok(password);
      assert.equal(password.sensitive, true);
      assert.ok(!("value" in password));

      const card = snapshot.elements.find(
        (element: any) => element.autocomplete === "cc-number"
      );
      assert.ok(card);
      assert.equal(card.sensitive, true);
      assert.equal(card.valuePresent, true);
      assert.ok(!("value" in card));

      const notes = snapshot.elements.find(
        (element: any) => element.tag === "textarea"
      );
      assert.ok(notes);
      assert.equal(notes.valuePresent, true);
      assert.equal(notes.editable, true);

      const agree = snapshot.elements.find(
        (element: any) => element.type === "checkbox"
      );
      assert.ok(agree);
      assert.equal(agree.selected, true);
      assert.equal(agree.form, "form");

      const upload = snapshot.elements.find(
        (element: any) => element.type === "file"
      );
      assert.ok(upload);
      assert.equal(upload.sensitive, true);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = await call("zen_read_page", { tabId });
      assert.equal(mutationCount(after.text), beforeCount);
    });

    it("keeps a ref valid across repeated actions on one node", async () => {
      const snapshot = await call("zen_read_page", {
        tabId,
        format: "snapshot",
      });
      const counter = snapshot.elements.find(
        (element: any) => element.label === "Count"
      );
      assert.ok(counter?.ref);

      const first = await call("zen_click", { tabId, ref: counter.ref });
      assert.equal(first.clicked, true);
      const second = await call("zen_click", { tabId, ref: counter.ref });
      assert.equal(second.clicked, true);

      const read = await call("zen_wait_for", {
        tabId,
        text: "count 2",
        timeout_ms: 5_000,
      });
      assert.equal(read.matched, true);
    });

    it("rejects a ref whose node was replaced by an identical clone", async () => {
      const snapshot = await call("zen_read_page", {
        tabId,
        format: "snapshot",
      });
      const target = snapshot.elements.find(
        (element: any) => element.label === "Replace target"
      );
      const swap = snapshot.elements.find(
        (element: any) => element.label === "Swap clone"
      );
      assert.ok(target?.ref);
      assert.ok(swap?.ref);

      const replaced = await call("zen_click", { tabId, ref: swap.ref });
      assert.equal(replaced.clicked, true);

      const state = await call("zen_wait_for", {
        tabId,
        text: "replaced",
        timeout_ms: 5_000,
      });
      assert.equal(state.matched, true);

      await assert.rejects(
        call("zen_click", { tabId, ref: target.ref }),
        /element_not_found|stale|removed|replaced/
      );

      const fresh = await call("zen_read_page", {
        tabId,
        format: "snapshot",
      });
      const freshTarget = fresh.elements.find(
        (element: any) => element.label === "Replace target"
      );
      assert.ok(freshTarget?.ref);
      const clicked = await call("zen_click", {
        tabId,
        ref: freshTarget.ref,
      });
      assert.equal(clicked.clicked, true);
    });

    it("invalidates refs when the document navigates", async () => {
      const opened = await call("zen_tabs_open", {
        urls: [`${page.url}?identity=1`],
        space: spaceId,
      });
      const navTabId = opened.tabs[0].id;
      try {
        await waitForLoadedTab(navTabId);
        const snapshot = await call("zen_read_page", {
          tabId: navTabId,
          format: "snapshot",
        });
        const navigate = snapshot.elements.find(
          (element: any) => element.label === "Navigate away"
        );
        const counter = snapshot.elements.find(
          (element: any) => element.label === "Count"
        );
        assert.ok(navigate?.ref);
        assert.ok(counter?.ref);

        const clicked = await call("zen_click", {
          tabId: navTabId,
          ref: navigate.ref,
        });
        assert.equal(clicked.clicked, true);
        assert.equal(clicked.effect?.navigation, true);
        assert.equal(clicked.effect?.documentReplaced, true);
        assert.match(
          String(clicked.effect?.delta?.limitation),
          /document was replaced/
        );

        const moved = await call("zen_wait_for", {
          tabId: navTabId,
          url_contains: "nav=1",
          timeout_ms: 10_000,
        });
        assert.equal(moved.matched, true);

        await assert.rejects(
          call("zen_click", { tabId: navTabId, ref: counter.ref }),
          /element_not_found|navigation|replaced/
        );
      } finally {
        await call("zen_tabs_close", { tabIds: [navTabId] }).catch(
          () => undefined
        );
      }
    });

    it("separates snapshot collection completeness from output caps", async () => {
      const controls = Array.from(
        { length: 250 },
        (_, index) => `<button type="button">Action ${index + 1}</button>`
      ).join("");
      const headings = Array.from(
        { length: 90 },
        (_, index) => `<h2>Heading ${index + 1}</h2>`
      ).join("");
      const filler = `<p>${"Long page text. ".repeat(400)}</p>`;
      const complexPage = await startPageServer(
        `<!doctype html><html><head><title>Snapshot Matrix</title></head>` +
          `<body><main>${headings}${filler}${controls}` +
          `<iframe src="about:blank" title="opaque frame"></iframe>` +
          `</main></body></html>`
      );
      const opened = await call("zen_tabs_open", {
        urls: [complexPage.url],
        space: spaceId,
      });
      const complexTabId = opened.tabs[0].id;
      try {
        await waitForLoadedTab(complexTabId);
        const snapshot = await call("zen_read_page", {
          tabId: complexTabId,
          format: "snapshot",
        });
        assert.equal(snapshot.elements.length, 100);
        assert.ok(snapshot.elementsTotal >= 250);
        assert.equal(snapshot.elementsTruncated, true);
        assert.equal(snapshot.outline.length, 80);
        assert.equal(snapshot.outlineTruncated, true);
        assert.equal(snapshot.text.length, 4_000);
        assert.equal(snapshot.textTruncated, true);
        assert.equal(snapshot.snapshotComplete, false);
        assert.equal(snapshot.framesComplete, false);
        assert.ok(
          snapshot.limitations.some((line: string) => /skipped|not http/i.test(line))
        );
        assert.ok(snapshot.limitations.length <= 5);

        const wide = await call("zen_read_page", {
          tabId: complexTabId,
          format: "snapshot",
          maxElements: 200,
        });
        assert.equal(wide.elements.length, 200);
        assert.equal(wide.elementsTruncated, true);
        assert.equal(wide.snapshotComplete, false);

        const complete = await call("zen_read_page", {
          tabId,
          format: "snapshot",
        });
        assert.equal(complete.elementsTruncated, false);
        assert.equal(complete.textTruncated, false);
        assert.equal(complete.outlineTruncated, false);
        assert.equal(complete.snapshotComplete, true);
        assert.equal(complete.framesComplete, true);
      } finally {
        await call("zen_tabs_close", { tabIds: [complexTabId] }).catch(
          () => undefined
        );
        await complexPage.close();
      }
    });

    it("reads, waits in, and drives a cross-origin frame", async () => {
      const frameWait = await call("zen_wait_for", {
        tabId,
        frame_path: [0],
        selector: "#frame-input",
        timeout_ms: 10_000,
      });
      assert.equal(frameWait.matched, true);
      assert.deepEqual(frameWait.framePath, [0]);
      assert.match(frameWait.frameUrl, /\/frame$/);

      const frameRead = await call("zen_read_page", {
        tabId,
        framePath: [0],
      });
      assert.match(frameRead.text, /FRAME TEXT/);
      assert.deepEqual(frameRead.framePath, [0]);
      assert.ok(frameRead.frames.some((frame: any) => frame.path[0] === 0));

      const interactive = await call("zen_read_page", {
        tabId,
        format: "interactive",
      });
      const frameInput = interactive.elements.find(
        (element: any) =>
          element.framePath?.[0] === 0 && element.tag === "input"
      );
      assert.ok(frameInput?.ref?.startsWith("f0-"));

      const typed = await call("zen_type", {
        tabId,
        ref: frameInput.ref,
        text: "in frame",
        clear: true,
      });
      assert.deepEqual(typed.framePath, [0]);
      assert.equal(typed.effect?.valueChanged, true);

      const frameButton = interactive.elements.find(
        (element: any) =>
          element.framePath?.[0] === 0 && element.tag === "button"
      );
      assert.ok(frameButton?.ref?.startsWith("f0-"));

      const clicked = await call("zen_click", {
        tabId,
        ref: frameButton.ref,
      });
      assert.deepEqual(clicked.framePath, [0]);

      const after = await call("zen_read_page", {
        tabId,
        framePath: [0],
      });
      assert.match(after.text, /FRAME CLICKED/);
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
        "zen://capabilities",
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
      // Without a cursor a long poll returns buffered events immediately, so
      // the wait must start after every event the watch could otherwise see.
      const baseline = await call("zen_events", { waitSeconds: 0 });
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

      const hit = await call("zen_events", {
        after: baseline.cursor,
        waitSeconds: 25,
      });
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

      const beforeRestore = await call("zen_spaces_list");
      const beforeIds = new Set(
        beforeRestore.spaces.map((entry: any) => entry.id)
      );
      const restored = await call("zen_session_restore", {
        name: "mcp-e2e-session",
        newSpaces: true,
      });
      assert.ok(restored.tabsOpened >= 2);

      // Restoring with newSpaces copies every space in the session. Delete
      // only the IDs the restore reported creating; never infer ownership from
      // names, prefixes or the current Space list.
      const spaces = await call("zen_spaces_list");
      const restoredSpaces = spaces.spaces.filter(
        (entry: any) =>
          !beforeIds.has(entry.id) && /\(restored\)$/.test(entry.name)
      );
      assert.ok(
        restoredSpaces.some((entry: any) =>
          entry.name.startsWith(`${TEST_SPACE_NAME} (restored`)
        )
      );
      const createdIds = new Set<string>(restored.createdSpaceIds ?? []);
      for (const id of createdIds) {
        await call("zen_space_delete", { space: id });
      }

      const deleted = await call("zen_session_delete", {
        name: "mcp-e2e-session",
      });
      assert.equal(deleted.deleted, true);
      const after = await call("zen_session_list");
      assert.ok(
        !after.sessions.some((entry: any) => entry.name === "mcp-e2e-session")
      );
    });

    it("deletes only explicit created space ids, never decoy names", async () => {
      const suffix = Date.now();
      const decoy = await call("zen_space_create", {
        name: `MCP Decoy ${suffix}`,
      });
      const created = await call("zen_space_create", {
        name: `MCP Created ${suffix}`,
      });
      try {
        await call("zen_space_delete", { space: created.space.id });
        const after = await call("zen_spaces_list");
        const ids = after.spaces.map((entry: any) => entry.id);
        assert.ok(ids.includes(decoy.space.id), "the decoy Space must remain");
        assert.ok(!ids.includes(created.space.id), "the created Space is gone");
      } finally {
        await call("zen_space_delete", { space: decoy.space.id }).catch(
          () => undefined
        );
      }
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
    ZEN_MCP_TOOL_SURFACE: "full",
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
      assert.match(textOf(launch), /restricted/i);

      const open = await readOnlyClient!.callTool({
        name: "zen_tabs_open",
        arguments: { urls: ["https://example.com/"] },
      });
      assert.equal(open.isError, true);
      assert.match(textOf(open), /restricted/i);

      const evidence = await readOnlyClient!.callTool({
        name: "zen_show_evidence",
        arguments: { url: "https://example.com/", quote: "Example Domain" },
      });
      assert.equal(evidence.isError, true);
      assert.match(textOf(evidence), /restricted/i);

      // A read is not blocked by the policy; it fails later on the missing
      // bridge and must not mention a policy restriction.
      const spaces = await readOnlyClient!.callTool({
        name: "zen_spaces_list",
        arguments: {},
      });
      assert.equal(spaces.isError, true);
      assert.doesNotMatch(textOf(spaces), /restricted/i);

      const config = JSON.parse(
        textOf(
          await readOnlyClient!.callTool({ name: "zen_config", arguments: {} })
        )
      );
      assert.equal(config.readOnly, true);
      assert.equal(config.dataDir, "<data>");

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
          (entry: any) => entry.error?.code === "restricted"
        )
      );
    });

    it("blocks URLs outside the domain allowlist", async () => {
      const blocked = await allowlistClient!.callTool({
        name: "zen_tabs_open",
        arguments: { urls: ["https://blocked.test/page"] },
      });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /allowed website list/i);

      const glance = await allowlistClient!.callTool({
        name: "zen_glance",
        arguments: { url: "https://blocked.test/preview" },
      });
      assert.equal(glance.isError, true);
      assert.match(textOf(glance), /allowed website list/i);

      const evidence = await allowlistClient!.callTool({
        name: "zen_show_evidence",
        arguments: { url: "https://blocked.test/page", quote: "Quoted text" },
      });
      assert.equal(evidence.isError, true);
      assert.match(textOf(evidence), /allowed website list/i);

      const schemeLess = await allowlistClient!.callTool({
        name: "zen_show_evidence",
        arguments: { url: "blocked.test/page", quote: "Quoted text" },
      });
      assert.equal(schemeLess.isError, true);
      assert.match(textOf(schemeLess), /allowed website list/i);

      const scheme = await allowlistClient!.callTool({
        name: "zen_tabs_open",
        arguments: { urls: ["file:///etc/passwd"] },
      });
      assert.equal(scheme.isError, true);
      assert.match(textOf(scheme), /internal_page|internal browser pages/i);

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
          (entry: any) => entry.error?.code === "site_default_denied"
        )
      );
    });
  }
);

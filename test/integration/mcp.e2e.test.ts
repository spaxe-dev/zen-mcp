import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  e2eEnabled,
  killZen,
  launchHeadlessZen,
  removeTestProfile,
  startPageServer,
  testConfig,
  testProfilePath,
  type LaunchedZen,
  type PageServer,
} from "./helpers.js";

const EXPECTED_TOOLS = [
  "zen_answers",
  "zen_ask",
  "zen_bookmarks_search",
  "zen_folder_add_tabs",
  "zen_folder_create",
  "zen_folders_list",
  "zen_history_search",
  "zen_launch",
  "zen_notify",
  "zen_read_page",
  "zen_space_create",
  "zen_space_delete",
  "zen_space_switch",
  "zen_spaces_list",
  "zen_status",
  "zen_tab_select",
  "zen_tabs_close",
  "zen_tabs_list",
  "zen_tabs_open",
];

const MARKER = "mcp-marker-7";
const PAGE = `<!doctype html><html><head><title>MCP Test Page</title>
<meta name="description" content="Page used by the Zen MCP test.">
</head><body><main><h1>MCP heading</h1>
<p>Agent harness end to end. ${MARKER}</p></main></body></html>`;

describe(
  "Zen MCP server",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let client: Client | null = null;
    let zen: LaunchedZen | null = null;
    let page: PageServer;
    let spaceId = "";
    let tabId = "";

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
      const config = testConfig();
      zen = await launchHeadlessZen(config);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "dist", "cli.js"), "serve"],
        env: process.env as Record<string, string>,
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
      await client?.close().catch(() => undefined);
      await page?.close();
      killZen(zen);
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

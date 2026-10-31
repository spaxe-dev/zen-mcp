import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, type ZenMcpConfig } from "../src/config.js";
import { launchZen } from "../src/zen/launcher.js";
import { MarionetteClient } from "../src/zen/marionette.js";

const root = process.cwd();
const config: ZenMcpConfig = {
  ...loadConfig(),
  profilePath: "D:\\tmp\\zen-marionette-test\\profile",
  autoLaunch: false,
  launchTimeoutMs: 60_000,
  marionettePort: 2828,
};

const MARKER = "mcp-probe-marker-7";
const page = `<!doctype html><html><head><title>MCP Probe Page</title>
<meta name="description" content="Page used by the Zen MCP probe.">
</head><body><main><h1>MCP heading</h1>
<p>Agent harness end to end. ${MARKER}</p></main></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no http port");
const pageUrl = `http://127.0.0.1:${address.port}/mcp-probe`;
console.log("test page:", pageUrl);

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

function parseTool(result: any): any {
  const text =
    result?.content?.find((part: any) => part.type === "text")?.text ?? "";
  if (result?.isError) throw new Error(`tool error: ${text}`);
  return JSON.parse(text);
}

let zenPid = 0;
let launcherPid = 0;
let client: Client | null = null;
let transport: StdioClientTransport | null = null;
const started = Date.now();

try {
  const launch = await launchZen({
    config,
    args: ["--headless", "--new-instance", "-no-remote"],
  });
  launcherPid = launch.pid;
  console.log("zen launcher pid:", launch.pid);

  // Grab the real browser process id before the MCP server takes the single
  // Marionette session, then release it. The port probe inside launchZen can
  // briefly occupy the accept slot, so retry like the runtime does.
  const scout = new MarionetteClient({ port: config.marionettePort });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await scout.connect();
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  zenPid = Number(
    await scout.executeChrome("return Services.appinfo.processID;")
  );
  await scout.disconnect();
  console.log("zen process id:", zenPid);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "cli.js"), "serve"],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  });
  client = new Client({ name: "zen-mcp-probe", version: "0.0.0" });
  await client.connect(transport);
  console.log("mcp connected");

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS, "tool surface");
  console.log("tools:", names.length);

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parseTool(await client!.callTool({ name, arguments: args }, undefined, {
      timeout: 60_000,
    }));

  const status = await call("zen_status");
  assert.equal(status.appName, "Zen");
  const spaceBefore = status.activeSpaceId;
  const tabBefore = status.activeTab?.id ?? null;
  console.log("status:", status.appVersion, "·", status.spaces.length, "spaces");

  const created = await call("zen_space_create", {
    name: "MCP Probe",
    icon: "🧪",
  });
  assert.equal(created.created, true);
  assert.equal(created.switched, false);
  assert.notEqual(created.space.id, spaceBefore);
  console.log("space:", created.space.name, created.space.id);

  const opened = await call("zen_tabs_open", {
    urls: [pageUrl],
    space: "MCP Probe",
  });
  assert.equal(opened.tabs.length, 1);
  const tab = opened.tabs[0];
  assert.equal(tab.spaceId, created.space.id);
  assert.equal(tab.active, false);
  console.log("tab:", tab.id, "in", tab.spaceName);

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const read = await call("zen_read_page", { tabId: tab.id });
  assert.equal(read.title, "MCP Probe Page");
  assert.match(read.text, /mcp-probe-marker-7/);
  assert.equal(read.description, "Page used by the Zen MCP probe.");
  console.log("read:", read.title, `(${read.length} chars)`);

  const afterRead = await call("zen_status");
  assert.equal(afterRead.activeSpaceId, spaceBefore, "no space switch");
  assert.equal(afterRead.activeTab?.id ?? null, tabBefore, "no tab selection");

  const listed = await call("zen_tabs_list", { space: "MCP Probe" });
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].id, tab.id);
  console.log("tabs listed:", listed.total);

  const folder = await call("zen_folder_create", {
    label: "MCP Folder",
    tabIds: [tab.id],
    space: "MCP Probe",
  });
  assert.equal(folder.created, true);
  assert.equal(folder.folder.spaceId, created.space.id);
  assert.ok(folder.folder.tabIds.includes(tab.id));
  const folders = await call("zen_folders_list");
  assert.ok(folders.folders.some((f: any) => f.id === folder.folder.id));
  console.log("folder:", folder.folder.label);

  const spaces = await call("zen_spaces_list");
  const probeSpace = spaces.spaces.find((s: any) => s.id === created.space.id);
  assert.ok(probeSpace, "space listed");
  assert.ok(probeSpace.tabCount >= 1);
  assert.ok(probeSpace.folderCount >= 1);
  console.log("space counts:", probeSpace.tabCount, "tabs,", probeSpace.folderCount, "folders");

  const notified = await call("zen_notify", {
    title: "MCP probe finished",
    detail: "The probe space is ready.",
    tone: "success",
    space: "MCP Probe",
    actionLabel: "Open MCP Probe",
    autoHideMs: 60_000,
  });
  assert.equal(notified.delivered, true);
  console.log("notify delivered");

  const asked = await call("zen_ask", {
    question: "Should the probe keep this space?",
    options: [{ label: "Yes" }, { label: "No" }],
    context: "MCP probe",
    waitSeconds: 0,
  });
  assert.equal(asked.status, "pending");
  const answers = await call("zen_answers");
  assert.ok(
    answers.pending.some((entry: any) => entry.question.id === asked.questionId),
    "question is pending in the inbox"
  );
  console.log("ask recorded:", asked.questionId);

  const deleted = await call("zen_space_delete", { space: "MCP Probe" });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.spaceId, created.space.id);
  const afterDelete = await call("zen_spaces_list");
  assert.ok(!afterDelete.spaces.some((s: any) => s.id === created.space.id));
  const tabsAfter = await call("zen_tabs_list", { query: "mcp-probe" });
  assert.equal(tabsAfter.total, 0, "space tabs are gone with the space");
  console.log("space deleted with its tabs");

  console.log(`\nMCP CHECKS PASSED in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error("MCP PROBE FAILED", error);
  process.exitCode = 1;
} finally {
  try {
    await client?.close();
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const pid of new Set([zenPid, launcherPid])) {
    if (!pid) continue;
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
      console.log("cleanup: stopped pid", pid);
    } catch {
      console.warn("cleanup: could not stop pid", pid);
    }
  }
}

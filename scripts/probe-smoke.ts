import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig, type ZenMcpConfig } from "../src/config.js";
import type { AskResult } from "../src/shared/protocol.js";
import { launchZen } from "../src/zen/launcher.js";
import { ZenRuntime } from "../src/zen/runtime.js";

const root = process.cwd();
const profile = "D:\\tmp\\zen-marionette-test\\profile";
const config: ZenMcpConfig = {
  ...loadConfig(),
  profilePath: profile,
  autoLaunch: false,
  launchTimeoutMs: 60_000,
  marionettePort: 2828,
};

const MARKER = "zen-mcp-marker-42";
const page = `<!doctype html><html><head><title>Zen MCP Test Page</title>
<meta name="description" content="A page used by the Zen MCP smoke test.">
</head><body><main><h1>Smoke heading</h1>
<p>The quick brown fox jumps over the lazy dog. ${MARKER}</p>
</main></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no http port");
const pageUrl = `http://127.0.0.1:${address.port}/zen-mcp-smoke`;
console.log("test page:", pageUrl);

const runtime = new ZenRuntime({
  config,
  bridgeScriptPath: join(root, "dist", "bridge.js"),
});

let zenPid = 0;
const started = Date.now();

const pollUi = async (
  selector: string,
  body: string,
  timeoutMs = 15_000
): Promise<any> => {
  const deadline = Date.now() + timeoutMs;
  let last: any = { ok: false, why: "not polled" };
  while (Date.now() < deadline) {
    last = await runtime.marionette.executeChrome(`
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const host = win.document.getElementById("zen-mcp-host");
      if (!host) return { ok: false, why: "no host" };
      const card = host.shadowRoot.querySelector(${JSON.stringify(selector)});
      if (!card) return { ok: false, why: "no card" };
      ${body}
    `);
    if (last && last.ok) return last;
    await new Promise((r) => setTimeout(r, 180));
  }
  return last;
};

try {
  await runtime.start();
  const launch = await launchZen({
    config,
    args: ["--headless", "--new-instance", "-no-remote"],
  });
  zenPid = launch.pid;
  console.log("zen pid:", zenPid);

  const connected = await runtime.connect({ allowLaunch: false });
  console.log("CONNECT", JSON.stringify(connected, null, 2));
  assert.equal(runtime.hub.connectionCount, 1, "one bridge connection");

  const status = await runtime.status();
  assert.equal(status.appName, "Zen");
  assert.ok(status.workspacesEnabled, "spaces are enabled");
  console.log("status ok:", status.appVersion, "·", status.tabCount, "tabs");

  const created = await runtime.hub.createSpace({
    name: "Zen MCP Smoke",
    icon: "🧪",
    switchTo: false,
  });
  console.log("space created:", created.space.name, created.space.id);
  assert.equal(created.created, true);
  assert.equal(created.switched, false);

  const opened = await runtime.hub.openTabs({
    space: "Zen MCP Smoke",
    urls: [pageUrl],
    background: true,
  });
  console.log("opened tabs:", JSON.stringify(opened.tabs.map((t) => ({ id: t.id, spaceId: t.spaceId, active: t.active }))));
  assert.equal(opened.tabs.length, 1);
  const tab = opened.tabs[0];
  assert.equal(tab.spaceId, created.space.id);
  assert.equal(tab.active, false, "tab opened in background");

  const listed = await runtime.hub.listTabs({ space: "Zen MCP Smoke" });
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].id, tab.id);

  await new Promise((r) => setTimeout(r, 1_200));
  const beforeBackground = await runtime.status();
  const backgroundRead = await runtime.readPage({ tabId: tab.id });
  console.log("background read:", backgroundRead.title, backgroundRead.url);
  assert.equal(backgroundRead.title, "Zen MCP Test Page");
  assert.match(backgroundRead.text, /zen-mcp-marker-42/);
  const afterBackground = await runtime.status();
  assert.equal(
    afterBackground.activeSpaceId,
    beforeBackground.activeSpaceId,
    "reading a background tab must not switch spaces"
  );
  assert.equal(
    afterBackground.activeTab?.id,
    beforeBackground.activeTab?.id,
    "reading a background tab must not change the active tab"
  );

  console.log("asking a question in Zen…");
  const askPromise = runtime.hub.ask(
    "Summarize the test page now?",
    [
      { label: "The test page", description: "One background tab" },
      { label: "Skip", description: "Leave it for later" },
    ],
    { waitSeconds: 25, context: "Smoke test", allowFreeform: true }
  );
  const clicked = await pollUi(
    ".card.question",
    `const buttons = [...card.querySelectorAll("button.option")];
     if (buttons.length !== 2) return { ok: false, why: "expected 2 options, saw " + buttons.length };
     const label = buttons[0].querySelector(".label-text")?.textContent;
     const question = card.querySelector("h2.question")?.textContent;
     buttons[0].click();
     return { ok: true, label, question, options: buttons.length };`,
    20_000
  );
  console.log("UI answer click:", JSON.stringify(clicked));
  assert.equal(clicked.ok, true, `question card: ${clicked.why}`);
  const answer: AskResult = await askPromise;
  console.log("ASK", JSON.stringify(answer, null, 2));
  assert.equal(answer.status, "answered");
  assert.deepEqual(answer.selectedLabels, ["The test page"]);
  assert.equal(answer.answer, "The test page");
  assert.deepEqual(runtime.answers().pending, []);
  assert.equal(runtime.answers().answered[0]?.answer, "The test page");

  console.log("showing an activity card…");
  const notified = await runtime.notify({
    title: "1 PR waiting for a reply",
    detail: "The smoke space has your test page open.",
    tone: "success",
    action: { label: "Open Zen MCP Smoke", space: created.space.id },
    autoHideMs: 90_000,
  });
  assert.equal(notified.delivered, true);
  const activityClicked = await pollUi(
    ".card.activity",
    `const button = card.querySelector("button.action");
     if (!button) return { ok: false, why: "no action button" };
     const title = card.querySelector(".a-title")?.textContent;
     button.click();
     return { ok: true, title };`,
    10_000
  );
  console.log("activity action click:", JSON.stringify(activityClicked));
  assert.equal(activityClicked.ok, true, `activity card: ${activityClicked.why}`);

  const switchDeadline = Date.now() + 10_000;
  let activeSpace: string | null = null;
  while (Date.now() < switchDeadline) {
    activeSpace = (await runtime.status()).activeSpaceId;
    if (activeSpace === created.space.id) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(activeSpace, created.space.id, "activity action switched spaces");
  console.log("space switched to", activeSpace);

  const selected = await runtime.hub.selectTab({ tabId: tab.id });
  console.log("selected:", selected.tab.title, selected.tab.url);
  await new Promise((r) => setTimeout(r, 800));

  const read = await runtime.readPage();
  console.log("READ", JSON.stringify(read, null, 2));
  assert.equal(read.title, "Zen MCP Test Page");
  assert.match(read.text, /quick brown fox/);
  assert.match(read.text, /zen-mcp-marker-42/);
  assert.equal(read.description, "A page used by the Zen MCP smoke test.");

  const folder = await runtime.hub.createFolder({
    label: "Smoke Folder",
    tabIds: [tab.id],
    space: "Zen MCP Smoke",
  });
  console.log("folder:", JSON.stringify(folder.folder));
  assert.equal(folder.created, true);
  assert.equal(folder.folder.label, "Smoke Folder");
  assert.equal(folder.folder.spaceId, created.space.id);
  assert.ok(folder.folder.tabIds.includes(tab.id) || folder.folder.tabIds.length === 1);

  const folders = await runtime.hub.listFolders();
  assert.ok(folders.folders.some((f) => f.id === folder.folder.id));

  const history = await runtime.hub.searchHistory({ query: "zen-mcp-smoke" });
  console.log("history:", JSON.stringify(history.entries));
  assert.ok(history.entries.some((entry) => entry.url === pageUrl), "history recorded the test page");

  const bookmark = await runtime.marionette.executeChrome<{ guid: string }>(`
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    const info = await PlacesUtils.bookmarks.insert({
      parentGuid: PlacesUtils.bookmarks.toolbarGuid,
      url: ${JSON.stringify(pageUrl)},
      title: "Zen MCP Bookmark",
    });
    return { guid: info.guid };
  `);
  const bookmarks = await runtime.hub.searchBookmarks({ query: "Zen MCP Bookmark" });
  console.log("bookmarks:", JSON.stringify(bookmarks.entries));
  assert.ok(bookmarks.entries.some((entry) => entry.url === pageUrl));
  await runtime.marionette.executeChrome(`
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    await PlacesUtils.bookmarks.remove(${JSON.stringify(bookmark.guid)});
    return true;
  `);

  console.log(`\nALL CHECKS PASSED in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error("PROBE FAILED", error);
  process.exitCode = 1;
} finally {
  try {
    await runtime.marionette.executeChrome(`
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const ws = win.gZenWorkspaces;
      const space = ws.getWorkspaces().find((w) => w.name === "Zen MCP Smoke");
      if (space) {
        const fallback = ws.getWorkspaces().find((w) => w.uuid !== space.uuid);
        if (fallback && ws.activeWorkspace === space.uuid) {
          await ws.changeWorkspaceWithID(fallback.uuid);
        }
        await ws.removeWorkspace(space.uuid);
      }
      return true;
    `);
    console.log("cleanup: space removed");
  } catch (error) {
    console.warn("cleanup failed:", (error as Error).message);
  }
  await runtime.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (zenPid) {
    try {
      execFileSync("taskkill", ["/PID", String(zenPid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
      console.log("cleanup: zen stopped");
    } catch {
      console.warn("cleanup: could not stop zen pid", zenPid);
    }
  }
}

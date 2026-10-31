import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import type { AskResult } from "../../src/shared/protocol.js";
import { ZenRuntime } from "../../src/zen/runtime.js";
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

const MARKER = "sidekick-marker-42";
const PAGE = `<!doctype html><html><head><title>Sidekick Test Page</title>
<meta name="description" content="A page used by the Zen Sidekick end-to-end test.">
</head><body><main><h1>Test heading</h1>
<p>The quick brown fox jumps over the lazy dog. ${MARKER}</p>
</main></body></html>`;

describe(
  "Zen runtime against a real browser",
  { skip: e2eEnabled() ? false : "set ZEN_SIDEKICK_E2E=1 to run" },
  () => {
    let runtime: ZenRuntime;
    let zen: LaunchedZen | null = null;
    let page: PageServer;
    let spaceId = "";
    let spaceName = "";
    let tabId = "";

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
          const host = win.document.getElementById("zen-sidekick-host");
          if (!host) return { ok: false, why: "no host" };
          const card = host.shadowRoot.querySelector(${JSON.stringify(selector)});
          if (!card) return { ok: false, why: "no card" };
          ${body}
        `);
        if (last && last.ok) return last;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      return last;
    };

    before(async () => {
      page = await startPageServer(PAGE);
      runtime = new ZenRuntime({
        config: testConfig(),
        bridgeScriptPath: join(process.cwd(), "dist", "bridge.js"),
      });
      await runtime.start();
      zen = await launchHeadlessZen(runtime.config);
      await runtime.connect({ allowLaunch: false });
      assert.ok(runtime.hub.connectionCount > 0, "bridge attached");
    });

    after(async () => {
      if (spaceId && runtime) {
        try {
          const spaces = await runtime.hub.listSpaces();
          if (spaces.spaces.some((space) => space.id === spaceId)) {
            await runtime.hub.deleteSpace({ space: spaceId });
          }
        } catch {
          // Best effort; Zen may already be gone.
        }
      }
      await runtime?.shutdown().catch(() => undefined);
      await page?.close();
      killZen(zen);
      removeTestProfile(testProfilePath());
    });

    it("reports status and creates a space without switching", async () => {
      const status = await runtime.status();
      assert.equal(status.appName, "Zen");
      assert.ok(status.workspacesEnabled, "spaces enabled");

      const created = await runtime.hub.createSpace({
        name: "Sidekick Test Space",
        icon: "🧪",
        switchTo: false,
      });
      spaceId = created.space.id;
      spaceName = created.space.name;
      assert.equal(created.created, true);
      assert.equal(created.switched, false);
    });

    it("reads a tab in another space without changing the view", async () => {
      const opened = await runtime.hub.openTabs({
        space: spaceId,
        urls: [page.url],
        background: true,
      });
      assert.equal(opened.tabs.length, 1);
      tabId = opened.tabs[0].id;
      assert.equal(opened.tabs[0].spaceId, spaceId);
      assert.equal(opened.tabs[0].active, false);

      const listed = await runtime.hub.listTabs({ space: spaceId });
      assert.equal(listed.tabs.length, 1);
      assert.equal(listed.tabs[0].id, tabId);

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const beforeRead = await runtime.status();
      const read = await runtime.readPage({ tabId });
      assert.equal(read.title, "Sidekick Test Page");
      assert.match(read.text, new RegExp(MARKER));
      assert.equal(
        read.description,
        "A page used by the Zen Sidekick end-to-end test."
      );

      const afterRead = await runtime.status();
      assert.equal(
        afterRead.activeSpaceId,
        beforeRead.activeSpaceId,
        "background read must not switch spaces"
      );
      assert.equal(
        afterRead.activeTab?.id ?? null,
        beforeRead.activeTab?.id ?? null,
        "background read must not select the tab"
      );
    });

    it("asks in the browser and takes the clicked answer", async () => {
      const pending = runtime.hub.ask(
        "Summarize the test page now?",
        [
          { label: "The test page", description: "One background tab" },
          { label: "Skip", description: "Leave it for later" },
        ],
        { waitSeconds: 25, context: "End-to-end test", allowFreeform: true }
      );

      const clicked = await pollUi(
        ".card.question",
        `const buttons = [...card.querySelectorAll("button.option")];
         if (buttons.length !== 2) return { ok: false, why: "expected 2 options, saw " + buttons.length };
         const label = buttons[0].querySelector(".label-text")?.textContent;
         buttons[0].click();
         return { ok: true, label };`,
        20_000
      );
      assert.equal(clicked.ok, true, `question card: ${clicked.why}`);
      assert.equal(clicked.label, "The test page");

      const answer: AskResult = await pending;
      assert.equal(answer.status, "answered");
      assert.deepEqual(answer.selectedLabels, ["The test page"]);
      assert.equal(answer.answer, "The test page");

      assert.deepEqual(runtime.answers().pending, []);
      assert.equal(runtime.answers().answered[0]?.answer, "The test page");
    });

    it("shows an activity card whose action switches spaces", async () => {
      const notified = await runtime.notify({
        title: "1 PR waiting for a reply",
        detail: "The test space has the page open.",
        tone: "success",
        action: { label: `Open ${spaceName}`, space: spaceId },
        autoHideMs: 90_000,
      });
      assert.equal(notified.delivered, true);

      const clicked = await pollUi(
        ".card.activity",
        `const button = card.querySelector("button.action");
         if (!button) return { ok: false, why: "no action button" };
         button.click();
         return { ok: true };`,
        10_000
      );
      assert.equal(clicked.ok, true, `activity card: ${clicked.why}`);

      const deadline = Date.now() + 10_000;
      let activeSpace: string | null = null;
      while (Date.now() < deadline) {
        activeSpace = (await runtime.status()).activeSpaceId;
        if (activeSpace === spaceId) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(activeSpace, spaceId, "action switched spaces");
    });

    it("reads the active page and manages folders", async () => {
      await runtime.hub.selectTab({ tabId });
      await new Promise((resolve) => setTimeout(resolve, 800));

      const read = await runtime.readPage();
      assert.equal(read.title, "Sidekick Test Page");
      assert.match(read.text, new RegExp(MARKER));

      const folder = await runtime.hub.createFolder({
        label: "Test Folder",
        tabIds: [tabId],
        space: spaceId,
      });
      assert.equal(folder.created, true);
      assert.equal(folder.folder.spaceId, spaceId);
      assert.ok(folder.folder.tabIds.includes(tabId));

      const folders = await runtime.hub.listFolders();
      assert.ok(folders.folders.some((entry) => entry.id === folder.folder.id));
    });

    it("searches history and bookmarks", async () => {
      const history = await runtime.hub.searchHistory({ query: "page" });
      assert.ok(
        history.entries.some((entry) => entry.url === page.url),
        "history contains the test page"
      );

      const bookmark = await runtime.marionette.executeChrome<{ guid: string }>(`
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        const info = await PlacesUtils.bookmarks.insert({
          parentGuid: PlacesUtils.bookmarks.toolbarGuid,
          url: ${JSON.stringify(page.url)},
          title: "Sidekick Test Bookmark",
        });
        return { guid: info.guid };
      `);
      const bookmarks = await runtime.hub.searchBookmarks({
        query: "Sidekick Test Bookmark",
      });
      assert.ok(bookmarks.entries.some((entry) => entry.url === page.url));

      await runtime.marionette.executeChrome(`
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        await PlacesUtils.bookmarks.remove(${JSON.stringify(bookmark.guid)});
        return true;
      `);
    });

    it("deletes a space and the tabs it holds", async () => {
      const deleted = await runtime.hub.deleteSpace({ space: spaceId });
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.spaceId, spaceId);
      spaceId = "";

      const spaces = await runtime.hub.listSpaces();
      assert.ok(!spaces.spaces.some((space) => space.name === spaceName));

      const tabs = await runtime.hub.listTabs({ query: page.url });
      assert.equal(tabs.total, 0, "the space's tabs are gone");
    });
  }
);

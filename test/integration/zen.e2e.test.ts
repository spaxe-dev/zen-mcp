import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import type { AskResult } from "../../src/shared/protocol.js";
import {
  terminateZenProcess,
  waitForProcessExit,
} from "../../src/zen/launcher.js";
import { ZenRuntime } from "../../src/zen/runtime.js";
import {
  e2eEnabled,
  removeTestProfile,
  startPageServer,
  testConfig,
  testProfilePath,
  type PageServer,
} from "./helpers.js";

const MARKER = "zen-mcp-marker-42";
const EVIDENCE_QUOTE = "The lighthouse keeper checked the lamp at dawn.";
const REPEATED_QUOTE = "The shared lighthouse sentence appears in two places.";
const SCROLL_FILLER = "Spacer text for evidence scrolling. ".repeat(60);
const PAGE = `<!doctype html><html><head><title>Zen MCP Test Page</title>
<meta name="description" content="A page used by the Zen MCP end-to-end test.">
</head><body><main><h1>Test heading</h1>
<p>The quick brown fox jumps over the lazy dog. ${MARKER}</p>
<section id="alpha"><h2>Alpha context</h2><p>${REPEATED_QUOTE}</p></section>
<div style="height: 2400px">${SCROLL_FILLER}</div>
<section id="omega"><h2>Omega context</h2><p>${REPEATED_QUOTE}</p></section>
<p id="evidence-target">${EVIDENCE_QUOTE}</p>
<p id="page-owned-mark" data-zen-mcp-evidence="mark">Page-owned lookalike marker.</p>
</main></body></html>`;

describe(
  "Zen runtime against a real browser",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let runtime: ZenRuntime;
    let browserPid: number | null = null;
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
          const host = win.document.getElementById("zen-mcp-host");
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

    /**
     * Counts overlay hosts in a page. Marks live in a closed shadow root, so
     * page script can only see the host, never the painted boxes.
     */
    const inspectContent = async (
      url: string
    ): Promise<{ hosts: number; closed: boolean; scrollY: number } | null> => {
      const handles = await runtime.marionette.getWindowHandles();
      for (const handle of handles) {
        try {
          const info = await runtime.marionette.executeInContent<any>(
            handle,
            `
            if (String(location.href) !== ${JSON.stringify(url)}) return null;
            var hosts = [];
            var root = document.documentElement;
            if (root) {
              for (var i = 0; i < root.children.length; i += 1) {
                var element = root.children[i];
                var names =
                  element.getAttributeNames ? element.getAttributeNames() : [];
                for (var j = 0; j < names.length; j += 1) {
                  if (names[j].indexOf("data-zen-") === 0) {
                    hosts.push(element);
                    break;
                  }
                }
              }
            }
            var first = hosts[0];
            return {
              hosts: hosts.length,
              closed: !!first && first.shadowRoot === null,
              scrollY: Number(window.scrollY) || 0
            };
          `
          );
          if (info) return info;
        } catch {
          // The handle can disappear while iterating, or belong to a page
          // that is not ready.
        }
      }
      return null;
    };

    before(async () => {
      page = await startPageServer(PAGE);
      runtime = new ZenRuntime({
        config: testConfig(),
        bridgeScriptPath: join(process.cwd(), "dist", "bridge.js"),
      });
      await runtime.start();
      await runtime.connect({ allowLaunch: true });
      assert.ok(runtime.hub.connectionCount > 0, "bridge attached");

      const session = runtime.sessionInfo();
      browserPid = session.browserPid;
      assert.equal(session.ownsBrowser, true, "runtime owns the browser");
      assert.equal(session.lockedDown, true, "Marionette is locked down");
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
      if (!(await waitForProcessExit(browserPid, 20_000))) {
        terminateZenProcess(browserPid ?? undefined);
      }
      await page?.close();
      removeTestProfile(testProfilePath());
    });

    it("reports status and creates a space without switching", async () => {
      const status = await runtime.status();
      assert.equal(status.appName, "Zen");
      assert.ok(status.workspacesEnabled, "spaces enabled");

      const created = await runtime.hub.createSpace({
        name: "Zen MCP Test Space",
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
      assert.equal(read.title, "Zen MCP Test Page");
      assert.match(read.text, new RegExp(MARKER));
      assert.equal(
        read.description,
        "A page used by the Zen MCP end-to-end test."
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
      assert.equal(read.title, "Zen MCP Test Page");
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
          title: "Zen MCP Test Bookmark",
        });
        return { guid: info.guid };
      `);
      const bookmarks = await runtime.hub.searchBookmarks({
        query: "Zen MCP Test Bookmark",
      });
      assert.ok(bookmarks.entries.some((entry) => entry.url === page.url));

      await runtime.marionette.executeChrome(`
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        await PlacesUtils.bookmarks.remove(${JSON.stringify(bookmark.guid)});
        return true;
      `);
    });

    it("shows evidence, disambiguates repeats and clears the marks", async () => {
      const other = await runtime.hub.openTabs({
        urls: [`${page.url}?other=1`],
        background: false,
        switchTo: true,
      });
      const otherTabId = other.tabs[0]?.id ?? "";
      assert.ok(otherTabId);
      await new Promise((resolve) => setTimeout(resolve, 800));

      const shown = await runtime.showEvidence({
        url: page.url,
        quote: EVIDENCE_QUOTE,
        claim: "The keeper checked the lamp at dawn",
        sourceTitle: "Zen MCP Test Page",
        highlightMs: 60_000,
      });
      assert.equal(shown.ok, true, JSON.stringify(shown.error));
      assert.equal(shown.tabId, tabId);
      assert.equal(shown.tabReused, true);
      assert.equal(shown.focused, false);
      assert.equal(shown.title, "Zen MCP Test Page");
      assert.equal(shown.matchMethod, "exact");
      assert.equal(shown.confidence, 1);
      assert.equal(shown.highlighted, true);
      assert.equal(shown.scrolled, true);
      assert.equal(shown.sourceUrl, page.url);

      // Verification runs in the background by default, so the user's current
      // tab stays where it is.
      const status = await runtime.status();
      assert.equal(status.activeTab?.id, otherTabId, "focus did not move");

      const card = await pollUi(
        ".card.activity",
        `const title = card.querySelector(".a-title")?.textContent || "";
         const detail = card.querySelector(".a-detail")?.textContent || "";
         if (!title.includes("keeper checked the lamp")) {
           return { ok: false, why: "title: " + title };
         }
         if (!detail.includes("Source: Zen MCP Test Page")) {
           return { ok: false, why: "source: " + detail };
         }
         if (!detail.includes("exact match") || !detail.includes("highlighted")) {
           return { ok: false, why: "status: " + detail };
         }
         const button = card.querySelector("button.action");
         if (!button) return { ok: false, why: "no action button" };
         const label = button.textContent || "";
         button.click();
         return { ok: true, title, detail, label };`
      );
      assert.equal(card.ok, true, `evidence card: ${card.why}`);
      assert.match(card.label, /Show source/);

      const showDeadline = Date.now() + 5_000;
      let shownActive: string | null = null;
      while (Date.now() < showDeadline) {
        shownActive = (await runtime.status()).activeTab?.id ?? null;
        if (shownActive === tabId) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.equal(shownActive, tabId, "Show source selects the source tab");

      await runtime.hub.selectTab({ tabId: otherTabId, focusWindow: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(
        (await runtime.status()).activeTab?.id,
        otherTabId,
        "background tab is active again"
      );

      const focused = await runtime.showEvidence({
        url: page.url,
        quote: EVIDENCE_QUOTE,
        claim: "Focused keeper check",
        focus: true,
        highlightMs: 60_000,
      });
      assert.equal(focused.ok, true, JSON.stringify(focused.error));
      assert.equal(focused.focused, true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(
        (await runtime.status()).activeTab?.id,
        tabId,
        "focus brings the source forward"
      );

      // Content handles follow the selected tab, so inspect the page after it
      // is in front.
      const view = await inspectContent(page.url);
      assert.ok(view, "content window reachable");
      assert.ok(view.hosts > 0, "an overlay host exists");
      assert.equal(view.closed, true, "marks live in a closed shadow root");
      assert.ok(view.scrollY > 0, "page scrolled to the passage");
      assert.equal(focused.verified, true, "an exact, visible match is verified");

      const found = await runtime.findText({
        tabId,
        query: "LIGHTHOUSE keeper",
      });
      assert.equal(found.ok, true, JSON.stringify(found.error));
      assert.equal(found.totalMatches, 1);
      assert.equal(found.matches[0]?.text, "lighthouse keeper");

      const exactFound = await runtime.findText({
        tabId,
        query: "LIGHTHOUSE keeper",
        caseSensitive: true,
      });
      assert.equal(exactFound.totalMatches, 0);

      const scanned = await runtime.searchTabs({
        query: REPEATED_QUOTE,
        space: spaceId,
      });
      assert.equal(scanned.tabsSearched, 2);
      assert.equal(scanned.tabsMatched, 2);
      assert.equal(scanned.totalMatches, 4);
      assert.equal(scanned.truncated, false);

      const batch = await runtime.showEvidenceBatch({
        citations: [
          { url: page.url, quote: EVIDENCE_QUOTE, claim: "Batch exact" },
          {
            url: page.url,
            quote: REPEATED_QUOTE,
            context: "Omega context",
            claim: "Batch context",
          },
          {
            url: `${page.url}?other=1`,
            quote: EVIDENCE_QUOTE,
            claim: "Batch other tab",
          },
          {
            url: page.url,
            quote: "A sentence that is definitely not in the test page.",
            claim: "Batch missing",
          },
        ],
        highlightMs: 60_000,
      });
      assert.equal(batch.total, 4);
      assert.equal(batch.matched, 3);
      assert.equal(batch.failed, 1);
      assert.equal(batch.ok, false);
      assert.equal(batch.openedTabs, 0);
      assert.equal(batch.reusedTabs, 2);
      assert.equal(batch.results[0]?.ok, true);
      assert.equal(batch.results[1]?.matchMethod, "context");
      assert.equal(batch.results[2]?.tabId, otherTabId);
      assert.equal(batch.results[3]?.error?.code, "QUOTE_NOT_FOUND");

      const ambiguous = await runtime.showEvidence({
        url: page.url,
        quote: REPEATED_QUOTE,
        highlightMs: 60_000,
      });
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.error?.code, "AMBIGUOUS_MATCH");

      const chosen = await runtime.showEvidence({
        url: page.url,
        quote: REPEATED_QUOTE,
        context: "Omega context",
        highlightMs: 60_000,
      });
      assert.equal(chosen.ok, true, JSON.stringify(chosen.error));
      assert.equal(chosen.matchMethod, "context");
      assert.equal(chosen.occurrences, 2);

      const missing = await runtime.showEvidence({
        url: page.url,
        quote: "A sentence that is definitely not in the test page.",
        highlightMs: 60_000,
      });
      assert.equal(missing.ok, false);
      assert.equal(missing.error?.code, "QUOTE_NOT_FOUND");

      const cleared = await runtime.clearEvidence({ tabId });
      assert.equal(cleared.cleared, true);
      assert.ok(cleared.removed >= 1);
      const after = await inspectContent(page.url);
      assert.equal(after?.hosts, 0, "overlays removed");
      const owned = await runtime.readPage({
        tabId,
        selector: '[data-zen-mcp-evidence="mark"]',
      });
      assert.match(owned.text, /Page-owned lookalike marker/);
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

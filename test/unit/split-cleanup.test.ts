import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOps } from "../../src/bridge/ops.js";
import {
  isSyntheticSplitTab,
  planSplitCleanup,
  type SplitCleanupCandidate,
} from "../../src/bridge/split-cleanup.js";

function candidate(
  id: string,
  url: string,
  overrides: Partial<SplitCleanupCandidate> = {}
): SplitCleanupCandidate {
  return { id, url, title: `Tab ${id}`, ...overrides };
}

describe("planSplitCleanup", () => {
  it("finds no residue when the tab set is unchanged", () => {
    const plan = planSplitCleanup(
      { beforeTabIds: ["a", "b"], groupUrls: ["https://a.test/p"] },
      [candidate("a", "https://a.test/p"), candidate("b", "https://b.test/")]
    );
    assert.deepEqual(plan.closeTabIds, []);
    assert.deepEqual(plan.duplicates, []);
    assert.deepEqual(plan.newTabIds, []);
    assert.equal(plan.limitation, undefined);
  });

  it("closes new synthetic New Tab and blank tabs", () => {
    const plan = planSplitCleanup(
      { beforeTabIds: ["a"], groupUrls: ["https://a.test/p"] },
      [
        candidate("a", "https://a.test/p"),
        candidate("newtab", "about:newtab"),
        candidate("blank", "about:blank"),
        candidate("empty-url", ""),
        candidate("flagged", "https://a.test/p", { empty: true }),
      ]
    );
    assert.deepEqual(plan.closeTabIds, [
      "newtab",
      "blank",
      "empty-url",
      "flagged",
    ]);
    assert.equal(isSyntheticSplitTab(candidate("newtab", "about:newtab")), true);
    assert.equal(
      isSyntheticSplitTab(candidate("real", "https://a.test/p")),
      false
    );
  });

  it("reports a duplicate source tab but never selects it for closing", () => {
    const plan = planSplitCleanup(
      { beforeTabIds: ["a", "b"], groupUrls: ["https://a.test/page"] },
      [
        candidate("a", "https://a.test/page"),
        candidate("b", "https://b.test/"),
        candidate("dup", "https://A.test/page#section", {
          title: "Duplicate source",
        }),
      ]
    );
    assert.deepEqual(plan.closeTabIds, []);
    assert.deepEqual(plan.duplicates, [
      {
        tabId: "dup",
        title: "Duplicate source",
        url: "https://A.test/page#section",
      },
    ]);
    assert.match(plan.limitation ?? "", /Duplicate source/);
    assert.match(plan.limitation ?? "", /dup/);
  });

  it("never closes a tab that existed before the call", () => {
    const plan = planSplitCleanup(
      { beforeTabIds: ["old-newtab"], groupUrls: [] },
      [candidate("old-newtab", "about:newtab", { empty: true })]
    );
    assert.deepEqual(plan.closeTabIds, []);
    assert.deepEqual(plan.newTabIds, []);
  });

  it("leaves other groups and unrelated new tabs untouched", () => {
    const plan = planSplitCleanup(
      {
        beforeTabIds: ["a", "b", "c", "d"],
        groupUrls: ["https://a.test/p", "https://b.test/p"],
      },
      [
        candidate("a", "https://a.test/p"),
        candidate("b", "https://b.test/p"),
        candidate("c", "https://c.test/p"),
        candidate("d", "https://d.test/p"),
        candidate("user", "https://user.test/new"),
      ]
    );
    assert.deepEqual(plan.closeTabIds, []);
    assert.deepEqual(plan.duplicates, []);
    assert.deepEqual(plan.newTabIds, ["user"]);
    assert.equal(plan.limitation, undefined);
  });

  it("ignores candidates from another window", () => {
    const plan = planSplitCleanup(
      { beforeTabIds: ["a"], groupUrls: ["https://a.test/p"], windowId: "w1" },
      [
        candidate("a", "https://a.test/p", { windowId: "w1" }),
        candidate("other", "about:newtab", { windowId: "w2" }),
      ]
    );
    assert.deepEqual(plan.closeTabIds, []);
    assert.deepEqual(plan.newTabIds, []);
  });
});

/* ------------------------------------------------------------------ */
/* split.close integration over a structural fake window               */
/* ------------------------------------------------------------------ */

class FakeTab {
  readonly attributes = new Map<string, string>();
  splitView = false;
  isConnected = true;
  closing = false;
  pinned = false;
  selected = false;
  group: any = null;
  lastAccessed = 0;
  userContextId = 0;
  readonly label: string;
  readonly linkedBrowser: { currentURI: { spec: string } };

  constructor(url: string, title: string) {
    this.label = title;
    this.linkedBrowser = { currentURI: { spec: url } };
    this.attributes.set("zen-url", url);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setUrl(url: string): void {
    this.linkedBrowser.currentURI.spec = url;
    this.attributes.set("zen-url", url);
  }
}

function createFakeWindow(options: {
  tabs: FakeTab[];
  selected?: FakeTab;
  splitter?: any;
}) {
  const tabs = options.tabs;
  let selectedTab = options.selected ?? tabs[0];
  const win: any = {
    document: {
      querySelectorAll(selector: string) {
        return selector === "tab.tabbrowser-tab" ? tabs : [];
      },
    },
    gZenWorkspaces: {
      shouldHaveWorkspaces: false,
      activeWorkspace: "space-1",
      allStoredTabs: tabs,
      getWorkspaces: () => [],
      moveTabsToWorkspace(members: FakeTab[], spaceId: string) {
        for (const member of members) {
          member.setAttribute("zen-workspace-id", spaceId);
        }
      },
    },
    gBrowser: {
      tabs,
      get selectedTab() {
        return selectedTab;
      },
      set selectedTab(tab: FakeTab) {
        selectedTab = tab;
        for (const candidateTab of tabs) candidateTab.selected = candidateTab === tab;
      },
      removeTab(tab: FakeTab) {
        const index = tabs.indexOf(tab);
        if (index >= 0) tabs.splice(index, 1);
        tab.isConnected = false;
      },
      pinTab(tab: FakeTab) {
        tab.pinned = true;
      },
      unpinTab(tab: FakeTab) {
        tab.pinned = false;
      },
    },
    gZenViewSplitter: options.splitter,
  };
  return win;
}

async function tabIdsByLabel(ops: ReturnType<typeof createOps>) {
  const listed: any = await ops.dispatch("tabs.list", {});
  const ids = new Map<string, string>();
  for (const tab of listed.tabs) ids.set(tab.title, tab.id);
  return ids;
}

describe("split.close residue cleanup", () => {
  it("closes a synthetic New Tab left behind when closing by tab id", async () => {
    const tabA = new FakeTab("https://a.test/p", "Tab A");
    const tabB = new FakeTab("https://b.test/p", "Tab B");
    const other = new FakeTab("https://other.test/", "Other");
    tabA.splitView = true;
    tabB.splitView = true;
    const tabs = [tabA, tabB, other];

    let removeGroupCalls = 0;
    let unsplitCalls = 0;
    const splitter = {
      _data: [{ tabs: [tabA, tabB] }],
      removeGroup(index: number) {
        removeGroupCalls++;
        assert.equal(index, 0);
        tabA.splitView = false;
        tabB.splitView = false;
        const stray = new FakeTab("about:newtab", "New Tab");
        stray.setAttribute("zen-empty-tab", "true");
        tabs.push(stray);
      },
      unsplitCurrentView() {
        unsplitCalls++;
      },
    };
    const win = createFakeWindow({ tabs, selected: other, splitter });
    const ops = createOps(win, "w1");
    const ids = await tabIdsByLabel(ops);

    const result: any = await ops.dispatch("split.close", {
      tabId: ids.get("Tab A"),
    });

    assert.equal(result.unsplit, true);
    assert.equal(result.tabIds.length, 2);
    assert.equal(result.closedResidue, 1);
    assert.equal(result.limitation, undefined);
    assert.equal(removeGroupCalls, 1);
    assert.equal(unsplitCalls, 0);
    assert.deepEqual(
      tabs.map((tab) => tab.label),
      ["Tab A", "Tab B", "Other"]
    );
  });

  it("closes the current split through the supported fallback", async () => {
    const tabA = new FakeTab("https://a.test/page", "Tab A");
    const tabB = new FakeTab("https://b.test/page", "Tab B");
    tabA.splitView = true;
    tabB.splitView = true;
    const tabs = [tabA, tabB];
    let duplicate: FakeTab | null = null;

    const splitter = {
      unsplitCurrentView() {
        tabA.splitView = false;
        tabB.splitView = false;
        duplicate = new FakeTab("https://a.test/page", "Duplicate A");
        tabs.push(duplicate);
      },
    };
    const win = createFakeWindow({ tabs, selected: tabA, splitter });
    const ops = createOps(win, "w1");
    const ids = await tabIdsByLabel(ops);

    const result: any = await ops.dispatch("split.close", {});

    assert.equal(result.unsplit, true);
    assert.deepEqual(result.tabIds, [ids.get("Tab A")]);
    assert.equal(result.closedResidue, 0);
    assert.match(result.limitation ?? "", /Duplicate A/);
    assert.match(result.limitation ?? "", /tab-/);
    assert.equal(duplicate !== null, true);
    assert.equal(tabs.includes(duplicate as unknown as FakeTab), true);
  });

  it("does not return unsplit false when the tab is not in the private data", async () => {
    const tabA = new FakeTab("https://a.test/page", "Tab A");
    tabA.splitView = true;
    const tabs = [tabA];
    const win = createFakeWindow({
      tabs,
      selected: tabA,
      splitter: {
        unsplitCurrentView() {
          tabA.splitView = false;
        },
      },
    });
    const ops = createOps(win, "w1");
    await tabIdsByLabel(ops);

    const result: any = await ops.dispatch("split.close", {});
    assert.equal(result.unsplit, true);
  });

  it("throws split_close_failed when the split remains", async () => {
    const tabA = new FakeTab("https://a.test/page", "Tab A");
    const tabB = new FakeTab("https://b.test/page", "Tab B");
    tabA.splitView = true;
    tabB.splitView = true;
    const tabs = [tabA, tabB];
    const win = createFakeWindow({
      tabs,
      selected: tabA,
      splitter: {
        _data: [{ tabs: [tabA, tabB] }],
        removeGroup() {
          // Zen silently refuses to detach the tabs.
        },
        unsplitCurrentView() {
          // No-op as well.
        },
      },
    });
    const ops = createOps(win, "w1");
    await tabIdsByLabel(ops);

    await assert.rejects(
      () => ops.dispatch("split.close", {}),
      (error: any) => error?.code === "split_close_failed"
    );
  });

  it("returns unsplit false when the tab is not in a split at all", async () => {
    const tabA = new FakeTab("https://a.test/page", "Tab A");
    const other = new FakeTab("https://other.test/", "Other");
    const tabs = [tabA, other];
    const win = createFakeWindow({
      tabs,
      selected: other,
      splitter: { unsplitCurrentView() {} },
    });
    const ops = createOps(win, "w1");
    await tabIdsByLabel(ops);

    const result: any = await ops.dispatch("split.close", {
      tabId: (await tabIdsByLabel(ops)).get("Tab A"),
    });
    assert.equal(result.unsplit, false);
    assert.match(result.limitation ?? "", /No split view/);
  });
});

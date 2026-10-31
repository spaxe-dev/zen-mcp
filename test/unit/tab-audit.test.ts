import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  FolderInfo,
  SpaceInfo,
  TabInfo,
} from "../../src/shared/protocol.js";
import {
  auditTabs,
  planDomainFolders,
} from "../../src/zen/tab-audit.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function tab(id: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: "w1",
    spaceId: "s1",
    spaceName: "Work",
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    pinned: false,
    essential: false,
    active: false,
    audible: false,
    muted: false,
    loading: false,
    folderId: null,
    folderLabel: null,
    index: 0,
    lastAccessed: null,
    ...overrides,
  };
}

function space(id: string, name: string, index = 0): SpaceInfo {
  return {
    id,
    name,
    icon: null,
    active: false,
    index,
    containerTabId: index + 1,
    tabCount: 0,
    pinnedCount: 0,
    folderCount: 0,
  };
}

function folder(id: string, spaceId: string, tabIds: string[] = []): FolderInfo {
  return {
    id,
    label: `Folder ${id}`,
    spaceId,
    collapsed: false,
    parentId: null,
    tabIds,
    liveFolder: false,
  };
}

describe("auditTabs totals", () => {
  it("counts tabs, spaces, folders, pinned, essentials, grouped and loading", () => {
    const tabs = [
      tab("a", { pinned: true, folderId: "f1", loading: true }),
      tab("b", { essential: true }),
      tab("c", { spaceId: null, spaceName: null }),
      tab("d", { pinned: true, url: "https://other.com/d" }),
    ];
    const result = auditTabs({
      tabs,
      spaces: [space("s1", "Work"), space("s2", "Play", 1)],
      folders: [folder("f1", "s1"), folder("f2", "s1"), folder("f3", "s2")],
    });
    assert.deepEqual(result.totals, {
      tabs: 4,
      spaces: 2,
      folders: 3,
      pinned: 2,
      essentials: 1,
      grouped: 1,
      loading: 1,
      duplicates: 0,
      stale: 0,
    });
  });
});

describe("auditTabs duplicates", () => {
  it("normalizes case, hash and trailing slash, and includes essentials", () => {
    const tabs = [
      tab("t1", { url: "https://Example.com/Path/#one" }),
      tab("t2", {
        url: "https://example.com/Path",
        spaceId: "s2",
        spaceName: "Play",
      }),
      tab("t3", {
        url: "https://example.com/Path/#two",
        essential: true,
        spaceId: "s2",
        spaceName: "Play",
      }),
      tab("t4", { url: "https://other.com/unique" }),
      tab("t5", { url: "about:blank" }),
      tab("t6", { url: "about:blank" }),
      tab("t7", { url: "chrome://newtab" }),
      tab("t8", { url: "chrome://newtab" }),
      tab("t9", { url: "   " }),
    ];
    const result = auditTabs({ tabs, spaces: [], folders: [] });
    assert.equal(result.duplicates.length, 1);
    const duplicate = result.duplicates[0];
    assert.equal(duplicate?.url, "https://example.com/path");
    assert.deepEqual(duplicate?.tabIds, ["t1", "t2", "t3"]);
    assert.deepEqual(duplicate?.spaces, ["Work", "Play"]);
    assert.equal(duplicate?.title, "Tab t1");
    assert.equal(result.totals.duplicates, 1);
  });

  it("sorts by count and respects duplicateLimit", () => {
    const tabs = [
      tab("a1", { url: "https://small.test/x" }),
      tab("a2", { url: "https://small.test/x" }),
      tab("b1", { url: "https://big.test/y" }),
      tab("b2", { url: "https://big.test/y" }),
      tab("b3", { url: "https://big.test/y" }),
    ];
    const result = auditTabs(
      { tabs, spaces: [], folders: [] },
      { duplicateLimit: 1 }
    );
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0]?.url, "https://big.test/y");
    assert.equal(result.totals.duplicates, 2);
  });
});

describe("auditTabs stale", () => {
  const tabs = [
    tab("recent", { lastAccessed: NOW - 2 * DAY }),
    tab("edge", { lastAccessed: NOW - 14 * DAY }),
    tab("old", { lastAccessed: NOW - 20 * DAY }),
    tab("older", { lastAccessed: NOW - 40 * DAY }),
    tab("unknown", { lastAccessed: null }),
    tab("missing"),
    tab("future", { lastAccessed: NOW + DAY }),
  ];

  it("marks only tabs older than the cutoff, oldest first", () => {
    const result = auditTabs(
      { tabs, spaces: [], folders: [] },
      { now: NOW, staleDays: 14 }
    );
    assert.deepEqual(
      result.staleTabs.map((entry) => entry.tabId),
      ["older", "old"]
    );
    assert.equal(result.staleTabs[0]?.ageDays, 40);
    assert.equal(result.staleTabs[1]?.ageDays, 20);
    assert.equal(result.staleTabs[0]?.lastAccessed, NOW - 40 * DAY);
    assert.equal(result.totals.stale, 2);
  });

  it("honors staleDays and staleLimit", () => {
    const result = auditTabs(
      { tabs, spaces: [], folders: [] },
      { now: NOW, staleDays: 30, staleLimit: 1 }
    );
    assert.deepEqual(
      result.staleTabs.map((entry) => entry.tabId),
      ["older"]
    );
    assert.equal(result.totals.stale, 1);
  });

  it("defaults to 14 days and Date.now()", () => {
    const result = auditTabs({
      tabs: [tab("x", { lastAccessed: Date.now() - 30 * DAY })],
      spaces: [],
      folders: [],
    });
    assert.equal(result.staleTabs.length, 1);
  });
});

describe("auditTabs domains", () => {
  it("strips www, ignores non-http(s) and sorts by count then name", () => {
    const tabs = [
      tab("a", { url: "https://www.Example.com/a" }),
      tab("b", { url: "https://example.com/b" }),
      tab("c", { url: "https://sub.example.com/c" }),
      tab("d", { url: "https://other.com/d" }),
      tab("e", { url: "about:blank" }),
      tab("f", { url: "chrome://settings" }),
      tab("g", { url: "not a url" }),
    ];
    const result = auditTabs({ tabs, spaces: [], folders: [] });
    assert.deepEqual(result.domains, [
      { domain: "example.com", count: 2, tabIds: ["a", "b"] },
      { domain: "other.com", count: 1, tabIds: ["d"] },
      { domain: "sub.example.com", count: 1, tabIds: ["c"] },
    ]);
  });

  it("caps the domain list at 30", () => {
    const tabs = Array.from({ length: 31 }, (_, index) =>
      tab(`t${index}`, { url: `https://site${String(index).padStart(2, "0")}.test/` })
    );
    const result = auditTabs({ tabs, spaces: [], folders: [] });
    assert.equal(result.domains.length, 30);
    assert.equal(result.domains[0]?.domain, "site00.test");
  });
});

describe("auditTabs bySpace", () => {
  it("reports each space plus a no-space bucket when needed", () => {
    const tabs = [
      tab("w1", { pinned: true, lastAccessed: NOW - 20 * DAY }),
      tab("w2"),
      tab("p1", {
        spaceId: "s2",
        spaceName: "Play",
        lastAccessed: NOW - 30 * DAY,
      }),
      tab("loose", { spaceId: null, spaceName: null }),
    ];
    const result = auditTabs(
      {
        tabs,
        spaces: [space("s1", "Work"), space("s2", "Play", 1)],
        folders: [folder("f1", "s1"), folder("f2", "s2"), folder("f3", "s2")],
      },
      { now: NOW }
    );
    assert.deepEqual(result.bySpace, [
      {
        spaceId: "s1",
        spaceName: "Work",
        tabs: 2,
        pinned: 1,
        folders: 1,
        stale: 1,
      },
      {
        spaceId: "s2",
        spaceName: "Play",
        tabs: 1,
        pinned: 0,
        folders: 2,
        stale: 1,
      },
      {
        spaceId: null,
        spaceName: "No space",
        tabs: 1,
        pinned: 0,
        folders: 0,
        stale: 0,
      },
    ]);
  });

  it("omits the no-space bucket when every tab belongs to a space", () => {
    const result = auditTabs({
      tabs: [tab("a")],
      spaces: [space("s1", "Work")],
      folders: [],
    });
    assert.equal(result.bySpace.length, 1);
    assert.equal(result.bySpace[0]?.spaceId, "s1");
  });
});

describe("planDomainFolders", () => {
  const tabs = [
    tab("a1", { url: "https://example.com/1" }),
    tab("a2", { url: "https://www.example.com/2" }),
    tab("a3", {
      url: "https://example.com/3",
      spaceId: "s2",
      spaceName: "Play",
    }),
    tab("b1", { url: "https://other.com/1" }),
    tab("b2", { url: "https://other.com/2" }),
    tab("grouped", { url: "https://example.com/g", folderId: "f1" }),
    tab("pinned", { url: "https://example.com/p", pinned: true }),
    tab("essential", { url: "https://example.com/e", essential: true }),
    tab("about1", { url: "about:blank" }),
    tab("about2", { url: "about:blank" }),
    tab("lone", { url: "https://lone.test/x" }),
  ];

  it("groups ungrouped http(s) tabs by domain with default minTabs 2", () => {
    const plans = planDomainFolders(tabs);
    assert.deepEqual(plans, [
      { domain: "example.com", label: "example.com", tabIds: ["a1", "a2", "a3"] },
      { domain: "other.com", label: "other.com", tabIds: ["b1", "b2"] },
    ]);
  });

  it("filters by space id", () => {
    const s1 = planDomainFolders(tabs, { spaceId: "s1" });
    assert.deepEqual(
      s1.map((plan) => [plan.domain, plan.tabIds]),
      [
        ["example.com", ["a1", "a2"]],
        ["other.com", ["b1", "b2"]],
      ]
    );
    const s2 = planDomainFolders(tabs, { spaceId: "s2" });
    assert.deepEqual(s2, []);
    const s2Loose = planDomainFolders(tabs, { spaceId: "s2", minTabs: 1 });
    assert.deepEqual(s2Loose, [
      { domain: "example.com", label: "example.com", tabIds: ["a3"] },
    ]);
  });

  it("filters the null space when spaceId is null", () => {
    const withLoose = [
      ...tabs,
      tab("loose1", { spaceId: null, spaceName: null, url: "https://loose.test/1" }),
      tab("loose2", { spaceId: null, spaceName: null, url: "https://loose.test/2" }),
    ];
    const plans = planDomainFolders(withLoose, { spaceId: null });
    assert.deepEqual(plans, [
      { domain: "loose.test", label: "loose.test", tabIds: ["loose1", "loose2"] },
    ]);
  });

  it("honors minTabs and excludes empty domains", () => {
    assert.deepEqual(planDomainFolders(tabs, { minTabs: 3 }), [
      { domain: "example.com", label: "example.com", tabIds: ["a1", "a2", "a3"] },
    ]);
    assert.deepEqual(planDomainFolders(tabs, { minTabs: 5 }), []);
  });

  it("keeps tab ids unique", () => {
    const duplicated = [
      tab("same", { url: "https://dup.test/1" }),
      tab("same", { url: "https://dup.test/2" }),
    ];
    const plans = planDomainFolders(duplicated, { minTabs: 2 });
    assert.equal(plans.length, 0);
    const single = planDomainFolders(duplicated, { minTabs: 1 });
    assert.deepEqual(single[0]?.tabIds, ["same"]);
  });
});

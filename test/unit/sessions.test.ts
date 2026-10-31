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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
  CreateFolderParams,
  CreateFolderResult,
  CreateSpaceParams,
  CreateSpaceResult,
  EssentialsParams,
  EssentialsResult,
  FolderInfo,
  FoldersResult,
  OpenedTab,
  OpenTabsParams,
  OpenTabsResult,
  PinTabsParams,
  PinTabsResult,
  Space,
  SpaceInfo,
  SpacesResult,
  TabInfo,
  TabsListParams,
  TabsResult,
} from "../../src/shared/protocol.js";
import { SessionStore, type SessionHub } from "../../src/zen/sessions.js";

const tempRoot = existsSync("D:/tmp") ? "D:/tmp" : tmpdir();
const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tempRoot, "zen-mcp-sessions-"));
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

let tabSeq = 0;

function makeTab(input: Partial<TabInfo> & { url: string }): TabInfo {
  tabSeq += 1;
  return {
    id: input.id ?? `tab-${tabSeq}`,
    windowId: "win-1",
    spaceId: null,
    spaceName: null,
    title: input.title ?? input.url,
    pinned: false,
    essential: false,
    active: false,
    audible: false,
    muted: false,
    loading: false,
    folderId: null,
    folderLabel: null,
    index: tabSeq,
    ...input,
    url: input.url,
  };
}

function makeSpace(id: string, name: string, index: number): SpaceInfo {
  return {
    id,
    name,
    icon: null,
    active: index === 0,
    index,
    containerTabId: 1000 + index,
    tabCount: 0,
    pinnedCount: 0,
    folderCount: 0,
  };
}

function makeFolder(
  input: Partial<FolderInfo> & {
    id: string;
    label: string;
    spaceId: string;
  }
): FolderInfo {
  return {
    collapsed: false,
    parentId: null,
    tabIds: [],
    liveFolder: true,
    ...input,
  };
}

function toSpace(info: SpaceInfo): Space {
  return {
    id: info.id,
    name: info.name,
    icon: info.icon,
    active: info.active,
    index: info.index,
    containerTabId: info.containerTabId,
  };
}

class FakeHub implements SessionHub {
  spaces: SpaceInfo[] = [];
  tabs: TabInfo[] = [];
  folders: FolderInfo[] = [];
  calls = {
    createSpace: [] as CreateSpaceParams[],
    openTabs: [] as OpenTabsParams[],
    createFolder: [] as CreateFolderParams[],
    pinTabs: [] as PinTabsParams[],
    addEssentials: [] as EssentialsParams[],
  };

  #nextId = 1;

  #id(prefix: string): string {
    const id = `${prefix}-new-${this.#nextId}`;
    this.#nextId += 1;
    return id;
  }

  #resolve(target: string | undefined): SpaceInfo {
    const space = target
      ? this.spaces.find(
          (entry) =>
            entry.id === target ||
            entry.name.toLowerCase() === target.toLowerCase()
        )
      : this.spaces.find((entry) => entry.active) ?? this.spaces[0];
    if (!space) throw new Error("No space available in fake hub.");
    return space;
  }

  async listSpaces(_windowId?: string): Promise<SpacesResult> {
    return {
      activeSpaceId:
        this.spaces.find((space) => space.active)?.id ??
        this.spaces[0]?.id ??
        null,
      spaces: this.spaces,
      workspacesEnabled: true,
    };
  }

  async createSpace(
    params: CreateSpaceParams,
    _windowId?: string
  ): Promise<CreateSpaceResult> {
    this.calls.createSpace.push({ ...params });
    const index = this.spaces.length;
    const info: SpaceInfo = {
      id: this.#id("space"),
      name: params.name,
      icon: params.icon ?? null,
      active: params.switchTo ?? false,
      index,
      containerTabId: 2000 + index,
      tabCount: 0,
      pinnedCount: 0,
      folderCount: 0,
    };
    if (info.active) {
      for (const space of this.spaces) space.active = false;
    }
    this.spaces.push(info);
    return {
      created: true,
      space: toSpace(info),
      activeSpaceId:
        this.spaces.find((space) => space.active)?.id ?? null,
      switched: params.switchTo ?? false,
    };
  }

  async listTabs(
    params: TabsListParams,
    _windowId?: string
  ): Promise<TabsResult> {
    let tabs = this.tabs;
    if (params.space) {
      const space = this.#resolve(params.space);
      tabs = tabs.filter((tab) => tab.spaceId === space.id);
    }
    if (params.query) {
      const query = params.query.toLowerCase();
      tabs = tabs.filter(
        (tab) =>
          tab.title.toLowerCase().includes(query) ||
          tab.url.toLowerCase().includes(query)
      );
    }
    if (params.pinnedOnly) {
      tabs = tabs.filter((tab) => tab.pinned || tab.folderId !== null);
    }
    const total = tabs.length;
    if (params.limit !== undefined) {
      tabs = tabs.slice(0, params.limit);
    }
    return {
      windowId: "win-1",
      activeSpaceId:
        this.spaces.find((space) => space.active)?.id ??
        this.spaces[0]?.id ??
        null,
      total,
      tabs,
    };
  }

  async openTabs(
    params: OpenTabsParams,
    _windowId?: string
  ): Promise<OpenTabsResult> {
    this.calls.openTabs.push({ ...params, urls: [...params.urls] });
    const space = this.#resolve(params.space);
    const base = this.tabs.length;
    const opened: OpenedTab[] = params.urls.map((url, index) => {
      const tab = makeTab({
        url,
        requestedUrl: url,
        spaceId: space.id,
        spaceName: space.name,
        index: base + index,
      });
      this.tabs.push(tab);
      return { ...tab, requestedUrl: url };
    });
    return {
      space: toSpace(space),
      tabs: opened,
      background: params.background ?? true,
    };
  }

  async listFolders(_windowId?: string): Promise<FoldersResult> {
    return { folders: this.folders };
  }

  async createFolder(
    params: CreateFolderParams,
    _windowId?: string
  ): Promise<CreateFolderResult> {
    this.calls.createFolder.push({
      ...params,
      tabIds: params.tabIds ? [...params.tabIds] : undefined,
    });
    const space = this.#resolve(params.space);
    const id = this.#id("folder");
    const folder = makeFolder({
      id,
      label: params.label,
      spaceId: space.id,
      collapsed: params.collapsed ?? false,
      tabIds: params.tabIds ?? [],
    });
    this.folders.push(folder);
    for (const tab of this.tabs) {
      if (params.tabIds?.includes(tab.id)) {
        tab.folderId = id;
        tab.folderLabel = params.label;
      }
    }
    return { created: true, folder };
  }

  async pinTabs(
    params: PinTabsParams,
    _windowId?: string
  ): Promise<PinTabsResult> {
    this.calls.pinTabs.push({ ...params, tabIds: [...params.tabIds] });
    let changed = 0;
    for (const tab of this.tabs) {
      if (params.tabIds.includes(tab.id) && tab.pinned !== params.pinned) {
        tab.pinned = params.pinned;
        changed += 1;
      }
    }
    return { tabIds: [...params.tabIds], changed };
  }

  async addEssentials(
    params: EssentialsParams,
    _windowId?: string
  ): Promise<EssentialsResult> {
    this.calls.addEssentials.push({ tabIds: [...params.tabIds] });
    let changed = 0;
    for (const tab of this.tabs) {
      if (params.tabIds.includes(tab.id) && !tab.essential) {
        tab.essential = true;
        changed += 1;
      }
    }
    return { tabIds: [...params.tabIds], changed };
  }
}

describe("SessionStore", () => {
  it("snapshots spaces, tabs, folders and essentials", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [
      makeSpace("space-1", "Research", 0),
      makeSpace("space-2", "Inbox", 1),
    ];
    hub.folders = [
      makeFolder({
        id: "folder-1",
        label: "Sources",
        spaceId: "space-1",
        collapsed: true,
        tabIds: ["tab-c"],
      }),
    ];
    hub.tabs = [
      makeTab({
        id: "tab-a",
        url: "https://example.com/a",
        spaceId: "space-1",
        spaceName: "Research",
        index: 0,
      }),
      makeTab({
        id: "tab-b",
        url: "https://example.com/b",
        spaceId: "space-1",
        spaceName: "Research",
        pinned: true,
        index: 1,
      }),
      makeTab({
        id: "tab-c",
        url: "https://example.com/c",
        spaceId: "space-1",
        spaceName: "Research",
        folderId: "folder-1",
        folderLabel: "Sources",
        index: 2,
      }),
      makeTab({
        id: "tab-blank",
        url: "about:blank",
        spaceId: "space-1",
        spaceName: "Research",
        index: 3,
      }),
      makeTab({
        id: "tab-empty",
        url: "   ",
        spaceId: "space-1",
        spaceName: "Research",
        index: 4,
      }),
      makeTab({
        id: "tab-file",
        url: "file:///C:/secret.txt",
        spaceId: "space-1",
        spaceName: "Research",
        index: 5,
      }),
      makeTab({
        id: "tab-logins",
        url: "about:logins",
        spaceId: "space-1",
        spaceName: "Research",
        index: 6,
      }),
      makeTab({
        id: "tab-d",
        url: "https://example.com/d",
        spaceId: "space-2",
        spaceName: "Inbox",
        index: 0,
      }),
      makeTab({
        id: "tab-e",
        url: "https://mail.example.com/",
        essential: true,
        index: 0,
      }),
    ];

    const store = new SessionStore({ dir, hub });
    const snapshot = await store.save("Research");

    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.name, "Research");
    assert.match(snapshot.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(snapshot.spaces.length, 2);

    const research = snapshot.spaces[0]!;
    assert.equal(research.name, "Research");
    assert.equal(research.containerTabId, 1000);
    assert.deepEqual(
      research.tabs.map((tab) => tab.url),
      [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ]
    );
    assert.equal(research.tabs[1]!.pinned, true);
    assert.equal(research.tabs[2]!.folder, "Sources");
    assert.deepEqual(research.folders, [
      { label: "Sources", collapsed: true },
    ]);
    assert.equal(snapshot.spaces[1]!.tabs.length, 1);
    assert.equal(snapshot.essentials.length, 1);
    assert.equal(snapshot.essentials[0]!.url, "https://mail.example.com/");
    assert.equal(snapshot.essentials[0]!.essential, true);
  });

  it("lists summaries for every saved session", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "One", 0)];
    hub.tabs = [
      makeTab({
        url: "https://one.example/1",
        spaceId: "space-1",
        spaceName: "One",
        index: 0,
      }),
      makeTab({
        url: "https://one.example/2",
        spaceId: "space-1",
        spaceName: "One",
        index: 1,
      }),
      makeTab({
        url: "https://one.example/3",
        spaceId: "space-1",
        spaceName: "One",
        index: 2,
      }),
      makeTab({ url: "https://mail.example/", essential: true }),
    ];
    const store = new SessionStore({ dir, hub });
    await store.save("One");

    hub.spaces = [makeSpace("space-2", "Two", 0)];
    hub.tabs = [
      makeTab({
        url: "https://two.example/1",
        spaceId: "space-2",
        spaceName: "Two",
      }),
    ];
    await store.save("Two");

    const list = store.list();
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((entry) => ({
        name: entry.name,
        spaceCount: entry.spaceCount,
        tabCount: entry.tabCount,
        essentialCount: entry.essentialCount,
      })),
      [
        {
          name: "One",
          spaceCount: 1,
          tabCount: 3,
          essentialCount: 1,
        },
        {
          name: "Two",
          spaceCount: 1,
          tabCount: 1,
          essentialCount: 0,
        },
      ]
    );
  });

  it("rejects duplicate, empty and oversized names", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Research", 0)];
    hub.tabs = [
      makeTab({
        url: "https://example.com/a",
        spaceId: "space-1",
        spaceName: "Research",
      }),
    ];
    const store = new SessionStore({ dir, hub });

    await store.save("Research");
    await assert.rejects(
      () => store.save("research"),
      /already exists/i
    );
    await assert.rejects(() => store.save("   "), /cannot be empty/i);
    await assert.rejects(
      () => store.save("x".repeat(65)),
      /64 characters or fewer/
    );
    assert.equal(store.list().length, 1);
  });

  it("persists snapshots across store instances and deletes only one", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Research", 0)];
    hub.tabs = [
      makeTab({
        url: "https://example.com/a",
        spaceId: "space-1",
        spaceName: "Research",
      }),
    ];
    const store = new SessionStore({ dir, hub });
    await store.save("Research");

    assert.equal(existsSync(join(dir, "sessions.json")), true);
    assert.equal(store.path, join(dir, "sessions.json"));

    const reopened = new SessionStore({ dir, hub });
    assert.equal(reopened.get("RESEARCH")!.name, "Research");
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.delete("research"), true);
    assert.equal(reopened.get("Research"), null);
    assert.equal(reopened.delete("Research"), false);
  });

  it("reuses an existing space and skips URLs already open there", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Research", 0)];
    const existing = makeTab({
      url: "https://example.com/a",
      spaceId: "space-1",
      spaceName: "Research",
      index: 0,
    });
    hub.tabs = [
      existing,
      makeTab({
        url: "https://example.com/b",
        spaceId: "space-1",
        spaceName: "Research",
        index: 1,
      }),
      makeTab({
        url: "https://example.com/c",
        spaceId: "space-1",
        spaceName: "Research",
        index: 2,
      }),
    ];
    const store = new SessionStore({ dir, hub });
    await store.save("Research");

    hub.tabs = [{ ...existing }];
    hub.calls.openTabs.length = 0;

    const result = await store.restore("Research");

    assert.equal(result.spacesReused, 1);
    assert.equal(result.spacesCreated, 0);
    assert.equal(hub.calls.createSpace.length, 0);
    assert.equal(hub.calls.openTabs.length, 1);
    assert.deepEqual(hub.calls.openTabs[0]!.urls, [
      "https://example.com/b",
      "https://example.com/c",
    ]);
    assert.equal(hub.calls.openTabs[0]!.space, "space-1");
    assert.equal(hub.calls.openTabs[0]!.background, true);
    assert.equal(hub.calls.openTabs[0]!.switchTo, false);
    assert.equal(result.tabsOpened, 2);
    assert.equal(result.tabsSkipped, 1);
  });

  it("creates a missing space and restores folders, pins and essentials", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    const research = makeSpace("space-1", "Research", 0);
    research.icon = "🔬";
    hub.spaces = [research];
    hub.folders = [
      makeFolder({
        id: "folder-1",
        label: "Sources",
        spaceId: "space-1",
        collapsed: true,
        tabIds: ["tab-a", "tab-b"],
      }),
    ];
    hub.tabs = [
      makeTab({
        id: "tab-a",
        url: "https://example.com/a",
        spaceId: "space-1",
        spaceName: "Research",
        pinned: true,
        folderId: "folder-1",
        folderLabel: "Sources",
        index: 0,
      }),
      makeTab({
        id: "tab-b",
        url: "https://example.com/b",
        spaceId: "space-1",
        spaceName: "Research",
        folderId: "folder-1",
        folderLabel: "Sources",
        index: 1,
      }),
      makeTab({
        id: "tab-e",
        url: "https://mail.example.com/",
        essential: true,
        index: 2,
      }),
    ];
    const store = new SessionStore({ dir, hub });
    await store.save("Research");

    hub.spaces = [];
    hub.tabs = [];
    hub.folders = [];
    hub.calls.openTabs.length = 0;

    const result = await store.restore("Research", { switchTo: true });

    assert.equal(result.spacesCreated, 1);
    assert.equal(result.spacesReused, 0);
    assert.equal(result.foldersCreated, 1);
    assert.equal(result.essentialsAdded, 1);
    assert.equal(result.tabsOpened, 3);
    assert.deepEqual(result.warnings, []);

    const createCall = hub.calls.createSpace[0]!;
    assert.equal(createCall.name, "Research");
    assert.equal(createCall.icon, "🔬");
    assert.equal(createCall.switchTo, true);
    const created = hub.spaces[0]!;

    assert.equal(hub.calls.openTabs.length, 2);
    assert.equal(hub.calls.openTabs[0]!.space, created.id);
    assert.equal(hub.calls.openTabs[0]!.background, true);
    assert.equal(hub.calls.openTabs[0]!.switchTo, false);
    assert.equal(hub.calls.openTabs[1]!.space, created.id);

    const tabA = hub.tabs.find(
      (tab) => tab.url === "https://example.com/a"
    )!;
    const tabB = hub.tabs.find(
      (tab) => tab.url === "https://example.com/b"
    )!;
    assert.equal(tabA.pinned, true);
    assert.equal(tabB.pinned, false);
    assert.deepEqual(hub.calls.pinTabs[0]!.tabIds, [tabA.id]);

    const folderCall = hub.calls.createFolder[0]!;
    assert.equal(folderCall.label, "Sources");
    assert.equal(folderCall.space, created.id);
    assert.equal(folderCall.collapsed, true);
    assert.deepEqual(
      [...folderCall.tabIds!].sort(),
      [tabA.id, tabB.id].sort()
    );

    const essentialTab = hub.tabs.find(
      (tab) => tab.url === "https://mail.example.com/"
    )!;
    assert.equal(essentialTab.essential, true);
    assert.deepEqual(hub.calls.addEssentials[0]!.tabIds, [
      essentialTab.id,
    ]);
  });

  it("suffixes the space name when newSpaces is set", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Research", 0)];
    hub.tabs = [
      makeTab({
        url: "https://example.com/a",
        spaceId: "space-1",
        spaceName: "Research",
      }),
    ];
    const store = new SessionStore({ dir, hub });
    await store.save("Research");

    const result = await store.restore("Research", { newSpaces: true });

    assert.equal(result.spacesCreated, 1);
    assert.equal(result.spacesReused, 0);
    assert.equal(hub.calls.createSpace[0]!.name, "Research (restored)");
    assert.equal(hub.spaces.length, 2);
  });

  it("opens missing tabs in batches of 30 and honours maxTabs", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Bulk", 0)];
    hub.tabs = Array.from({ length: 35 }, (_, index) =>
      makeTab({
        url: `https://example.com/${index}`,
        spaceId: "space-1",
        spaceName: "Bulk",
        index,
      })
    );
    const store = new SessionStore({ dir, hub });
    await store.save("Bulk");

    hub.tabs = [];
    hub.calls.openTabs.length = 0;

    const result = await store.restore("Bulk", { maxTabs: 32 });

    assert.deepEqual(
      hub.calls.openTabs.map((call) => call.urls.length),
      [30, 2]
    );
    assert.equal(result.tabsOpened, 32);
    assert.equal(result.tabsSkipped, 3);
    assert.ok(
      result.warnings.some((warning) => /limited to 32/.test(warning))
    );
  });

  it("names the file when sessions.json is corrupt", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.json"), "{ nope", "utf8");
    const store = new SessionStore({ dir, hub: new FakeHub() });

    assert.throws(
      () => store.list(),
      /Could not parse .*sessions\.json/
    );
  });

  it("ignores malformed entries instead of breaking every session", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            name: "Good",
            createdAt: "2026-01-01T00:00:00.000Z",
            spaces: [
              {
                name: "Space",
                icon: null,
                containerTabId: 1,
                tabs: [
                  {
                    url: "https://example.com/good",
                    title: "Good tab",
                    pinned: false,
                    essential: false,
                    folder: null,
                  },
                ],
                folders: [],
              },
            ],
            essentials: [],
          },
          { name: 42 },
          null,
          "not a session",
          {
            name: "Bad",
            createdAt: "2026-01-01T00:00:00.000Z",
            spaces: "not an array",
            essentials: [],
          },
        ],
      }),
      "utf8"
    );
    const store = new SessionStore({ dir, hub: new FakeHub() });

    assert.deepEqual(
      store.list().map((entry) => entry.name),
      ["Good", "Bad"]
    );
    assert.equal(
      store.get("Good")!.spaces[0]!.tabs[0]!.url,
      "https://example.com/good"
    );
    assert.deepEqual(store.get("Bad")!.spaces, []);
  });

  it("keeps concurrent saves without losing a session", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "One", 0)];
    hub.tabs = [
      makeTab({
        url: "https://one.example/",
        spaceId: "space-1",
        spaceName: "One",
      }),
    ];
    const store = new SessionStore({ dir, hub });

    await Promise.all([store.save("First"), store.save("Second")]);

    assert.deepEqual(
      store.list().map((entry) => entry.name).sort(),
      ["First", "Second"]
    );
  });

  it("allows only one of two concurrent saves with the same name", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "One", 0)];
    hub.tabs = [
      makeTab({
        url: "https://one.example/",
        spaceId: "space-1",
        spaceName: "One",
      }),
    ];
    const store = new SessionStore({ dir, hub });

    const results = await Promise.allSettled([
      store.save("Twin"),
      store.save("Twin"),
    ]);

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal(store.list().length, 1);
  });

  it(
    "refuses to write through a symlinked sessions file",
    { skip: process.platform === "win32" },
    async () => {
      const dir = tempDir();
      mkdirSync(dir, { recursive: true });
      const outside = join(dir, "outside.json");
      writeFileSync(
        outside,
        JSON.stringify({ version: 1, sessions: [] }),
        "utf8"
      );
      symlinkSync(outside, join(dir, "sessions.json"));
      const hub = new FakeHub();
      hub.spaces = [makeSpace("space-1", "One", 0)];
      hub.tabs = [
        makeTab({
          url: "https://one.example/",
          spaceId: "space-1",
          spaceName: "One",
        }),
      ];
      const store = new SessionStore({ dir, hub });

      await assert.rejects(() => store.save("One"), /symbolic link/i);
      assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")).sessions, []);
    }
  );

  it(
    "writes sessions with owner-only permissions",
    { skip: process.platform === "win32" },
    async () => {
      const dir = join(tempDir(), "nested");
      const hub = new FakeHub();
      hub.spaces = [makeSpace("space-1", "One", 0)];
      hub.tabs = [
        makeTab({
          url: "https://one.example/",
          spaceId: "space-1",
          spaceName: "One",
        }),
      ];
      const store = new SessionStore({ dir, hub });
      await store.save("One");

      assert.equal(statSync(store.path).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
  );
});

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
  FolderInfo,
  FoldersResult,
  OpenedTab,
  OpenTabsParams,
  OpenTabsResult,
  Space,
  SpaceInfo,
  SpacesResult,
  TabInfo,
  TabsListParams,
  TabsResult,
} from "../../src/shared/protocol.js";
import {
  BUILTIN_TEMPLATES,
  TemplateStore,
  type TemplateHub,
} from "../../src/zen/templates.js";

const tempRoot = existsSync("D:/tmp") ? "D:/tmp" : tmpdir();
const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tempRoot, "zen-mcp-templates-"));
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

class FakeHub implements TemplateHub {
  spaces: SpaceInfo[] = [];
  tabs: TabInfo[] = [];
  folders: FolderInfo[] = [];
  calls = {
    createSpace: [] as CreateSpaceParams[],
    openTabs: [] as OpenTabsParams[],
    createFolder: [] as CreateFolderParams[],
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

  async listTabs(
    params: TabsListParams,
    _windowId?: string
  ): Promise<TabsResult> {
    let tabs = this.tabs;
    if (params.space) {
      const space = this.#resolve(params.space);
      tabs = tabs.filter((tab) => tab.spaceId === space.id);
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

  async listFolders(_windowId?: string): Promise<FoldersResult> {
    return { folders: this.folders };
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
      containerTabId: 3000 + index,
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

  async createFolder(
    params: CreateFolderParams,
    _windowId?: string
  ): Promise<CreateFolderResult> {
    this.calls.createFolder.push({
      ...params,
      tabIds: params.tabIds ? [...params.tabIds] : undefined,
    });
    const space = this.#resolve(params.space);
    const folder = makeFolder({
      id: this.#id("folder"),
      label: params.label,
      spaceId: space.id,
      collapsed: params.collapsed ?? false,
      tabIds: params.tabIds ?? [],
    });
    this.folders.push(folder);
    return { created: true, folder };
  }
}

describe("TemplateStore", () => {
  it("lists built-in templates first with unique URLs", () => {
    const dir = tempDir();
    const store = new TemplateStore({ dir, hub: new FakeHub() });

    const list = store.list();
    assert.equal(list.length, BUILTIN_TEMPLATES.length);
    assert.deepEqual(
      list.map((template) => template.name),
      ["research", "github-triage", "news", "docs"]
    );

    for (const template of list) {
      assert.equal(template.builtIn, true);
      assert.ok(template.icon);
      assert.ok(template.description.length > 0);
      const urls = [
        ...template.looseUrls,
        ...template.folders.flatMap((folder) => folder.urls),
      ];
      assert.equal(new Set(urls).size, urls.length);
    }

    const research = store.get("RESEARCH")!;
    assert.deepEqual(research.folders, [
      {
        label: "Sources",
        urls: [
          "https://en.wikipedia.org",
          "https://arxiv.org",
          "https://scholar.google.com",
          "https://www.semanticscholar.org",
        ],
      },
    ]);
    assert.equal(store.get("missing"), null);
  });

  it("saves a live space as a user template and persists it", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Docs", 0)];
    hub.folders = [
      makeFolder({
        id: "folder-1",
        label: "Reference",
        spaceId: "space-1",
      }),
    ];
    hub.tabs = [
      makeTab({
        url: "https://developer.mozilla.org",
        spaceId: "space-1",
        spaceName: "Docs",
        folderId: "folder-1",
        folderLabel: "Reference",
        index: 0,
      }),
      makeTab({
        url: "https://caniuse.com",
        spaceId: "space-1",
        spaceName: "Docs",
        folderId: "folder-1",
        folderLabel: "Reference",
        index: 1,
      }),
      makeTab({
        url: "https://stackoverflow.com",
        spaceId: "space-1",
        spaceName: "Docs",
        index: 2,
      }),
      makeTab({
        url: "about:blank",
        spaceId: "space-1",
        spaceName: "Docs",
        index: 3,
      }),
      makeTab({
        url: "https://mail.example.com/",
        essential: true,
        index: 4,
      }),
      makeTab({
        url: "https://other.example/",
        spaceId: "space-2",
        spaceName: "Other",
        index: 0,
      }),
    ];

    const store = new TemplateStore({ dir, hub });
    const saved = await store.saveFromSpace("docs", "My Docs", {
      description: "Personal references",
      icon: "📘",
    });

    assert.equal(saved.name, "My Docs");
    assert.equal(saved.label, "My Docs");
    assert.equal(saved.description, "Personal references");
    assert.equal(saved.icon, "📘");
    assert.equal(saved.builtIn, false);
    assert.match(saved.createdAt!, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(saved.folders, [
      {
        label: "Reference",
        urls: ["https://developer.mozilla.org", "https://caniuse.com"],
      },
    ]);
    assert.deepEqual(saved.looseUrls, ["https://stackoverflow.com"]);

    assert.equal(existsSync(join(dir, "templates.json")), true);
    assert.equal(store.path, join(dir, "templates.json"));

    const reopened = new TemplateStore({ dir, hub });
    const list = reopened.list();
    assert.equal(list.length, BUILTIN_TEMPLATES.length + 1);
    assert.equal(list[0]!.name, "research");
    assert.equal(list.at(-1)!.name, "My Docs");
    assert.equal(reopened.get("MY DOCS")!.description, "Personal references");
  });

  it("applies a template in batches and groups folder tabs", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    const loose = Array.from(
      { length: 31 },
      (_, index) => `https://example.com/${index}`
    );
    const folderUrls = [
      "https://ref.example/a",
      "https://ref.example/b",
    ];
    const userTemplate = {
      name: "bulk",
      label: "Bulk",
      description: "",
      icon: "🗂️",
      builtIn: false,
      folders: [{ label: "Refs", urls: folderUrls }],
      looseUrls: [...loose, "ftp://example.com/file"],
    };
    writeFileSync(
      join(dir, "templates.json"),
      JSON.stringify({ version: 1, templates: [userTemplate] }),
      "utf8"
    );

    const store = new TemplateStore({ dir, hub });
    const result = await store.apply("bulk");

    assert.equal(result.template, "bulk");
    assert.equal(result.space.name, "Bulk");
    assert.equal(result.tabsOpened, 33);
    assert.equal(result.foldersCreated, 1);
    assert.equal(result.tabsFailed, 1);
    assert.ok(
      result.warnings.some((warning) => /non-http/.test(warning))
    );

    const createCall = hub.calls.createSpace[0]!;
    assert.equal(createCall.name, "Bulk");
    assert.equal(createCall.icon, "🗂️");
    assert.deepEqual(
      hub.calls.openTabs.map((call) => call.urls.length),
      [30, 1, 2]
    );
    for (const call of hub.calls.openTabs) {
      assert.equal(call.space, result.space.id);
      assert.equal(call.background, true);
      assert.equal(call.switchTo, false);
      assert.ok(call.urls.length <= 30);
    }

    const folderCall = hub.calls.createFolder[0]!;
    assert.equal(folderCall.label, "Refs");
    assert.equal(folderCall.space, result.space.id);
    assert.equal(folderCall.collapsed, false);
    const folderTabIds = hub.tabs
      .filter((tab) => folderUrls.includes(tab.url))
      .map((tab) => tab.id);
    assert.deepEqual(
      [...folderCall.tabIds!].sort(),
      folderTabIds.sort()
    );
    assert.equal(hub.tabs.length, 33);
  });

  it("picks the next free space name case-insensitively", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [
      makeSpace("space-1", "Research", 0),
      makeSpace("space-2", "research 2", 1),
    ];
    const store = new TemplateStore({ dir, hub });

    const result = await store.apply("research", {
      spaceName: "Research",
    });

    assert.equal(result.space.name, "Research 3");
    assert.equal(hub.calls.createSpace[0]!.name, "Research 3");
  });

  it("refuses to delete built-ins but removes user templates", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Scratch", 0)];
    hub.tabs = [
      makeTab({
        url: "https://example.com/",
        spaceId: "space-1",
        spaceName: "Scratch",
      }),
    ];
    const store = new TemplateStore({ dir, hub });
    await store.saveFromSpace("Scratch", "Scratch copy");

    assert.throws(
      () => store.delete("RESEARCH"),
      /Built-in template .* cannot be deleted/
    );
    assert.equal(store.delete("scratch copy"), true);
    assert.equal(store.get("Scratch copy"), null);
    assert.equal(store.delete("scratch copy"), false);
    assert.ok(store.get("research"));
  });

  it("names the file when templates.json is corrupt", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "templates.json"), "{ nope", "utf8");
    const store = new TemplateStore({ dir, hub: new FakeHub() });

    assert.throws(
      () => store.list(),
      /Could not parse .*templates\.json/
    );
  });

  it("ignores malformed entries and bounds stored URLs", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "templates.json"),
      JSON.stringify({
        version: 1,
        templates: [
          {
            name: "Good",
            label: "Good label",
            description: "desc",
            icon: "📦",
            builtIn: true,
            folders: [
              {
                label: "Refs",
                urls: [
                  "https://ref.example/a",
                  42,
                  "",
                  `https://ref.example/${"x".repeat(5000)}`,
                ],
              },
            ],
            looseUrls: ["https://loose.example/", null, 7],
          },
          { name: 42 },
          null,
          "not a template",
          { name: "research", folders: [], looseUrls: [] },
          { name: "   ", folders: [], looseUrls: [] },
          {
            name: "No folders",
            folders: "nope",
            looseUrls: ["https://only.example/"],
          },
        ],
      }),
      "utf8"
    );
    const store = new TemplateStore({ dir, hub: new FakeHub() });

    assert.deepEqual(
      store.list().map((entry) => entry.name),
      [
        ...BUILTIN_TEMPLATES.map((entry) => entry.name),
        "Good",
        "No folders",
      ]
    );
    const good = store.get("Good")!;
    assert.equal(good.builtIn, false);
    assert.deepEqual(good.folders, [
      { label: "Refs", urls: ["https://ref.example/a"] },
    ]);
    assert.deepEqual(good.looseUrls, ["https://loose.example/"]);
    assert.deepEqual(store.get("No folders")!.folders, []);
    assert.deepEqual(store.get("No folders")!.looseUrls, [
      "https://only.example/",
    ]);
  });

  it("keeps concurrent saves of different templates", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Scratch", 0)];
    hub.tabs = [
      makeTab({
        url: "https://example.com/",
        spaceId: "space-1",
        spaceName: "Scratch",
      }),
    ];
    const store = new TemplateStore({ dir, hub });

    await Promise.all([
      store.saveFromSpace("Scratch", "Copy A"),
      store.saveFromSpace("Scratch", "Copy B"),
    ]);

    assert.deepEqual(
      store
        .list()
        .filter((entry) => !entry.builtIn)
        .map((entry) => entry.name)
        .sort(),
      ["Copy A", "Copy B"]
    );
  });

  it("allows only one of two concurrent saves with the same name", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    hub.spaces = [makeSpace("space-1", "Scratch", 0)];
    hub.tabs = [
      makeTab({
        url: "https://example.com/",
        spaceId: "space-1",
        spaceName: "Scratch",
      }),
    ];
    const store = new TemplateStore({ dir, hub });

    const results = await Promise.allSettled([
      store.saveFromSpace("Scratch", "Twin"),
      store.saveFromSpace("Scratch", "Twin"),
    ]);

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal(
      store.list().filter((entry) => !entry.builtIn).length,
      1
    );
  });

  it(
    "refuses to write through a symlinked templates file",
    { skip: process.platform === "win32" },
    async () => {
      const dir = tempDir();
      mkdirSync(dir, { recursive: true });
      const outside = join(dir, "outside.json");
      writeFileSync(
        outside,
        JSON.stringify({ version: 1, templates: [] }),
        "utf8"
      );
      symlinkSync(outside, join(dir, "templates.json"));
      const hub = new FakeHub();
      hub.spaces = [makeSpace("space-1", "Scratch", 0)];
      hub.tabs = [
        makeTab({
          url: "https://example.com/",
          spaceId: "space-1",
          spaceName: "Scratch",
        }),
      ];
      const store = new TemplateStore({ dir, hub });

      await assert.rejects(
        () => store.saveFromSpace("Scratch", "Copy"),
        /symbolic link/i
      );
      assert.deepEqual(
        JSON.parse(readFileSync(outside, "utf8")).templates,
        []
      );
    }
  );

  it(
    "writes templates with owner-only permissions",
    { skip: process.platform === "win32" },
    async () => {
      const dir = join(tempDir(), "nested");
      const hub = new FakeHub();
      hub.spaces = [makeSpace("space-1", "Scratch", 0)];
      hub.tabs = [
        makeTab({
          url: "https://example.com/",
          spaceId: "space-1",
          spaceName: "Scratch",
        }),
      ];
      const store = new TemplateStore({ dir, hub });
      await store.saveFromSpace("Scratch", "Copy");

      assert.equal(statSync(store.path).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
  );
});

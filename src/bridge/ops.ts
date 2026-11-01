import type {
  AddTabsToFolderParams,
  AddTabsToFolderResult,
  BookmarksResult,
  BookmarksSearchParams,
  BridgeMethod,
  BridgeMethodMap,
  BridgeStatus,
  ClipboardWriteParams,
  ClipboardWriteResult,
  CloseTabsParams,
  CloseTabsResult,
  ContainerInfo,
  ContainersResult,
  CreateFolderParams,
  CreateFolderResult,
  CreateSpaceParams,
  CreateSpaceResult,
  DeleteSpaceResult,
  EssentialsParams,
  EssentialsResult,
  EvidenceClearParams,
  EvidenceClearResult,
  EvidenceErrorCode,
  EvidenceOpResult,
  EvidenceShowParams,
  FolderInfo,
  FoldersResult,
  GlanceParams,
  GlanceResult,
  HistoryEntry,
  HistoryGroup,
  HistoryResult,
  HistorySearchParams,
  OpenTabsParams,
  OpenTabsResult,
  OpenedTab,
  PageReadResult,
  PinTabsParams,
  PinTabsResult,
  RecentlyClosedEntry,
  RecentlyClosedResult,
  SelectTabParams,
  SelectTabResult,
  Space,
  SpaceInfo,
  SpacesResult,
  SpaceTargetParams,
  SplitParams,
  SplitResult,
  SwitchSpaceParams,
  SwitchSpaceResult,
  TabReadParams,
  TabInfo,
  TabsListParams,
  TabsResult,
  TextSearchParams,
  TextSearchResult,
  UnsplitParams,
  UnsplitResult,
} from "../shared/protocol.js";
import {
  buildReadScript,
  coercePageSnapshot,
  toPageReadResult,
} from "../shared/read-script.js";
import {
  buildEvidenceClearScript,
  buildEvidenceHighlightScript,
  buildEvidenceIndexScript,
  buildEvidenceStateScript,
  coerceEvidenceClear,
  coerceEvidenceHighlight,
  coerceEvidenceIndex,
  coerceEvidenceState,
  createEvidenceMarker,
} from "../shared/evidence-script.js";
import { findEvidenceQuote } from "../shared/evidence.js";
import { findLiteralMatches } from "../shared/search.js";

type ChromeWindow = any;
type ChromeTab = any;
type ChromeFolder = any;
type ChromeSpace = any;

const MAX_TABS_PER_OPEN = 30;
const MAX_RESULTS = 100;
/** Rows scanned before the post-query domain filter is applied. */
const HISTORY_SCAN_LIMIT = 200;
const MAX_CLIPBOARD_CHARS = 1_048_576;
const PDF_WAIT_MS = 8_000;
const EVIDENCE_WAIT_MS = 12_000;
const EVIDENCE_POLL_MS = 250;
const EVIDENCE_SETTLE_MS = 200;
const EVIDENCE_MAX_TEXT = 600_000;
const EVIDENCE_HIGHLIGHT_MS = 20_000;
const EVIDENCE_MAX_ATTEMPTS = 3;

function isHttpUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

function isPrivilegedUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return [
      "about:",
      "chrome:",
      "resource:",
      "view-source:",
      "moz-extension:",
      "javascript:",
    ].includes(scheme);
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class OpsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Operations executed inside a Zen browser window with full chrome access.
 * Values are returned as plain objects so they can cross the WebSocket as JSON.
 */
export function createOps(win: ChromeWindow, windowId: string) {
  const tabIds = new WeakMap<ChromeTab, string>();
  const tabsById = new Map<string, ChromeTab>();
  /** Overlay attribute names created by this bridge session, per tab. */
  const evidenceMarkers = new Map<string, string[]>();

  const markersFor = (tabId: string): string[] =>
    evidenceMarkers.get(tabId) ?? [];
  const rememberMarkers = (tabId: string, markers: string[]): void => {
    if (markers.length === 0) {
      evidenceMarkers.delete(tabId);
      return;
    }
    evidenceMarkers.set(tabId, markers.slice(-20));
  };

  const idForTab = (tab: ChromeTab): string => {
    let id = tabIds.get(tab);
    if (!id) {
      id = `tab-${crypto.randomUUID().slice(0, 8)}`;
      tabIds.set(tab, id);
      tabsById.set(id, tab);
    }
    return id;
  };

  const pruneTabIds = (): void => {
    for (const [id, tab] of tabsById) {
      if (!tab.isConnected || tab.closing) tabsById.delete(id);
    }
  };

  const workspaces = (): any => {
    const manager = win.gZenWorkspaces;
    if (!manager) {
      throw new OpsError("zen_not_ready", "Zen workspaces are not available yet");
    }
    return manager;
  };

  const spacesEnabled = (): boolean => {
    try {
      return !!win.gZenWorkspaces?.shouldHaveWorkspaces;
    } catch {
      return false;
    }
  };

  const listSpaces = (): ChromeSpace[] => {
    if (!spacesEnabled()) return [];
    return win.gZenWorkspaces.getWorkspaces();
  };

  const findSpace = (target: string | undefined): ChromeSpace | null => {
    if (!target) {
      return win.gZenWorkspaces?.getActiveWorkspaceFromCache?.() ?? null;
    }
    const needle = target.trim().toLowerCase();
    if (!needle) return null;
    return (
      listSpaces().find(
        (space: ChromeSpace) =>
          space.uuid === target || space.name?.toLowerCase() === needle
      ) ?? null
    );
  };

  const requireSpace = (target: string, action: string): ChromeSpace => {
    const space = findSpace(target);
    if (!space) {
      const names = listSpaces()
        .map((candidate: ChromeSpace) => candidate.name)
        .filter(Boolean)
        .slice(0, 12);
      throw new OpsError(
        "space_not_found",
        `Could not ${action}: no space matches "${target}". Known spaces: ${
          names.length ? names.join(", ") : "(none)"
        }.`
      );
    }
    return space;
  };

  const spaceName = (spaceId: string | null): string | null => {
    if (!spaceId) return null;
    return (
      listSpaces().find((space: ChromeSpace) => space.uuid === spaceId)?.name ??
      null
    );
  };

  const collectTabs = (): ChromeTab[] => {
    pruneTabIds();
    const seen = new Set<ChromeTab>();
    const tabs: ChromeTab[] = [];
    const add = (tab: ChromeTab) => {
      if (!tab || seen.has(tab)) return;
      if (tab.closing) return;
      seen.add(tab);
      tabs.push(tab);
    };

    // The DOM contains tabs from every space, including hidden ones.
    for (const tab of win.document.querySelectorAll("tab.tabbrowser-tab")) {
      add(tab);
    }
    try {
      for (const tab of win.gZenWorkspaces?.allStoredTabs ?? []) add(tab);
    } catch {
      // Workspaces may still be initializing.
    }
    for (const tab of win.gBrowser?.tabs ?? []) add(tab);
    return tabs;
  };

  const realTabs = (): ChromeTab[] =>
    collectTabs().filter((tab: ChromeTab) => !tab.hasAttribute("zen-empty-tab"));

  const tabUrl = (tab: ChromeTab): string => {
    try {
      return tab.linkedBrowser?.currentURI?.spec ?? tab.getAttribute("zen-url") ?? "";
    } catch {
      return "";
    }
  };

  const tabTitle = (tab: ChromeTab): string => {
    const label = tab.label || tab.linkedBrowser?.contentTitle;
    if (label) return String(label);
    const url = tabUrl(tab);
    return url || "(untitled tab)";
  };

  const containerIdOf = (tab: ChromeTab): number =>
    Number(tab.userContextId ?? tab.getAttribute("usercontextid") ?? 0) || 0;

  const isEssentialTab = (tab: ChromeTab): boolean =>
    tab.hasAttribute("zen-essential") ||
    tab.getAttribute("zen-essential") === "true";

  const folderOf = (tab: ChromeTab): ChromeFolder | null => {
    const group = tab.group;
    if (!group) return null;
    return group.isZenFolder || group.tagName?.toLowerCase() === "zen-folder"
      ? group
      : null;
  };

  const tabInfo = (tab: ChromeTab, index: number): TabInfo => {
    const spaceId: string | null = tab.getAttribute("zen-workspace-id") || null;
    const folder = folderOf(tab);
    return {
      id: idForTab(tab),
      windowId,
      spaceId,
      spaceName: spaceName(spaceId),
      title: tabTitle(tab),
      url: tabUrl(tab),
      requestedUrl: tabUrl(tab),
      pinned: !!tab.pinned,
      essential: isEssentialTab(tab),
      active: !!tab.selected,
      audible: tab.hasAttribute("soundplaying"),
      muted: !!tab.muted || tab.hasAttribute("muted"),
      loading: tab.hasAttribute("busy"),
      folderId: folder?.id ?? null,
      folderLabel: folder?.label ?? null,
      index,
      lastAccessed: Number(tab.lastAccessed) || null,
      containerId: containerIdOf(tab),
      splitView: !!tab.splitView,
    };
  };

  const allSpaceInfo = (): SpaceInfo[] => {
    const tabs = realTabs();
    const folders = collectFolders();
    return listSpaces().map((space: ChromeSpace, index: number) => {
      const spaceTabs = tabs.filter(
        (tab: ChromeTab) => tab.getAttribute("zen-workspace-id") === space.uuid
      );
      return {
        id: space.uuid,
        name: space.name,
        icon: space.icon ?? null,
        active: space.uuid === win.gZenWorkspaces.activeWorkspace,
        index,
        containerTabId: space.containerTabId ?? 0,
        tabCount: spaceTabs.length,
        pinnedCount: spaceTabs.filter((tab: ChromeTab) => tab.pinned).length,
        folderCount: folders.filter(
          (folder: ChromeFolder) =>
            folder.getAttribute("zen-workspace-id") === space.uuid
        ).length,
      };
    });
  };

  const spaceInfoFor = (space: ChromeSpace): Space => ({
    id: space.uuid,
    name: space.name,
    icon: space.icon ?? null,
    active: space.uuid === win.gZenWorkspaces?.activeWorkspace,
    index: Math.max(
      0,
      listSpaces().findIndex((candidate: ChromeSpace) => candidate.uuid === space.uuid)
    ),
    containerTabId: space.containerTabId ?? 0,
  });

  const collectFolders = (): ChromeFolder[] =>
    [...win.document.querySelectorAll("zen-folder")].filter(
      (folder: ChromeFolder) => !folder.closing
    );

  const folderInfo = (folder: ChromeFolder): FolderInfo => ({
    id: folder.id,
    label: folder.label ?? "",
    spaceId: folder.getAttribute("zen-workspace-id") ?? "",
    collapsed: !!folder.collapsed,
    parentId: folder.parentElement?.closest("zen-folder")?.id ?? null,
    tabIds: (folder.tabs ?? [])
      .filter(
        (tab: ChromeTab) =>
          !tab.hasAttribute("zen-empty-tab") && !tab.closing
      )
      .map((tab: ChromeTab) => idForTab(tab)),
    liveFolder: !!folder.isLiveFolder,
  });

  const resolveTabs = (ids: string[]): ChromeTab[] => {
    const tabs: ChromeTab[] = [];
    for (const id of ids) {
      const tab = tabsById.get(id);
      if (!tab || !tab.isConnected || tab.closing) {
        throw new OpsError(
          "tab_not_found",
          `No open tab matches id "${id}". Tab ids are stable only while the tab is open; call zen_tabs_list again.`
        );
      }
      tabs.push(tab);
    }
    return tabs;
  };

  const normalizeUrl = (input: string): string => {
    const trimmed = String(input ?? "").trim();
    if (!trimmed) throw new OpsError("invalid_url", "Empty URL");
    let candidate = trimmed;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      candidate = `https://${candidate}`;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new OpsError("invalid_url", `Not a valid URL: ${input}`);
    }
    if (!["http:", "https:", "about:"].includes(parsed.protocol)) {
      throw new OpsError(
        "invalid_url",
        `Refusing to open ${parsed.protocol} URL. Zen MCP only opens http(s) and about: URLs.`
      );
    }
    return parsed.href;
  };

  const contextualIdentityService = (): any => {
    try {
      if (win.ContextualIdentityService) return win.ContextualIdentityService;
    } catch {
      // Fall through to the bare global.
    }
    try {
      if (typeof ContextualIdentityService !== "undefined") {
        return ContextualIdentityService;
      }
    } catch {
      // The service is not exposed on this window.
    }
    return null;
  };

  const containerIdentities = (): ContainerInfo[] => {
    const service = contextualIdentityService();
    if (!service || typeof service.getPublicIdentities !== "function") {
      return [];
    }
    try {
      const identities = service.getPublicIdentities() ?? [];
      if (!Array.isArray(identities)) return [];
      return identities.map((identity: any) => {
        const userContextId = Number(identity?.userContextId ?? 0) || 0;
        return {
          userContextId,
          name: String(identity?.name ?? ""),
          icon: String(identity?.icon ?? ""),
          color: String(identity?.color ?? ""),
          public: userContextId > 0 && identity?.public !== false,
        } satisfies ContainerInfo;
      });
    } catch {
      return [];
    }
  };

  const resolveContainer = (
    target: string | number | undefined | null
  ): ContainerInfo => {
    const identities = containerIdentities();
    const names = identities
      .filter((identity) => identity.userContextId > 0)
      .map((identity) => identity.name || `#${identity.userContextId}`)
      .filter(Boolean);
    const known = names.length ? names.join(", ") : "(none)";
    if (!identities.length) {
      throw new OpsError(
        "container_not_found",
        `Firefox containers are not available in this window. Known containers: ${known}.`
      );
    }
    const raw = String(target ?? "").trim();
    let match: ContainerInfo | undefined;
    if (/^\d+$/.test(raw)) {
      const userContextId = Number(raw);
      match = identities.find(
        (identity) => identity.userContextId === userContextId
      );
    }
    if (!match && raw) {
      const needle = raw.toLowerCase();
      match = identities.find(
        (identity) => identity.name.toLowerCase() === needle
      );
    }
    if (!match) {
      throw new OpsError(
        "container_not_found",
        `No container matches "${raw}". Known containers: ${known}.`
      );
    }
    return match;
  };

  const contentTypeOf = (tab: ChromeTab): string | null => {
    try {
      const value = tab.linkedBrowser?.contentDocument?.contentType;
      return value ? String(value) : null;
    } catch {
      return null;
    }
  };

  const isPdfUrl = (url: string): boolean =>
    url.split("#")[0].split("?")[0].toLowerCase().endsWith(".pdf");

  const isPdfTab = (tab: ChromeTab): boolean => {
    const contentType = contentTypeOf(tab);
    if (contentType && contentType.toLowerCase().includes("pdf")) return true;
    return isPdfUrl(tabUrl(tab));
  };

  /**
   * Runs a fixed script inside a tab's content process. Unlike Marionette's
   * content context this also reaches tabs in inactive spaces, and the agent
   * never supplies the script text.
   */
  const runEvidenceScript = async (
    tab: ChromeTab,
    script: string,
    timeoutMs: number
  ): Promise<unknown> => {
    const global = tab.linkedBrowser?.browsingContext?.currentWindowGlobal;
    if (!global) {
      throw new OpsError(
        "tab_not_loaded",
        `The tab "${tabTitle(tab)}" has not loaded a page yet.`
      );
    }
    const actor =
      typeof global.getActor === "function"
        ? global.getActor("MarionetteCommands")
        : null;
    if (!actor) {
      throw new OpsError(
        "actor_unavailable",
        "Zen MCP's Marionette session does not expose background page " +
          "access in this window. Restart Zen with zen_launch."
      );
    }
    return actor.sendQuery("MarionetteCommandsParent:executeScript", {
      script,
      args: [],
      opts: { timeout: timeoutMs },
    });
  };

  /**
   * PDF.js exposes `PDFViewerApplication` on the viewer's content window. It is
   * reachable from chrome, but only once the document has been parsed.
   */
  const waitForPdfApplication = async (
    browser: ChromeTab
  ): Promise<any | null> => {
    const deadline = Date.now() + PDF_WAIT_MS;
    for (;;) {
      try {
        const app = browser?.contentWindow?.PDFViewerApplication;
        if (app?.pdfDocument) return app;
      } catch {
        // Cross-process viewers can throw while they are being set up.
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const readPdfTab = async (
    tab: ChromeTab,
    maxChars: number,
    offset: number
  ): Promise<PageReadResult> => {
    const unavailable =
      "Could not extract text from this PDF. It may still be loading, " +
      "password protected, or the built-in PDF viewer is not available for this tab.";
    let app: any = null;
    try {
      app = await waitForPdfApplication(tab.linkedBrowser);
    } catch {
      app = null;
    }
    if (!app) throw new OpsError("pdf_unreadable", unavailable);

    let title = tabTitle(tab);
    let text = "";
    try {
      title = String(app.documentTitle || app.metadata?.info?.Title || title);
      const document = app.pdfDocument;
      const pageCount = Math.max(0, Number(document?.numPages) || 0);
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = Array.isArray(content?.items) ? content.items : [];
        const pageText = items
          .map((item: any) => String(item?.str ?? ""))
          .join(" ")
          .replace(/[ \t\u00a0]+/g, " ")
          .trim();
        if (pageText) pages.push(pageText);
      }
      text = pages.join("\n\n");
    } catch {
      throw new OpsError("pdf_unreadable", unavailable);
    }
    if (!text) throw new OpsError("pdf_unreadable", unavailable);

    const start = Math.min(Math.max(0, offset), text.length);
    const body = text.slice(start, start + maxChars);
    const nextOffset =
      body.length > 0 && start + body.length < text.length
        ? start + body.length
        : null;

    return {
      title,
      url: tabUrl(tab),
      selectedText: "",
      text: body,
      truncated: nextOffset !== null,
      length: text.length,
      offset: start,
      nextOffset,
      description: null,
      format: "text",
      contentType: "application/pdf",
      selector: null,
    } satisfies PageReadResult;
  };

  const openTab = (
    url: string,
    inBackground: boolean,
    userContextId?: number
  ): ChromeTab => {
    const options: Record<string, unknown> = {
      inBackground,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    };
    if (typeof userContextId === "number" && userContextId > 0) {
      options.userContextId = userContextId;
    }
    return win.gBrowser.addTab(url, options);
  };

  const assertSpacesEnabled = (): void => {
    if (!spacesEnabled()) {
      throw new OpsError(
        "spaces_unavailable",
        "Spaces are disabled in this Zen window (private window or workspaces turned off)."
      );
    }
  };

  const ops: {
    [K in BridgeMethod]: (params: BridgeMethodMap[K]["params"]) => Promise<BridgeMethodMap[K]["result"]> | BridgeMethodMap[K]["result"];
  } = {
    status: () => {
      const manager = win.gZenWorkspaces;
      const tabs = realTabs();
      const activeTab = win.gBrowser?.selectedTab;
      const activeFolder = activeTab ? folderOf(activeTab) : null;
      const spaces = allSpaceInfo();
      const profile = (() => {
        try {
          return Services.dirsvc.get("ProfD", Components.interfaces.nsIFile).path;
        } catch {
          return "";
        }
      })();

      return {
        appName: Services.appinfo.name,
        appVersion: Services.appinfo.version,
        buildId: Services.appinfo.appBuildID,
        platform: Services.appinfo.OS,
        profile,
        windowId,
        focused: win.document.hasFocus(),
        workspacesEnabled: spacesEnabled(),
        activeSpaceId: spacesEnabled() ? manager.activeWorkspace : null,
        activeTab: activeTab
          ? {
              id: idForTab(activeTab),
              title: tabTitle(activeTab),
              url: tabUrl(activeTab),
              spaceId: activeTab.getAttribute("zen-workspace-id") || null,
              folderId: activeFolder?.id ?? null,
            }
          : null,
        spaces,
        tabCount: tabs.length,
        folderCount: collectFolders().length,
      } satisfies BridgeStatus;
    },

    "spaces.list": () =>
      ({
        activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
        spaces: allSpaceInfo(),
        workspacesEnabled: spacesEnabled(),
      }) satisfies SpacesResult,

    "spaces.create": async (params: CreateSpaceParams) => {
      assertSpacesEnabled();
      const name = String(params?.name ?? "").trim();
      if (!name) throw new OpsError("invalid_name", "Space name cannot be empty");
      if (name.length > 64) {
        throw new OpsError("invalid_name", "Space name must be 64 characters or fewer");
      }
      const existing = findSpace(name);
      if (existing) {
        throw new OpsError(
          "space_exists",
          `A space named "${existing.name}" already exists. Switch to it or use another name.`
        );
      }
      const icon = params.icon ? String(params.icon) : undefined;
      const containerTabId = Number.isFinite(params.containerTabId)
        ? Number(params.containerTabId)
        : 0;
      const switchTo = params.switchTo === true;
      const data = await win.gZenWorkspaces.createAndSaveWorkspace(
        name,
        icon,
        !switchTo,
        containerTabId
      );
      if (!data) {
        throw new OpsError("space_create_failed", "Zen refused to create the space");
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        created: true,
        space: spaceInfoFor(data),
        activeSpaceId: win.gZenWorkspaces.activeWorkspace,
        switched: win.gZenWorkspaces.activeWorkspace === data.uuid,
      } satisfies CreateSpaceResult;
    },

    "spaces.switch": async (params: SwitchSpaceParams) => {
      assertSpacesEnabled();
      const space = requireSpace(String(params?.space ?? ""), "switch spaces");
      if (win.gZenWorkspaces.activeWorkspace !== space.uuid) {
        await win.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
      }
      return {
        space: spaceInfoFor(space),
        activeSpaceId: win.gZenWorkspaces.activeWorkspace,
      } satisfies SwitchSpaceResult;
    },

    "spaces.delete": async (params: SpaceTargetParams) => {
      assertSpacesEnabled();
      const space = requireSpace(String(params?.space ?? ""), "delete spaces");
      if (win.gZenWorkspaces.activeWorkspace === space.uuid) {
        const fallback = listSpaces().find(
          (candidate: ChromeSpace) => candidate.uuid !== space.uuid
        );
        if (fallback) {
          await win.gZenWorkspaces.changeWorkspaceWithID(fallback.uuid);
        }
      }
      await win.gZenWorkspaces.removeWorkspace(space.uuid);
      return {
        deleted: true,
        spaceId: space.uuid,
        spaceName: space.name,
        activeSpaceId: win.gZenWorkspaces.activeWorkspace ?? null,
      } satisfies DeleteSpaceResult;
    },

    "tabs.list": (params: TabsListParams | undefined) => {
      const limit = clamp(params?.limit ?? 500, 1, 2000);
      const query = String(params?.query ?? "").trim().toLowerCase();
      const requestedSpace = params?.space
        ? requireSpace(params.space, "filter tabs")
        : null;
      const tabs = realTabs()
        .map((tab: ChromeTab, index: number) => tabInfo(tab, index))
        .filter((tab: TabInfo) => {
          if (requestedSpace && tab.spaceId !== requestedSpace.uuid) return false;
          if (params?.pinnedOnly && !tab.pinned && !tab.folderId) return false;
          if (query) {
            const haystack = `${tab.title}\n${tab.url}`.toLowerCase();
            if (!haystack.includes(query)) return false;
          }
          return true;
        });
      return {
        windowId,
        activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
        total: tabs.length,
        tabs: tabs.slice(0, limit),
      } satisfies TabsResult;
    },

    "tabs.open": async (params: OpenTabsParams) => {
      assertSpacesEnabled();
      const incoming = Array.isArray(params?.urls) ? params.urls : [];
      if (!incoming.length) {
        throw new OpsError("no_urls", "Provide at least one URL to open");
      }
      if (incoming.length > MAX_TABS_PER_OPEN) {
        throw new OpsError(
          "too_many_urls",
          `Opening ${incoming.length} tabs at once is too many (max ${MAX_TABS_PER_OPEN}). Split the work into smaller batches.`
        );
      }
      const urls = [...new Set(incoming.map(normalizeUrl))];
      const container =
        params.container === undefined ||
        params.container === null ||
        params.container === ""
          ? null
          : resolveContainer(params.container);
      const targetSpace = params.space
        ? requireSpace(params.space, "open tabs")
        : findSpace(undefined);
      if (!targetSpace) {
        throw new OpsError("no_space", "There is no space to open tabs in");
      }
      const background = params.background !== false;
      const opened: ChromeTab[] = [];
      const requested = new Map<ChromeTab, string>();
      try {
        for (const url of urls) {
          const tab = openTab(url, background, container?.userContextId);
          opened.push(tab);
          requested.set(tab, url);
        }
      } catch (error) {
        for (const tab of opened) {
          try {
            win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
          } catch {
            // Best effort cleanup.
          }
        }
        throw error;
      }

      if (targetSpace.uuid !== win.gZenWorkspaces.activeWorkspace) {
        win.gZenWorkspaces.moveTabsToWorkspace(opened, targetSpace.uuid);
      }

      let folder: ChromeFolder | null = null;
      if (params.folderId) {
        folder =
          collectFolders().find(
            (candidate: ChromeFolder) => candidate.id === params.folderId
          ) ?? null;
        if (!folder) {
          throw new OpsError(
            "folder_not_found",
            `No folder matches id "${params.folderId}" in this window`
          );
        }
        if (folder.getAttribute("zen-workspace-id") !== targetSpace.uuid) {
          throw new OpsError(
            "mixed_spaces",
            "The folder and the target space must be the same space"
          );
        }
        for (const tab of opened) {
          if (!tab.pinned) win.gBrowser.pinTab(tab);
        }
        folder.addTabs(opened);
      }

      const switchTo = params.switchTo === true;
      if (switchTo) {
        await win.gZenWorkspaces.changeWorkspaceWithID(targetSpace.uuid);
        if (opened[0]?.isConnected) {
          win.gBrowser.selectedTab = opened[0];
        }
      }

      // Give Zen a beat to adopt the tabs before reading their labels/URLs.
      await new Promise((resolve) => setTimeout(resolve, switchTo ? 260 : 160));

      const tabs: OpenedTab[] = opened
        .filter((tab) => tab?.isConnected && !tab.closing)
        .map((tab, index) => ({
          ...tabInfo(tab, index),
          requestedUrl: requested.get(tab) ?? tabUrl(tab),
        }));

      return {
        space: spaceInfoFor(targetSpace),
        tabs,
        background,
      } satisfies OpenTabsResult;
    },

    "tabs.close": (params: CloseTabsParams) => {
      const ids = Array.isArray(params?.tabIds) ? params.tabIds : [];
      if (!ids.length) throw new OpsError("no_tabs", "Provide tabIds to close");
      const tabs = resolveTabs(ids);
      const closed: string[] = [];
      for (const tab of tabs) {
        if (!tab.isConnected || tab.closing) continue;
        const id = tabIds.get(tab)!;
        win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
        closed.push(id);
      }
      return { closed: closed.length, tabIds: closed } satisfies CloseTabsResult;
    },

    "tabs.select": async (params: SelectTabParams) => {
      const [tab] = resolveTabs([String(params?.tabId ?? "")]);
      if (!tab) throw new OpsError("tab_not_found", "No tab matched that id");
      const spaceId = tab.getAttribute("zen-workspace-id");
      if (spaceId && spaceId !== win.gZenWorkspaces?.activeWorkspace) {
        await win.gZenWorkspaces.changeWorkspaceWithID(spaceId);
      }
      win.gBrowser.selectedTab = tab;
      tab.scrollIntoView?.({ block: "nearest" });
      if (params.focusWindow) {
        win.focus();
      }
      return {
        tab: tabInfo(tab, [...realTabs()].indexOf(tab)),
        activeSpaceId: spacesEnabled() ? win.gZenWorkspaces.activeWorkspace : null,
      } satisfies SelectTabResult;
    },

    "tabs.pin": (params: PinTabsParams) => {
      const ids = Array.isArray(params?.tabIds) ? params.tabIds : [];
      if (!ids.length) {
        throw new OpsError("no_tabs", "Provide tabIds to pin or unpin");
      }
      if (typeof params?.pinned !== "boolean") {
        throw new OpsError(
          "invalid_params",
          "`pinned` must be true or false"
        );
      }
      const pinned = params.pinned;
      const tabs = resolveTabs(ids);
      const changed: string[] = [];
      for (const tab of tabs) {
        // Essentials are pinned by definition and managed by essentials.*.
        if (isEssentialTab(tab)) continue;
        if (!!tab.pinned === pinned) continue;
        if (!tab.isConnected || tab.closing) continue;
        if (pinned) {
          win.gBrowser.pinTab(tab);
        } else {
          win.gBrowser.unpinTab(tab);
        }
        changed.push(idForTab(tab));
      }
      return { tabIds: changed, changed: changed.length } satisfies PinTabsResult;
    },

    "tabs.read": async (params: TabReadParams) => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) {
        throw new OpsError("no_tab", "Provide the tabId of the tab to read");
      }
      const [tab] = resolveTabs([tabId]);
      const listedUrl = tabUrl(tab);
      if (!isHttpUrl(listedUrl)) {
        throw new OpsError(
          isPrivilegedUrl(listedUrl) ? "privileged_page" : "unsupported_page",
          "Zen MCP only reads http(s) pages. Browser-internal and local-file " +
            "pages are never read."
        );
      }
      const maxChars = clamp(params?.maxChars ?? 24_000, 500, 60_000);
      const requestedOffset = Number(params?.offset);
      const offset = Number.isFinite(requestedOffset)
        ? Math.max(0, Math.floor(requestedOffset))
        : 0;
      const format = params?.format;
      const selector = params?.selector ? String(params.selector).trim() : undefined;

      // PDFs render in the pdf.js viewer, which the page read script cannot
      // see. Their text comes straight from the viewer instead.
      if (isPdfTab(tab)) {
        return readPdfTab(tab, maxChars, offset);
      }
      const contentType = contentTypeOf(tab);

      // Marionette's content context only sees tabs in gBrowser, so tabs in an
      // inactive space cannot be reached that way. The driver's content actor
      // executes the same script inside any loaded browsing context, which is
      // what makes non-disruptive background research possible.
      const global = tab.linkedBrowser?.browsingContext?.currentWindowGlobal;
      if (!global) {
        throw new OpsError(
          "tab_not_loaded",
          `The tab "${tabTitle(tab)}" has no loaded page to read yet. ` +
            "Wait a moment for it to finish loading, then try again."
        );
      }
      const actor =
        typeof global.getActor === "function"
          ? global.getActor("MarionetteCommands")
          : null;
      if (!actor) {
        throw new OpsError(
          "actor_unavailable",
          "Zen MCP's Marionette session does not expose background page " +
            "access in this window. Restart Zen with zen_launch."
        );
      }

      let raw: unknown;
      try {
        raw = await actor.sendQuery(
          "MarionetteCommandsParent:executeScript",
          {
            script: buildReadScript({
              maxChars,
              offset,
              ...(format ? { format } : {}),
              ...(selector ? { selector } : {}),
            }),
            args: [],
            opts: { timeout: 15_000 },
          }
        );
      } catch (error) {
        throw new OpsError(
          "read_failed",
          `Could not read "${tabTitle(tab)}": ${String(
            (error as Error)?.message ?? error
          )}`
        );
      }

      const page = coercePageSnapshot(raw);
      if (!page) {
        throw new OpsError(
          "read_failed",
          `The tab "${tabTitle(tab)}" did not return page content. It may be ` +
            "a privileged page, a PDF viewer, or still loading."
        );
      }
      // `selectorMatched` is only meaningful when a selector was supplied.
      if (selector && page.selectorMatched === false) {
        throw new OpsError(
          "selector_not_found",
          `No element matches selector "${selector}"`
        );
      }
      return toPageReadResult(page, {
        maxChars,
        contentType,
        offset,
      }) satisfies PageReadResult;
    },

    "tabs.findText": async (
      params: TextSearchParams
    ): Promise<TextSearchResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) {
        throw new OpsError("no_tab", "Provide the tabId to search.");
      }
      const query =
        typeof params?.query === "string" ? params.query.trim() : "";
      if (!query) {
        throw new OpsError("invalid_query", "Provide the text to find.");
      }
      if (query.length > 2_000) {
        throw new OpsError(
          "query_too_large",
          "Refusing to search for more than 2,000 characters at once."
        );
      }

      const [tab] = resolveTabs([tabId]);
      const listedUrl = tabUrl(tab);
      const listedTitle = tabTitle(tab);
      const failed = (
        code: EvidenceErrorCode,
        message: string,
        extra: Partial<TextSearchResult> = {}
      ): TextSearchResult => ({
        ok: false,
        tabId,
        url: listedUrl,
        title: listedTitle,
        query,
        matches: [],
        totalMatches: 0,
        truncated: false,
        ...extra,
        error: { code, message },
      });

      if (!isHttpUrl(listedUrl)) {
        return failed(
          isPrivilegedUrl(listedUrl) ? "PRIVILEGED_PAGE" : "UNSUPPORTED_PAGE",
          "Text search only inspects http(s) pages."
        );
      }
      if (isPdfTab(tab)) {
        return failed(
          "UNSUPPORTED_PAGE",
          "PDF documents render in a viewer that exposes no HTML text."
        );
      }

      let snapshot = null as ReturnType<typeof coerceEvidenceIndex>;
      try {
        snapshot = coerceEvidenceIndex(
          await runEvidenceScript(
            tab,
            buildEvidenceIndexScript({ maxChars: EVIDENCE_MAX_TEXT }),
            15_000
          )
        );
      } catch (error) {
        if (error instanceof OpsError) {
          if (error.code === "actor_unavailable") {
            return failed("ACTOR_UNAVAILABLE", error.message);
          }
          if (error.code === "tab_not_loaded") {
            return failed("PAGE_STILL_LOADING", error.message);
          }
        }
        return failed(
          "PAGE_NOT_FOUND",
          `Could not read the page in the tab "${listedTitle}".`
        );
      }
      if (!snapshot) {
        return failed(
          "PAGE_NOT_FOUND",
          `The tab "${listedTitle}" did not return readable page content.`
        );
      }
      if (snapshot.readyState === "loading") {
        return failed("PAGE_STILL_LOADING", "The page is still loading.");
      }
      if (snapshot.contentType && !/html|xml/i.test(snapshot.contentType)) {
        return failed(
          "UNSUPPORTED_PAGE",
          `The page is served as ${snapshot.contentType}, which exposes no ` +
            "HTML text to search."
        );
      }

      const outcome = findLiteralMatches(snapshot.text, {
        query,
        caseSensitive: params?.caseSensitive === true,
        maxMatches: params?.maxMatches,
        contextChars: params?.contextChars,
      });
      const limitations: string[] = [];
      if (snapshot.truncated) {
        limitations.push(
          `Only the first ${snapshot.text.length} characters of the page were searched.`
        );
      }
      if (outcome.totalMatches > outcome.matches.length) {
        limitations.push(
          `Showing ${outcome.matches.length} of ${outcome.totalMatches} matches. ` +
            "Raise maxMatches to see more."
        );
      }
      if (outcome.scanStopped) {
        limitations.push(
          "The page contains more matches than the scan limit, so the total is a lower bound."
        );
      }

      return {
        ok: true,
        tabId,
        url: isHttpUrl(snapshot.url) ? snapshot.url : listedUrl,
        title: snapshot.title || listedTitle,
        query,
        matches: outcome.matches,
        totalMatches: outcome.totalMatches,
        truncated:
          snapshot.truncated ||
          outcome.scanStopped ||
          outcome.totalMatches > outcome.matches.length,
        ...(limitations.length ? { limitation: limitations.join(" ") } : {}),
      } satisfies TextSearchResult;
    },

    "tabs.evidence": async (
      params: EvidenceShowParams
    ): Promise<EvidenceOpResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) {
        throw new OpsError("no_tab", "Provide the tabId that holds the evidence.");
      }
      const quote =
        typeof params?.quote === "string"
          ? params.quote.replace(/\r\n?/g, "\n").trim()
          : "";
      if (!quote) {
        throw new OpsError("invalid_quote", "Provide the quote to locate in the page.");
      }
      if (quote.length > 20_000) {
        throw new OpsError(
          "quote_too_large",
          "Refusing to search for a quote longer than 20,000 characters."
        );
      }

      const [tab] = resolveTabs([tabId]);
      const listedUrl = tabUrl(tab);
      const listedTitle = tabTitle(tab);
      const failed = (
        code: EvidenceErrorCode,
        message: string,
        extra: Partial<EvidenceOpResult> = {}
      ): EvidenceOpResult => ({
        ok: false,
        tabId,
        url: listedUrl,
        title: listedTitle,
        ...extra,
        error: { code, message },
      });

      if (!isHttpUrl(listedUrl)) {
        return failed(
          isPrivilegedUrl(listedUrl) ? "PRIVILEGED_PAGE" : "UNSUPPORTED_PAGE",
          "Evidence Mode only inspects http(s) pages. Browser-internal pages " +
            "cannot be read or marked."
        );
      }
      if (isPdfTab(tab)) {
        return failed(
          "UNSUPPORTED_PAGE",
          "PDF documents render in a viewer that exposes no HTML text, so " +
            "Evidence Mode cannot locate a quote in them."
        );
      }

      // Wait for the tab to leave about:blank and finish loading. A freshly
      // opened tab can report "complete" for its empty initial document.
      const deadline = Date.now() + EVIDENCE_WAIT_MS;
      let state = null as ReturnType<typeof coerceEvidenceState>;
      let lastError: Error | null = null;
      for (;;) {
        try {
          state = coerceEvidenceState(
            await runEvidenceScript(tab, buildEvidenceStateScript(), 5_000)
          );
          lastError = null;
        } catch (error) {
          lastError = error as Error;
          state = null;
        }
        if (
          state &&
          isHttpUrl(state.url) &&
          state.readyState !== "" &&
          state.readyState !== "loading"
        ) {
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(EVIDENCE_POLL_MS);
      }

      if (!state) {
        if (
          lastError instanceof OpsError &&
          lastError.code === "actor_unavailable"
        ) {
          return failed("ACTOR_UNAVAILABLE", lastError.message);
        }
        return failed(
          "PAGE_NOT_FOUND",
          `Could not reach the page in the tab "${listedTitle}". ` +
            "The tab may have been closed, navigated away, or not loaded yet."
        );
      }
      if (!state.readyState || state.readyState === "loading") {
        return failed(
          "PAGE_STILL_LOADING",
          `The page "${state.title || listedTitle}" is still loading after ` +
            `${Math.round(EVIDENCE_WAIT_MS / 1000)} seconds.`
        );
      }
      if (!isHttpUrl(state.url)) {
        return failed(
          isPrivilegedUrl(state.url) ? "PRIVILEGED_PAGE" : "UNSUPPORTED_PAGE",
          `The tab ended up on ${state.url || "an unsupported page"}. ` +
            "Evidence Mode only inspects http(s) pages."
        );
      }
      if (state.contentType && !/html|xml/i.test(state.contentType)) {
        return failed(
          "UNSUPPORTED_PAGE",
          `The page is served as ${state.contentType}, which exposes no HTML ` +
            "text to locate a quote in."
        );
      }

      // Let late-rendering content settle before taking the text snapshot.
      await sleep(EVIDENCE_SETTLE_MS);

      const context =
        typeof params?.context === "string" ? params.context : undefined;
      const minConfidence =
        typeof params?.minConfidence === "number" &&
        Number.isFinite(params.minConfidence)
          ? params.minConfidence
          : undefined;
      const highlightMs = clamp(
        params?.highlightMs ?? EVIDENCE_HIGHLIGHT_MS,
        1_000,
        120_000
      );
      const scroll = params?.scroll !== false;
      const maxChars = EVIDENCE_MAX_TEXT;

      let snapshot = null as ReturnType<typeof coerceEvidenceIndex>;
      try {
        snapshot = coerceEvidenceIndex(
          await runEvidenceScript(
            tab,
            buildEvidenceIndexScript({ maxChars }),
            15_000
          )
        );
      } catch (error) {
        if (error instanceof OpsError && error.code === "actor_unavailable") {
          return failed("ACTOR_UNAVAILABLE", error.message);
        }
        return failed(
          "PAGE_NOT_FOUND",
          `Could not read the page in the tab "${state.title || listedTitle}".`
        );
      }
      if (!snapshot) {
        return failed(
          "PAGE_NOT_FOUND",
          `The tab "${state.title || listedTitle}" did not return readable page content.`
        );
      }
      if (snapshot.readyState === "loading") {
        return failed("PAGE_STILL_LOADING", "The page is still loading.");
      }
      if (snapshot.contentType && !/html|xml/i.test(snapshot.contentType)) {
        return failed(
          "UNSUPPORTED_PAGE",
          `The page is served as ${snapshot.contentType}, which exposes no ` +
            "HTML text to locate a quote in."
        );
      }

      const base = {
        tabId,
        url: isHttpUrl(snapshot.url) ? snapshot.url : state.url,
        title: snapshot.title || state.title || listedTitle,
      };
      if (!snapshot.text.trim()) {
        return {
          ...base,
          ok: false,
          error: {
            code: "QUOTE_NOT_FOUND",
            message: "The page exposes no readable text to search.",
          },
        } satisfies EvidenceOpResult;
      }

      let current = snapshot;
      const marker = createEvidenceMarker();
      for (let attempt = 0; attempt < EVIDENCE_MAX_ATTEMPTS; attempt += 1) {
        const outcome = findEvidenceQuote(current.text, {
          quote,
          ...(context ? { context } : {}),
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });

        if (outcome.status === "not_found") {
          return {
            ...base,
            ok: false,
            error: { code: "QUOTE_NOT_FOUND", message: outcome.message },
            ...(current.truncated
              ? {
                  limitation:
                    "Only the first " +
                    `${current.text.length} characters of the page were searched.`,
                }
              : {}),
          } satisfies EvidenceOpResult;
        }
        if (outcome.status === "ambiguous") {
          return {
            ...base,
            ok: false,
            occurrences: outcome.occurrences,
            error: { code: "AMBIGUOUS_MATCH", message: outcome.message },
            limitation: outcome.occurrencesTruncated
              ? `At least ${outcome.occurrences} passages matched and the scan ` +
                `stopped at ${outcome.occurrences}. Use a longer, more ` +
                "distinctive quote. No highlight was added."
              : `${outcome.occurrences} occurrences matched; add surrounding ` +
                "context to identify the intended passage. No highlight was added.",
          } satisfies EvidenceOpResult;
        }
        if (outcome.status === "low_confidence") {
          return {
            ...base,
            ok: false,
            confidence: outcome.candidate.confidence,
            error: { code: "LOW_MATCH_CONFIDENCE", message: outcome.message },
            limitation:
              `The closest passage scored ${outcome.candidate.confidence.toFixed(3)} ` +
              `against the requested ${outcome.threshold.toFixed(2)} confidence ` +
              "threshold. No highlight was added.",
          } satisfies EvidenceOpResult;
        }

        const candidate = outcome.candidate;
        const expectedText = current.text.slice(candidate.start, candidate.end);
        let report: ReturnType<typeof coerceEvidenceHighlight>;
        let scriptFailed = false;
        try {
          report = coerceEvidenceHighlight(
            await runEvidenceScript(
              tab,
              buildEvidenceHighlightScript({
                start: candidate.start,
                end: candidate.end,
                expectedText,
                ttlMs: highlightMs,
                scroll,
                marker,
                clearMarkers: markersFor(tabId),
              }),
              15_000
            )
          );
        } catch (error) {
          if (
            error instanceof OpsError &&
            error.code === "actor_unavailable"
          ) {
            return failed("ACTOR_UNAVAILABLE", error.message);
          }
          scriptFailed = true;
          report = {
            ok: false,
            stale: false,
            highlighted: false,
            scrolled: false,
            inView: false,
            rects: 0,
            scrollY: 0,
            reason: String((error as Error)?.message ?? error).slice(0, 200),
          };
        }

        if (report.stale) {
          // The page changed between matching and marking. Re-read it and try
          // again rather than highlighting offsets that may now point at a
          // different passage.
          await sleep(EVIDENCE_POLL_MS);
          try {
            const refreshed = coerceEvidenceIndex(
              await runEvidenceScript(
                tab,
                buildEvidenceIndexScript({ maxChars }),
                15_000
              )
            );
            if (refreshed) {
              current = refreshed;
              base.url = isHttpUrl(refreshed.url) ? refreshed.url : base.url;
              base.title = refreshed.title || base.title;
            }
          } catch {
            // Keep the previous snapshot; the loop exhausts attempts.
          }
          continue;
        }

        if (!report.highlighted) {
          if (!scriptFailed) rememberMarkers(tabId, []);
          return {
            ...base,
            ok: false,
            matchedQuote: expectedText,
            matchMethod: candidate.method,
            confidence: candidate.confidence,
            occurrences: outcome.occurrences,
            scrolled: false,
            highlighted: false,
            verified: false,
            limitation:
              "The passage has no visible pixels in the page, so no highlight " +
              "was added. It may be hidden, clipped, or placed off-screen.",
            error: {
              code: "HIGHLIGHT_FAILED",
              message:
                "The matched passage is hidden or has no visible area, so it " +
                "could not be shown in the page.",
            },
          } satisfies EvidenceOpResult;
        }

        rememberMarkers(tabId, [marker]);

        const limitations: string[] = [];
        if (candidate.method === "normalized" && candidate.confidence < 0.99) {
          limitations.push(
            "The quote matched after Unicode normalization, so case, spacing, " +
              "punctuation, or accents differ slightly from the page."
          );
        }
        if (candidate.method === "fuzzy") {
          limitations.push(
            "Fuzzy match: the page wording differs from the quote and should " +
              "be checked. Numbers and negation words matched exactly."
          );
        }
        if (outcome.occurrencesTruncated) {
          limitations.push(
            `At least ${outcome.occurrences} passages matched; the occurrence ` +
              "count is a lower bound."
          );
        }
        if (!report.inView) {
          limitations.push(
            "The passage is outside the visible viewport, so the user cannot " +
              "see the highlight without scrolling."
          );
        }
        if (current.truncated) {
          limitations.push(
            "Only the first " +
              `${current.text.length} characters of the page were searched.`
          );
        }

        return {
          ...base,
          ok: true,
          verified: candidate.method !== "fuzzy" && report.inView,
          matchedQuote: expectedText,
          matchMethod: candidate.method,
          confidence: candidate.confidence,
          occurrences: outcome.occurrences,
          scrolled: scroll ? report.scrolled : false,
          highlighted: true,
          ...(limitations.length ? { limitation: limitations.join(" ") } : {}),
        } satisfies EvidenceOpResult;
      }

      return {
        ...base,
        ok: false,
        limitation:
          "The page kept changing while Zen MCP located the passage, so no " +
          "highlight was added.",
        error: {
          code: "HIGHLIGHT_FAILED",
          message:
            "The page changed before the passage could be marked. Try again " +
            "once the page settles.",
        },
      } satisfies EvidenceOpResult;
    },

    "tabs.evidenceClear": async (
      params: EvidenceClearParams
    ): Promise<EvidenceClearResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) {
        throw new OpsError("no_tab", "Provide the tabId whose marks to clear.");
      }
      const [tab] = resolveTabs([tabId]);
      const markers = markersFor(tabId);
      if (markers.length === 0) {
        return { tabId, removed: 0 } satisfies EvidenceClearResult;
      }
      let raw: unknown;
      try {
        raw = await runEvidenceScript(
          tab,
          buildEvidenceClearScript({ markers }),
          10_000
        );
      } catch {
        return { tabId, removed: 0 } satisfies EvidenceClearResult;
      }
      const report = coerceEvidenceClear(raw);
      rememberMarkers(tabId, []);
      return { tabId, removed: report.removed } satisfies EvidenceClearResult;
    },

    "folders.list": () =>
      ({
        folders: collectFolders().map(folderInfo),
      }) satisfies FoldersResult,

    "folders.create": async (params: CreateFolderParams) => {
      const label = String(params?.label ?? "").trim();
      if (!label) throw new OpsError("invalid_name", "Folder name cannot be empty");
      const tabs = Array.isArray(params.tabIds) ? resolveTabs(params.tabIds) : [];
      if (tabs.some((tab) => tab.group)) {
        throw new OpsError(
          "tab_already_grouped",
          "One or more tabs already belong to a folder or split view. Pick ungrouped tabs."
        );
      }

      let workspaceId = params.space
        ? requireSpace(params.space, "create a folder").uuid
        : null;
      if (!workspaceId && tabs.length) {
        workspaceId = tabs[0].getAttribute("zen-workspace-id") || null;
      }
      if (!workspaceId) {
        workspaceId = win.gZenWorkspaces.activeWorkspace;
      }
      if (
        tabs.some(
          (tab) => tab.getAttribute("zen-workspace-id") !== workspaceId
        )
      ) {
        throw new OpsError(
          "mixed_spaces",
          "All tabs in a folder must belong to the same space"
        );
      }

      const folder = win.gZenFolders.createFolder(tabs, {
        workspaceId,
        label,
        collapsed: params.collapsed === true,
      });
      await new Promise((resolve) => setTimeout(resolve, 160));
      return {
        created: true,
        folder: folderInfo(folder),
      } satisfies CreateFolderResult;
    },

    "folders.addTabs": (params: AddTabsToFolderParams) => {
      const folder =
        collectFolders().find(
          (candidate: ChromeFolder) => candidate.id === params?.folderId
        ) ?? null;
      if (!folder) {
        throw new OpsError("folder_not_found", `No folder matches "${params?.folderId}"`);
      }
      const tabs = resolveTabs(Array.isArray(params.tabIds) ? params.tabIds : []);
      if (!tabs.length) throw new OpsError("no_tabs", "Provide tabIds to add");
      if (tabs.some((tab) => tab.group)) {
        throw new OpsError(
          "tab_already_grouped",
          "One or more tabs already belong to a folder or split view"
        );
      }
      const folderSpace = folder.getAttribute("zen-workspace-id");
      if (
        tabs.some(
          (tab) => tab.getAttribute("zen-workspace-id") !== folderSpace
        )
      ) {
        throw new OpsError(
          "mixed_spaces",
          "Tabs must be in the same space as the folder"
        );
      }
      for (const tab of tabs) {
        if (!tab.pinned) win.gBrowser.pinTab(tab);
      }
      folder.addTabs(tabs);
      return {
        folder: folderInfo(folder),
        added: tabs.length,
      } satisfies AddTabsToFolderResult;
    },

    "essentials.add": async (params: EssentialsParams) => {
      const manager = win.gZenPinnedTabManager;
      if (!manager || typeof manager.addToEssentials !== "function") {
        throw new OpsError(
          "essentials_unavailable",
          "Zen essentials are not available in this window."
        );
      }
      const tabs = resolveTabs(Array.isArray(params?.tabIds) ? params.tabIds : []);
      if (!tabs.length) {
        throw new OpsError("no_tabs", "Provide tabIds to add to essentials");
      }
      const changed: string[] = [];
      for (const tab of tabs) {
        if (isEssentialTab(tab)) continue;
        const added = await Promise.resolve(manager.addToEssentials(tab));
        if (added === true) changed.push(idForTab(tab));
      }
      if (changed.length) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return { tabIds: changed, changed: changed.length } satisfies EssentialsResult;
    },

    "essentials.remove": async (params: EssentialsParams) => {
      const manager = win.gZenPinnedTabManager;
      if (!manager || typeof manager.removeEssentials !== "function") {
        throw new OpsError(
          "essentials_unavailable",
          "Zen essentials are not available in this window."
        );
      }
      const tabs = resolveTabs(Array.isArray(params?.tabIds) ? params.tabIds : []);
      if (!tabs.length) {
        throw new OpsError("no_tabs", "Provide tabIds to remove from essentials");
      }
      const changed: string[] = [];
      for (const tab of tabs) {
        if (!isEssentialTab(tab)) continue;
        const removed = await Promise.resolve(manager.removeEssentials(tab));
        if (removed !== false) changed.push(idForTab(tab));
      }
      if (changed.length) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return { tabIds: changed, changed: changed.length } satisfies EssentialsResult;
    },

    "containers.list": () =>
      ({ containers: containerIdentities() }) satisfies ContainersResult,

    "glance.open": async (params: GlanceParams) => {
      const sourceTab = params?.tabId
        ? resolveTabs([String(params.tabId)])[0]
        : null;
      let url: string;
      let userContextId: number | undefined;
      if (sourceTab) {
        url = tabUrl(sourceTab);
        if (!url) {
          throw new OpsError(
            "invalid_url",
            `The tab "${tabTitle(sourceTab)}" has no URL to preview.`
          );
        }
        const containerId = containerIdOf(sourceTab);
        userContextId = containerId > 0 ? containerId : undefined;
      } else {
        url = normalizeUrl(String(params?.url ?? ""));
        if (
          params?.container !== undefined &&
          params?.container !== null &&
          params?.container !== ""
        ) {
          const container = resolveContainer(params.container);
          userContextId =
            container.userContextId > 0 ? container.userContextId : undefined;
        }
      }

      const manager = win.gZenGlanceManager;
      if (!manager || typeof manager.openGlance !== "function") {
        return {
          opened: false,
          url,
          mode: "none",
          message:
            "Zen glance is not available in this window. Update Zen or open the URL as a tab instead.",
        } satisfies GlanceResult;
      }

      const width = clamp(Number(params?.width ?? 960), 240, 4096);
      const height = clamp(Number(params?.height ?? 720), 240, 4096);
      let result: unknown = null;
      try {
        result = await manager.openGlance({
          url,
          clientX: 200,
          clientY: 120,
          width,
          height,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          ...(userContextId ? { userContextId } : {}),
        });
      } catch (error) {
        throw new OpsError(
          "glance_failed",
          `Could not open glance: ${String(
            (error as Error)?.message ?? error
          )}`
        );
      }
      return {
        opened: !!result,
        url,
        mode: result ? "glance" : "none",
        message: result ? undefined : "Zen declined to open the glance view.",
      } satisfies GlanceResult;
    },

    "split.open": async (params: SplitParams) => {
      const ids = [
        ...new Set(Array.isArray(params?.tabIds) ? params.tabIds : []),
      ];
      if (ids.length < 2 || ids.length > 4) {
        throw new OpsError(
          "invalid_split",
          "A split view needs between 2 and 4 tabs."
        );
      }
      const tabs = resolveTabs(ids);
      const activeSpace = win.gZenWorkspaces?.activeWorkspace ?? null;
      for (const tab of tabs) {
        if ((tab.getAttribute("zen-workspace-id") || null) !== activeSpace) {
          throw new OpsError(
            "mixed_spaces",
            "Split views can only contain tabs from the active space."
          );
        }
        if (isEssentialTab(tab)) {
          throw new OpsError(
            "essential_tab",
            `The tab "${tabTitle(tab)}" is an essential and cannot join a split view.`
          );
        }
      }

      const splitter = win.gZenViewSplitter;
      if (!splitter || typeof splitter.splitTabs !== "function") {
        throw new OpsError(
          "split_unavailable",
          "Zen split views are not available in this window."
        );
      }

      let existingGroup: any = null;
      for (const tab of tabs) {
        const group = tab.group && !folderOf(tab) ? tab.group : null;
        if (!group) continue;
        if (existingGroup && group !== existingGroup) {
          throw new OpsError(
            "tab_already_split",
            "One or more tabs already belong to a different split view."
          );
        }
        existingGroup = group;
      }
      if (existingGroup && tabs.some((tab) => tab.group !== existingGroup)) {
        throw new OpsError(
          "tab_already_split",
          "One or more tabs already belong to a different split view."
        );
      }

      const gridType = ["grid", "hsep", "vsep"].includes(String(params?.gridType))
        ? String(params.gridType)
        : "grid";
      const created = await Promise.resolve(
        splitter.splitTabs(
          tabs,
          gridType,
          params?.activate === false ? -1 : 0
        )
      );
      if (!created) {
        throw new OpsError(
          "split_failed",
          "Zen did not create the split view. Make sure the tabs are in the " +
            "active space and are not already grouped."
        );
      }
      return {
        split: true,
        tabIds: tabs.map((tab) => idForTab(tab)),
        gridType,
      } satisfies SplitResult;
    },

    "split.close": (params: UnsplitParams) => {
      const splitter = win.gZenViewSplitter;
      if (!splitter) {
        throw new OpsError(
          "split_unavailable",
          "Zen split views are not available in this window."
        );
      }
      const tab = params?.tabId
        ? resolveTabs([String(params.tabId)])[0]
        : win.gBrowser?.selectedTab ?? null;
      if (!tab) {
        throw new OpsError("tab_not_found", "No tab is selected to unsplit.");
      }

      const groups: any[] = Array.isArray(splitter._data)
        ? splitter._data
        : [];
      const index = groups.findIndex(
        (group) => Array.isArray(group?.tabs) && group.tabs.includes(tab)
      );
      let groupIds: string[] = [];
      if (index >= 0) {
        groupIds = groups[index].tabs
          .filter((member: ChromeTab) => member?.isConnected)
          .map((member: ChromeTab) => idForTab(member));
      }

      if (index >= 0 && typeof splitter.removeGroup === "function") {
        splitter.removeGroup(index);
        return { unsplit: true, tabIds: groupIds } satisfies UnsplitResult;
      }

      win.gBrowser.selectedTab = tab;
      if (typeof splitter.unsplitCurrentView === "function") {
        splitter.unsplitCurrentView();
        return { unsplit: true, tabIds: groupIds } satisfies UnsplitResult;
      }
      return { unsplit: false, tabIds: groupIds } satisfies UnsplitResult;
    },

    "history.search": async (params: HistorySearchParams) => {
      const limit = clamp(params?.limit ?? 25, 1, MAX_RESULTS);
      const query = String(params?.query ?? "").trim();
      const domainFilter = String(params?.domain ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "");
      const sinceDays = Number(params?.sinceDays ?? 0);
      const sinceMicros =
        sinceDays > 0 ? (Date.now() - sinceDays * 86_400_000) * 1000 : 0;
      const places = getPlacesUtils();
      const db = await places.promiseDBConnection();
      const rows = await db.executeCached(
        `SELECT p.url AS url,
                p.title AS title,
                p.last_visit_date AS last_visit_date,
                p.visit_count AS visit_count
           FROM moz_places p
          WHERE p.hidden = 0
            AND p.last_visit_date IS NOT NULL
            AND p.last_visit_date >= :since
            AND (:query = ''
                 OR p.url LIKE :pattern ESCAPE '\\'
                 OR p.title LIKE :pattern ESCAPE '\\')
          ORDER BY p.last_visit_date DESC
          LIMIT :limit`,
        { query, pattern: likePattern(query), since: sinceMicros, limit: HISTORY_SCAN_LIMIT }
      );
      const entries: HistoryEntry[] = [];
      for (const row of rows) {
        const url = String(row.getResultByName("url") ?? "");
        if (!url) continue;
        const domain = hostnameOf(url);
        if (domainFilter && !domainMatches(domain, domainFilter)) continue;
        entries.push({
          title: row.getResultByName("title") ?? "",
          url,
          lastVisited: toIso(row.getResultByName("last_visit_date")),
          visitCount: Number(row.getResultByName("visit_count") ?? 0),
          domain,
        });
        if (entries.length >= limit) break;
      }
      const result: HistoryResult = { entries };
      if (params?.groupByDomain) result.groups = groupHistoryEntries(entries);
      return result;
    },

    "bookmarks.search": async (params: BookmarksSearchParams) => {
      const limit = clamp(params?.limit ?? 25, 1, MAX_RESULTS);
      const query = String(params?.query ?? "").trim();
      const places = getPlacesUtils();
      const db = await places.promiseDBConnection();
      const rows = await db.executeCached(
        `SELECT b.title AS title,
                p.url AS url,
                b.dateAdded AS date_added
           FROM moz_bookmarks b
           JOIN moz_places p ON p.id = b.fk
          WHERE b.type = 1
            AND p.hidden = 0
            AND (:query = ''
                 OR p.url LIKE :pattern ESCAPE '\\'
                 OR b.title LIKE :pattern ESCAPE '\\')
          ORDER BY b.dateAdded DESC
          LIMIT :limit`,
        { query, pattern: likePattern(query), limit }
      );
      const seen = new Set<string>();
      const entries: BookmarksResult["entries"] = [];
      for (const row of rows) {
        const url = row.getResultByName("url");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        entries.push({
          title: row.getResultByName("title") || url,
          url,
          dateAdded: toIso(row.getResultByName("date_added")),
        });
      }
      return { entries };
    },

    "history.recentlyClosed": () => {
      const store = win.SessionStore;
      if (!store || typeof store.getClosedTabData !== "function") {
        return { entries: [] } satisfies RecentlyClosedResult;
      }
      let raw: unknown;
      try {
        // Newer Firefox versions take a ClosedTabsOptions object. Older ones
        // took a window directly, so keep that as a fallback.
        raw = store.getClosedTabData({
          sourceWindow: win,
          closedTabsFromAllWindows: false,
          closedTabsFromClosedWindows: false,
        });
      } catch {
        try {
          raw = store.getClosedTabData(win);
        } catch {
          return { entries: [] } satisfies RecentlyClosedResult;
        }
      }
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return { entries: [] } satisfies RecentlyClosedResult;
        }
      }
      let closed: any[] = [];
      if (Array.isArray(raw)) {
        closed = raw;
      } else if (Array.isArray((raw as any)?.closedTabs)) {
        closed = (raw as any).closedTabs;
      }

      const entries: RecentlyClosedEntry[] = [];
      const pushState = (state: any, fallbackClosedAt: unknown): void => {
        if (!state || typeof state !== "object") return;
        const stateEntries = Array.isArray(state.entries) ? state.entries : null;
        let entry: any = null;
        if (stateEntries && stateEntries.length) {
          const index = Number.isInteger(state.index) ? Number(state.index) : -1;
          entry = stateEntries[index] ?? stateEntries[0] ?? null;
        } else if (typeof state.url === "string") {
          entry = state;
        }
        if (!entry) return;
        const url = String(entry.url ?? state.url ?? "");
        if (!/^https?:/i.test(url)) return;
        const closedAt = Number(state.closedAt ?? fallbackClosedAt);
        entries.push({
          title: String(entry.title || state.title || url),
          url,
          closedAt:
            Number.isFinite(closedAt) && closedAt > 0
              ? new Date(closedAt).toISOString()
              : null,
        });
      };

      for (const item of closed) {
        if (Array.isArray(item?.tabs)) {
          for (const tab of item.tabs) pushState(tab, item?.closedAt);
        } else {
          pushState(item?.state ?? item, item?.closedAt);
        }
      }
      return {
        entries: entries.slice(0, 50),
      } satisfies RecentlyClosedResult;
    },

    "clipboard.write": async (params: ClipboardWriteParams) => {
      const text = params?.text;
      if (typeof text !== "string") {
        throw new OpsError(
          "invalid_text",
          "clipboard.write expects a string in `text`."
        );
      }
      if (text.length > MAX_CLIPBOARD_CHARS) {
        throw new OpsError(
          "text_too_large",
          "Refusing to copy more than 1 MB of text to the clipboard."
        );
      }
      let written = false;
      try {
        const helper = Components.classes[
          "@mozilla.org/widget/clipboardhelper;1"
        ].getService(Components.interfaces.nsIClipboardHelper);
        helper.copyString(String(text));
        written = true;
      } catch {
        written = false;
      }
      if (!written) {
        try {
          const clipboard = win.navigator?.clipboard;
          if (!clipboard || typeof clipboard.writeText !== "function") {
            throw new Error("Clipboard is unavailable");
          }
          await clipboard.writeText(String(text));
          written = true;
        } catch (error) {
          throw new OpsError(
            "clipboard_failed",
            `Could not write to the clipboard: ${String(
              (error as Error)?.message ?? error
            )}`
          );
        }
      }
      return {
        written: true,
        length: String(text).length,
      } satisfies ClipboardWriteResult;
    },
  };

  return {
    dispatch(method: string, params: unknown): Promise<unknown> {
      const handler = (ops as Record<string, ((p: unknown) => unknown) | undefined>)[
        method
      ];
      if (!handler) {
        throw new OpsError(
          "unknown_method",
          `Unknown bridge method "${method}". Update Zen MCP in the browser (re-run zen_launch).`
        );
      }
      return Promise.resolve(
        handler(params as never) as Promise<unknown>
      );
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Places rejects cached queries whose LIKE pattern is built from expressions,
 * so the wildcards are bound directly and the query's own `%`/`_` are escaped.
 */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Lowercased hostname, or an empty string for malformed URLs. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Matches a host against a domain, so "mozilla.org" also matches "www.mozilla.org". */
function domainMatches(hostname: string, domain: string): boolean {
  if (!domain) return true;
  if (!hostname) return false;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function groupHistoryEntries(entries: HistoryEntry[]): HistoryGroup[] {
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const domain = entry.domain || "(other)";
    const list = groups.get(domain);
    if (list) list.push(entry);
    else groups.set(domain, [entry]);
  }
  return [...groups.entries()]
    .map(([domain, list]) => ({ domain, entries: list }))
    .sort(
      (left, right) =>
        right.entries.length - left.entries.length ||
        left.domain.localeCompare(right.domain)
    );
}

function toIso(micros: unknown): string | null {
  const value = Number(micros);
  if (!value) return null;
  return new Date(value / 1000).toISOString();
}

function getPlacesUtils(): any {
  return ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs"
  ).PlacesUtils;
}

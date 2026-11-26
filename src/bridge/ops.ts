import type {
  AddTabsToFolderParams,
  AddTabsToFolderResult,
  BookmarksResult,
  BookmarksSearchParams,
  BridgeMethod,
  BridgeMethodMap,
  BridgeStatus,
  ClickElementParams,
  ClickElementResult,
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
  PageActionEffect,
  PageActionTarget,
  PageActionTargetInfo,
  PageFrame,
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
  TypeTextParams,
  TypeTextResult,
  UnsplitParams,
  UnsplitResult,
  WaitCondition,
  WaitElementState,
  WaitForParams,
  WaitForResult,
} from "../shared/protocol.js";
import {
  buildInspectElementScript,
  buildPageSignatureScript,
  buildReadScript,
  buildSemanticTargetScript,
  buildVerifyTypedValueScript,
  buildWaitProbeScript,
  coercePageSignature,
  coercePageSnapshot,
  coerceSemanticTarget,
  coerceTypedValueProbe,
  coerceWaitProbe,
  comparePageSignatures,
  MAX_PAGE_ELEMENTS,
  toPageReadResult,
  type PageSignature,
  type PageSnapshot,
  type ReadScriptElement,
  type WaitProbe,
  type WaitProbeOptions,
} from "../shared/read-script.js";
import {
  TargetInputError,
  normalizeTargetInput,
  type NormalizedTarget,
} from "../shared/target.js";
import {
  SNAPSHOT_TEXT_CHARS,
  clampSnapshotElements,
  snapshotCompleteness,
} from "../shared/snapshot.js";
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
import {
  frameRefPrefix,
  MAX_FRAME_DEPTH,
  normalizeFramePath,
  parseFrameRef,
} from "../shared/frame-path.js";
import { findLiteralMatches } from "../shared/search.js";
import { buildPageDelta, deltaHasChanges } from "../shared/delta.js";
import { isUrlAllowed, normalizeWebUrl } from "../shared/url-policy.js";
import { activateTab, type TabActivationOutcome } from "./tab-activation.js";
import {
  RefRegistry,
  documentChanged,
  elementDigest,
  type ResolvedRef,
} from "./ref-registry.js";
import {
  captureEssentialsState,
  EssentialsStateStore,
  restoreEssentialsState,
  verifyEssentialsState,
  type EssentialsCapture,
  type EssentialsRestoreHost,
} from "./essentials-state.js";
import { planSplitCleanup } from "./split-cleanup.js";
import { documentIdForTab } from "./tab-identity.js";
import {
  BridgePolicyError,
  type BridgePolicyGate,
} from "./policy-gate.js";

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
/** Time Zen gets to settle after an essentials change or a split close. */
const LAYOUT_SETTLE_MS = 120;
/** How long a closed split view may take to clear before it counts as failed. */
const SPLIT_CLOSE_TIMEOUT_MS = 1_000;
const SPLIT_CLOSE_POLL_MS = 100;
/** Frames listed or scanned for one read. */
const MAX_FRAMES = 20;
/** Frame reads merged into one interactive snapshot. */
const MAX_FRAME_SCANS = 10;
/** How long to watch a page after click or type before calling it unchanged. */
const ACTION_SETTLE_MS = 1_200;
const ACTION_PROBE_INTERVAL_MS = 120;
const ACTION_PROBE_TIMEOUT_MS = 2_500;
const SIGNATURE_BEFORE_TIMEOUT_MS = 1_500;
const WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_MS = 250;
const WAIT_MAX_TIMEOUT_MS = 30_000;
const WAIT_MIN_POLL_MS = 100;
const WAIT_MAX_POLL_MS = 2_000;
const WAIT_PROBE_TIMEOUT_MS = 2_500;
const WAIT_MIN_TIMEOUT_MS = 0;

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

const GLANCE_SETTLE_MS = 10_000;
const GLANCE_POLL_MS = 50;

/** Zen resolves a normal glance with its Tab; anything else cannot be checked. */
function isGlanceTab(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "linkedBrowser" in (result as Record<string, unknown>)
  );
}

/** The URL a glance tab has actually committed, once it leaves about:blank. */
function glanceUrlOf(result: unknown): string | undefined {
  const browser = (
    result as { linkedBrowser?: { currentURI?: { spec?: unknown } } } | null
  )?.linkedBrowser;
  const spec = browser?.currentURI?.spec;
  if (typeof spec !== "string" || !spec || spec === "about:blank") {
    return undefined;
  }
  return spec;
}

async function waitForGlanceUrl(
  result: unknown
): Promise<string | undefined> {
  const deadline = Date.now() + GLANCE_SETTLE_MS;
  let observed = glanceUrlOf(result);
  while (!observed && Date.now() < deadline) {
    await sleep(GLANCE_POLL_MS);
    observed = glanceUrlOf(result);
  }
  return observed;
}

/**
 * Glance can follow a redirect after opening, so keep watching the committed
 * URL and close the preview if it leaves the allowlist.
 */
function watchGlanceRedirects(
  result: unknown,
  manager: { closeGlance?: (options?: Record<string, unknown>) => unknown },
  allowedDomains: string[],
  isPolicyAllowed?: (url: string) => boolean
): void {
  const tab = result as {
    linkedBrowser?: {
      addEventListener?: (...args: unknown[]) => void;
      removeEventListener?: (...args: unknown[]) => void;
    };
    addEventListener?: (...args: unknown[]) => void;
    removeEventListener?: (...args: unknown[]) => void;
  } | null;
  const browser = tab?.linkedBrowser;
  if (typeof browser?.addEventListener !== "function") return;

  function stop() {
    try {
      browser?.removeEventListener?.("locationchange", check, true);
      tab?.removeEventListener?.("GlanceClose", stop, true);
    } catch {
      // The tab is already gone.
    }
  }

  function check() {
    const current = glanceUrlOf(result);
    if (!current) return;
    const target = normalizeWebUrl(current);
    if (
      target &&
      isUrlAllowed(target.href, allowedDomains) &&
      (isPolicyAllowed ? isPolicyAllowed(target.href) : true)
    ) {
      return;
    }
    stop();
    try {
      manager.closeGlance?.({ noAnimation: true, skipPermitUnload: true });
    } catch {
      // Closing is best effort; the host also checks the returned URL.
    }
  }

  try {
    browser.addEventListener("locationchange", check, true);
    tab?.addEventListener?.("GlanceClose", stop, true);
  } catch {
    // Without a listener the final-URL check at open time still applies.
  }
}

class OpsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

interface ResolvedPageTarget {
  found?: boolean;
  root?: unknown;
  element?: unknown;
  tag?: string;
  role?: string;
  name?: string;
  type?: string | null;
  label?: string;
  placeholder?: string | null;
  href?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  sensitive?: boolean;
  editable?: boolean;
  visible?: boolean;
  valuePresent?: boolean;
  checked?: boolean | null;
  selected?: boolean | null;
}

/** A frame's actor plus the path and URL used to reach it. */
interface ResolvedFrame {
  actor: any;
  path: number[];
  url: string;
  name: string;
}

/**
 * Operations executed inside a Zen browser window with full chrome access.
 * Values are returned as plain objects so they can cross the WebSocket as JSON.
 */
export function createOps(
  win: ChromeWindow,
  windowId: string,
  policy: BridgePolicyGate
) {
  const tabIds = new WeakMap<ChromeTab, string>();
  const tabsById = new Map<string, ChromeTab>();
  /**
   * WebElement refs per tab and frame document; bounded and cleared on close.
   * Semantic reads register control elements plus up to ~236 anchors, so the
   * per-document budget is higher than a snapshot's element cap.
   */
  const refRegistry = new RefRegistry({ maxRefsPerDocument: 400 });
  /** Overlay attribute names created by this bridge session, per tab. */
  const evidenceMarkers = new Map<string, string[]>();
  /** Space and pinned state captured before tabs entered essentials. */
  const essentialsCaptures = new EssentialsStateStore();
  /** Dialog notices from the chrome observer, consumed by dialog waits. */
  let dialogSeq = 0;
  const dialogWaiters = new Set<() => void>();
  const noteDialogShown = (): void => {
    dialogSeq += 1;
    const waiters = [...dialogWaiters];
    dialogWaiters.clear();
    for (const waiter of waiters) {
      try {
        waiter();
      } catch {
        // Waiters only wake the polling loop.
      }
    }
  };

  const essentialsRestoreHost = (): EssentialsRestoreHost => {
    const workspaceManager = win.gZenWorkspaces;
    const browser = win.gBrowser;
    return {
      moveTabsToWorkspace:
        workspaceManager &&
        typeof workspaceManager.moveTabsToWorkspace === "function"
          ? (tabs, spaceId) =>
              workspaceManager.moveTabsToWorkspace(tabs, spaceId)
          : undefined,
      pinTab:
        browser && typeof browser.pinTab === "function"
          ? (tab) => browser.pinTab(tab)
          : undefined,
      unpinTab:
        browser && typeof browser.unpinTab === "function"
          ? (tab) => browser.unpinTab(tab)
          : undefined,
    };
  };

  const markersFor = (tabId: string): string[] =>
    evidenceMarkers.get(tabId) ?? [];
  const rememberMarkers = (tabId: string, markers: string[]): void => {
    if (markers.length === 0) {
      evidenceMarkers.delete(tabId);
      return;
    }
    evidenceMarkers.set(tabId, markers.slice(-20));
  };
  /**
   * Serializes evidence work per tab. Batch verification can run two quotes
   * from the same source at once, and interleaved paint/record steps leave an
   * overlay host that clear cannot find.
   */
  const tabLocks = new Map<string, Promise<unknown>>();
  const serializeTab = <T>(tabId: string, work: () => Promise<T>): Promise<T> => {
    const previous = tabLocks.get(tabId) ?? Promise.resolve();
    const run = previous.then(work, work);
    tabLocks.set(tabId, run);
    const release = (): void => {
      if (tabLocks.get(tabId) === run) tabLocks.delete(tabId);
    };
    void run.then(release, release);
    return run;
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

  /** Bounded memory of ids whose tabs closed, so a later wait can match. */
  const closedTabIds = new Set<string>();

  const pruneTabIds = (): void => {
    for (const [id, tab] of tabsById) {
      if (!tab.isConnected || tab.closing) {
        tabsById.delete(id);
        closedTabIds.add(id);
      }
    }
    while (closedTabIds.size > 256) {
      const first = closedTabIds.values().next().value;
      if (first === undefined) break;
      closedTabIds.delete(first);
    }
  };

  /** Polls until none of the group members report a split view. */
  const waitForSplitGone = async (
    members: ChromeTab[],
    timeoutMs: number = SPLIT_CLOSE_TIMEOUT_MS
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    const gone = (): boolean =>
      members.every(
        (member) => !member || !member.isConnected || !member.splitView
      );
    while (!gone()) {
      if (Date.now() >= deadline) return false;
      await sleep(SPLIT_CLOSE_POLL_MS);
    }
    return true;
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

  /** Formats captured restoration failures as one user-facing limitation. */
  const describeEssentialsLimitations = (
    notes: Map<string, Set<string>>
  ): string | undefined => {
    if (notes.size === 0) return undefined;
    return [...notes]
      .map(([tabId, reasons]) => {
        const tab = tabsById.get(tabId);
        const label = tab
          ? `"${tabTitle(tab)}" (${tabId})`
          : `(${tabId})`;
        return `The tab ${label} ${[...reasons].join(", ")}.`;
      })
      .join(" ");
  };

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

  /** The MarionetteCommands actor for a loaded tab, reachable in any space. */
  const pageActor = (tab: ChromeTab): any => {
    const global = tab.linkedBrowser?.browsingContext?.currentWindowGlobal;
    if (!global) {
      throw new OpsError(
        "tab_not_loaded",
        `The tab "${tabTitle(tab)}" has no loaded page yet. Wait for it to ` +
          "finish loading, then try again."
      );
    }
    const actor =
      typeof global.getActor === "function"
        ? global.getActor("MarionetteCommands")
        : null;
    if (!actor) {
      throw new OpsError(
        "actor_unavailable",
        "Zen MCP's Marionette session does not expose page interaction in " +
          "this window. Restart Zen with zen_launch."
      );
    }
    return actor;
  };

  /** The process actor for one browsing context, if it is loaded. */
  const actorForContext = (context: any): any => {
    const global = context?.currentWindowGlobal;
    if (!global) return null;
    return typeof global.getActor === "function"
      ? global.getActor("MarionetteCommands")
      : null;
  };

  const childFrameContexts = (context: any): any[] => {
    try {
      return Array.from(context?.children ?? []);
    } catch {
      return [];
    }
  };

  const frameUrlOfContext = (context: any): string => {
    try {
      const spec = context?.currentWindowGlobal?.documentURI?.spec;
      if (typeof spec === "string") return spec;
    } catch {
      // The frame may be navigating or already gone.
    }
    return "";
  };

  const frameNameOfContext = (context: any): string => {
    try {
      return String(context?.name ?? "");
    } catch {
      return "";
    }
  };

  const frameIsVisible = (
    url: string,
    allowedDomains: string[] | undefined,
    isPolicyAllowed?: (url: string) => boolean
  ): boolean => {
    if (!isHttpUrl(url)) return false;
    if (allowedDomains?.length && !isUrlAllowed(url, allowedDomains)) {
      return false;
    }
    return isPolicyAllowed ? isPolicyAllowed(url) : true;
  };

  const requireFramePath = (raw: unknown): number[] => {
    const path = normalizeFramePath(raw);
    if (!path) {
      throw new OpsError(
        "invalid_frame",
        `framePath must be an array of at most ${MAX_FRAME_DEPTH} non-negative ` +
          "child frame indexes, such as [0] or [0,1]."
      );
    }
    return path;
  };

  /** Lists reachable http(s) frames depth-first, filtered by the allowlist. */
  const listFrames = (
    tab: ChromeTab,
    allowedDomains: string[] | undefined
  ): { frames: PageFrame[]; skipped: number; truncated: boolean } => {
    const frames: PageFrame[] = [];
    let skipped = 0;
    let truncated = false;
    const root = tab.linkedBrowser?.browsingContext;
    const walk = (context: any, prefix: number[]): void => {
      for (const [index, child] of childFrameContexts(context).entries()) {
        if (frames.length >= MAX_FRAMES) {
          truncated = true;
          return;
        }
        const path = [...prefix, index];
        const url = frameUrlOfContext(child);
        if (
          !frameIsVisible(url, allowedDomains, (frameUrl) =>
            policy.allows("page.read", frameUrl)
          )
        ) {
          skipped += 1;
          continue;
        }
        frames.push({ path, url, name: frameNameOfContext(child) });
        if (path.length < MAX_FRAME_DEPTH) walk(child, path);
      }
    };
    if (root) walk(root, []);
    return { frames, skipped, truncated };
  };

  const resolveFrame = (
    tab: ChromeTab,
    path: number[],
    allowedDomains: string[] | undefined
  ): ResolvedFrame => {
    let context = tab.linkedBrowser?.browsingContext;
    if (!context) {
      throw new OpsError(
        "tab_not_loaded",
        `The tab "${tabTitle(tab)}" has no loaded page yet.`
      );
    }
    for (let depth = 0; depth < path.length; depth += 1) {
      const index = path[depth];
      const children = childFrameContexts(context);
      if (index >= children.length) {
        throw new OpsError(
          "frame_not_found",
          `Frame path [${path.join(", ")}] does not exist: the document at ` +
            `level ${depth} has ${children.length} child frame(s).`
        );
      }
      context = children[index];
    }
    const url = frameUrlOfContext(context);
    if (!url) {
      throw new OpsError(
        "frame_not_loaded",
        `The frame at [${path.join(", ")}] has not loaded a page yet.`
      );
    }
    if (!isHttpUrl(url)) {
      throw new OpsError(
        "unsupported_frame",
        "Zen MCP only reads and drives http(s) frames. This frame is " +
          `${isPrivilegedUrl(url) ? "browser-internal" : "not a web page"}.`
      );
    }
    assertActionUrlAllowed(url, allowedDomains, "reading frame");
    const actor = actorForContext(context);
    if (!actor) {
      throw new OpsError(
        "actor_unavailable",
        "Zen MCP's Marionette session does not expose page interaction in " +
          "this frame. Restart Zen with zen_launch."
      );
    }
    return { actor, path: [...path], url, name: frameNameOfContext(context) };
  };

  /** Best-effort frame URL, used to report where an action landed. */
  const currentFrameUrl = (
    tab: ChromeTab,
    path: number[]
  ): string | null => {
    let context = tab.linkedBrowser?.browsingContext;
    for (const index of path) {
      if (!context) return null;
      context = childFrameContexts(context)[index];
    }
    return frameUrlOfContext(context) || null;
  };

  const requireActionTab = (tabId: string, action: string): ChromeTab => {
    if (!tabId) {
      throw new OpsError("no_tab", `Provide the tabId to ${action}.`);
    }
    const [tab] = resolveTabs([tabId]);
    const url = tabUrl(tab);
    if (!isHttpUrl(url)) {
      throw new OpsError(
        isPrivilegedUrl(url) ? "privileged_page" : "unsupported_page",
        "Zen MCP only interacts with http(s) pages. Browser-internal and " +
          "local-file pages are never driven."
      );
    }
    if (isPdfTab(tab)) {
      throw new OpsError(
        "unsupported_page",
        "Zen MCP cannot click or type inside the PDF viewer. Open the page " +
          "as HTML instead."
      );
    }
    return tab;
  };

  const assertActionUrlAllowed = (
    url: string,
    allowedDomains: string[] | undefined,
    action: string
  ): void => {
    if (!url || !allowedDomains?.length) return;
    if (isUrlAllowed(url, allowedDomains)) return;
    throw new OpsError(
      "domain_not_allowed",
      `Blocked by domain allowlist: ${action} ${url} is outside the ` +
        "configured domains."
    );
  };

  const resolvePageTarget = async (
    tab: ChromeTab,
    params: PageActionTarget,
    allowedDomains?: string[]
  ): Promise<{
    target: ResolvedPageTarget;
    actor: any;
    framePath: number[];
    frameUrl: string | null;
    legacy: boolean;
    kind: NormalizedTarget["kind"];
  }> => {
    let normalized: NormalizedTarget;
    try {
      normalized = normalizeTargetInput(params ?? {});
    } catch (error) {
      if (error instanceof TargetInputError) {
        throw new OpsError(error.code, error.message, error.details);
      }
      throw error;
    }

    if (normalized.kind === "ref") {
      const ref = normalized.ref;
      const parsed = parseFrameRef(ref);
      if (!parsed) {
        throw new OpsError(
          "invalid_target",
          `"${ref}" is not an interactive-read ref. Use a value such as ` +
            '"e1", "f0-e3" for a child frame, or "f0.1-e2" for a nested frame.'
        );
      }
      const frame = parsed.path.length
        ? resolveFrame(tab, parsed.path, allowedDomains)
        : null;
      const actor = frame?.actor ?? pageActor(tab);
      const framePath = parsed.path;
      const frameUrl = frame?.url ?? null;
      const stored: ResolvedRef | null = refRegistry.resolve(
        idForTab(tab),
        framePath,
        ref
      );
      if (!stored) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          normalized.legacy
            ? `No element has ref "${ref}". It may be from an older read. ` +
                'Call zen_read_page with format="snapshot" or "interactive" ' +
                "again; refs are replaced by the next read of that document " +
                "or a navigation."
            : `Ref "${ref}" is not in the current snapshot. Call ` +
                'zen_read_page with format="snapshot" and use a new ref.',
          {
            ref,
            reason: "unknown_ref",
            category: "stale_reference",
          }
        );
      }

      let fresh: unknown;
      try {
        fresh = await actor.sendQuery("MarionetteCommandsParent:executeScript", {
          script: buildInspectElementScript(),
          args: [stored.element],
          opts: { timeout: 10_000 },
        });
      } catch {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          normalized.legacy
            ? `Ref "${ref}" is stale: the page removed or replaced the ` +
                "element after it was read. Call zen_read_page again for a " +
                "current ref."
            : `Ref "${ref}" was removed or replaced after it was read. Call ` +
                "zen_read_page again for a current ref.",
          {
            ref,
            reason: "element_removed",
            category: "stale_reference",
          }
        );
      }

      const inspected = fresh as ResolvedPageTarget | null;
      if (!inspected || inspected.found !== true || !inspected.element) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          `Ref "${ref}" is stale: the page removed the element after it was ` +
            "read. Call zen_read_page again for a current ref.",
          {
            ref,
            reason: "element_removed",
            category: "stale_reference",
          }
        );
      }
      if (documentChanged(stored.root, inspected.root)) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "document_changed",
          normalized.legacy
            ? `Ref "${ref}" belongs to a document that was replaced by a ` +
                "navigation. Call zen_read_page again for a current ref."
            : `Ref "${ref}" belongs to a document that was replaced by a ` +
                "navigation. Call zen_read_page again for a current ref.",
          {
            ref,
            reason: "document_replaced",
            category: "document_changed",
          }
        );
      }
      if (elementDigest(inspected) !== stored.digest) {
        throw new OpsError(
          normalized.legacy ? "element_not_found" : "stale_reference",
          `Ref "${ref}" points to an element whose role, label, or link ` +
            "changed after it was read. Call zen_read_page again for a " +
            "current ref.",
          {
            ref,
            reason: "descriptor_changed",
            category: "stale_reference",
          }
        );
      }
      return {
        target: { ...inspected, element: stored.element },
        actor,
        framePath,
        frameUrl,
        legacy: normalized.legacy,
        kind: normalized.kind,
      };
    }

    const actor = pageActor(tab);
    let raw: unknown;
    try {
      raw = await actor.sendQuery("MarionetteCommandsParent:executeScript", {
        script: buildSemanticTargetScript(normalized),
        args: [],
        opts: { timeout: 10_000 },
      });
    } catch (error) {
      throw new OpsError(
        normalized.legacy ? "element_not_found" : "target_not_found",
        `Could not resolve the target: ${String(
          (error as Error)?.message ?? error
        )}`,
        { kind: normalized.kind, reason: "resolution_failed" }
      );
    }

    const probe = coerceSemanticTarget(raw);
    if (!probe || probe.invalidSelector) {
      throw new OpsError(
        "invalid_target",
        "The CSS selector is not valid in this document.",
        { kind: normalized.kind }
      );
    }
    if (probe.truncated) {
      throw new OpsError(
        "unsupported_operation",
        "The target search hit its node limit before uniqueness could be " +
          "proven. Use a snapshot ref or a CSS selector.",
        { kind: normalized.kind, reason: "scan_limit" }
      );
    }
    if (probe.ambiguous) {
      const candidates = (probe.candidates ?? []).slice(0, 5);
      throw new OpsError(
        "target_ambiguous",
        `${describeTargetKind(normalized)} matches ${probe.count} elements. ` +
          "Use a snapshot ref or a more specific target.",
        {
          kind: normalized.kind,
          count: probe.count,
          candidates,
        }
      );
    }
    if (!probe.found || !probe.element) {
      throw new OpsError(
        normalized.legacy ? "element_not_found" : "target_not_found",
        normalized.kind === "selector" && normalized.legacy
          ? `No element matches selector "${normalized.selector}".`
          : `No element matches the ${describeTargetKind(normalized)} target.`,
        { kind: normalized.kind, match: "exact" }
      );
    }
    return {
      target: probe,
      actor,
      framePath: [],
      frameUrl: null,
      legacy: normalized.legacy,
      kind: normalized.kind,
    };
  };

  const describeTargetKind = (target: NormalizedTarget): string => {
    switch (target.kind) {
      case "selector":
        return `selector "${target.selector}"`;
      case "role":
        return "role+name";
      case "text":
        return "text";
      case "label":
        return "label";
      case "placeholder":
        return "placeholder";
      default:
        return "ref";
    }
  };

  const actionTarget = (
    target: ResolvedPageTarget
  ): PageActionTargetInfo => ({
    tag: String(target.tag ?? ""),
    role: String(target.role ?? "generic"),
    label: String(target.label ?? ""),
    type: typeof target.type === "string" ? target.type : null,
    sensitive: target.sensitive === true,
  });

  const clickCapabilities = {
    "moz:accessibilityChecks": false,
    "moz:webdriverClick": true,
  };

  const captureSignature = async (
    actor: any,
    timeoutMs: number
  ): Promise<PageSignature | null> => {
    try {
      const raw = await actor.sendQuery(
        "MarionetteCommandsParent:executeScript",
        {
          script: buildPageSignatureScript(),
          args: [],
          opts: { timeout: timeoutMs },
        }
      );
      return coercePageSignature(raw);
    } catch {
      return null;
    }
  };

  /**
   * Watches the acted-on document briefly so the result can say whether the
   * click or typed text changed anything. A probe failure never fails the
   * action itself.
   */
  const observeActionEffect = async (
    tab: ChromeTab,
    framePath: number[],
    allowedDomains: string[] | undefined,
    before: PageSignature | null
  ): Promise<PageActionEffect> => {
    const started = Date.now();
    let after: PageSignature | null = null;
    let documentReplaced = false;
    let waitedMs = 0;
    if (!before) {
      // Without a before signature there is nothing to compare; give a
      // triggered navigation a moment to land, then report the limitation.
      await sleep(ACTION_PROBE_INTERVAL_MS * 2);
      waitedMs = Date.now() - started;
    }
    while (before && waitedMs < ACTION_SETTLE_MS) {
      await sleep(Math.min(ACTION_PROBE_INTERVAL_MS, ACTION_SETTLE_MS - waitedMs));
      try {
        const actor = framePath.length
          ? resolveFrame(tab, framePath, allowedDomains).actor
          : pageActor(tab);
        after = await captureSignature(actor, ACTION_PROBE_TIMEOUT_MS);
      } catch {
        after = null;
      }
      waitedMs = Date.now() - started;
      if (!before || !after) continue;
      documentReplaced = documentChanged(before.root, after.root);
      if (documentReplaced) {
        // A replaced document has to finish loading before its state means
        // anything; comparing it with the old document would be a false diff.
        if (after.readyState === "complete") break;
        continue;
      }
      const delta = buildPageDelta(before, after, { documentReplaced: false });
      if (comparePageSignatures(before, after).changed || deltaHasChanges(delta)) {
        break;
      }
    }
    if (!before || !after) {
      // A navigation can outlive the old actor. The tab URL is still worth
      // comparing even when a full signature cannot be captured.
      const currentUrl = framePath.length ? "" : tabUrl(tab);
      const urlChanged =
        !!before && !!currentUrl && currentUrl !== before.url;
      return {
        changed: urlChanged,
        urlChanged,
        titleChanged: false,
        domChanged: false,
        valueChanged: false,
        waitedMs,
        probeFailed: true,
        ...(urlChanged ? { navigation: true } : {}),
        ...(after ? { readyState: after.readyState } : {}),
      };
    }
    const diff = comparePageSignatures(before, after);
    const delta = buildPageDelta(before, after, { documentReplaced });
    return {
      changed: documentReplaced || diff.changed || deltaHasChanges(delta),
      urlChanged: diff.urlChanged,
      titleChanged: diff.titleChanged,
      domChanged: documentReplaced ? false : diff.domChanged,
      valueChanged: documentReplaced ? false : diff.valueChanged,
      waitedMs,
      ...(diff.urlChanged ? { navigation: true } : {}),
      ...(documentReplaced ? { documentReplaced: true } : {}),
      readyState: after.readyState,
      attribution: "observed_after_action_not_proven",
      delta,
    };
  };

  const typeCapabilities = {
    ...clickCapabilities,
    strictFileInteractability: false,
  };

  const redactTab = (tab: TabInfo): TabInfo => {
    const url = tab.url || tab.requestedUrl || "";
    if (policy.allowsMetadata(url)) return tab;
    return {
      ...tab,
      title: "(restricted by policy)",
      url: "",
      requestedUrl: "",
    };
  };

  /**
   * Resolves every URL this call would touch from browser-owned tab state,
   * before the handler runs. The capability itself is always checked first so
   * a denied or unknown operation cannot be smuggled through a tab-id error.
   */
  const policyPreflight = (method: string, params: unknown): void => {
    policy.assertCapability(method);
    const p =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    // tabClosed is a lifecycle-only wait. A tab that already closed, or has
    // no http(s) URL left, exposes no page content; an open http(s) tab still
    // gets the normal site check below.
    if (p.tabClosed === true) {
      const closedTabId = typeof p.tabId === "string" ? p.tabId : "";
      const closedTab = closedTabId ? tabsById.get(closedTabId) : undefined;
      if (!closedTab || !/^https?:/i.test(tabUrl(closedTab))) return;
    }
    const tabId = typeof p.tabId === "string" ? p.tabId : "";
    const tab = tabId ? tabsById.get(tabId) : undefined;
    const tabScoped = new Set([
      "tabs.read",
      "tabs.findText",
      "tabs.waitFor",
      "tabs.click",
      "tabs.type",
      "tabs.evidence",
      "tabs.evidenceClear",
    ]);
    if (!tab || !tabScoped.has(method)) return;
    const urls = [tabUrl(tab)];
    if (
      ["tabs.read", "tabs.waitFor", "tabs.click", "tabs.type"].includes(
        method
      ) &&
      p.framePath !== undefined
    ) {
      const framePath = requireFramePath(p.framePath);
      if (framePath.length) {
        const frame = resolveFrame(
          tab,
          framePath,
          Array.isArray(p.allowedDomains)
            ? (p.allowedDomains as string[])
            : undefined
        );
        urls.push(frame.url);
      }
    }
    policy.assertOperation(method, urls, { requireUrl: true });
  };

  const assertFrameStillAllowed = (
    method: string,
    params: unknown
  ): void => {
    const p =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const tabId = typeof p.tabId === "string" ? p.tabId : "";
    const tab = tabId ? tabsById.get(tabId) : undefined;
    if (!tab) return;
    const urls = [tabUrl(tab)];
    if (p.framePath !== undefined) {
      const framePath = requireFramePath(p.framePath);
      if (framePath.length) {
        const frameUrl = currentFrameUrl(tab, framePath);
        if (frameUrl) urls.push(frameUrl);
      }
    }
    policy.assertOperation(method, urls, { requireUrl: true });
  };

  /** Revalidates actual URLs after an operation, then filters metadata. */
  const policyPostflight = (
    method: string,
    params: unknown,
    result: unknown
  ): unknown => {
    const value = result as any;
    switch (method) {
      case "status": {
        if (value?.activeTab && !policy.allowsMetadata(value.activeTab.url)) {
          value.activeTab = {
            ...value.activeTab,
            title: "(restricted by policy)",
            url: "",
          };
        }
        return value;
      }
      case "tabs.list": {
        value.tabs = Array.isArray(value?.tabs)
          ? value.tabs.map(redactTab)
          : [];
        return value;
      }
      case "tabs.select": {
        if (value?.tab) value.tab = redactTab(value.tab);
        return value;
      }
      case "tabs.read": {
        policy.assertOperation("tabs.read", [String(value?.url ?? "")], {
          requireUrl: true,
        });
        if (Array.isArray(value?.frames)) {
          value.frames = value.frames.filter((frame: PageFrame) =>
            policy.allows("page.read", frame.url)
          );
        }
        assertFrameStillAllowed("tabs.read", params);
        return value;
      }
      case "tabs.click":
      case "tabs.type":
      case "tabs.findText":
      case "tabs.evidence":
      case "tabs.waitFor": {
        const p =
          params && typeof params === "object"
            ? (params as Record<string, unknown>)
            : {};
        const tabId = typeof p.tabId === "string" ? p.tabId : "";
        const tab = tabId ? tabsById.get(tabId) : undefined;
        // A matched closure wait has no page left to re-check. Reusing its
        // emptied URL would fail a successful lifecycle wait as internal_page.
        const closedWait =
          p.tabClosed === true &&
          !!value &&
          typeof value === "object" &&
          (value as { matched?: unknown }).matched === true;
        if (tab && !closedWait && tab.closing !== true) {
          policy.assertOperation(method, [tabUrl(tab)], {
            requireUrl: true,
          });
          assertFrameStillAllowed(method, params);
        }
        return value;
      }
      case "tabs.evidenceClear": {
        const p =
          params && typeof params === "object"
            ? (params as Record<string, unknown>)
            : {};
        const tabId = typeof p.tabId === "string" ? p.tabId : "";
        const tab = tabId ? tabsById.get(tabId) : undefined;
        if (tab) {
          policy.assertOperation(method, [tabUrl(tab)], {
            requireUrl: true,
          });
        }
        return value;
      }
      case "history.search": {
        value.entries = (value?.entries ?? []).filter((entry: HistoryEntry) =>
          policy.allows("history.read", entry.url)
        );
        if (value.groups) value.groups = groupHistoryEntries(value.entries);
        return value;
      }
      case "bookmarks.search": {
        value.entries = (value?.entries ?? []).filter(
          (entry: BookmarksResult["entries"][number]) =>
            policy.allows("bookmarks.read", entry.url)
        );
        return value;
      }
      case "history.recentlyClosed": {
        value.entries = (value?.entries ?? []).filter(
          (entry: RecentlyClosedEntry) =>
            policy.allows("history.read", entry.url)
        );
        return value;
      }
      default:
        return value;
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
        outcome: "completed",
        confirmation: "delivered",
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
      // Check the requested URLs before any tab exists. The post-check below
      // covers redirects that commit a different URL.
      policy.assertOperation("tabs.open", urls, { requireUrl: true });
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

      // A requested URL can redirect. Close tabs that committed a blocked
      // URL instead of returning a window into a site policy forbids.
      const blocked = opened.filter((tab) => {
        const actual = tabUrl(tab) || requested.get(tab) || "";
        return !policy.allows("nav.open", actual);
      });
      if (blocked.length) {
        const blockedUrls: string[] = [];
        for (const tab of blocked) {
          blockedUrls.push(tabUrl(tab) || requested.get(tab) || "");
          try {
            const id = tabIds.get(tab);
            if (id) tabsById.delete(id);
            tabIds.delete(tab);
            win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
          } catch {
            // Best effort cleanup; the denial below still applies.
          }
        }
        policy.assertOperation("tabs.open", blockedUrls, {
          requireUrl: true,
        });
      }

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
        const id = tabIds.get(tab);
        if (id) refRegistry.clearTab(id);
        if (!tab.isConnected || tab.closing || !id) continue;
        win.gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
        closed.push(id);
      }
      return { closed: closed.length, tabIds: closed } satisfies CloseTabsResult;
    },

    "tabs.select": async (params: SelectTabParams) => {
      const [tab] = resolveTabs([String(params?.tabId ?? "")]);
      if (!tab) throw new OpsError("tab_not_found", "No tab matched that id");
      const tabId = idForTab(tab);
      const focusWindow = params?.focusWindow === true;
      let outcome: TabActivationOutcome;
      try {
        outcome = await activateTab(win, tab, { focusWindow });
      } catch (error) {
        throw new OpsError(
          "select_failed",
          `Could not select the tab "${tabTitle(tab)}" (${tabId}): ` +
            `${String((error as Error)?.message ?? error)}`
        );
      }
      if (!outcome.active) {
        const current = win.gBrowser?.selectedTab;
        const currentTitle =
          current && current !== tab
            ? `"${tabTitle(current)}" (${idForTab(current)})`
            : "another tab";
        const detail = outcome.lastError ? ` Last error: ${outcome.lastError}` : "";
        throw new OpsError(
          "select_failed",
          `The tab "${tabTitle(tab)}" (${tabId}) did not become the active ` +
            `tab after ${outcome.attempts} attempt(s); ${currentTitle} is ` +
            `still active.${detail}`
        );
      }
      const result: SelectTabResult = {
        tab: tabInfo(tab, [...realTabs()].indexOf(tab)),
        activeSpaceId: spacesEnabled()
          ? win.gZenWorkspaces.activeWorkspace
          : null,
      };
      if (focusWindow && outcome.windowFocused !== undefined) {
        result.windowFocused = outcome.windowFocused;
      }
      return result;
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
      const format = params?.format;
      const isSnapshot = format === "snapshot";
      const isSemantic = format === "semantic";
      const isCompact = isSnapshot || isSemantic;
      const isControls = format === "interactive" || isCompact;
      const maxChars = isCompact
        ? SNAPSHOT_TEXT_CHARS
        : clamp(params?.maxChars ?? 24_000, 500, 60_000);
      const requestedMaxElements = params?.maxElements;
      const maxElements = isCompact
        ? isSemantic
          ? Math.min(120, clampSnapshotElements(requestedMaxElements))
          : clampSnapshotElements(requestedMaxElements)
        : MAX_PAGE_ELEMENTS;
      const requestedOffset = Number(params?.offset);
      const offset = Number.isFinite(requestedOffset)
        ? Math.max(0, Math.floor(requestedOffset))
        : 0;
      const selector = params?.selector ? String(params.selector).trim() : undefined;
      const framePath = requireFramePath(params?.framePath);
      const allowedDomains = params?.allowedDomains;
      const notes: string[] = [];

      if (requestedMaxElements !== undefined && !isCompact) {
        notes.push("maxElements only applies to snapshot and semantic reads.");
      }
      if (
        isCompact &&
        params?.maxChars !== undefined &&
        Math.floor(Number(params.maxChars)) !== SNAPSHOT_TEXT_CHARS
      ) {
        notes.push(
          `maxChars is ignored for ${format} reads; the text preview is capped ` +
            `at ${SNAPSHOT_TEXT_CHARS} characters.`
        );
      }
      if (isSemantic && selector) {
        notes.push("Semantic reads search only the selected subtree.");
      }

      if (isControls && isPdfTab(tab)) {
        throw new OpsError(
          "unsupported_page",
          "Zen MCP cannot build an interactive, snapshot or semantic view of " +
            "the PDF viewer. Open the page as HTML instead."
        );
      }

      // PDFs render in the pdf.js viewer, which the page read script cannot
      // see. Their text comes straight from the viewer instead.
      if (isPdfTab(tab)) {
        if (framePath.length) {
          throw new OpsError(
            "unsupported_frame",
            "PDF text is only read from the tab's top-level document."
          );
        }
        return readPdfTab(tab, maxChars, offset);
      }

      const frame = framePath.length
        ? resolveFrame(tab, framePath, allowedDomains)
        : null;
      // Re-check the browser-owned URL immediately before content is read.
      policy.assertOperation(
        "tabs.read",
        [frame?.url ?? tabUrl(tab)],
        { requireUrl: true }
      );
      const contentType = frame ? null : contentTypeOf(tab);

      // Marionette's content context only sees tabs in gBrowser, so tabs in an
      // inactive space cannot be reached that way. The driver's content actor
      // executes the same script inside any loaded browsing context, which is
      // what makes non-disruptive background research possible.
      const runRead = (
        actor: any,
        refPrefix: string
      ): Promise<unknown> =>
        actor.sendQuery("MarionetteCommandsParent:executeScript", {
          script: buildReadScript({
            maxChars,
            offset,
            ...(format ? { format } : {}),
            ...(selector ? { selector } : {}),
            ...(isCompact ? { maxElements } : {}),
            ...(refPrefix ? { refPrefix } : {}),
          }),
          args: [],
          opts: { timeout: 15_000 },
        });

      let raw: unknown;
      try {
        raw = await runRead(
          frame?.actor ?? pageActor(tab),
          frameRefPrefix(framePath)
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

      const listed = listFrames(tab, allowedDomains);
      const snapshotId = isControls
        ? `snap-${crypto.randomUUID().slice(0, 8)}`
        : null;
      const refTabId = idForTab(tab);
      const storeDocument = (path: number[], target: PageSnapshot): void => {
        if (!snapshotId) return;
        refRegistry.beginSnapshot(
          refTabId,
          path,
          snapshotId,
          target.root,
          [...(target.elements ?? []), ...(target.semanticAnchors ?? [])]
        );
      };

      // Replace this document's refs only after the read succeeded, so a failed
      // selector read never invalidates refs the agent is still using.
      if (isControls) storeDocument(framePath, page);

      if (isControls && !selector && !isSemantic) {
        const descendants = listed.frames.filter(
          (candidate) =>
            candidate.path.length > framePath.length &&
            framePath.every(
              (index, position) => candidate.path[position] === index
            )
        );
        const scanned = descendants.slice(0, MAX_FRAME_SCANS);
        const scanCap = MAX_FRAME_SCANS;
        const mergeCap = isSnapshot ? maxElements : MAX_PAGE_ELEMENTS;

        const merged: ReadScriptElement[] = (page.elements ?? []).map((element) =>
          framePath.length
            ? {
                ...element,
                framePath: [...framePath],
                frameUrl: frame?.url ?? null,
              }
            : element
        );
        let elementsTotal =
          page.elementsTotal ?? page.elements?.length ?? 0;
        let truncated = page.elementsTruncated === true;
        const pending = scanned.map(async (candidate) => {
          try {
            const context = resolveFrame(tab, candidate.path, allowedDomains);
            const frameRaw = await runRead(
              context.actor,
              frameRefPrefix(candidate.path)
            );
            return {
              frame: candidate,
              page: coercePageSnapshot(frameRaw),
            };
          } catch {
            return { frame: candidate, page: null };
          }
        });
        const outcomes = await Promise.all(pending);
        let failed = 0;
        for (const outcome of outcomes) {
          if (!outcome.page) {
            failed += 1;
            continue;
          }
          storeDocument(outcome.frame.path, outcome.page);
          elementsTotal +=
            outcome.page.elementsTotal ?? outcome.page.elements?.length ?? 0;
          if (outcome.page.elementsTruncated === true) truncated = true;
          for (const element of outcome.page.elements ?? []) {
            if (merged.length >= mergeCap) {
              truncated = true;
              break;
            }
            merged.push({
              ...element,
              framePath: [...outcome.frame.path],
              frameUrl: outcome.frame.url,
            });
          }
        }
        page.elements = merged;
        page.elementsTruncated = truncated;
        page.elementsTotal = elementsTotal;

        if (isSnapshot) {
          const completeness = snapshotCompleteness({
            selectorUsed: false,
            relevantFrames: descendants.length,
            scannedFrames: scanned.length,
            failedFrames: failed,
            listedTruncated: listed.truncated,
            listedSkipped: listed.skipped,
            scanCap,
          });
          page.framesComplete = completeness.framesComplete;
          page.snapshotComplete = completeness.snapshotComplete;
          page.limitations = [
            ...(page.limitations ?? []),
            ...completeness.limitations,
          ];
        } else {
          if (descendants.length > scanned.length) {
            notes.push(
              `Only the first ${scanCap} frames were scanned for controls.`
            );
          }
          if (failed > 0) {
            notes.push(`${failed} frame(s) could not be read.`);
          }
        }
      } else if (isSemantic) {
        const nestedFrames = listed.frames.filter(
          (candidate) =>
            candidate.path.length > framePath.length &&
            framePath.every(
              (index, position) => candidate.path[position] === index
            )
        );
        if (nestedFrames.length) {
          notes.push(
            "Child frames are not part of the semantic model; read a frame " +
              "with framePath."
          );
        }
        // The model covers one document. A child frame, or a truncated frame
        // list that may hide one, means it is not complete.
        if (page.semantic) {
          page.semantic.coverage.complete =
            page.semantic.coverage.complete &&
            nestedFrames.length === 0 &&
            !listed.truncated;
        }
      } else if (isSnapshot) {
        const completeness = snapshotCompleteness({
          selectorUsed: true,
          relevantFrames: 0,
          scannedFrames: 0,
          failedFrames: 0,
          listedTruncated: false,
          listedSkipped: 0,
        });
        page.framesComplete = completeness.framesComplete;
        page.snapshotComplete = completeness.snapshotComplete;
        page.limitations = [
          ...(page.limitations ?? []),
          ...completeness.limitations,
        ];
      } else if (format === "interactive" && listed.frames.length) {
        notes.push(
          "Frame controls are not included because selector was used."
        );
      }

      if (!isSnapshot) {
        if (listed.skipped > 0) {
          notes.push(
            `${listed.skipped} frame(s) were skipped because they are not ` +
              "http(s) pages or are outside the domain allowlist."
          );
        }
        if (listed.truncated) {
          notes.push(
            `Only the first ${MAX_FRAMES} frames are listed; deeper frames ` +
              "were not inspected."
          );
        }
      }
      if (isCompact && notes.length) {
        // Frame and scope notes belong to the read, not the semantic model;
        // keeping them in one list avoids repeating them in both places.
        page.limitations = [...(page.limitations ?? []), ...notes];
      }

      // A background tab can hide contentDocument from chrome scope, so omit
      // the override and let the read script's contentType through instead.
      const result = toPageReadResult(page, {
        maxChars,
        ...(contentType !== null ? { contentType } : {}),
        offset,
        ...(snapshotId ? { snapshotId } : {}),
      }) satisfies PageReadResult;
      result.frames = listed.frames;
      if (framePath.length) result.framePath = framePath;
      if (!isCompact && notes.length) {
        const note = notes.join(" ");
        result.limitation = result.limitation
          ? `${result.limitation} ${note}`
          : note;
      }
      return result;
    },

    "tabs.click": async (
      params: ClickElementParams
    ): Promise<ClickElementResult> => {
      const tabId = String(params?.tabId ?? "");
      const tab = requireActionTab(tabId, "click");
      assertActionUrlAllowed(
        tabUrl(tab),
        params?.allowedDomains,
        "clicking in"
      );
      const resolved = await resolvePageTarget(
        tab,
        params ?? {},
        params?.allowedDomains
      );
      const target = resolved.target;
      if (!resolved.legacy && target.visible === false) {
        throw new OpsError(
          "target_not_actionable",
          `The target "${target.label || target.tag}" is not visible.`,
          { reason: "hidden" }
        );
      }
      if (target.disabled) {
        throw new OpsError(
          resolved.legacy ? "element_disabled" : "target_not_actionable",
          `The target "${target.label || target.tag}" is disabled.`,
          { reason: "disabled" }
        );
      }
      if (target.href) {
        assertActionUrlAllowed(
          target.href,
          params?.allowedDomains,
          "following a link to"
        );
      }
      policy.assertOperation(
        "tabs.click",
        [
          tabUrl(tab),
          ...(resolved.frameUrl ? [resolved.frameUrl] : []),
          ...(target.href ? [target.href] : []),
        ],
        { requireUrl: true }
      );

      const before = await captureSignature(
        resolved.actor,
        SIGNATURE_BEFORE_TIMEOUT_MS
      );
      try {
        await resolved.actor.sendQuery("MarionetteCommandsParent:clickElement", {
          elem: target.element,
          capabilities: clickCapabilities,
        });
      } catch (error) {
        throw new OpsError(
          "click_failed",
          `Could not click "${target.label || target.tag}": ${String(
            (error as Error)?.message ?? error
          )}`
        );
      }
      const effect = await observeActionEffect(
        tab,
        resolved.framePath,
        params?.allowedDomains,
        before
      );
      const url = tabUrl(tab);
      return {
        clicked: true,
        tabId,
        url: isHttpUrl(url) ? url : "",
        title: tabTitle(tab),
        target: actionTarget(target),
        effect,
        ...(resolved.framePath.length
          ? {
              framePath: resolved.framePath,
              frameUrl:
                currentFrameUrl(tab, resolved.framePath) ??
                resolved.frameUrl,
            }
          : {}),
      } satisfies ClickElementResult;
    },

    "tabs.type": async (params: TypeTextParams): Promise<TypeTextResult> => {
      const tabId = String(params?.tabId ?? "");
      const tab = requireActionTab(tabId, "type into");
      const text = String(params?.text ?? "");
      const clear = params?.clear === true;
      if (!text && !clear) {
        throw new OpsError(
          "invalid_args",
          "Provide text to type, or set clear=true to empty the field."
        );
      }
      if (text.length > 10_000) {
        throw new OpsError(
          "invalid_args",
          "text must be 10,000 characters or fewer."
        );
      }
      assertActionUrlAllowed(
        tabUrl(tab),
        params?.allowedDomains,
        "typing into"
      );
      const resolved = await resolvePageTarget(
        tab,
        params ?? {},
        params?.allowedDomains
      );
      const target = resolved.target;
      if (!resolved.legacy && target.visible === false) {
        throw new OpsError(
          "target_not_actionable",
          `The target "${target.label || target.tag}" is not visible.`,
          { reason: "hidden" }
        );
      }
      if (target.disabled) {
        throw new OpsError(
          resolved.legacy ? "element_disabled" : "target_not_actionable",
          `The target "${target.label || target.tag}" is disabled.`,
          { reason: "disabled" }
        );
      }
      if (target.readOnly) {
        throw new OpsError(
          resolved.legacy ? "element_readonly" : "target_not_actionable",
          `The target "${target.label || target.tag}" is read-only.`,
          { reason: "read_only" }
        );
      }
      if (target.tag === "input" && target.type === "file") {
        throw new OpsError(
          resolved.legacy ? "unsupported_target" : "target_not_actionable",
          "Zen MCP does not attach files. Ask the user to choose the file " +
            "in Zen.",
          { reason: "file_input" }
        );
      }
      if (!resolved.legacy && target.editable !== true) {
        throw new OpsError(
          "target_not_actionable",
          `The target "${target.label || target.tag}" is not editable.`,
          { reason: "not_editable" }
        );
      }
      policy.assertOperation(
        "tabs.type",
        [tabUrl(tab), ...(resolved.frameUrl ? [resolved.frameUrl] : [])],
        { requireUrl: true }
      );

      const before = await captureSignature(
        resolved.actor,
        SIGNATURE_BEFORE_TIMEOUT_MS
      );
      try {
        if (clear) {
          await resolved.actor.sendQuery(
            "MarionetteCommandsParent:clearElement",
            {
              elem: target.element,
            }
          );
        }
        await resolved.actor.sendQuery(
          "MarionetteCommandsParent:sendKeysToElement",
          {
            elem: target.element,
            text,
            capabilities: typeCapabilities,
          }
        );
      } catch (error) {
        throw new OpsError(
          "type_failed",
          `Could not type into "${target.label || target.tag}": ${String(
            (error as Error)?.message ?? error
          )}`
        );
      }
      const observed = await (async () => {
        try {
          const raw = await resolved.actor.sendQuery(
            "MarionetteCommandsParent:executeScript",
            {
              script: buildVerifyTypedValueScript(),
              args: [target.element, text, clear ? "exact" : "suffix"],
              opts: { timeout: 5_000 },
            }
          );
          const probe = coerceTypedValueProbe(raw);
          return {
            ...probe,
            sensitive: probe.sensitive || target.sensitive === true,
          };
        } catch {
          return {
            compared: false,
            matchesInput: null,
            sensitive: target.sensitive === true,
          };
        }
      })();
      const limitation = observed.compared
        ? observed.matchesInput === false
          ? "The field value did not match the typed text exactly; the page " +
            "may have reformatted it."
          : undefined
        : observed.sensitive
          ? "This field is classified sensitive. The text is not echoed or " +
            "read back, so typing was not verified."
          : "The typed value could not be read back; the field may have " +
            "navigated or been replaced.";
      const effect = await observeActionEffect(
        tab,
        resolved.framePath,
        params?.allowedDomains,
        before
      );
      const url = tabUrl(tab);
      return {
        typed: text.length,
        cleared: clear,
        tabId,
        url: isHttpUrl(url) ? url : "",
        title: tabTitle(tab),
        target: actionTarget(target),
        effect,
        observed,
        ...(resolved.framePath.length
          ? {
              framePath: resolved.framePath,
              frameUrl:
                currentFrameUrl(tab, resolved.framePath) ??
                resolved.frameUrl,
            }
          : {}),
        ...(limitation ? { limitation } : {}),
      } satisfies TypeTextResult;
    },

    "tabs.waitFor": async (params: WaitForParams): Promise<WaitForResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) {
        throw new OpsError("no_tab", "Provide the tabId to wait in.");
      }
      const value = (input: unknown): string =>
        typeof input === "string" ? input.trim() : "";
      const until = params?.until === "absent" ? "absent" : "present";
      const tabClosed = params?.tabClosed === true;
      const selector = value(params?.selector);
      const text = value(params?.text);
      const urlContains = value(params?.urlContains);
      const titleContains = value(params?.titleContains);
      const state: WaitElementState =
        params?.state === "visible" || params?.state === "enabled"
          ? params.state
          : "present";
      if (params?.state !== undefined && !selector) {
        throw new OpsError(
          "invalid_args",
          "state requires a selector condition."
        );
      }
      const documentChanged = params?.documentChanged === true;
      const requestedDocumentId = value(params?.documentId);
      const newTab = params?.newTab === true;
      const dialog = params?.dialog === true;

      const candidates: Array<[WaitCondition, string]> = [];
      if (selector) candidates.push(["selector", selector]);
      if (text) candidates.push(["text", text]);
      if (urlContains) candidates.push(["urlContains", urlContains]);
      if (titleContains) candidates.push(["titleContains", titleContains]);
      if (documentChanged || requestedDocumentId) {
        candidates.push(["document", requestedDocumentId || "document"]);
      }
      if (newTab) candidates.push(["newTab", "newTab"]);
      if (tabClosed) candidates.push(["tabClosed", tabId]);
      if (dialog) candidates.push(["dialog", "dialog"]);
      if (candidates.length !== 1) {
        throw new OpsError(
          "invalid_args",
          "Provide exactly one condition: selector, text, urlContains, " +
            "titleContains, documentChanged, documentId, newTab, tabClosed, " +
            "or dialog."
        );
      }
      const [condition, query] = candidates[0];
      if (query.length > 2_000) {
        throw new OpsError(
          "invalid_args",
          "The condition text must be 2,000 characters or fewer."
        );
      }
      if (
        until === "absent" &&
        (condition === "document" ||
          condition === "newTab" ||
          condition === "tabClosed" ||
          condition === "dialog")
      ) {
        throw new OpsError(
          "invalid_args",
          "until absent is only supported for selector, text, URL and title conditions."
        );
      }

      let tab: ChromeTab;
      try {
        tab = requireActionTab(tabId, "wait in");
      } catch (error) {
        // Only a tab this session knew and that is now gone counts as closed;
        // a live privileged or PDF tab must keep its original error.
        const known = tabsById.get(tabId);
        const closed =
          closedTabIds.has(tabId) ||
          (known !== undefined && (!known.isConnected || known.closing));
        if (tabClosed && closed) {
          return {
            matched: true,
            waitedMs: 0,
            condition: "tabClosed",
            until,
            query: tabId,
            tabId,
            url: "",
            title: "",
            limitation: "The tab was already closed when the wait started.",
          } satisfies WaitForResult;
        }
        throw error;
      }
      const framePath = requireFramePath(params?.framePath);
      if (framePath.length && condition === "document") {
        throw new OpsError(
          "invalid_args",
          "Document identity conditions apply to the top document; " +
            "remove framePath."
        );
      }
      const allowedDomains = params?.allowedDomains;
      assertActionUrlAllowed(tabUrl(tab), allowedDomains, "waiting in");

      const requestedTimeout = Number(params?.timeoutMs);
      // Zero means one immediate check, not the default window.
      const timeoutMs = clamp(
        Number.isFinite(requestedTimeout) && requestedTimeout >= 0
          ? requestedTimeout
          : WAIT_TIMEOUT_MS,
        0,
        WAIT_MAX_TIMEOUT_MS
      );
      const requestedPoll = Number(params?.pollMs);
      const pollMs = clamp(
        Number.isFinite(requestedPoll) && requestedPoll > 0
          ? requestedPoll
          : WAIT_POLL_MS,
        WAIT_MIN_POLL_MS,
        WAIT_MAX_POLL_MS
      );

      const pageCondition =
        condition === "selector" ||
        condition === "text" ||
        condition === "urlContains" ||
        condition === "titleContains";

      const startDocumentId = documentIdForTab(tab);
      const documentBaseline = requestedDocumentId || startDocumentId;
      const startTabIds = new Set(realTabs().map((entry) => idForTab(entry)));
      let openedTabId = "";
      let closedTab = false;
      const dialogBaseline = dialogSeq;

      let changeWaiter: (() => void) | null = null;
      let wakeTimer: ReturnType<typeof setTimeout> | null = null;
      const signalChange = (): void => {
        if (wakeTimer) {
          clearTimeout(wakeTimer);
          wakeTimer = null;
        }
        const waiter = changeWaiter;
        changeWaiter = null;
        waiter?.();
      };
      const sleepOrChange = (ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            changeWaiter = null;
            if (wakeTimer) {
              clearTimeout(wakeTimer);
              wakeTimer = null;
            }
            resolve();
          };
          changeWaiter = finish;
          wakeTimer = setTimeout(finish, ms);
        });

      const container = win.gBrowser?.tabContainer;
      const onTabOpen = (event: any): void => {
        try {
          const id = idForTab(event?.target);
          if (!openedTabId && !startTabIds.has(id)) openedTabId = id;
        } catch {
          // A tab that cannot be identified still wakes the loop.
        }
        signalChange();
      };
      const onTabClose = (event: any): void => {
        try {
          if (idForTab(event?.target) === tabId) closedTab = true;
        } catch {
          // Fall through to polling.
        }
        signalChange();
      };
      const dialogWaiter = (): void => signalChange();
      const watchingTabs = condition === "newTab" || condition === "tabClosed";
      try {
        if (watchingTabs && container?.addEventListener) {
          container.addEventListener("TabOpen", onTabOpen);
          container.addEventListener("TabClose", onTabClose);
        }
        if (condition === "dialog") dialogWaiters.add(dialogWaiter);

        const probeOptions: WaitProbeOptions = {
          [condition]: query,
          ...(condition === "selector" ? { state } : {}),
        };
        let probe: WaitProbe | null = null;
        let lastError = "";
        let matched = false;
        let waitedMs = 0;
        const started = Date.now();
        for (;;) {
          if (!tab.isConnected && (pageCondition || condition === "document")) {
            lastError = "the tab closed";
            matched = false;
            break;
          }
          if (pageCondition) {
            // The top document can navigate to another site mid-wait; recheck
            // the allowlist before probing so an off-list page is not read.
            try {
              assertActionUrlAllowed(tabUrl(tab), allowedDomains, "waiting in");
            } catch (error) {
              if (
                error instanceof OpsError &&
                error.code === "domain_not_allowed"
              ) {
                lastError = "the page left the domain allowlist";
                matched = false;
                break;
              }
              throw error;
            }
            try {
              policy.assertOperation("tabs.waitFor", [tabUrl(tab)], {
                requireUrl: true,
              });
            } catch (error) {
              if (error instanceof BridgePolicyError) {
                lastError = "the page left the policy";
                matched = false;
                break;
              }
              throw error;
            }
            let actor: any = null;
            try {
              const frame = framePath.length
                ? resolveFrame(tab, framePath, allowedDomains)
                : null;
              policy.assertOperation(
                "tabs.waitFor",
                [tabUrl(tab), ...(frame ? [frame.url] : [])],
                { requireUrl: true }
              );
              actor = frame?.actor ?? pageActor(tab);
            } catch (error) {
              if (error instanceof BridgePolicyError) {
                lastError = "the page left the policy";
                matched = false;
                break;
              }
              if (
                error instanceof OpsError &&
                error.code === "domain_not_allowed"
              ) {
                throw error;
              }
              lastError = String((error as Error)?.message ?? error);
            }
            if (actor) {
              try {
                const raw = await actor.sendQuery(
                  "MarionetteCommandsParent:executeScript",
                  {
                    script: buildWaitProbeScript(probeOptions),
                    args: [],
                    opts: { timeout: WAIT_PROBE_TIMEOUT_MS },
                  }
                );
                probe = coerceWaitProbe(raw);
                if (!probe) lastError = "the probe returned no document state";
              } catch (error) {
                probe = null;
                lastError = String((error as Error)?.message ?? error);
              }
            }
            matched = probe
              ? until === "absent"
                ? probe.matched === false
                : probe.matched === true
              : false;
          } else if (condition === "document") {
            const current = tab.isConnected ? documentIdForTab(tab) : "";
            // An empty identity is a missing document, never a match: a
            // replaced page that has not committed must not read as changed.
            matched =
              current !== "" &&
              documentBaseline !== "" &&
              (documentChanged
                ? current !== documentBaseline
                : current === documentBaseline);
          } else if (condition === "newTab") {
            if (!openedTabId) {
              for (const entry of realTabs()) {
                const id = idForTab(entry);
                if (!startTabIds.has(id)) {
                  openedTabId = id;
                  break;
                }
              }
            }
            matched = openedTabId.length > 0;
          } else if (condition === "tabClosed") {
            if (!closedTab) {
              const alive = realTabs().some(
                (entry) => idForTab(entry) === tabId
              );
              if (!alive) closedTab = true;
            }
            matched = closedTab;
          } else if (condition === "dialog") {
            matched = dialogSeq > dialogBaseline;
          }
          waitedMs = Date.now() - started;
          if (matched || waitedMs >= timeoutMs) break;
          const remaining = Math.min(pollMs, timeoutMs - waitedMs);
          if (watchingTabs || condition === "dialog") {
            await sleepOrChange(remaining);
          } else {
            await sleep(remaining);
          }
        }

        const finalDocumentId = tab.isConnected ? documentIdForTab(tab) : "";
        const finalUrl = tab.isConnected ? tabUrl(tab) : "";
        // The page may have navigated off the allowlist since the last probe;
        // do not echo a title or URL the caller was never allowed to read.
        const finalAllowed =
          isHttpUrl(finalUrl) && isUrlAllowed(finalUrl, allowedDomains);
        let limitation: string | undefined;
        if (!matched) {
          if (lastError && (pageCondition || condition === "document")) {
            limitation = `The document could not be inspected after ${waitedMs} ms` +
              (lastError ? `: ${lastError}` : ".");
          } else if (condition === "document") {
            limitation = documentBaseline
              ? `The document identity did not ${
                  documentChanged ? "change" : "match"
                } within ${waitedMs} ms.`
              : `The document identity was not available after ${waitedMs} ms.`;
          } else if (condition === "newTab") {
            limitation = `No new tab opened within ${waitedMs} ms.`;
          } else if (condition === "tabClosed") {
            limitation = `The tab was still open after ${waitedMs} ms.`;
          } else if (condition === "dialog") {
            limitation =
              `No browser dialog was observed within ${waitedMs} ms. ` +
              "A dialog that appeared before the wait started is not counted.";
          } else {
            limitation = `The condition did not hold within ${waitedMs} ms.`;
          }
        } else if (condition === "tabClosed") {
          limitation =
            "The tab closed during the wait; its final page state was not read.";
        }
        return {
          matched,
          waitedMs,
          condition,
          until,
          query,
          tabId,
          url: finalAllowed ? finalUrl : "",
          title: finalAllowed ? tabTitle(tab) : "",
          ...(condition === "selector" ? { state } : {}),
          ...(finalDocumentId ? { documentId: finalDocumentId } : {}),
          ...(openedTabId ? { newTabId: openedTabId } : {}),
          ...(framePath.length
            ? {
                framePath,
                frameUrl: (() => {
                  const candidate =
                    currentFrameUrl(tab, framePath) ??
                    (probe?.url ? probe.url : null);
                  return candidate &&
                    isHttpUrl(candidate) &&
                    isUrlAllowed(candidate, allowedDomains)
                    ? candidate
                    : null;
                })(),
              }
            : {}),
          ...(limitation ? { limitation } : {}),
        } satisfies WaitForResult;
      } finally {
        if (watchingTabs && container?.removeEventListener) {
          container.removeEventListener("TabOpen", onTabOpen);
          container.removeEventListener("TabClose", onTabClose);
        }
        dialogWaiters.delete(dialogWaiter);
      }
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
      policy.assertOperation("tabs.findText", [tabUrl(tab)], {
        requireUrl: true,
      });

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

      return serializeTab(tabId, async () => {
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
      // The tab can navigate while this call waits for the page to settle.
      policy.assertOperation("tabs.evidence", [state.url], {
        requireUrl: true,
      });

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
      });
    },

    "tabs.evidenceClear": async (
      params: EvidenceClearParams
    ): Promise<EvidenceClearResult> => {
      const tabId = String(params?.tabId ?? "");
      if (!tabId) {
        throw new OpsError("no_tab", "Provide the tabId whose marks to clear.");
      }
      return serializeTab(tabId, async () => {
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
      });
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
      const tracked: Array<{
        tab: ChromeTab;
        tabId: string;
        capture: EssentialsCapture;
      }> = [];
      for (const tab of tabs) {
        if (isEssentialTab(tab)) continue;
        const tabId = idForTab(tab);
        // Capture before Zen can re-home the tab. Repeated adds keep the first
        // capture so the essentials placement never overwrites the original.
        const capture = captureEssentialsState(essentialsCaptures, tabId, tab);
        const added = await Promise.resolve(manager.addToEssentials(tab));
        if (added === true) {
          changed.push(tabId);
          tracked.push({ tab, tabId, capture });
        }
      }

      const notes = new Map<string, Set<string>>();
      const note = (tabId: string, reasons: string[]): void => {
        if (!reasons.length) return;
        const existing = notes.get(tabId) ?? new Set<string>();
        for (const reason of reasons) existing.add(reason);
        notes.set(tabId, existing);
      };
      let restored = 0;
      if (tracked.length) {
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of tracked) {
          const report = restoreEssentialsState(
            entry.capture,
            entry.tab,
            essentialsRestoreHost(),
            { restorePinned: false }
          );
          if (report.applied && report.spaceRestored) restored++;
          note(entry.tabId, report.reasons);
        }
        // Give Zen a moment to apply the restore, then confirm it held.
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of tracked) {
          const verification = verifyEssentialsState(
            entry.capture,
            entry.tab,
            { restorePinned: false }
          );
          note(entry.tabId, verification.reasons);
        }
      }
      const limitation = describeEssentialsLimitations(notes);
      return {
        tabIds: changed,
        changed: changed.length,
        ...(tracked.length ? { restored } : {}),
        ...(limitation ? { limitation } : {}),
      } satisfies EssentialsResult;
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
      const tracked: Array<{
        tab: ChromeTab;
        tabId: string;
        capture: EssentialsCapture | undefined;
      }> = [];
      for (const tab of tabs) {
        if (!isEssentialTab(tab)) continue;
        const tabId = idForTab(tab);
        const removed = await Promise.resolve(manager.removeEssentials(tab));
        if (removed !== false) {
          changed.push(tabId);
          // A missing capture means this bridge session did not add the tab,
          // so its prior state is unknown and no restoration is attempted.
          tracked.push({
            tab,
            tabId,
            capture: essentialsCaptures.take(tabId),
          });
        }
      }

      const notes = new Map<string, Set<string>>();
      const note = (tabId: string, reasons: string[]): void => {
        if (!reasons.length) return;
        const existing = notes.get(tabId) ?? new Set<string>();
        for (const reason of reasons) existing.add(reason);
        notes.set(tabId, existing);
      };
      let restored = 0;
      const withCapture = tracked.filter(
        (entry): entry is typeof entry & { capture: EssentialsCapture } =>
          entry.capture !== undefined
      );
      if (withCapture.length) {
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of withCapture) {
          const report = restoreEssentialsState(
            entry.capture,
            entry.tab,
            essentialsRestoreHost()
          );
          if (
            report.applied &&
            report.spaceRestored &&
            report.pinnedRestored
          ) {
            restored++;
          }
          note(entry.tabId, report.reasons);
        }
        await sleep(LAYOUT_SETTLE_MS);
        for (const entry of withCapture) {
          const verification = verifyEssentialsState(
            entry.capture,
            entry.tab
          );
          note(entry.tabId, verification.reasons);
        }
      }
      const limitation = describeEssentialsLimitations(notes);
      return {
        tabIds: changed,
        changed: changed.length,
        ...(withCapture.length ? { restored } : {}),
        ...(limitation ? { limitation } : {}),
      } satisfies EssentialsResult;
    },

    "containers.list": () =>
      ({ containers: containerIdentities() }) satisfies ContainersResult,

    "glance.open": async (params: GlanceParams) => {
      const sourceTab = params?.tabId
        ? resolveTabs([String(params.tabId)])[0]
        : null;
      let rawUrl: string;
      let userContextId: number | undefined;
      if (sourceTab) {
        rawUrl = tabUrl(sourceTab);
        if (!rawUrl) {
          throw new OpsError(
            "invalid_url",
            `The tab "${tabTitle(sourceTab)}" has no URL to preview.`
          );
        }
        const containerId = containerIdOf(sourceTab);
        userContextId = containerId > 0 ? containerId : undefined;
      } else {
        rawUrl = normalizeUrl(String(params?.url ?? ""));
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

      // Glance hands the URL to a privileged loader, so reject everything that
      // is not plain web content before the preview starts.
      const preview = normalizeWebUrl(rawUrl);
      if (!preview) {
        throw new OpsError(
          "invalid_url",
          `Refusing to preview "${rawUrl}". Glance only opens http(s) URLs.`
        );
      }
      const url = preview.href;
      const allowedDomains = Array.isArray(params?.allowedDomains)
        ? params.allowedDomains.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [];
      if (!isUrlAllowed(url, allowedDomains)) {
        throw new OpsError(
          "domain_not_allowed",
          `Refusing to preview ${preview.hostname}, which is outside the ` +
            "configured domain allowlist."
        );
      }
      policy.assertOperation("glance.open", [url], { requireUrl: true });

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

      let triggeringPrincipal: unknown;
      try {
        triggeringPrincipal =
          Services.scriptSecurityManager.createContentPrincipal(
            Services.io.newURI(url),
            userContextId ? { userContextId } : {}
          );
      } catch (error) {
        throw new OpsError(
          "glance_failed",
          `Could not prepare the preview: ${String(
            (error as Error)?.message ?? error
          )}`
        );
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
          triggeringPrincipal,
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
      if (!result) {
        return {
          opened: false,
          url,
          mode: "none",
          message: "Zen declined to open the glance view.",
        } satisfies GlanceResult;
      }

      const closePreview = () => {
        try {
          manager.closeGlance?.({ noAnimation: true, skipPermitUnload: true });
        } catch {
          // Closing is best effort; the policy violation is reported below.
        }
      };

      // The requested URL is not necessarily the URL that loads: a redirect
      // can leave the allowlist. Verify what the preview committed.
      const loadedUrl = isGlanceTab(result)
        ? await waitForGlanceUrl(result)
        : undefined;
      if (!loadedUrl) {
        closePreview();
        throw new OpsError(
          "glance_failed",
          "The preview opened but its URL could not be verified, so it was closed."
        );
      }
      const loaded = normalizeWebUrl(loadedUrl);
      if (!loaded) {
        closePreview();
        throw new OpsError(
          "invalid_url",
          `The preview loaded "${loadedUrl}", which is not an http(s) URL.`
        );
      }
      if (!isUrlAllowed(loaded.href, allowedDomains)) {
        closePreview();
        throw new OpsError(
          "domain_not_allowed",
          `The preview redirected to ${loaded.hostname}, which is outside the ` +
            "configured domain allowlist, so it was closed."
        );
      }
      try {
        policy.assertOperation("glance.open", [loaded.href], {
          requireUrl: true,
        });
      } catch (error) {
        closePreview();
        throw error;
      }
      watchGlanceRedirects(result, manager, allowedDomains, (candidate) =>
        policy.allows("nav.glance", candidate)
      );
      return {
        opened: true,
        url: loaded.href,
        mode: "glance",
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

    "split.close": async (params: UnsplitParams) => {
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

      // Snapshot the whole window before closing anything so residue can only
      // be identified from tabs that did not exist at call time.
      const beforeSnapshot = collectTabs().map((candidate) => ({
        id: idForTab(candidate),
        url: tabUrl(candidate),
        title: tabTitle(candidate),
      }));
      const beforeIds = beforeSnapshot.map((entry) => entry.id);
      const beforeById = new Map(
        beforeSnapshot.map((entry) => [entry.id, entry])
      );

      const groups: any[] = Array.isArray(splitter._data)
        ? splitter._data
        : [];
      const index = groups.findIndex(
        (group) => Array.isArray(group?.tabs) && group.tabs.includes(tab)
      );
      let groupTabs: ChromeTab[] = [];
      if (index >= 0) {
        groupTabs = groups[index].tabs.filter(
          (member: ChromeTab) => member?.isConnected && !member.closing
        );
      } else if (tab.splitView) {
        // The private group data is missing or stale. The target tab is the
        // only member we can confirm without guessing.
        groupTabs = [tab];
      }
      const groupIds = groupTabs.map((member) => idForTab(member));
      const groupUrls = [
        ...new Set(groupTabs.map((member) => tabUrl(member)).filter(Boolean)),
      ];
      if (groupIds.length === 0) {
        return {
          unsplit: false,
          tabIds: [],
          limitation: `No split view contains the tab "${tabTitle(tab)}".`,
        } satisfies UnsplitResult;
      }

      const selectedTab = win.gBrowser?.selectedTab ?? null;
      const targetIsCurrent = selectedTab === tab || !!tab.selected;
      const canUseCurrentView =
        typeof splitter.unsplitCurrentView === "function";

      let cleared = false;
      let usedSupportedPath = false;
      let usedRemoveGroup = false;

      // Prefer the supported current-view API when the target is already the
      // visible tab, so no other split can be affected by selecting it.
      if (canUseCurrentView && targetIsCurrent) {
        try {
          win.gBrowser.selectedTab = tab;
          splitter.unsplitCurrentView();
          usedSupportedPath = true;
        } catch {
          usedSupportedPath = false;
        }
        // Verify even when the call threw: it may have detached some tabs.
        cleared = await waitForSplitGone(groupTabs);
      }

      if (!cleared && typeof splitter.removeGroup === "function") {
        // `_data` may have shifted after a partial unsplit, so resolve the
        // group again instead of trusting the original index.
        const currentGroups: any[] = Array.isArray(splitter._data)
          ? splitter._data
          : [];
        const currentIndex = currentGroups.findIndex(
          (group) => Array.isArray(group?.tabs) && group.tabs.includes(tab)
        );
        if (currentIndex >= 0) {
          try {
            splitter.removeGroup(currentIndex);
            usedRemoveGroup = true;
          } catch {
            usedRemoveGroup = false;
          }
          if (usedRemoveGroup) cleared = await waitForSplitGone(groupTabs);
        }
      }

      // Last chance: select the target and let Zen unsplit its current view.
      // This is also the path taken when `_data` is missing or stale.
      if (!cleared && !usedSupportedPath && canUseCurrentView) {
        try {
          win.gBrowser.selectedTab = tab;
          splitter.unsplitCurrentView();
          usedSupportedPath = true;
        } catch {
          usedSupportedPath = false;
        }
        cleared = await waitForSplitGone(groupTabs);
      }

      if (!cleared) {
        throw new OpsError(
          "split_close_failed",
          `Zen did not close the split view for "${tabTitle(tab)}". The tabs ` +
            "are unchanged; close the split from Zen's UI and try again."
        );
      }

      // Let Zen settle after detaching tabs before classifying the residue.
      await sleep(LAYOUT_SETTLE_MS);
      const candidates = collectTabs().map((candidate) => ({
        id: idForTab(candidate),
        url: tabUrl(candidate),
        title: tabTitle(candidate),
        empty: candidate.hasAttribute("zen-empty-tab"),
        windowId,
      }));
      const plan = planSplitCleanup(
        { beforeTabIds: beforeIds, groupUrls, windowId },
        candidates
      );

      const limitations: string[] = [];
      if (plan.limitation) limitations.push(plan.limitation);
      const removeTab =
        win.gBrowser && typeof win.gBrowser.removeTab === "function"
          ? (target: ChromeTab) => win.gBrowser.removeTab(target)
          : undefined;
      let closedResidue = 0;
      for (const residueId of plan.closeTabIds) {
        const residue = tabsById.get(residueId);
        if (!residue || !residue.isConnected || residue.closing) continue;
        if (typeof removeTab !== "function") {
          limitations.push(
            `Zen cannot close the leftover tab "${tabTitle(residue)}" (${residueId}) automatically.`
          );
          continue;
        }
        try {
          await Promise.resolve(removeTab(residue));
          closedResidue++;
        } catch {
          limitations.push(
            `Could not close the leftover tab "${tabTitle(residue)}" (${residueId}).`
          );
        }
      }
      if (plan.closeTabIds.length) {
        await sleep(LAYOUT_SETTLE_MS);
        const stillOpen = plan.closeTabIds.filter((residueId) => {
          const residue = tabsById.get(residueId);
          return !!residue && residue.isConnected && !residue.closing;
        });
        if (stillOpen.length) {
          limitations.push(
            `Zen did not close ${stillOpen.length} leftover tab(s): ${stillOpen.join(", ")}.`
          );
        }
      }
      const missingGroupMembers = groupIds.filter((groupId) => {
        const member = tabsById.get(groupId);
        return !member || !member.isConnected || member.closing;
      });
      if (missingGroupMembers.length) {
        const listed = missingGroupMembers
          .map((groupId) => {
            const entry = beforeById.get(groupId);
            return entry ? `"${entry.title}" (${groupId})` : groupId;
          })
          .join(", ");
        limitations.push(
          `Zen closed ${missingGroupMembers.length} tab(s) from the split: ${listed}. Reopen them if needed.`
        );
      }

      return {
        unsplit: true,
        tabIds: groupIds,
        closedResidue,
        ...(limitations.length ? { limitation: limitations.join(" ") } : {}),
      } satisfies UnsplitResult;
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
      // Only the fixed operation map is callable. An inherited name such as
      // `constructor`, `toString` or `__proto__` is not an operation.
      const handler = Object.hasOwn(ops, method)
        ? (ops as Record<string, ((p: unknown) => unknown) | undefined>)[method]
        : undefined;
      if (typeof handler !== "function") {
        throw new OpsError(
          "unknown_method",
          `Unknown bridge method "${method}". Update Zen MCP in the browser (re-run zen_launch).`
        );
      }
      return (async () => {
        await policy.refresh();
        policyPreflight(method, params);
        const result = await handler(params as never);
        // Re-read policy after the operation before releasing data or claiming
        // success. Postflight then filters/rejects its result against the
        // newest browser-owned policy snapshot. A committed browser action
        // cannot be rolled back, but its result must not escape after revoke.
        await policy.refresh();
        return policyPostflight(method, params, result);
      })();
    },
    /** Stable id for a tab seen by a chrome observer. */
    tabIdFor: idForTab,
    /** Lets a dialog wait learn that a prompt appeared in this window. */
    noteDialogShown,
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

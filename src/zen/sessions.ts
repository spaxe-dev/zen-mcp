import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWritePrivate,
  readFileTextBounded,
} from "../utils/safe-file.js";
import type {
  CreateFolderParams,
  CreateFolderResult,
  CreateSpaceParams,
  CreateSpaceResult,
  EssentialsParams,
  EssentialsResult,
  FoldersResult,
  OpenedTab,
  OpenTabsParams,
  OpenTabsResult,
  PinTabsParams,
  PinTabsResult,
  SpacesResult,
  TabsListParams,
  TabsResult,
} from "../shared/protocol.js";

const FILE_NAME = "sessions.json";
const DEFAULT_BATCH_SIZE = 15;
const MAX_BATCH_SIZE = 30;
const DEFAULT_MAX_TABS = 100;
const RESTORE_MAX_SPACES = 16;
const RESTORE_MAX_DURATION_MS = 40_000;
const RESTORE_MAX_FOLDERS = 50;
const RESTORE_MAX_ESSENTIALS = 20;
const MAX_NAME_LENGTH = 64;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 100;
const MAX_SPACES_PER_SESSION = 50;
const MAX_TABS_PER_SESSION = 2000;
const MAX_FOLDERS_PER_SPACE = 200;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 300;
const MAX_ICON_LENGTH = 200;
const MAX_CREATED_AT_LENGTH = 64;

export type SessionFolder = {
  label: string;
  collapsed: boolean;
};

export type SessionTab = {
  url: string;
  title: string;
  pinned: boolean;
  essential: boolean;
  folder: string | null;
};

export type SessionSpace = {
  name: string;
  icon: string | null;
  containerTabId: number;
  tabs: SessionTab[];
  folders: SessionFolder[];
};

export type SessionSnapshot = {
  version: 1;
  name: string;
  createdAt: string;
  spaces: SessionSpace[];
  essentials: SessionTab[];
};

export type SessionSummary = {
  name: string;
  createdAt: string;
  spaceCount: number;
  tabCount: number;
  essentialCount: number;
};

export interface RestoreBudget {
  maxSpaces: number;
  maxTabs: number;
  maxDurationMs: number;
  maxBatchSize: number;
  maxFolders: number;
  maxEssentials: number;
}

export type RestoreStopReason =
  | "client_cancelled"
  | "duration_budget"
  | "space_budget"
  | "tab_budget"
  | "folder_budget"
  | "essential_budget"
  | "space_error"
  | "none";

export type RestoreOutcome =
  | "completed"
  | "partial"
  | "cancelled"
  | "budget_exhausted";

export interface RestoreInFlight {
  operation:
    | "space.create"
    | "tabs.open"
    | "tabs.pin"
    | "folder.create"
    | "essentials.add";
  mayHaveCommitted: "unknown";
}

export type SessionRestoreOptions = {
  newSpaces?: boolean;
  switchTo?: boolean;
  maxTabs?: number;
  signal?: AbortSignal;
  budget?: Partial<RestoreBudget>;
};

export type SessionRestoreResult = {
  name: string;
  spacesCreated: number;
  spacesReused: number;
  tabsOpened: number;
  tabsSkipped: number;
  foldersCreated: number;
  essentialsAdded: number;
  warnings: string[];
  outcome: RestoreOutcome;
  partial: boolean;
  cancelled: boolean;
  budgetExhausted: boolean;
  stopReason: RestoreStopReason;
  incomplete: boolean;
  rollback: "none";
  createdSpaceIds: string[];
  skipped: {
    spaces: number;
    tabs: number;
    folders: number;
    essentials: number;
    byReason: Record<string, number>;
  };
  inFlight?: RestoreInFlight;
};

export interface SessionRequestOptions {
  signal?: AbortSignal;
}

export const DEFAULT_RESTORE_BUDGET: Readonly<RestoreBudget> = {
  maxSpaces: RESTORE_MAX_SPACES,
  maxTabs: DEFAULT_MAX_TABS,
  maxDurationMs: RESTORE_MAX_DURATION_MS,
  maxBatchSize: DEFAULT_BATCH_SIZE,
  maxFolders: RESTORE_MAX_FOLDERS,
  maxEssentials: RESTORE_MAX_ESSENTIALS,
};

/**
 * Only the hub calls this module needs. Keeping it structural means the store
 * does not have to be rebuilt when BridgeHub grows new methods.
 */
export interface SessionHub {
  listSpaces(
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<SpacesResult>;
  listTabs(
    params: TabsListParams,
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<TabsResult>;
  listFolders(
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<FoldersResult>;
  createSpace(
    params: CreateSpaceParams,
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<CreateSpaceResult>;
  openTabs(
    params: OpenTabsParams,
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<OpenTabsResult>;
  createFolder(
    params: CreateFolderParams,
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<CreateFolderResult>;
  pinTabs(
    params: PinTabsParams,
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<PinTabsResult>;
  addEssentials(
    params: EssentialsParams,
    windowId?: string,
    options?: SessionRequestOptions
  ): Promise<EssentialsResult>;
}

export interface SessionStoreOptions {
  /** Directory that holds sessions.json. */
  dir: string;
  hub: SessionHub;
  /**
   * Policy predicate for stored URLs. The MCP server supplies it so a policy
   * change hides or skips URLs that may no longer be opened. Callers that
   * supply no predicate keep the previous behavior.
   */
  allowsUrl?: (url: string) => boolean;
  /** Monotonic clock seam for deterministic restore-budget tests. */
  now?: () => number;
}

interface SessionsFile {
  version: 1;
  sessions: SessionSnapshot[];
}

export class SessionStore {
  readonly #dir: string;
  readonly #hub: SessionHub;
  readonly #allowsUrl: (url: string) => boolean;
  readonly #now: () => number;
  #warnedInvalid = false;

  constructor(options: SessionStoreOptions) {
    this.#dir = options.dir;
    this.#hub = options.hub;
    this.#allowsUrl = options.allowsUrl ?? (() => true);
    this.#now = options.now ?? (() => performance.now());
  }

  /** Absolute path of the sessions file. */
  get path(): string {
    return join(this.#dir, FILE_NAME);
  }

  list(): SessionSummary[] {
    return this.#read().sessions.map((session) => {
      const visible = this.#visibleSnapshot(session);
      return {
        name: visible.name,
        createdAt: visible.createdAt,
        spaceCount: visible.spaces.length,
        tabCount: visible.spaces.reduce(
          (total, space) => total + space.tabs.length,
          0
        ),
        essentialCount: visible.essentials.length,
      };
    });
  }

  get(name: string): SessionSnapshot | null {
    const key = name.trim().toLowerCase();
    const session = this.#read().sessions.find(
      (entry) => entry.name.toLowerCase() === key
    );
    return session ? this.#visibleSnapshot(session) : null;
  }

  /** Drops stored tabs whose URL the current policy would not open. */
  #visibleSnapshot(session: SessionSnapshot): SessionSnapshot {
    const visibleTabs = (tabs: SessionTab[]): SessionTab[] =>
      tabs.filter((tab) => this.#allowsUrl(tab.url));
    return {
      ...session,
      spaces: session.spaces.map((space) => {
        const tabs = visibleTabs(space.tabs);
        const labels = new Set(tabs.map((tab) => tab.folder));
        return {
          ...space,
          tabs,
          folders: space.folders.filter((folder) => labels.has(folder.label)),
        };
      }),
      essentials: visibleTabs(session.essentials),
    };
  }

  /** Snapshot every space, folder and tab in the target window. */
  async save(
    name: string,
    options: { windowId?: string } = {}
  ): Promise<SessionSnapshot> {
    const display = validateName(name, "Session");
    const existing = this.#read();
    if (findSession(existing, display)) {
      throw new Error(
        `A session named "${display}" already exists. Delete it or pick another name.`
      );
    }

    const windowId = options.windowId;
    const [spacesResult, tabsResult, foldersResult] = await Promise.all([
      this.#hub.listSpaces(windowId),
      this.#hub.listTabs({ limit: MAX_TABS_PER_SESSION }, windowId),
      this.#hub.listFolders(windowId),
    ]);
    if (tabsResult.total > tabsResult.tabs.length) {
      throw new Error(
        `This window has ${tabsResult.total} tabs; a session can hold at most ` +
          `${MAX_TABS_PER_SESSION}. Close some tabs and try again.`
      );
    }

    const folderById = new Map(
      foldersResult.folders.map((folder) => [folder.id, folder])
    );
    const allTabs = tabsResult.tabs;
    const essentials: SessionTab[] = [];

    for (const tab of allTabs) {
      if (!tab.essential) continue;
      const url = snapshotUrl(tab.url);
      if (!url || !this.#allowsUrl(url)) continue;
      essentials.push({
        url,
        title: boundedText(tab.title, MAX_TITLE_LENGTH),
        pinned: tab.pinned,
        essential: true,
        folder: null,
      });
    }

    const spaces: SessionSpace[] = spacesResult.spaces.map((space) => {
      const folders = new Map<string, SessionFolder>();
      const tabs: SessionTab[] = [];

      const spaceTabs = allTabs
        .filter((tab) => tab.spaceId === space.id && !tab.essential)
        .sort((a, b) => a.index - b.index);

      for (const tab of spaceTabs) {
        const url = snapshotUrl(tab.url);
        if (!url || !this.#allowsUrl(url)) continue;

        const folderRecord = tab.folderId
          ? folderById.get(tab.folderId)
          : undefined;
        const folder = folderRecord?.label ?? tab.folderLabel ?? null;
        if (folder) {
          folders.set(folder, {
            label: folder,
            collapsed: folderRecord?.collapsed ?? false,
          });
        }

        tabs.push({
          url,
          title: boundedText(tab.title, MAX_TITLE_LENGTH),
          pinned: tab.pinned,
          essential: false,
          folder,
        });
      }

      return {
        name: boundedText(space.name, MAX_NAME_LENGTH) || "Space",
        icon: space.icon ? boundedText(space.icon, MAX_ICON_LENGTH) : null,
        containerTabId: space.containerTabId,
        tabs,
        folders: Array.from(folders.values()),
      };
    });

    const snapshot: SessionSnapshot = {
      version: 1,
      name: display,
      createdAt: new Date().toISOString(),
      spaces,
      essentials,
    };

    this.#commit((current) => {
      if (findSession(current, display)) {
        throw new Error(
          `A session named "${display}" already exists. Delete it or pick another name.`
        );
      }
      if (current.sessions.length >= MAX_SESSIONS) {
        throw new Error(
          `Session storage holds at most ${MAX_SESSIONS} sessions. Delete one first.`
        );
      }
      current.sessions.push(snapshot);
    });
    return snapshot;
  }

  async restore(
    name: string,
    options: SessionRestoreOptions = {}
  ): Promise<SessionRestoreResult> {
    const snapshot = this.get(name);
    if (!snapshot) {
      throw new Error(`Session "${name.trim()}" not found.`);
    }

    const budget: RestoreBudget = {
      ...DEFAULT_RESTORE_BUDGET,
      ...(options.budget ?? {}),
    };
    const maxTabs = Math.max(
      0,
      Math.floor(options.maxTabs ?? budget.maxTabs)
    );
    const maxSpaces = Math.max(0, Math.floor(budget.maxSpaces));
    const maxDurationMs = Math.max(0, budget.maxDurationMs);
    const batchSize = Math.min(
      MAX_BATCH_SIZE,
      Math.max(1, Math.floor(budget.maxBatchSize))
    );
    const maxFolders = Math.max(0, Math.floor(budget.maxFolders));
    const maxEssentials = Math.max(0, Math.floor(budget.maxEssentials));
    const signal = options.signal;
    const startedMono = this.#now();

    const warnings: string[] = [];
    const createdSpaceIds: string[] = [];
    const skipped: SessionRestoreResult["skipped"] = {
      spaces: 0,
      tabs: 0,
      folders: 0,
      essentials: 0,
      byReason: {},
    };
    let spacesCreated = 0;
    let spacesReused = 0;
    let tabsOpened = 0;
    let tabsSkipped = 0;
    let foldersCreated = 0;
    let essentialsAdded = 0;
    let spacesSkipped = 0;
    let processedSpaces = 0;
    let essentialsAttempted = false;
    let stopReason: RestoreStopReason = "none";
    let hardStop = false;
    let incomplete = false;
    let inFlight: RestoreInFlight | undefined;

    const warn = (message: string): void => {
      if (warnings.length < 50) warnings.push(message);
    };
    const skipTabs = (count: number, reason: string): void => {
      if (count <= 0) return;
      tabsSkipped += count;
      skipped.byReason[reason] = (skipped.byReason[reason] ?? 0) + count;
    };
    const stopped = (): boolean => {
      if (signal?.aborted) {
        if (stopReason === "none") stopReason = "client_cancelled";
        hardStop = true;
        return true;
      }
      if (this.#now() - startedMono >= maxDurationMs) {
        if (stopReason === "none") stopReason = "duration_budget";
        hardStop = true;
        return true;
      }
      return false;
    };
    const stopNow = (reason: RestoreStopReason): void => {
      if (stopReason === "none") stopReason = reason;
      hardStop = true;
    };
    const uncertain = (error: unknown): boolean => {
      const code = (error as { code?: string })?.code;
      const name = (error as { name?: string })?.name;
      return (
        code === "bridge_timeout" ||
        code === "bridge_disconnected" ||
        code === "bridge_unavailable" ||
        code === "cancelled" ||
        name === "MarionetteConnectionError"
      );
    };
    const finalize = (): SessionRestoreResult => {
      if (stopReason === "none" && inFlight) stopReason = "space_error";
      const cancelled = stopReason === "client_cancelled";
      const budgetExhausted =
        stopReason === "duration_budget" ||
        stopReason === "space_budget" ||
        stopReason === "tab_budget" ||
        stopReason === "folder_budget" ||
        stopReason === "essential_budget";
      const partial = cancelled || budgetExhausted || incomplete || !!inFlight;
      const outcome: RestoreOutcome = cancelled
        ? "cancelled"
        : budgetExhausted
          ? "budget_exhausted"
          : partial
            ? "partial"
            : "completed";
      if (cancelled) {
        warn(
          "Restore stopped because the caller cancelled. Completed work is preserved; no rollback was performed."
        );
      } else if (budgetExhausted) {
        warn(
          "Restore stopped at its resource budget. Completed work is preserved and the remaining session was not applied; no rollback was performed."
        );
      }
      if (inFlight) {
        warn(
          `The in-flight ${inFlight.operation} may still have changed the browser. No rollback was attempted.`
        );
      }
      // Count every Space the restore never reached, whatever stopped it. The
      // earlier per-branch counting could miss Spaces skipped by a mid-space
      // stop such as the tab budget.
      if (processedSpaces < snapshot.spaces.length) {
        const reason = stopReason === "none" ? "space_error" : stopReason;
        for (let rest = processedSpaces; rest < snapshot.spaces.length; rest += 1) {
          spacesSkipped += 1;
          skipTabs(snapshot.spaces[rest]!.tabs.length, reason);
        }
      }
      if (!essentialsAttempted && snapshot.essentials.length > 0) {
        const reason = stopReason === "none" ? "space_error" : stopReason;
        skipped.essentials += snapshot.essentials.length;
        skipped.byReason[reason] =
          (skipped.byReason[reason] ?? 0) + snapshot.essentials.length;
      }
      skipped.spaces = spacesSkipped;
      skipped.tabs = tabsSkipped;
      return {
        name: snapshot.name,
        spacesCreated,
        spacesReused,
        tabsOpened,
        tabsSkipped,
        foldersCreated,
        essentialsAdded,
        warnings,
        outcome,
        partial,
        cancelled,
        budgetExhausted,
        stopReason,
        incomplete: partial,
        rollback: "none",
        createdSpaceIds,
        skipped,
        ...(inFlight ? { inFlight } : {}),
      };
    };

    if (stopped()) return finalize();

    let spacesResult: SpacesResult;
    let tabsResult: TabsResult;
    try {
      spacesResult = await this.#hub.listSpaces(undefined, { signal });
      tabsResult = await this.#hub.listTabs(
        { limit: MAX_TABS_PER_SESSION },
        undefined,
        { signal }
      );
    } catch (error) {
      if (signal?.aborted) {
        stopReason = "client_cancelled";
        return finalize();
      }
      if (uncertain(error)) {
        stopReason = "space_error";
        return finalize();
      }
      throw error;
    }

    const spacesByName = new Map(
      spacesResult.spaces.map((space) => [space.name.toLowerCase(), space])
    );
    const takenNames = new Set(spacesByName.keys());
    const urlsBySpace = new Map<string, Set<string>>();
    for (const tab of tabsResult.tabs) {
      if (!tab.spaceId) continue;
      const set = urlsBySpace.get(tab.spaceId) ?? new Set<string>();
      set.add(urlKey(tab.url));
      if (tab.requestedUrl) set.add(urlKey(tab.requestedUrl));
      urlsBySpace.set(tab.spaceId, set);
    }

    let firstTargetId: string | null = null;

    spaceLoop: for (let index = 0; index < snapshot.spaces.length; index += 1) {
      if (stopped()) break;
      if (index >= maxSpaces) {
        stopNow("space_budget");
        break;
      }
      if (maxTabs - tabsOpened <= 0) {
        stopNow("tab_budget");
        break;
      }

      const snapshotSpace = snapshot.spaces[index]!;
      processedSpaces = index + 1;
      let openedInSpace = 0;
      try {
        const existing = spacesByName.get(snapshotSpace.name.toLowerCase());
        let targetId: string;
        let targetName: string;
        const seen = new Set<string>();

        if (existing && !options.newSpaces) {
          targetId = existing.id;
          targetName = existing.name;
          spacesReused += 1;
          for (const url of urlsBySpace.get(existing.id) ?? []) {
            seen.add(url);
          }
        } else {
          const desiredName = existing
            ? restoredName(snapshotSpace.name, takenNames)
            : snapshotSpace.name;
          inFlight = { operation: "space.create", mayHaveCommitted: "unknown" };
          const created = await this.#hub.createSpace(
            {
              name: desiredName,
              ...(snapshotSpace.icon ? { icon: snapshotSpace.icon } : {}),
              switchTo: options.switchTo ?? false,
            },
            undefined,
            { signal }
          );
          inFlight = undefined;
          targetId = created.space.id;
          targetName = created.space.name;
          takenNames.add(targetName.toLowerCase());
          createdSpaceIds.push(created.space.id);
          spacesCreated += 1;
        }

        if (!firstTargetId) firstTargetId = targetId;

        const missing = snapshotSpace.tabs.filter((tab) => {
          const url = tab.url.trim();
          return url.length > 0 && !seen.has(urlKey(url));
        });
        const alreadyPresent = snapshotSpace.tabs.length - missing.length;
        tabsSkipped += alreadyPresent;
        if (alreadyPresent > 0) {
          skipped.byReason.already_present =
            (skipped.byReason.already_present ?? 0) + alreadyPresent;
        }

        const remaining = maxTabs - tabsOpened;
        let toOpen = missing;
        if (missing.length > remaining) {
          toOpen = missing.slice(0, Math.max(0, remaining));
          const overflow = missing.length - toOpen.length;
          skipTabs(overflow, "tab_budget");
          stopNow("tab_budget");
          warn(
            `Skipped ${overflow} tab(s) because restore is limited to ${maxTabs} tabs.`
          );
        }

        const folderTabs = new Map<string, string[]>();

        for (let start = 0; start < toOpen.length; start += batchSize) {
          if (stopped()) {
            const left = toOpen.length - start;
            skipTabs(left, stopReason);
            break spaceLoop;
          }
          const batch = toOpen.slice(start, start + batchSize);
          inFlight = { operation: "tabs.open", mayHaveCommitted: "unknown" };
          try {
            const opened = await this.#hub.openTabs(
              {
                urls: batch.map((tab) => tab.url),
                space: targetId,
                background: true,
                switchTo: false,
              },
              undefined,
              { signal }
            );
            inFlight = undefined;
            tabsOpened += opened.tabs.length;
            openedInSpace += opened.tabs.length;

            const byRequested = mapOpened(opened.tabs);
            const pinnedIds: string[] = [];
            for (const tab of batch) {
              const live = byRequested.get(urlKey(tab.url));
              if (!live) continue;
              seen.add(urlKey(live.url));
              if (live.requestedUrl) seen.add(urlKey(live.requestedUrl));
              if (tab.pinned && !tab.essential) pinnedIds.push(live.id);
              if (tab.folder) {
                const ids = folderTabs.get(tab.folder) ?? [];
                ids.push(live.id);
                folderTabs.set(tab.folder, ids);
              }
            }

            if (pinnedIds.length > 0) {
              if (stopped()) {
                skipTabs(pinnedIds.length, stopReason);
                break spaceLoop;
              }
              inFlight = { operation: "tabs.pin", mayHaveCommitted: "unknown" };
              try {
                await this.#hub.pinTabs(
                  { tabIds: pinnedIds, pinned: true },
                  undefined,
                  { signal }
                );
                inFlight = undefined;
              } catch (error) {
                if (signal?.aborted || uncertain(error)) {
                  if (signal?.aborted) stopNow("client_cancelled");
                  else stopNow("space_error");
                  break spaceLoop;
                }
                inFlight = undefined;
                warn(
                  `Could not pin tabs in "${targetName}": ${messageOf(error)}`
                );
              }
            }
          } catch (error) {
            if (signal?.aborted || uncertain(error)) {
              if (signal?.aborted) stopNow("client_cancelled");
              else stopNow("space_error");
              break spaceLoop;
            }
            inFlight = undefined;
            warn(
              `Could not open tabs in "${targetName}": ${messageOf(error)}`
            );
            incomplete = true;
            break;
          }
        }
        if (hardStop) break spaceLoop;

        for (const [label, tabIds] of folderTabs) {
          if (tabIds.length === 0) continue;
          if (stopped()) break spaceLoop;
          if (foldersCreated >= maxFolders) {
            skipped.folders += 1;
            skipped.byReason.folder_budget =
              (skipped.byReason.folder_budget ?? 0) + 1;
            if (stopReason === "none") stopReason = "folder_budget";
            incomplete = true;
            continue;
          }
          const collapsed =
            snapshotSpace.folders.find((folder) => folder.label === label)
              ?.collapsed ?? false;
          inFlight = { operation: "folder.create", mayHaveCommitted: "unknown" };
          try {
            const created = await this.#hub.createFolder(
              { label, tabIds, space: targetId, collapsed },
              undefined,
              { signal }
            );
            inFlight = undefined;
            if (created.created) foldersCreated += 1;
          } catch (error) {
            if (signal?.aborted || uncertain(error)) {
              if (signal?.aborted) stopNow("client_cancelled");
              else stopNow("space_error");
              break spaceLoop;
            }
            inFlight = undefined;
            warn(
              `Could not create folder "${label}" in "${targetName}": ${messageOf(
                error
              )}`
            );
            incomplete = true;
          }
        }
        if (openedInSpace === 0 && hardStop) break spaceLoop;
      } catch (error) {
        if (signal?.aborted || uncertain(error)) {
          if (signal?.aborted) stopNow("client_cancelled");
          else stopNow("space_error");
          break;
        }
        inFlight = undefined;
        spacesSkipped += 1;
        skipTabs(snapshotSpace.tabs.length, "space_error");
        warn(
          `Could not restore space "${snapshotSpace.name}": ${messageOf(error)}`
        );
        incomplete = true;
      }
    }

    if (!hardStop && snapshot.essentials.length > 0) {
      essentialsAttempted = true;
      const targetId =
        firstTargetId ??
        spacesResult.activeSpaceId ??
        spacesResult.spaces[0]?.id ??
        null;
      if (!targetId) {
        warn("Could not restore essentials because no space is available.");
        incomplete = true;
      } else {
        const essentialUrls = new Set(
          tabsResult.tabs
            .filter((tab) => tab.essential)
            .map((tab) => urlKey(tab.url))
        );
        const missing = snapshot.essentials.filter(
          (tab) => tab.url.trim() && !essentialUrls.has(urlKey(tab.url))
        );
        tabsSkipped += snapshot.essentials.length - missing.length;

        const remaining = Math.max(0, maxTabs - tabsOpened);
        let toOpen = missing;
        if (missing.length > remaining) {
          toOpen = missing.slice(0, remaining);
          skipTabs(missing.length - toOpen.length, "tab_budget");
          if (stopReason === "none") stopReason = "tab_budget";
          warn(
            `Skipped ${missing.length - toOpen.length} essential tab(s) because restore is limited to ${maxTabs} tabs.`
          );
          incomplete = true;
        }

        const essentialIds: string[] = [];
        for (let start = 0; start < toOpen.length; start += batchSize) {
          if (stopped()) {
            skipTabs(toOpen.length - start, stopReason);
            break;
          }
          if (essentialsAdded + essentialIds.length >= maxEssentials) {
            skipped.essentials += toOpen.length - start;
            skipped.byReason.essential_budget =
              (skipped.byReason.essential_budget ?? 0) +
              (toOpen.length - start);
            if (stopReason === "none") stopReason = "essential_budget";
            incomplete = true;
            break;
          }
          const batch = toOpen.slice(start, start + batchSize);
          inFlight = { operation: "tabs.open", mayHaveCommitted: "unknown" };
          try {
            const opened = await this.#hub.openTabs(
              {
                urls: batch.map((tab) => tab.url),
                space: targetId,
                background: true,
                switchTo: false,
              },
              undefined,
              { signal }
            );
            inFlight = undefined;
            tabsOpened += opened.tabs.length;
            essentialIds.push(...opened.tabs.map((tab) => tab.id));
          } catch (error) {
            if (signal?.aborted || uncertain(error)) {
              if (signal?.aborted) stopNow("client_cancelled");
              else stopNow("space_error");
              break;
            }
            inFlight = undefined;
            warn(`Could not open essential tabs: ${messageOf(error)}`);
            incomplete = true;
          }
        }

        if (essentialIds.length > 0) {
          if (stopped()) {
            skipTabs(essentialIds.length, stopReason);
          } else if (essentialsAdded >= maxEssentials) {
            skipped.essentials += essentialIds.length;
            skipped.byReason.essential_budget =
              (skipped.byReason.essential_budget ?? 0) + essentialIds.length;
            if (stopReason === "none") stopReason = "essential_budget";
            incomplete = true;
          } else {
            inFlight = { operation: "essentials.add", mayHaveCommitted: "unknown" };
            try {
              const result = await this.#hub.addEssentials(
                { tabIds: essentialIds },
                undefined,
                { signal }
              );
              inFlight = undefined;
              essentialsAdded += result.changed;
            } catch (error) {
              if (signal?.aborted || uncertain(error)) {
                if (signal?.aborted) stopNow("client_cancelled");
                else stopNow("space_error");
              } else {
                inFlight = undefined;
                warn(`Could not add essential tabs: ${messageOf(error)}`);
                incomplete = true;
              }
            }
          }
        }
      }
    }

    return finalize();
  }

  delete(name: string): boolean {
    const key = name.trim().toLowerCase();
    let removed = false;
    this.#commit((file) => {
      const index = file.sessions.findIndex(
        (session) => session.name.toLowerCase() === key
      );
      if (index === -1) return;
      file.sessions.splice(index, 1);
      removed = true;
    });
    return removed;
  }

  #read(): SessionsFile {
    const file = this.path;
    if (!existsSync(file)) return { version: 1, sessions: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileTextBounded(file, MAX_FILE_BYTES));
    } catch (error) {
      throw new Error(
        `Could not parse ${file}: ${messageOf(error)}. Fix or delete the file.`
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as SessionsFile).sessions)
    ) {
      throw new Error(
        `Could not read ${file}: expected { "version": 1, "sessions": [] }. Fix or delete the file.`
      );
    }
    const { sessions, skipped } = sanitizeSessions(
      (parsed as SessionsFile).sessions
    );
    if (skipped > 0 && !this.#warnedInvalid) {
      this.#warnedInvalid = true;
      console.error(
        `zen-mcp: ignored ${skipped} invalid session ` +
          `${skipped === 1 ? "entry" : "entries"} in ${file}.`
      );
    }
    return { version: 1, sessions };
  }

  #commit(mutate: (file: SessionsFile) => void): void {
    const file = this.#read();
    mutate(file);
    this.#write(file);
  }

  #write(file: SessionsFile): void {
    const text = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new Error(
        `The sessions file would exceed ${MAX_FILE_BYTES} bytes. Delete old ` +
          "sessions before saving a new one."
      );
    }
    atomicWritePrivate(this.path, text);
  }
}

function findSession(
  file: SessionsFile,
  name: string
): SessionSnapshot | undefined {
  const key = name.trim().toLowerCase();
  return file.sessions.find(
    (session) => session.name.toLowerCase() === key
  );
}

function validateName(name: string, kind: string): string {
  const display = name.trim();
  if (!display) {
    throw new Error(`${kind} name cannot be empty.`);
  }
  if (display.length > MAX_NAME_LENGTH) {
    throw new Error(
      `${kind} name must be ${MAX_NAME_LENGTH} characters or fewer.`
    );
  }
  return display;
}

/** Space names that already exist get a " (restored)" suffix. */
function restoredName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  const restored = `${base} (restored)`;
  if (!taken.has(restored.toLowerCase())) return restored;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (restored ${suffix})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function mapOpened(tabs: OpenedTab[]): Map<string, OpenedTab> {
  const map = new Map<string, OpenedTab>();
  for (const tab of tabs) {
    if (tab.requestedUrl) map.set(urlKey(tab.requestedUrl), tab);
    map.set(urlKey(tab.url), tab);
  }
  return map;
}

function urlKey(url: string): string {
  return url.trim();
}

function snapshotUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  return restorableUrl(trimmed);
}

/** Session files and snapshots keep only the schemes restore can open. */
function restorableUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTab(value: unknown): SessionTab | null {
  if (!isRecord(value)) return null;
  const url = restorableUrl(value.url);
  if (!url) return null;
  return {
    url,
    title: boundedText(value.title, MAX_TITLE_LENGTH),
    pinned: value.pinned === true,
    essential: value.essential === true,
    folder: boundedText(value.folder, MAX_NAME_LENGTH) || null,
  };
}

function sanitizeTabs(value: unknown, limit: number): SessionTab[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  const tabs: SessionTab[] = [];
  for (const entry of value.slice(0, limit)) {
    const tab = sanitizeTab(entry);
    if (tab) tabs.push(tab);
  }
  return tabs;
}

function sanitizeFolder(value: unknown): SessionFolder | null {
  if (!isRecord(value)) return null;
  const label = boundedText(value.label, MAX_NAME_LENGTH);
  if (!label) return null;
  return { label, collapsed: value.collapsed === true };
}

function sanitizeSessions(value: unknown[]): {
  sessions: SessionSnapshot[];
  skipped: number;
} {
  const sessions: SessionSnapshot[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (sessions.length >= MAX_SESSIONS || !isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const name = boundedText(entry.name, MAX_NAME_LENGTH);
    if (!name) {
      skipped += 1;
      continue;
    }
    const createdAt =
      boundedText(entry.createdAt, MAX_CREATED_AT_LENGTH) ||
      new Date(0).toISOString();
    const spaces: SessionSpace[] = [];
    let remaining = MAX_TABS_PER_SESSION;
    const rawSpaces = Array.isArray(entry.spaces) ? entry.spaces : [];
    for (const rawSpace of rawSpaces.slice(0, MAX_SPACES_PER_SESSION)) {
      if (!isRecord(rawSpace)) continue;
      const spaceName = boundedText(rawSpace.name, MAX_NAME_LENGTH);
      if (!spaceName) continue;
      const tabs = sanitizeTabs(rawSpace.tabs, remaining);
      remaining -= tabs.length;
      const folders: SessionFolder[] = [];
      if (Array.isArray(rawSpace.folders)) {
        for (const rawFolder of rawSpace.folders.slice(0, MAX_FOLDERS_PER_SPACE)) {
          const folder = sanitizeFolder(rawFolder);
          if (folder) folders.push(folder);
        }
      }
      spaces.push({
        name: spaceName,
        icon: boundedText(rawSpace.icon, MAX_ICON_LENGTH) || null,
        containerTabId:
          Number.isInteger(rawSpace.containerTabId) &&
          (rawSpace.containerTabId as number) >= 0
            ? (rawSpace.containerTabId as number)
            : 0,
        tabs,
        folders,
      });
    }
    const essentials = sanitizeTabs(entry.essentials, remaining);
    sessions.push({ version: 1, name, createdAt, spaces, essentials });
  }
  return { sessions, skipped };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

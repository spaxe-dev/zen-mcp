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
const BATCH_SIZE = 30;
const DEFAULT_MAX_TABS = 300;
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

export type SessionRestoreOptions = {
  newSpaces?: boolean;
  switchTo?: boolean;
  maxTabs?: number;
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
};

/**
 * Only the hub calls this module needs. Keeping it structural means the store
 * does not have to be rebuilt when BridgeHub grows new methods.
 */
export interface SessionHub {
  listSpaces(windowId?: string): Promise<SpacesResult>;
  listTabs(params: TabsListParams, windowId?: string): Promise<TabsResult>;
  listFolders(windowId?: string): Promise<FoldersResult>;
  createSpace(
    params: CreateSpaceParams,
    windowId?: string
  ): Promise<CreateSpaceResult>;
  openTabs(params: OpenTabsParams, windowId?: string): Promise<OpenTabsResult>;
  createFolder(
    params: CreateFolderParams,
    windowId?: string
  ): Promise<CreateFolderResult>;
  pinTabs(params: PinTabsParams, windowId?: string): Promise<PinTabsResult>;
  addEssentials(
    params: EssentialsParams,
    windowId?: string
  ): Promise<EssentialsResult>;
}

export interface SessionStoreOptions {
  /** Directory that holds sessions.json. */
  dir: string;
  hub: SessionHub;
}

interface SessionsFile {
  version: 1;
  sessions: SessionSnapshot[];
}

export class SessionStore {
  readonly #dir: string;
  readonly #hub: SessionHub;
  #warnedInvalid = false;

  constructor(options: SessionStoreOptions) {
    this.#dir = options.dir;
    this.#hub = options.hub;
  }

  /** Absolute path of the sessions file. */
  get path(): string {
    return join(this.#dir, FILE_NAME);
  }

  list(): SessionSummary[] {
    return this.#read().sessions.map((session) => ({
      name: session.name,
      createdAt: session.createdAt,
      spaceCount: session.spaces.length,
      tabCount: session.spaces.reduce(
        (total, space) => total + space.tabs.length,
        0
      ),
      essentialCount: session.essentials.length,
    }));
  }

  get(name: string): SessionSnapshot | null {
    const key = name.trim().toLowerCase();
    return (
      this.#read().sessions.find(
        (session) => session.name.toLowerCase() === key
      ) ?? null
    );
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
      if (!url) continue;
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
        if (!url) continue;

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

    const maxTabs = normalizeMaxTabs(options.maxTabs);
    const warnings: string[] = [];
    let spacesCreated = 0;
    let spacesReused = 0;
    let tabsOpened = 0;
    let tabsSkipped = 0;
    let foldersCreated = 0;
    let essentialsAdded = 0;
    let limitWarned = false;

    const spacesResult = await this.#hub.listSpaces();
    const tabsResult = await this.#hub.listTabs({ limit: MAX_TABS_PER_SESSION });
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

    for (const snapshotSpace of snapshot.spaces) {
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
          const created = await this.#hub.createSpace(
            {
              name: desiredName,
              ...(snapshotSpace.icon ? { icon: snapshotSpace.icon } : {}),
              switchTo: options.switchTo ?? false,
            }
          );
          targetId = created.space.id;
          targetName = created.space.name;
          takenNames.add(targetName.toLowerCase());
          spacesCreated += 1;
        }

        if (!firstTargetId) firstTargetId = targetId;

        const missing = snapshotSpace.tabs.filter((tab) => {
          const url = tab.url.trim();
          return url.length > 0 && !seen.has(urlKey(url));
        });
        tabsSkipped += snapshotSpace.tabs.length - missing.length;

        const remaining = maxTabs - tabsOpened;
        let toOpen = missing;
        if (missing.length > remaining) {
          toOpen = missing.slice(0, Math.max(0, remaining));
          const overflow = missing.length - toOpen.length;
          tabsSkipped += overflow;
          if (!limitWarned) {
            warnings.push(
              `Skipped ${overflow} tab(s) because restore is limited to ${maxTabs} tabs.`
            );
            limitWarned = true;
          }
        }

        const folderTabs = new Map<string, string[]>();

        for (let start = 0; start < toOpen.length; start += BATCH_SIZE) {
          const batch = toOpen.slice(start, start + BATCH_SIZE);
          const opened = await this.#hub.openTabs(
            {
              urls: batch.map((tab) => tab.url),
              space: targetId,
              background: true,
              switchTo: false,
            }
          );
          tabsOpened += opened.tabs.length;

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
            try {
              await this.#hub.pinTabs(
                { tabIds: pinnedIds, pinned: true }
              );
            } catch (error) {
              warnings.push(
                `Could not pin tabs in "${targetName}": ${messageOf(error)}`
              );
            }
          }
        }

        for (const [label, tabIds] of folderTabs) {
          if (tabIds.length === 0) continue;
          const collapsed =
            snapshotSpace.folders.find((folder) => folder.label === label)
              ?.collapsed ?? false;
          try {
            const created = await this.#hub.createFolder(
              { label, tabIds, space: targetId, collapsed }
            );
            if (created.created) foldersCreated += 1;
          } catch (error) {
            warnings.push(
              `Could not create folder "${label}" in "${targetName}": ${messageOf(
                error
              )}`
            );
          }
        }
      } catch (error) {
        warnings.push(
          `Could not restore space "${snapshotSpace.name}": ${messageOf(error)}`
        );
      }
    }

    if (snapshot.essentials.length > 0) {
      const targetId =
        firstTargetId ??
        spacesResult.activeSpaceId ??
        spacesResult.spaces[0]?.id ??
        null;
      if (!targetId) {
        warnings.push(
          "Could not restore essentials because no space is available."
        );
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
          tabsSkipped += missing.length - remaining;
          toOpen = missing.slice(0, remaining);
          if (!limitWarned && toOpen.length < missing.length) {
            warnings.push(
              `Skipped ${
                missing.length - toOpen.length
              } essential tab(s) because restore is limited to ${maxTabs} tabs.`
            );
            limitWarned = true;
          }
        }

        const essentialIds: string[] = [];
        for (let start = 0; start < toOpen.length; start += BATCH_SIZE) {
          const batch = toOpen.slice(start, start + BATCH_SIZE);
          try {
            const opened = await this.#hub.openTabs(
              {
                urls: batch.map((tab) => tab.url),
                space: targetId,
                background: true,
                switchTo: false,
              }
            );
            tabsOpened += opened.tabs.length;
            essentialIds.push(...opened.tabs.map((tab) => tab.id));
          } catch (error) {
            warnings.push(
              `Could not open essential tabs: ${messageOf(error)}`
            );
          }
        }

        if (essentialIds.length > 0) {
          try {
            const result = await this.#hub.addEssentials(
              { tabIds: essentialIds }
            );
            essentialsAdded += result.changed;
          } catch (error) {
            warnings.push(
              `Could not add essential tabs: ${messageOf(error)}`
            );
          }
        }
      }
    }

    return {
      name: snapshot.name,
      spacesCreated,
      spacesReused,
      tabsOpened,
      tabsSkipped,
      foldersCreated,
      essentialsAdded,
      warnings,
    };
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

function normalizeMaxTabs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_TABS;
  }
  return Math.max(0, Math.floor(value));
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

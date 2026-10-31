import type {
  FolderInfo,
  SpaceInfo,
  TabInfo,
} from "../shared/protocol.js";

export interface TabAuditOptions {
  staleDays?: number;
  now?: number;
  duplicateLimit?: number;
  staleLimit?: number;
}

export interface TabAuditDuplicate {
  url: string;
  title: string;
  tabIds: string[];
  spaces: string[];
}

export interface TabAuditStale {
  tabId: string;
  title: string;
  url: string;
  spaceName: string | null;
  lastAccessed: number | null;
  ageDays: number | null;
}

export interface TabAuditDomain {
  domain: string;
  count: number;
  tabIds: string[];
}

export interface TabAuditResult {
  totals: {
    tabs: number;
    spaces: number;
    folders: number;
    pinned: number;
    essentials: number;
    grouped: number;
    loading: number;
    duplicates: number;
    stale: number;
  };
  bySpace: Array<{
    spaceId: string | null;
    spaceName: string;
    tabs: number;
    pinned: number;
    folders: number;
    stale: number;
  }>;
  duplicates: TabAuditDuplicate[];
  staleTabs: TabAuditStale[];
  domains: TabAuditDomain[];
}

export interface DomainGroupPlan {
  domain: string;
  label: string;
  tabIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 14;
const DEFAULT_DUPLICATE_LIMIT = 20;
const DEFAULT_STALE_LIMIT = 30;
const MAX_DOMAIN_GROUPS = 30;

function isSkippedUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("about:") ||
    trimmed.startsWith("chrome:")
  );
}

/** Lowercased URL without its hash fragment and trailing slash. */
function normalizeUrl(url: string): string | null {
  if (isSkippedUrl(url)) {
    return null;
  }
  const lowered = url.trim().toLowerCase();
  const withoutHash = lowered.split("#")[0] ?? "";
  const withoutSlash = withoutHash.endsWith("/")
    ? withoutHash.slice(0, -1)
    : withoutHash;
  return withoutSlash.length > 0 ? withoutSlash : null;
}

function hostnameOf(url: string): string | null {
  if (isSkippedUrl(url)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return host.length > 0 ? host : null;
}

function spaceLabel(tab: TabInfo): string {
  return tab.spaceName ?? tab.spaceId ?? "No space";
}

export function auditTabs(
  input: { tabs: TabInfo[]; spaces: SpaceInfo[]; folders: FolderInfo[] },
  options: TabAuditOptions = {}
): TabAuditResult {
  const tabs = input.tabs ?? [];
  const spaces = input.spaces ?? [];
  const folders = input.folders ?? [];
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const staleDays =
    options.staleDays !== undefined && Number.isFinite(options.staleDays)
      ? Math.max(0, options.staleDays)
      : DEFAULT_STALE_DAYS;
  const duplicateLimit =
    options.duplicateLimit !== undefined
      ? Math.max(0, Math.floor(options.duplicateLimit))
      : DEFAULT_DUPLICATE_LIMIT;
  const staleLimit =
    options.staleLimit !== undefined
      ? Math.max(0, Math.floor(options.staleLimit))
      : DEFAULT_STALE_LIMIT;

  /* Duplicates ------------------------------------------------------- */

  const duplicateGroups = new Map<
    string,
    { title: string; tabIds: string[]; spaces: string[] }
  >();
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    if (!key) {
      continue;
    }
    const group = duplicateGroups.get(key);
    if (group) {
      group.tabIds.push(tab.id);
      const label = spaceLabel(tab);
      if (!group.spaces.includes(label)) {
        group.spaces.push(label);
      }
    } else {
      duplicateGroups.set(key, {
        title: tab.title,
        tabIds: [tab.id],
        spaces: [spaceLabel(tab)],
      });
    }
  }

  const allDuplicates: TabAuditDuplicate[] = [];
  for (const [url, group] of duplicateGroups) {
    if (group.tabIds.length < 2) {
      continue;
    }
    allDuplicates.push({
      url,
      title: group.title,
      tabIds: group.tabIds,
      spaces: group.spaces,
    });
  }
  allDuplicates.sort(
    (a, b) =>
      b.tabIds.length - a.tabIds.length || a.url.localeCompare(b.url)
  );
  const duplicates = allDuplicates.slice(0, duplicateLimit);

  /* Stale ------------------------------------------------------------- */

  const staleThresholdMs = staleDays * DAY_MS;
  const allStale: TabAuditStale[] = [];
  for (const tab of tabs) {
    const lastAccessed = tab.lastAccessed;
    if (typeof lastAccessed !== "number" || !Number.isFinite(lastAccessed)) {
      continue;
    }
    const ageMs = now - lastAccessed;
    if (!Number.isFinite(ageMs) || ageMs <= staleThresholdMs) {
      continue;
    }
    allStale.push({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      spaceName: tab.spaceName,
      lastAccessed,
      ageDays: Math.floor(ageMs / DAY_MS),
    });
  }
  // Oldest first: the least recently used tabs are the best cleanup targets.
  allStale.sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
  const staleTabs = allStale.slice(0, staleLimit);

  /* Domains ----------------------------------------------------------- */

  const domainGroups = new Map<string, string[]>();
  for (const tab of tabs) {
    const domain = hostnameOf(tab.url);
    if (!domain) {
      continue;
    }
    const ids = domainGroups.get(domain);
    if (ids) {
      ids.push(tab.id);
    } else {
      domainGroups.set(domain, [tab.id]);
    }
  }
  const domains: TabAuditDomain[] = [];
  for (const [domain, tabIds] of domainGroups) {
    domains.push({ domain, count: tabIds.length, tabIds });
  }
  domains.sort(
    (a, b) => b.count - a.count || a.domain.localeCompare(b.domain)
  );
  const cappedDomains = domains.slice(0, MAX_DOMAIN_GROUPS);

  /* Per space --------------------------------------------------------- */

  const bySpace: TabAuditResult["bySpace"] = spaces.map((space) => {
    const spaceTabs = tabs.filter((tab) => tab.spaceId === space.id);
    return {
      spaceId: space.id,
      spaceName: space.name,
      tabs: spaceTabs.length,
      pinned: spaceTabs.filter((tab) => tab.pinned).length,
      folders: folders.filter((folder) => folder.spaceId === space.id).length,
      stale: allStale.filter(
        (entry) =>
          spaceTabs.some((tab) => tab.id === entry.tabId)
      ).length,
    };
  });

  const looseTabs = tabs.filter((tab) => tab.spaceId === null);
  if (looseTabs.length > 0) {
    bySpace.push({
      spaceId: null,
      spaceName: "No space",
      tabs: looseTabs.length,
      pinned: looseTabs.filter((tab) => tab.pinned).length,
      folders: 0,
      stale: allStale.filter(
        (entry) => looseTabs.some((tab) => tab.id === entry.tabId)
      ).length,
    });
  }

  return {
    totals: {
      tabs: tabs.length,
      spaces: spaces.length,
      folders: folders.length,
      pinned: tabs.filter((tab) => tab.pinned).length,
      essentials: tabs.filter((tab) => tab.essential).length,
      grouped: tabs.filter((tab) => tab.folderId !== null).length,
      loading: tabs.filter((tab) => tab.loading).length,
      duplicates: allDuplicates.length,
      stale: allStale.length,
    },
    bySpace,
    duplicates,
    staleTabs,
    domains: cappedDomains,
  };
}

/**
 * Plans one folder per domain for tabs that are not already grouped, pinned or
 * essential. Only http(s) tabs with a real hostname are considered.
 */
export function planDomainFolders(
  tabs: TabInfo[],
  options: { minTabs?: number; spaceId?: string | null } = {}
): DomainGroupPlan[] {
  const minTabs =
    options.minTabs !== undefined
      ? Math.max(1, Math.floor(options.minTabs))
      : 2;
  const scopeProvided = options.spaceId !== undefined;
  const groups = new Map<string, string[]>();

  for (const tab of tabs) {
    if (tab.folderId !== null || tab.pinned || tab.essential) {
      continue;
    }
    if (scopeProvided && tab.spaceId !== options.spaceId) {
      continue;
    }
    const domain = hostnameOf(tab.url);
    if (!domain) {
      continue;
    }
    const ids = groups.get(domain);
    if (ids) {
      if (!ids.includes(tab.id)) {
        ids.push(tab.id);
      }
    } else {
      groups.set(domain, [tab.id]);
    }
  }

  const plans: DomainGroupPlan[] = [];
  for (const [domain, tabIds] of groups) {
    if (domain.length === 0 || tabIds.length < minTabs) {
      continue;
    }
    plans.push({ domain, label: domain, tabIds });
  }
  plans.sort(
    (a, b) => b.tabIds.length - a.tabIds.length || a.domain.localeCompare(b.domain)
  );
  return plans;
}

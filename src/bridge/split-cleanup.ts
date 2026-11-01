/**
 * Classifies tabs left behind after a split view is closed.
 *
 * Only tabs that appeared after the close can be residue. A tab that existed
 * before the call is never selected for closing. Clearly synthetic empty tabs
 * are safe to close; a non-empty tab that duplicates a URL from the split may
 * have been opened by the user, so it is reported instead of closed.
 */

export interface SplitTabSnapshot {
  id: string;
  url: string;
  title: string;
}

export interface SplitCleanupCandidate extends SplitTabSnapshot {
  /** Set when the tab carries Zen's `zen-empty-tab` attribute. */
  empty?: boolean;
  /** Window that owns the tab. Candidates from another window are ignored. */
  windowId?: string;
}

export interface SplitCleanupInput {
  /** Bridge tab ids that existed before the split was closed. */
  beforeTabIds: string[];
  /** URLs of the tabs that were in the split group. */
  groupUrls: string[];
  /** Window that was closed. Candidates from other windows are ignored. */
  windowId?: string;
}

export interface SplitDuplicateResidue {
  tabId: string;
  title: string;
  url: string;
}

export interface SplitCleanupPlan {
  /** New synthetic empty tabs that are safe to close. */
  closeTabIds: string[];
  /** New non-empty tabs that duplicate a split URL. Never closed automatically. */
  duplicates: SplitDuplicateResidue[];
  /** Every new tab id seen in the affected window, including harmless ones. */
  newTabIds: string[];
  /** Present when a duplicate must be left for the user to decide. */
  limitation?: string;
}

function normalizeSplitUrl(url: string): string {
  const lowered = String(url ?? "").trim().toLowerCase();
  if (!lowered) return "";
  const withoutHash = lowered.split("#")[0] ?? "";
  return withoutHash.endsWith("/") ? withoutHash.slice(0, -1) : withoutHash;
}

/** True for Zen's empty placeholders and blank/new-tab pages. */
export function isSyntheticSplitTab(tab: SplitCleanupCandidate): boolean {
  if (tab.empty === true) return true;
  const url = String(tab.url ?? "").trim().toLowerCase().split("#")[0] ?? "";
  return url === "" || url === "about:newtab" || url === "about:blank";
}

/**
 * Builds a cleanup plan from a pre-close snapshot and the post-close tab list.
 *
 * The candidate list is expected to be scoped to one window. When both the
 * input and a candidate carry a window id, mismatches are ignored so a tab in
 * another window can never be selected for closing.
 */
export function planSplitCleanup(
  input: SplitCleanupInput,
  candidates: SplitCleanupCandidate[]
): SplitCleanupPlan {
  const before = new Set(input.beforeTabIds ?? []);
  const groupUrls = new Set(
    (input.groupUrls ?? []).map(normalizeSplitUrl).filter(Boolean)
  );
  const closeTabIds: string[] = [];
  const duplicates: SplitDuplicateResidue[] = [];
  const newTabIds: string[] = [];

  for (const tab of candidates ?? []) {
    if (!tab?.id) continue;
    if (
      input.windowId !== undefined &&
      tab.windowId !== undefined &&
      tab.windowId !== input.windowId
    ) {
      continue;
    }
    if (before.has(tab.id)) continue;
    newTabIds.push(tab.id);
    if (isSyntheticSplitTab(tab)) {
      closeTabIds.push(tab.id);
      continue;
    }
    const key = normalizeSplitUrl(tab.url);
    if (key && groupUrls.has(key)) {
      duplicates.push({ tabId: tab.id, title: tab.title, url: tab.url });
    }
  }

  let limitation: string | undefined;
  if (duplicates.length > 0) {
    const listed = duplicates
      .map((duplicate) => `"${duplicate.title}" (${duplicate.tabId})`)
      .join(", ");
    limitation =
      `Left ${duplicates.length} new tab${duplicates.length === 1 ? "" : "s"} ` +
      `open because they duplicate the split: ${listed}. Close them manually ` +
      "if they were not opened by the user.";
  }

  return {
    closeTabIds,
    duplicates,
    newTabIds,
    ...(limitation ? { limitation } : {}),
  };
}

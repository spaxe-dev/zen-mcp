/**
 * Remembers the space and pinned state of tabs before they become essentials.
 *
 * Zen's essentials manager may re-home a tab when it is added to or removed
 * from essentials, so the bridge captures the original state, restores it with
 * plain DOM attributes and supported browser methods, and reports a limitation
 * when the restoration cannot be confirmed. Everything here is structural so it
 * can be exercised with plain objects instead of a live browser window.
 */

/** Maximum number of tabs whose pre-essentials state is remembered. */
export const ESSENTIALS_STATE_LIMIT = 20;

/** The subset of a Zen tab used to read and restore essentials state. */
export interface EssentialsTabLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  readonly pinned?: boolean;
  readonly isConnected?: boolean;
  readonly closing?: boolean;
}

export interface EssentialsTabState {
  /** The tab's `zen-workspace-id`, or null when it had no space. */
  spaceId: string | null;
  pinned: boolean;
}

export interface EssentialsCapture extends EssentialsTabState {
  /** Bridge tab id, used as the store key and in limitations. */
  tabId: string;
}

/**
 * Bounded, insertion-ordered capture store. A repeated capture for the same tab
 * keeps the first state so an essentials placement cannot overwrite the space
 * the tab had before it was added.
 */
export class EssentialsStateStore {
  readonly limit: number;
  readonly #entries = new Map<string, EssentialsCapture>();

  constructor(limit: number = ESSENTIALS_STATE_LIMIT) {
    const normalized = Math.floor(Number(limit));
    this.limit =
      Number.isFinite(normalized) && normalized > 0
        ? normalized
        : ESSENTIALS_STATE_LIMIT;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Stores the state unless this tab already has a capture. */
  capture(tabId: string, state: EssentialsTabState): EssentialsCapture {
    const existing = this.#entries.get(tabId);
    if (existing) return existing;
    const capture: EssentialsCapture = {
      tabId,
      spaceId: state.spaceId,
      pinned: state.pinned,
    };
    this.#entries.set(tabId, capture);
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return capture;
  }

  get(tabId: string): EssentialsCapture | undefined {
    return this.#entries.get(tabId);
  }

  /** Removes and returns a capture; used when a tab leaves essentials. */
  take(tabId: string): EssentialsCapture | undefined {
    const capture = this.#entries.get(tabId);
    if (capture) this.#entries.delete(tabId);
    return capture;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Reads the current space and pinned state through the structural tab API. */
export function readEssentialsTabState(tab: EssentialsTabLike): EssentialsTabState {
  const spaceId = tab.getAttribute("zen-workspace-id") || null;
  return { spaceId, pinned: !!tab.pinned };
}

/** Reads and remembers a tab's state before it is added to essentials. */
export function captureEssentialsState(
  store: EssentialsStateStore,
  tabId: string,
  tab: EssentialsTabLike
): EssentialsCapture {
  return store.capture(tabId, readEssentialsTabState(tab));
}

/** Browser methods used to restore a tab without touching any other tab. */
export interface EssentialsRestoreHost {
  moveTabsToWorkspace?: (
    tabs: EssentialsTabLike[],
    spaceId: string
  ) => unknown;
  pinTab?: (tab: EssentialsTabLike) => unknown;
  unpinTab?: (tab: EssentialsTabLike) => unknown;
}

export interface EssentialsRestoreOptions {
  /** Also restore the pinned flag. Defaults to true. */
  restorePinned?: boolean;
}

export interface EssentialsRestoreReport {
  /** A capture existed and the tab was still open, so restoration was attempted. */
  applied: boolean;
  /** The tab was already disconnected or closing, so nothing was touched. */
  skipped: boolean;
  spaceRestored: boolean;
  pinnedRestored: boolean;
  /** Predicate phrases behind any unconfirmed part of the restoration. */
  reasons: string[];
}

const CLOSED_REASON = "closed before its previous state could be restored";
const SPACE_REASON = "could not be returned to its original space";
const MOVE_REASON = "had an error while moving back to its original space";
const PIN_REASON = "could not have its pinned state restored";

function isTabGone(tab: EssentialsTabLike): boolean {
  return tab.isConnected === false || tab.closing === true;
}

function addReasons(target: string[], reasons: string[]): void {
  for (const reason of reasons) {
    if (!target.includes(reason)) target.push(reason);
  }
}

/**
 * Checks whether the tab currently holds the captured space and pinned state.
 * A capture with a null space is considered restored: there is no space to put
 * back, and this module never invents one.
 */
export function verifyEssentialsState(
  capture: EssentialsCapture | undefined,
  tab: EssentialsTabLike,
  options: EssentialsRestoreOptions = {}
): { spaceRestored: boolean; pinnedRestored: boolean; reasons: string[] } {
  if (!capture) {
    return { spaceRestored: true, pinnedRestored: true, reasons: [] };
  }
  if (isTabGone(tab)) {
    return {
      spaceRestored: false,
      pinnedRestored: false,
      reasons: [CLOSED_REASON],
    };
  }
  const reasons: string[] = [];
  const spaceId = tab.getAttribute("zen-workspace-id") || null;
  const spaceRestored = capture.spaceId === null || spaceId === capture.spaceId;
  if (!spaceRestored) reasons.push(SPACE_REASON);
  const pinnedRestored =
    options.restorePinned === false || !!tab.pinned === capture.pinned;
  if (!pinnedRestored) reasons.push(PIN_REASON);
  return { spaceRestored, pinnedRestored, reasons };
}

/**
 * Puts the captured space and (optionally) pinned state back on one tab.
 *
 * The space is restored with `zen-workspace-id` and, when the window exposes
 * `moveTabsToWorkspace`, through that supported API. Missing captures mean the
 * tab was not added by this bridge session, so it is left untouched.
 */
export function restoreEssentialsState(
  capture: EssentialsCapture | undefined,
  tab: EssentialsTabLike,
  host: EssentialsRestoreHost,
  options: EssentialsRestoreOptions = {}
): EssentialsRestoreReport {
  if (!capture) {
    return {
      applied: false,
      skipped: false,
      spaceRestored: true,
      pinnedRestored: true,
      reasons: [],
    };
  }
  if (isTabGone(tab)) {
    return {
      applied: false,
      skipped: true,
      spaceRestored: false,
      pinnedRestored: false,
      reasons: [CLOSED_REASON],
    };
  }

  const reasons: string[] = [];

  if (capture.spaceId !== null) {
    const currentSpace = tab.getAttribute("zen-workspace-id") || null;
    if (currentSpace !== capture.spaceId) {
      tab.setAttribute("zen-workspace-id", capture.spaceId);
      if (typeof host.moveTabsToWorkspace === "function") {
        try {
          host.moveTabsToWorkspace([tab], capture.spaceId);
        } catch {
          reasons.push(MOVE_REASON);
        }
      }
    }
  }

  if (options.restorePinned !== false && !!tab.pinned !== capture.pinned) {
    const handler = capture.pinned ? host.pinTab : host.unpinTab;
    if (typeof handler === "function") {
      try {
        handler.call(host, tab);
      } catch {
        reasons.push(PIN_REASON);
      }
    } else {
      reasons.push(PIN_REASON);
    }
  }

  const verification = verifyEssentialsState(capture, tab, options);
  addReasons(reasons, verification.reasons);
  return {
    applied: true,
    skipped: false,
    spaceRestored: verification.spaceRestored,
    pinnedRestored: verification.pinnedRestored,
    reasons,
  };
}

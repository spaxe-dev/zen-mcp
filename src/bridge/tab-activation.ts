/**
 * Tab activation against Zen's chrome surface, written against structural
 * types so it runs in Node under test.
 *
 * Zen 1.24b can ignore a single `gBrowser.selectedTab` assignment while a
 * workspace switch is still settling, so activation waits for the workspace
 * to become active and then retries the assignment a bounded number of times.
 * Nothing here claims success: the caller checks `active` and raises an error
 * when the tab never came forward.
 */

/** The parts of a `XULTab` this module touches. */
export interface ActivationTabLike {
  get selected(): boolean;
  isConnected?: boolean;
  closing?: boolean;
  getAttribute?(name: string): string | null;
  scrollIntoView?(options: { block: "nearest" }): void;
}

/** The parts of `gZenWorkspaces` this module touches. */
export interface ActivationWorkspaceManagerLike {
  activeWorkspace?: string | null;
  changeWorkspaceWithID?(spaceId: string): unknown;
}

/** The parts of a browser window this module touches. */
export interface ActivationWindowLike {
  gBrowser: { selectedTab: unknown };
  gZenWorkspaces?: ActivationWorkspaceManagerLike | null;
  focus?(): void;
  document?: { hasFocus?(): boolean } | null;
  /** Some test doubles expose focus state directly. */
  focused?: boolean;
}

export interface TabActivationOptions {
  /** Also raise the window, and observe whether it took focus. */
  focusWindow?: boolean;
  /** Selection attempts before giving up. */
  attempts?: number;
  /** Delay between selection attempts. */
  pollMs?: number;
  /** How long to wait for a workspace switch to settle. */
  workspaceTimeoutMs?: number;
  /** Delay between workspace checks. */
  workspacePollMs?: number;
  /** How many times to re-check window focus after calling focus(). */
  focusChecks?: number;
  /** Delay between window focus checks. */
  focusPollMs?: number;
}

export const DEFAULT_TAB_ACTIVATION_OPTIONS = {
  attempts: 6,
  pollMs: 60,
  workspaceTimeoutMs: 1_500,
  workspacePollMs: 50,
  focusChecks: 4,
  focusPollMs: 50,
} as const;

type ResolvedTabActivationOptions = {
  -readonly [K in keyof typeof DEFAULT_TAB_ACTIVATION_OPTIONS]: number;
};

export interface TabActivationOutcome {
  /** True only when the tab itself reports that it is selected. */
  active: boolean;
  /** The workspace the tab belongs to, when it declares one. */
  spaceId: string | null;
  /** How many assignment attempts were made. */
  attempts: number;
  /**
   * Observed window focus. Undefined when focusWindow was false or no focus
   * probe is available.
   */
  windowFocused?: boolean;
  /** The last assignment error, for diagnostics. */
  lastError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function resolveOptions(
  options: TabActivationOptions
): ResolvedTabActivationOptions {
  return {
    attempts: clampInt(
      options.attempts,
      1,
      20,
      DEFAULT_TAB_ACTIVATION_OPTIONS.attempts
    ),
    pollMs: clampInt(
      options.pollMs,
      1,
      1_000,
      DEFAULT_TAB_ACTIVATION_OPTIONS.pollMs
    ),
    workspaceTimeoutMs: clampInt(
      options.workspaceTimeoutMs,
      0,
      10_000,
      DEFAULT_TAB_ACTIVATION_OPTIONS.workspaceTimeoutMs
    ),
    workspacePollMs: clampInt(
      options.workspacePollMs,
      1,
      1_000,
      DEFAULT_TAB_ACTIVATION_OPTIONS.workspacePollMs
    ),
    focusChecks: clampInt(
      options.focusChecks,
      1,
      10,
      DEFAULT_TAB_ACTIVATION_OPTIONS.focusChecks
    ),
    focusPollMs: clampInt(
      options.focusPollMs,
      0,
      1_000,
      DEFAULT_TAB_ACTIVATION_OPTIONS.focusPollMs
    ),
  };
}

function spaceIdOf(tab: ActivationTabLike): string | null {
  try {
    return tab.getAttribute?.("zen-workspace-id") || null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/**
 * Waits until Zen reports the target workspace as active. Returns false when
 * the deadline passes first; selection still proceeds because the workspace
 * may settle a moment later.
 */
async function waitForWorkspace(
  manager: ActivationWorkspaceManagerLike,
  target: string,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (manager.activeWorkspace === target) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Reads window focus from `document.hasFocus()` when the document exposes it,
 * then from the browser's focus service. Returns undefined when neither probe
 * is available, so the caller can report focus as unknown instead of false.
 */
function probeWindowFocus(win: ActivationWindowLike): boolean | undefined {
  try {
    const hasFocus = win.document?.hasFocus;
    if (typeof hasFocus === "function") {
      return hasFocus.call(win.document) === true;
    }
  } catch {
    // Fall through to the next probe.
  }
  try {
    if (typeof Services !== "undefined" && Services?.focus) {
      return Services.focus.activeWindow === win;
    }
  } catch {
    // Fall through to the fallback.
  }
  return typeof win.focused === "boolean" ? win.focused : undefined;
}

async function observeWindowFocus(
  win: ActivationWindowLike,
  options: ResolvedTabActivationOptions
): Promise<boolean | undefined> {
  for (let check = 0; check < options.focusChecks; check += 1) {
    const observed = probeWindowFocus(win);
    if (observed === undefined) return undefined;
    if (observed) return true;
    if (check + 1 < options.focusChecks && options.focusPollMs > 0) {
      await sleep(options.focusPollMs);
    }
  }
  return false;
}

/**
 * Activates a tab, switching workspace first when needed. Focus is requested
 * only for `focusWindow: true` and reported only when it was observed.
 */
export async function activateTab(
  win: ActivationWindowLike,
  tab: ActivationTabLike,
  options: TabActivationOptions = {}
): Promise<TabActivationOutcome> {
  const settings = resolveOptions(options);
  const spaceId = spaceIdOf(tab);
  const manager = win.gZenWorkspaces ?? null;

  if (
    spaceId &&
    manager &&
    typeof manager.changeWorkspaceWithID === "function" &&
    manager.activeWorkspace !== spaceId
  ) {
    await manager.changeWorkspaceWithID(spaceId);
    await waitForWorkspace(
      manager,
      spaceId,
      settings.workspaceTimeoutMs,
      settings.workspacePollMs
    );
  }

  let attempts = 0;
  let lastError: string | undefined;
  while (attempts < settings.attempts) {
    attempts += 1;
    try {
      win.gBrowser.selectedTab = tab;
      lastError = undefined;
    } catch (error) {
      lastError = errorMessage(error);
    }
    // Zen can override the assignment a moment later while a workspace
    // switch settles, so re-check after a short pause instead of trusting
    // the synchronous value.
    await sleep(settings.pollMs);
    if (tab.selected === true) break;
  }

  const active = tab.selected === true;
  const outcome: TabActivationOutcome = { active, spaceId, attempts };
  if (lastError) outcome.lastError = lastError;
  if (!active) return outcome;

  try {
    tab.scrollIntoView?.({ block: "nearest" });
  } catch {
    // Scrolling is a nicety; activation already succeeded.
  }

  if (options.focusWindow === true) {
    const focused = await focusWindowAndObserve(win, options);
    if (focused !== undefined) outcome.windowFocused = focused;
  }

  return outcome;
}

/**
 * Calls focus() and reports what could be observed. Exposed separately so the
 * caller decides when raising the window is appropriate.
 */
export async function focusWindowAndObserve(
  win: ActivationWindowLike,
  options: TabActivationOptions = {}
): Promise<boolean | undefined> {
  try {
    win.focus?.();
  } catch {
    return false;
  }
  return observeWindowFocus(win, resolveOptions(options));
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activateTab,
  type ActivationTabLike,
  type ActivationWindowLike,
} from "../../src/bridge/tab-activation.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class FakeTab implements ActivationTabLike {
  selected = false;
  scrolled = false;
  readonly #attrs: Record<string, string>;

  constructor(attrs: Record<string, string> = {}) {
    this.#attrs = attrs;
  }

  getAttribute(name: string): string | null {
    return this.#attrs[name] ?? null;
  }

  scrollIntoView(): void {
    this.scrolled = true;
  }
}

/**
 * A window double whose assignment can be ignored or overridden, mirroring
 * Zen overriding a selection while a workspace switch settles.
 */
function fakeWindow(options: {
  activeWorkspace?: string;
  /** Assignments that stick only after this many overrides. */
  overrides?: number;
  /** Assignments that throw for this many calls. */
  failures?: number;
  onWorkspaceChange?: (spaceId: string) => void;
}): {
  win: ActivationWindowLike & {
    gBrowser: { selectedTab: FakeTab | null };
    gZenWorkspaces: {
      activeWorkspace: string | null;
      changeWorkspaceWithID(spaceId: string): Promise<void>;
    };
  };
  selectedTab(): FakeTab | null;
  focusCalls(): number;
  hasFocus(): boolean;
} {
  let selected: FakeTab | null = null;
  let overrides = options.overrides ?? 0;
  let failures = options.failures ?? 0;
  let focused = false;
  let focusCalls = 0;
  let activeWorkspace = options.activeWorkspace ?? "space-a";

  const gBrowser = {
    get selectedTab(): FakeTab | null {
      return selected;
    },
    set selectedTab(tab: FakeTab | null) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("browser is not ready");
      }
      if (!tab) return;
      selected = tab;
      tab.selected = true;
      if (overrides > 0) {
        overrides -= 1;
        // Zen reverts the assignment after the synchronous call returns.
        setTimeout(() => {
          tab.selected = false;
          if (selected === tab) selected = null;
        }, 1);
      }
    },
  };

  const win = {
    gBrowser,
    gZenWorkspaces: {
      get activeWorkspace(): string | null {
        return activeWorkspace;
      },
      async changeWorkspaceWithID(spaceId: string): Promise<void> {
        options.onWorkspaceChange?.(spaceId);
        // The switch lands asynchronously, after the call resolves.
        await sleep(5);
        activeWorkspace = spaceId;
      },
    },
    focus(): void {
      focusCalls += 1;
      focused = true;
    },
    document: {
      hasFocus: (): boolean => focused,
    },
  };

  return {
    win,
    selectedTab: () => selected,
    focusCalls: () => focusCalls,
    hasFocus: () => focused,
  };
}

const FAST = { attempts: 6, pollMs: 2, workspacePollMs: 1, workspaceTimeoutMs: 200 };

describe("tab activation", () => {
  it("selects a tab in the active space on the first attempt", async () => {
    const tab = new FakeTab({ "zen-workspace-id": "space-a" });
    let switched = false;
    const { win } = fakeWindow({ activeWorkspace: "space-a" });
    win.gZenWorkspaces.changeWorkspaceWithID = async () => {
      switched = true;
    };

    const outcome = await activateTab(win, tab, FAST);

    assert.equal(outcome.active, true);
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.spaceId, "space-a");
    assert.equal(switched, false, "no workspace switch for the active space");
    assert.equal(tab.selected, true);
    assert.equal(tab.scrolled, true);
    assert.equal(outcome.windowFocused, undefined);
  });

  it("waits for a cross-space switch and retries when it is overridden", async () => {
    const tab = new FakeTab({ "zen-workspace-id": "space-b" });
    // The first assignment is reverted while the space is still settling.
    const { win, selectedTab } = fakeWindow({
      activeWorkspace: "space-a",
      overrides: 1,
    });
    const requested: string[] = [];
    const change = win.gZenWorkspaces.changeWorkspaceWithID.bind(
      win.gZenWorkspaces
    );
    win.gZenWorkspaces.changeWorkspaceWithID = async (spaceId: string) => {
      requested.push(spaceId);
      await change(spaceId);
    };

    const outcome = await activateTab(win, tab, FAST);

    assert.deepEqual(requested, ["space-b"]);
    assert.equal(outcome.active, true);
    assert.ok(outcome.attempts >= 2, "the reverted assignment was retried");
    assert.equal(selectedTab(), tab);
    assert.equal(win.gZenWorkspaces.activeWorkspace, "space-b");
  });

  it("retries after a transient assignment rejection", async () => {
    const tab = new FakeTab({ "zen-workspace-id": "space-a" });
    const { win } = fakeWindow({ activeWorkspace: "space-a", failures: 1 });

    const outcome = await activateTab(win, tab, FAST);

    assert.equal(outcome.active, true);
    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.lastError, undefined);
  });

  it("reports a tab that never becomes active as inactive", async () => {
    const tab = new FakeTab({ "zen-workspace-id": "space-a" });
    const { win, focusCalls } = fakeWindow({ activeWorkspace: "space-a" });
    win.gBrowser = {
      get selectedTab() {
        return null;
      },
      set selectedTab(_tab: FakeTab | null) {
        // Zen ignores every assignment.
      },
    };

    const outcome = await activateTab(win, tab, {
      ...FAST,
      attempts: 4,
      focusWindow: true,
    });

    assert.equal(outcome.active, false);
    assert.equal(outcome.attempts, 4);
    assert.equal(outcome.windowFocused, undefined, "no focus is claimed");
    assert.equal(tab.selected, false);
    assert.equal(tab.scrolled, false);
    assert.equal(focusCalls(), 0, "the window is not raised on failure");
  });

  it("raises and observes the window only when asked", async () => {
    const tab = new FakeTab({ "zen-workspace-id": "space-a" });
    const focusedRun = fakeWindow({ activeWorkspace: "space-a" });

    const outcome = await activateTab(focusedRun.win, tab, {
      ...FAST,
      focusWindow: true,
    });

    assert.equal(outcome.active, true);
    assert.equal(outcome.windowFocused, true);
    assert.equal(focusedRun.focusCalls(), 1);
    assert.equal(focusedRun.hasFocus(), true);

    const quietTab = new FakeTab({ "zen-workspace-id": "space-a" });
    const quietRun = fakeWindow({ activeWorkspace: "space-a" });
    const quiet = await activateTab(quietRun.win, quietTab, FAST);
    assert.equal(quiet.windowFocused, undefined);
    assert.equal(quietRun.focusCalls(), 0);
  });

  it("reports focus as false when the window does not take it", async () => {
    const tab = new FakeTab({ "zen-workspace-id": "space-a" });
    const { win } = fakeWindow({ activeWorkspace: "space-a" });
    win.focus = () => {
      // The call succeeds but the window never gains focus.
    };

    const outcome = await activateTab(win, tab, {
      ...FAST,
      focusWindow: true,
      focusChecks: 2,
      focusPollMs: 1,
    });

    assert.equal(outcome.active, true);
    assert.equal(outcome.windowFocused, false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captureEssentialsState,
  EssentialsStateStore,
  readEssentialsTabState,
  restoreEssentialsState,
  verifyEssentialsState,
  type EssentialsRestoreHost,
  type EssentialsTabLike,
} from "../../src/bridge/essentials-state.js";

class FakeTab implements EssentialsTabLike {
  readonly attributes = new Map<string, string>();
  pinned = false;
  isConnected = true;
  closing = false;
  readonly setCalls: Array<[string, string]> = [];

  constructor(spaceId: string | null, pinned = false) {
    if (spaceId !== null) this.attributes.set("zen-workspace-id", spaceId);
    this.pinned = pinned;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.setCalls.push([name, value]);
    this.attributes.set(name, value);
  }

  get spaceId(): string | null {
    return this.getAttribute("zen-workspace-id");
  }
}

interface HostCalls {
  moves: Array<[EssentialsTabLike[], string]>;
  pins: number;
  unpins: number;
}

function hostFor(tab: FakeTab, options: { move?: boolean } = {}): {
  host: EssentialsRestoreHost;
  calls: HostCalls;
} {
  const calls: HostCalls = { moves: [], pins: 0, unpins: 0 };
  const host: EssentialsRestoreHost = {
    moveTabsToWorkspace: options.move === false
      ? undefined
      : (tabs, spaceId) => {
          calls.moves.push([tabs, spaceId]);
          tab.setAttribute("zen-workspace-id", spaceId);
        },
    pinTab: (target) => {
      calls.pins++;
      (target as FakeTab).pinned = true;
    },
    unpinTab: (target) => {
      calls.unpins++;
      (target as FakeTab).pinned = false;
    },
  };
  return { host, calls };
}

describe("essentials state capture", () => {
  it("reads the space and pinned flag, storing null for a tab without a space", () => {
    const inSpace = new FakeTab("space-a", true);
    assert.deepEqual(readEssentialsTabState(inSpace), {
      spaceId: "space-a",
      pinned: true,
    });
    const loose = new FakeTab(null);
    assert.deepEqual(readEssentialsTabState(loose), {
      spaceId: null,
      pinned: false,
    });
  });

  it("does not overwrite the first capture for the same tab", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", true);
    const first = captureEssentialsState(store, "tab-1", tab);

    // Zen places the tab in essentials away from its original space.
    tab.setAttribute("zen-workspace-id", "space-active");
    tab.pinned = false;

    const second = captureEssentialsState(store, "tab-1", tab);
    assert.deepEqual(second, first);
    assert.equal(second.spaceId, "space-a");
    assert.equal(second.pinned, true);
    assert.equal(store.size, 1);
  });

  it("evicts the oldest capture beyond the bounded store", () => {
    const store = new EssentialsStateStore(20);
    for (let index = 0; index < 21; index++) {
      store.capture(`tab-${index}`, { spaceId: "space-a", pinned: false });
    }
    assert.equal(store.size, 20);
    assert.equal(store.get("tab-0"), undefined);
    assert.equal(store.get("tab-1")?.spaceId, "space-a");
    assert.equal(store.get("tab-20")?.spaceId, "space-a");
  });
});

describe("essentials state restore", () => {
  it("round trips a captured space and pinned state", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", true);
    const capture = captureEssentialsState(store, "tab-1", tab);

    tab.setAttribute("zen-workspace-id", "space-active");
    tab.pinned = false;

    const { host, calls } = hostFor(tab);
    const report = restoreEssentialsState(capture, tab, host);

    assert.equal(report.applied, true);
    assert.equal(report.skipped, false);
    assert.equal(report.spaceRestored, true);
    assert.equal(report.pinnedRestored, true);
    assert.deepEqual(report.reasons, []);
    assert.equal(tab.spaceId, "space-a");
    assert.equal(tab.pinned, true);
    assert.equal(calls.moves.length, 1);
    assert.equal(calls.moves[0]?.[1], "space-a");
    assert.equal(calls.moves[0]?.[0][0], tab);
    assert.equal(calls.pins, 1);
    assert.equal(calls.unpins, 0);
  });

  it("restores the space on add and both space and pinned state on remove", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", true);

    // Add: capture, then simulate Zen re-homing the tab to the active space.
    const capture = captureEssentialsState(store, "tab-1", tab);
    tab.setAttribute("zen-workspace-id", "space-active");
    tab.pinned = false;
    const addHost = hostFor(tab);
    const addReport = restoreEssentialsState(capture, tab, addHost.host, {
      restorePinned: false,
    });
    assert.equal(addReport.spaceRestored, true);
    assert.equal(tab.spaceId, "space-a");
    assert.equal(tab.pinned, false);
    assert.equal(addHost.calls.pins, 0);
    assert.equal(addHost.calls.unpins, 0);

    // Remove: take the capture and simulate another re-home.
    tab.setAttribute("zen-workspace-id", "space-active");
    tab.pinned = false;
    const taken = store.take("tab-1");
    assert.deepEqual(taken, capture);
    assert.equal(store.size, 0);
    const removeHost = hostFor(tab);
    const removeReport = restoreEssentialsState(taken, tab, removeHost.host);
    assert.equal(removeReport.spaceRestored, true);
    assert.equal(removeReport.pinnedRestored, true);
    assert.equal(tab.spaceId, "space-a");
    assert.equal(tab.pinned, true);
    assert.equal(removeHost.calls.moves.length, 1);
    assert.equal(removeHost.calls.pins, 1);
  });

  it("restores a changed space through setAttribute and moveTabsToWorkspace", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", false);
    const capture = captureEssentialsState(store, "tab-1", tab);
    tab.setAttribute("zen-workspace-id", "space-active");
    tab.setCalls.length = 0;

    const { host, calls } = hostFor(tab);
    restoreEssentialsState(capture, tab, host, { restorePinned: false });

    assert.equal(tab.setCalls[0]?.[0], "zen-workspace-id");
    assert.equal(tab.setCalls[0]?.[1], "space-a");
    assert.equal(calls.moves.length, 1);
    assert.deepEqual(calls.moves[0]?.[1], "space-a");
  });

  it("still restores the attribute when moveTabsToWorkspace is unavailable", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", false);
    const capture = captureEssentialsState(store, "tab-1", tab);
    tab.setAttribute("zen-workspace-id", "space-active");

    const { host, calls } = hostFor(tab, { move: false });
    const report = restoreEssentialsState(capture, tab, host, {
      restorePinned: false,
    });

    assert.equal(report.spaceRestored, true);
    assert.equal(tab.spaceId, "space-a");
    assert.equal(calls.moves.length, 0);
  });

  it("does not invent a space for a tab captured without one", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab(null, false);
    const capture = captureEssentialsState(store, "tab-1", tab);
    assert.equal(capture.spaceId, null);
    tab.setAttribute("zen-workspace-id", "space-active");
    tab.setCalls.length = 0;

    const { host } = hostFor(tab);
    const report = restoreEssentialsState(capture, tab, host, {
      restorePinned: false,
    });

    assert.equal(report.spaceRestored, true);
    assert.equal(tab.spaceId, "space-active");
    assert.deepEqual(tab.setCalls, []);
  });

  it("leaves a tab without a capture untouched", () => {
    const tab = new FakeTab("space-active", true);
    const { host, calls } = hostFor(tab);
    const report = restoreEssentialsState(undefined, tab, host);

    assert.equal(report.applied, false);
    assert.equal(report.skipped, false);
    assert.deepEqual(report.reasons, []);
    assert.deepEqual(tab.setCalls, []);
    assert.equal(tab.spaceId, "space-active");
    assert.equal(tab.pinned, true);
    assert.equal(calls.moves.length, 0);
    assert.equal(calls.pins + calls.unpins, 0);
  });

  it("skips a disconnected tab instead of touching it", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", true);
    const capture = captureEssentialsState(store, "tab-1", tab);
    tab.setAttribute("zen-workspace-id", "space-active");
    tab.pinned = false;
    tab.isConnected = false;
    tab.setCalls.length = 0;

    const { host, calls } = hostFor(tab);
    const report = restoreEssentialsState(capture, tab, host);

    assert.equal(report.applied, false);
    assert.equal(report.skipped, true);
    assert.match(report.reasons.join(" "), /closed/);
    assert.deepEqual(tab.setCalls, []);
    assert.equal(calls.moves.length + calls.pins + calls.unpins, 0);
  });

  it("reports a limitation when Zen refuses the workspace restore", () => {
    const store = new EssentialsStateStore();
    const tab = new FakeTab("space-a", false);
    const capture = captureEssentialsState(store, "tab-1", tab);
    tab.setAttribute("zen-workspace-id", "space-active");

    const host: EssentialsRestoreHost = {
      moveTabsToWorkspace: () => {
        // Zen refuses the move and re-homes the tab again.
        tab.setAttribute("zen-workspace-id", "space-active");
      },
    };
    const report = restoreEssentialsState(capture, tab, host, {
      restorePinned: false,
    });

    assert.equal(report.spaceRestored, false);
    assert.match(report.reasons.join(" "), /original space/);
    assert.equal(
      verifyEssentialsState(capture, tab, { restorePinned: false })
        .spaceRestored,
      false
    );
  });
});

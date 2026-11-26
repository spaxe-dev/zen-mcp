import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOps } from "../../src/bridge/ops.js";
import {
  BridgePolicyError,
  BridgePolicyGate,
  type PolicyFileObservation,
} from "../../src/bridge/policy-gate.js";
import {
  createPolicy,
  type Policy,
  type WebsiteRule,
} from "../../src/shared/policy.js";
import { serializePolicy } from "../../src/shared/policy-schema.js";
import { testGate } from "./policy-gate-fixture.js";

function snapshot(policy: Policy) {
  return {
    policy,
    source: "file" as const,
    revision: policy.revision,
    digest: "digest-" + policy.revision,
    updatedAt: policy.updatedAt,
    warnings: [],
  };
}

function gateFor(
  options: {
    block?: string[];
    rules?: WebsiteRule[];
    allow?: string[];
    default?: "allow" | "deny";
  } = {}
) {
  const policy = createPolicy({
    mode: "permissive",
    websites: {
      default: options.default ?? "allow",
      allow: options.allow ?? [],
      block: options.block ?? [],
      rules: options.rules ?? [],
    },
  });
  return new BridgePolicyGate({ initial: snapshot(policy) });
}

function policyError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BridgePolicyError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

describe("bridge policy gate", () => {
  it("denies every browser operation while restricted", () => {
    const gate = new BridgePolicyGate();
    policyError(() => gate.assertOperation("tabs.list"), "mode_denied");
  });

  it("denies unknown bridge operations", () => {
    const gate = gateFor();
    policyError(
      () => gate.assertOperation("tabs.destroyEverything"),
      "unknown_capability"
    );
  });

  it("checks every actual URL, including a cross-origin frame", () => {
    const gate = gateFor({ block: ["blocked.example"] });
    gate.assertOperation(
      "tabs.read",
      ["https://allowed.example/page", "https://allowed.example/frame"],
      { requireUrl: true }
    );
    policyError(
      () =>
        gate.assertOperation(
          "tabs.read",
          ["https://allowed.example/page", "https://blocked.example/frame"],
          { requireUrl: true }
        ),
      "site_blocked"
    );
  });

  it("fails closed when a site-scoped operation has no resolved URL", () => {
    const gate = gateFor();
    policyError(
      () => gate.assertOperation("tabs.read", [], { requireUrl: true }),
      "unscoped_url"
    );
  });

  it("checks a URL-requiring capability before its URL is resolved", () => {
    const gate = gateFor();
    gate.assertCapability("tabs.open");
    const restricted = new BridgePolicyGate();
    policyError(() => restricted.assertCapability("tabs.open"), "mode_denied");
    const blocked = gateFor({ default: "deny", allow: ["example.com"] });
    policyError(
      () =>
        blocked.assertOperation("tabs.open", ["https://blocked.example/a"], {
          requireUrl: true,
        }),
      "site_default_denied"
    );
  });

  it("keeps exact-host and subdomain boundaries", () => {
    const gate = gateFor({ default: "deny", allow: ["example.com"] });
    gate.assertOperation("tabs.read", ["https://example.com/a"]);
    gate.assertOperation("tabs.read", ["https://docs.example.com/a"]);
    policyError(
      () => gate.assertOperation("tabs.read", ["https://notexample.com/a"]),
      "site_default_denied"
    );
    policyError(
      () =>
        gate.assertOperation(
          "tabs.read",
          ["https://example.com.attacker.test/a"]
        ),
      "site_default_denied"
    );
  });

  it("rejects a missing, older, newer or mismatched policy revision", () => {
    const gate = new BridgePolicyGate({
      initial: {
        policy: createPolicy({ mode: "permissive", revision: 4 }),
        source: "file",
        revision: 4,
        digest: "abc",
        updatedAt: new Date().toISOString(),
        warnings: [],
      },
    });
    gate.assertRequest(4, "abc");
    for (const [revision, digest] of [
      [undefined, "abc"],
      [3, "abc"],
      [5, "abc"],
      [4, ""],
      [4, "other"],
    ] as const) {
      policyError(() => gate.assertRequest(revision, digest), "policy_stale");
    }
  });

  it("refuses an authenticated update that lowers or rewrites a revision", () => {
    const at = new Date().toISOString();
    const gate = new BridgePolicyGate({
      initial: {
        policy: createPolicy({ mode: "permissive", revision: 4, now: new Date(at) }),
        source: "file",
        revision: 4,
        digest: "abc",
        updatedAt: at,
        warnings: [],
      },
    });
    const older = createPolicy({ mode: "permissive", revision: 3 });
    assert.equal(gate.acceptUpdate(snapshot(older)), false);

    const rewritten = createPolicy({
      mode: "permissive",
      revision: 4,
      websites: { block: ["blocked.example"] },
    });
    assert.equal(
      gate.acceptUpdate({ ...snapshot(rewritten), digest: "different" }),
      false
    );

    const newer = createPolicy({ mode: "permissive", revision: 5 });
    assert.equal(gate.acceptUpdate(snapshot(newer)), true);
    assert.equal(gate.snapshot().revision, 5);
  });

  it("fails closed when the policy file disappears after being seen", async () => {
    const observations: PolicyFileObservation[] = [
      { status: "missing" },
    ];
    const gate = new BridgePolicyGate({
      initial: snapshot(createPolicy({ mode: "permissive" })),
      readFile: async () => observations.shift() ?? { status: "missing" },
    });
    await gate.refresh();
    assert.equal(gate.snapshot().source, "invalid");
    policyError(() => gate.assertOperation("tabs.list"), "policy_invalid");
  });

  it("fails closed when the policy file is unreadable or invalid", async () => {
    const policy = createPolicy({ mode: "permissive" });
    const observations: PolicyFileObservation[] = [
      { status: "unreadable" },
      { status: "changed", text: "{ not a policy" },
    ];
    const gate = new BridgePolicyGate({
      initial: snapshot(policy),
      readFile: async () => observations.shift() ?? { status: "unchanged" },
    });
    await gate.refresh();
    assert.equal(gate.snapshot().errorCode, "policy_unavailable");
    policyError(() => gate.assertOperation("tabs.list"), "policy_invalid");

    await gate.refresh();
    assert.equal(gate.snapshot().source, "invalid");
    policyError(() => gate.assertOperation("tabs.list"), "policy_invalid");
  });

  it("applies a changed file and ignores a hand-edited rollback", async () => {
    const initial = createPolicy({ mode: "permissive", revision: 5 });
    let text = serializePolicy(
      createPolicy({
        mode: "permissive",
        revision: 3,
        websites: { block: ["blocked.example"] },
      })
    );
    const gate = new BridgePolicyGate({
      initial: snapshot(initial),
      readFile: async () => ({ status: "changed", text }),
    });
    await gate.refresh();
    assert.equal(gate.snapshot().revision, 5);
    assert.equal(gate.snapshot().policy.mode, "permissive");

    text = serializePolicy(
      createPolicy({
        mode: "permissive",
        revision: 5,
        websites: { block: ["blocked.example"] },
      })
    );
    await gate.refresh();
    assert.equal(gate.snapshot().revision, 5);
    assert.deepEqual(gate.snapshot().policy.websites.block, []);
    gate.assertOperation("tabs.read", ["https://blocked.example/a"]);

    text = serializePolicy(
      createPolicy({
        mode: "permissive",
        revision: 6,
        websites: { block: ["blocked.example"] },
      })
    );
    await gate.refresh();
    assert.equal(gate.snapshot().revision, 6);
    policyError(
      () => gate.assertOperation("tabs.read", ["https://blocked.example/a"]),
      "site_blocked"
    );
  });
});

class FakeTab {
  readonly attributes = new Map<string, string>();
  readonly label: string;
  readonly linkedBrowser: { currentURI: { spec: string } };
  isConnected = true;
  closing = false;
  selected = false;
  pinned = false;
  splitView = false;
  group = null;
  userContextId = 0;
  lastAccessed = 0;

  constructor(url: string, title: string) {
    this.label = title;
    this.linkedBrowser = { currentURI: { spec: url } };
    this.attributes.set("zen-url", url);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

function fakeWindow(tabs: FakeTab[]) {
  return {
    document: {
      querySelectorAll: (selector: string) =>
        selector === "tab.tabbrowser-tab" ? tabs : [],
    },
    gZenWorkspaces: {
      shouldHaveWorkspaces: false,
      activeWorkspace: "space-1",
      allStoredTabs: tabs,
      getWorkspaces: () => [],
    },
    gBrowser: {
      tabs,
      selectedTab: tabs[0],
      removeTab: () => undefined,
    },
    gZenViewSplitter: undefined,
  };
}

describe("bridge operation enforcement", () => {
  it("redacts metadata for a tab on a blocked site", async () => {
    const allowed = new FakeTab("https://allowed.example/page", "Allowed");
    const blocked = new FakeTab("https://blocked.example/secret", "Secret");
    const ops = createOps(
      fakeWindow([allowed, blocked]) as never,
      "w1",
      testGate({ websites: { block: ["blocked.example"] } })
    );

    const result = (await ops.dispatch("tabs.list", {})) as {
      tabs: Array<{ title: string; url: string; requestedUrl?: string }>;
    };
    const visible = result.tabs.find((tab) => tab.title === "Allowed");
    const hidden = result.tabs.find((tab) => tab.title !== "Allowed");
    assert.equal(visible?.url, "https://allowed.example/page");
    assert.equal(hidden?.title, "(restricted by policy)");
    assert.equal(hidden?.url, "");
    assert.equal(hidden?.requestedUrl, "");
  });

  it("denies a read on a blocked tab before the page handler runs", async () => {
    const blocked = new FakeTab("https://blocked.example/secret", "Secret");
    const ops = createOps(
      fakeWindow([blocked]) as never,
      "w1",
      testGate({ websites: { block: ["blocked.example"] } })
    );
    const listed = (await ops.dispatch("tabs.list", {})) as {
      tabs: Array<{ id: string }>;
    };
    const id = listed.tabs[0]?.id;
    assert.ok(id, "expected a tab id even when its metadata is redacted");
    await assert.rejects(
      () => ops.dispatch("tabs.read", { tabId: id }),
      (error: { code?: string }) => error.code === "site_blocked"
    );
  });
});

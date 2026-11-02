import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createOps } from "../../src/bridge/ops.js";

const originalServices = (globalThis as { Services?: unknown }).Services;

before(() => {
  (globalThis as { Services?: unknown }).Services = {
    io: { newURI: (url: string) => ({ spec: url }) },
    scriptSecurityManager: {
      createContentPrincipal: (uri: unknown, attrs: unknown) => ({
        kind: "content",
        uri,
        attrs,
      }),
      getSystemPrincipal: () => ({ kind: "system" }),
    },
  };
});

after(() => {
  (globalThis as { Services?: unknown }).Services = originalServices;
});

interface GlanceCall {
  url: string;
  triggeringPrincipal: { kind: string };
  userContextId?: number;
}

function fakeWindow(
  spec: string,
  calls: GlanceCall[],
  openGlance: (params: GlanceCall) => Promise<unknown> = async () => true
) {
  const tab = {
    label: "Preview",
    linkedBrowser: { currentURI: { spec } },
    userContextId: 0,
    isConnected: true,
    closing: false,
    selected: true,
    pinned: false,
    splitView: false,
    group: null,
    hasAttribute: () => false,
    getAttribute: () => null,
  };
  return {
    document: { querySelectorAll: () => [], hasFocus: () => true },
    gBrowser: {
      tabs: [tab],
      selectedTab: tab,
      removeTab: () => undefined,
    },
    gZenWorkspaces: undefined,
    gZenGlanceManager: {
      openGlance: (params: GlanceCall) => {
        calls.push(params);
        return openGlance(params);
      },
    },
    tab,
  };
}

async function tabIdFor(ops: ReturnType<typeof createOps>): Promise<string> {
  const listed = (await ops.dispatch("tabs.list", {})) as {
    tabs: Array<{ id: string }>;
  };
  const id = listed.tabs[0]?.id;
  assert.ok(id, "expected the fake tab to be listed");
  return id;
}

describe("Glance URL policy", () => {
  it("refuses an about: tab before calling Glance", async () => {
    const calls: GlanceCall[] = [];
    const ops = createOps(fakeWindow("about:config", calls) as never, "win");
    const tabId = await tabIdFor(ops);

    await assert.rejects(
      async () => ops.dispatch("glance.open", { tabId }),
      (error: { code?: string }) => error.code === "invalid_url"
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a file: URL before calling Glance", async () => {
    const calls: GlanceCall[] = [];
    const ops = createOps(fakeWindow("https://allowed.example/", calls) as never, "win");

    await assert.rejects(
      async () =>
        ops.dispatch("glance.open", {
          url: "file:///C:/secret.txt",
          allowedDomains: [],
        }),
      (error: { code?: string }) => error.code === "invalid_url"
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a tab outside the allowlist before calling Glance", async () => {
    const calls: GlanceCall[] = [];
    const ops = createOps(
      fakeWindow("https://blocked.example/article", calls) as never,
      "win"
    );
    const tabId = await tabIdFor(ops);

    await assert.rejects(
      async () =>
        ops.dispatch("glance.open", {
          tabId,
          allowedDomains: ["allowed.example"],
        }),
      (error: { code?: string }) => error.code === "domain_not_allowed"
    );
    assert.equal(calls.length, 0);
  });

  it("opens an allowed tab with a content principal", async () => {
    const calls: GlanceCall[] = [];
    const ops = createOps(
      fakeWindow("https://allowed.example/article", calls) as never,
      "win"
    );
    const tabId = await tabIdFor(ops);

    const result = (await ops.dispatch("glance.open", {
      tabId,
      allowedDomains: ["allowed.example"],
    })) as { opened: boolean; url: string };

    assert.equal(result.opened, true);
    assert.equal(result.url, "https://allowed.example/article");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.triggeringPrincipal.kind, "content");
  });
});

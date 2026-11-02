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

function glanceTab(url: string) {
  return { linkedBrowser: { currentURI: { spec: url } } };
}

function fakeWindow(
  spec: string,
  calls: GlanceCall[],
  openGlance: (params: GlanceCall) => Promise<unknown> = async (params) =>
    glanceTab(params.url),
  closes: unknown[] = []
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
      closeGlance: (options: unknown) => {
        closes.push(options);
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

  it("refuses data: and javascript: URLs before calling Glance", async () => {
    for (const url of ["data:text/html,<h1>hi</h1>", "javascript:alert(1)"]) {
      const calls: GlanceCall[] = [];
      const ops = createOps(
        fakeWindow("https://allowed.example/", calls) as never,
        "win"
      );

      await assert.rejects(
        async () => ops.dispatch("glance.open", { url, allowedDomains: [] }),
        (error: { code?: string }) => error.code === "invalid_url",
        url
      );
      assert.equal(calls.length, 0, url);
    }
  });

  it("allows an allowed subdomain and refuses a lookalike host", async () => {
    const allowedCalls: GlanceCall[] = [];
    const allowedOps = createOps(
      fakeWindow("https://deep.sub.allowed.example/a", allowedCalls) as never,
      "win"
    );
    const allowedId = await tabIdFor(allowedOps);

    const allowed = (await allowedOps.dispatch("glance.open", {
      tabId: allowedId,
      allowedDomains: ["allowed.example"],
    })) as { opened: boolean; url: string };
    assert.equal(allowed.opened, true);
    assert.equal(allowed.url, "https://deep.sub.allowed.example/a");

    const blockedCalls: GlanceCall[] = [];
    const blockedOps = createOps(
      fakeWindow(
        "https://allowed.example.attacker.test/a",
        blockedCalls
      ) as never,
      "win"
    );
    const blockedId = await tabIdFor(blockedOps);

    await assert.rejects(
      async () =>
        blockedOps.dispatch("glance.open", {
          tabId: blockedId,
          allowedDomains: ["allowed.example"],
        }),
      (error: { code?: string }) => error.code === "domain_not_allowed"
    );
    assert.equal(blockedCalls.length, 0);
  });

  it("closes a preview that redirects outside the allowlist", async () => {
    const calls: GlanceCall[] = [];
    const closes: unknown[] = [];
    const ops = createOps(
      fakeWindow(
        "https://allowed.example/start",
        calls,
        async () => glanceTab("https://blocked.example/landing"),
        closes
      ) as never,
      "win"
    );

    await assert.rejects(
      async () =>
        ops.dispatch("glance.open", {
          url: "https://allowed.example/start",
          allowedDomains: ["allowed.example"],
        }),
      (error: { code?: string }) => error.code === "domain_not_allowed"
    );
    assert.equal(calls.length, 1);
    assert.equal(closes.length, 1);
  });

  it("fails closed when the preview result cannot be inspected", async () => {
    const calls: GlanceCall[] = [];
    const closes: unknown[] = [];
    const ops = createOps(
      fakeWindow(
        "https://allowed.example/",
        calls,
        async () => true,
        closes
      ) as never,
      "win"
    );

    await assert.rejects(
      async () =>
        ops.dispatch("glance.open", {
          url: "https://allowed.example/",
          allowedDomains: ["allowed.example"],
        }),
      (error: { code?: string }) => error.code === "glance_failed"
    );
    assert.equal(calls.length, 1);
    assert.equal(closes.length, 1);
  });
});

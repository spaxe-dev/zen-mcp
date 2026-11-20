import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentIdForTab } from "../../src/bridge/tab-identity.js";

describe("tab document identity", () => {
  it("derives a stable id from the browsing context window global", () => {
    assert.equal(
      documentIdForTab({
        linkedBrowser: { browsingContext: { currentWindowGlobal: { innerWindowId: 42 } } },
      }),
      "doc-42"
    );
  });

  it("returns an empty id for the initial about:blank placeholder", () => {
    assert.equal(
      documentIdForTab({
        linkedBrowser: {
          browsingContext: {
            currentWindowGlobal: { innerWindowId: 42, isInitialDocument: true },
          },
        },
      }),
      ""
    );
  });

  it("keeps the id of a committed document", () => {
    assert.equal(
      documentIdForTab({
        linkedBrowser: {
          browsingContext: {
            currentWindowGlobal: { innerWindowId: 42, isInitialDocument: false },
          },
        },
      }),
      "doc-42"
    );
  });

  it("returns an empty id when the tab or its identity is unavailable", () => {
    assert.equal(documentIdForTab(null), "");
    assert.equal(documentIdForTab(undefined), "");
    assert.equal(documentIdForTab({}), "");
    assert.equal(
      documentIdForTab({ linkedBrowser: { browsingContext: null } }),
      ""
    );
    assert.equal(
      documentIdForTab({
        linkedBrowser: { browsingContext: { currentWindowGlobal: {} } },
      }),
      ""
    );
    assert.equal(
      documentIdForTab({
        linkedBrowser: {
          browsingContext: { currentWindowGlobal: { innerWindowId: "42" } },
        },
      }),
      ""
    );
    assert.equal(
      documentIdForTab({
        linkedBrowser: {
          browsingContext: { currentWindowGlobal: { innerWindowId: Number.NaN } },
        },
      }),
      ""
    );
  });

  it("returns an empty id instead of throwing when the context is torn down", () => {
    const hostile = {
      get linkedBrowser(): never {
        throw new Error("dead object");
      },
    };
    assert.equal(documentIdForTab(hostile), "");
    const tornGlobal = {
      linkedBrowser: {
        browsingContext: {
          get currentWindowGlobal(): never {
            throw new Error("dead object");
          },
        },
      },
    };
    assert.equal(documentIdForTab(tornGlobal), "");
  });
});

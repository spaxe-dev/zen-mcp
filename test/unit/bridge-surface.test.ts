import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBridgeSurface,
  type BridgeSurface,
} from "../../src/bridge/bridge-surface.js";

describe("bridge public surface", () => {
  it("exposes a token identifier but never the authentication token", () => {
    const surface = createBridgeSurface({
      version: "0.6.3",
      tokenId: "abc123",
      windowId: "win-1",
      isConnected: () => true,
      reconnect: () => undefined,
      destroy: () => undefined,
    });

    assert.deepEqual(Object.keys(surface).sort(), [
      "destroy",
      "isConnected",
      "reconnect",
      "tokenId",
      "version",
      "windowId",
    ]);
    assert.equal("token" in surface, false);
    assert.equal(surface.tokenId, "abc123");
  });

  it("keeps the reconnect and destroy closures callable", () => {
    let reconnects = 0;
    let destroys = 0;
    const surface: BridgeSurface = createBridgeSurface({
      version: "0.6.3",
      tokenId: "abc123",
      windowId: "win-1",
      isConnected: () => false,
      reconnect: () => {
        reconnects += 1;
      },
      destroy: () => {
        destroys += 1;
      },
    });

    assert.equal(surface.isConnected(), false);
    surface.reconnect();
    surface.destroy();
    assert.equal(reconnects, 1);
    assert.equal(destroys, 1);
  });
});

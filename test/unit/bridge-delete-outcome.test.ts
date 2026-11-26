import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeHub, BridgeRequestError } from "../../src/bridge/host.js";
import type { MarionetteClient } from "../../src/zen/marionette.js";
import { fullPolicySnapshot } from "./policy-fixtures.js";

type RequestCall = {
  method: string;
  params: unknown;
};

function makeHub(
  request: (method: string, params: unknown, calls: RequestCall[]) => Promise<unknown>
): { hub: BridgeHub; calls: RequestCall[] } {
  const hub = new BridgeHub({
    marionette: {} as MarionetteClient,
    policy: fullPolicySnapshot(),
  });
  const calls: RequestCall[] = [];
  (hub as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
  }).request = (method, params) => {
    calls.push({ method, params });
    return request(method, params, calls);
  };
  return { hub, calls };
}

const target = {
  id: "space-1",
  name: "Target",
  icon: null,
  active: true,
  index: 0,
  containerTabId: 0,
};

const list = (spaces: unknown[]) => ({
  activeSpaceId: spaces.length > 0 ? (spaces[0] as { id: string }).id : null,
  workspacesEnabled: true,
  spaces,
});

describe("bridge Space deletion outcomes", () => {
  it("returns completed only when deletion confirmation is delivered", async () => {
    const { hub } = makeHub(async (method) => {
      if (method === "spaces.list") return list([target]);
      return {
        deleted: true,
        spaceId: target.id,
        spaceName: target.name,
        activeSpaceId: "space-2",
        outcome: "completed",
        confirmation: "delivered",
      };
    });

    const result = await hub.deleteSpace({ space: target.id });
    assert.equal(result.deleted, true);
    assert.equal(result.outcome, "completed");
    assert.equal(result.confirmation, "delivered");
    assert.equal(result.spaceId, target.id);
  });

  it("verifies a timeout as absent_after_timeout and never retries", async () => {
    const { hub, calls } = makeHub(async (method) => {
      if (method === "spaces.list") {
        const listCalls = calls.filter((call) => call.method === "spaces.list").length;
        return list(listCalls === 1 ? [target] : []);
      }
      throw new BridgeRequestError("bridge_timeout", "timed out");
    });

    const result = await hub.deleteSpace({ space: target.id });
    assert.equal(result.deleted, false);
    assert.equal(result.outcome, "absent_after_timeout");
    assert.equal(result.confirmation, "lost");
    assert.equal(result.verifiedAfterTimeout, true);
    assert.equal(result.verification?.present, false);
    assert.equal(calls.filter((call) => call.method === "spaces.delete").length, 1);
  });

  it("reports pending_unknown when the target still exists after timeout", async () => {
    const { hub, calls } = makeHub(async (method) => {
      if (method === "spaces.list") return list([target]);
      throw new BridgeRequestError("bridge_timeout", "timed out");
    });

    const result = await hub.deleteSpace({ space: target.id });
    assert.equal(result.ok, false);
    assert.equal(result.deleted, false);
    assert.equal(result.outcome, "pending_unknown");
    assert.equal(result.verification?.present, true);
    assert.equal(calls.filter((call) => call.method === "spaces.delete").length, 1);
  });

  it("reports unknown when timeout verification is unavailable", async () => {
    const { hub, calls } = makeHub(async (method) => {
      if (method === "spaces.list") {
        if (calls.filter((call) => call.method === "spaces.list").length === 1) {
          return list([target]);
        }
        throw new BridgeRequestError("bridge_disconnected", "gone");
      }
      throw new BridgeRequestError("bridge_timeout", "timed out");
    });

    const result = await hub.deleteSpace({ space: target.id });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.verification?.present, null);
    assert.equal(calls.filter((call) => call.method === "spaces.delete").length, 1);
  });

  it("refuses an ambiguous name before any deletion", async () => {
    const { hub, calls } = makeHub(async () => list([target, { ...target, id: "space-2" }]));

    await assert.rejects(
      () => hub.deleteSpace({ space: "Target" }),
      (error: unknown) => {
        assert.ok(error instanceof BridgeRequestError);
        assert.equal(error.code, "space_delete_ambiguous");
        return true;
      }
    );
    assert.equal(calls.filter((call) => call.method === "spaces.delete").length, 0);
  });

  it("reports not_found before any deletion", async () => {
    const { hub, calls } = makeHub(async () => list([]));

    await assert.rejects(
      () => hub.deleteSpace({ space: "missing" }),
      (error: unknown) => {
        assert.ok(error instanceof BridgeRequestError);
        assert.equal(error.code, "space_delete_not_found");
        assert.equal(error.details?.outcome, "not_found");
        return true;
      }
    );
    assert.equal(calls.filter((call) => call.method === "spaces.delete").length, 0);
  });
});

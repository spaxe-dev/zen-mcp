import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PendingStopStore,
  deliverStop,
} from "../../src/bridge/pending-stop.js";

describe("pending Stop delivery", () => {
  it("queues a press when the socket send fails", () => {
    const store = new PendingStopStore();
    const delivered = deliverStop(store, "p-1", () => false, 1000);
    assert.equal(delivered, false);
    assert.deepEqual(store.peek(), { progressId: "p-1", ts: 1000 });
    assert.equal(store.size, 1);
  });

  it("clears the queue when the press is sent", () => {
    const store = new PendingStopStore();
    store.set("p-0", 500);
    const delivered = deliverStop(store, "p-1", () => true, 1000);
    assert.equal(delivered, true);
    assert.equal(store.peek(), null);
  });

  it("keeps the press available for resend after a reconnect", () => {
    const store = new PendingStopStore();
    deliverStop(store, "p-1", () => false, 1000);
    // The reconnect flush reads the press without consuming it; only the
    // host echo may clear it.
    assert.equal(store.peek()?.progressId, "p-1");
    store.clearIfProgressMoved("p-1");
    assert.deepEqual(store.peek(), { progressId: "p-1", ts: 1000 });
  });

  it("clears on a stopRequested echo", () => {
    const store = new PendingStopStore();
    deliverStop(store, "p-1", () => false, 1000);
    store.clearIfProgressMoved("p-1");
    assert.equal(store.size, 1);
    store.clear();
    assert.equal(store.peek(), null);
  });

  it("drops a press for a replaced or cleared progress card", () => {
    const replaced = new PendingStopStore();
    deliverStop(replaced, "p-1", () => false, 1000);
    replaced.clearIfProgressMoved("p-2");
    assert.equal(replaced.peek(), null);

    const cleared = new PendingStopStore();
    deliverStop(cleared, "p-1", () => false, 1000);
    cleared.clearIfProgressMoved(null);
    assert.equal(cleared.peek(), null);
  });

  it("stays bounded by replacing older presses", () => {
    const store = new PendingStopStore();
    deliverStop(store, "p-1", () => false, 1000);
    deliverStop(store, "p-1", () => false, 2000);
    assert.deepEqual(store.peek(), { progressId: "p-1", ts: 2000 });
    assert.equal(store.size, 1);

    deliverStop(store, "p-2", () => false, 3000);
    assert.deepEqual(store.peek(), { progressId: "p-2", ts: 3000 });
    assert.equal(store.size, 1);

    store.set("", 4000);
    assert.deepEqual(store.peek(), { progressId: "p-2", ts: 3000 });
  });

  it("returns a snapshot so callers cannot mutate the queue", () => {
    const store = new PendingStopStore();
    store.set("p-1", 1000);
    const pending = store.peek();
    assert.ok(pending);
    pending.progressId = "p-2";
    assert.equal(store.peek()?.progressId, "p-1");
  });
});

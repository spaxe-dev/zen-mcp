import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_TTL_MS,
  EventLog,
  MAX_EVENTS,
  filterPausedEvents,
} from "../../src/bridge/event-log.js";

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("event log", () => {
  it("assigns monotonic ids and returns events after a cursor", () => {
    const time = clock();
    const log = new EventLog({ now: time.now });
    const first = log.push({ kind: "stop", title: "Stop" });
    time.advance(5);
    const second = log.push({
      kind: "tab",
      phase: "opened",
      title: "Tab opened",
      tabId: "t1",
    });
    assert.equal(first?.id, 1);
    assert.equal(second?.id, 2);
    assert.equal(second?.at, 1_005);

    const firstRead = log.read(0);
    assert.deepEqual(
      firstRead.events.map((event) => event.id),
      [1, 2]
    );
    assert.equal(firstRead.cursor, 2);
    assert.equal(firstRead.oldestCursor, 1);
    assert.equal(firstRead.missed, 0);
    assert.equal(firstRead.dropped, 0);
    assert.equal(firstRead.lastEventAt, 1_005);

    const secondRead = log.read(1);
    assert.deepEqual(
      secondRead.events.map((event) => event.id),
      [2]
    );
    assert.equal(secondRead.missed, 0);
    assert.deepEqual(log.read(2).events, []);
  });

  it("reports how many sequence ids a cursor can no longer read", () => {
    const log = new EventLog({ maxEvents: 3, ttlMs: 0 });
    for (let index = 0; index < 5; index += 1) {
      log.push({ kind: "tab", phase: "selected", title: "Selected" });
    }
    const result = log.read(0);
    assert.deepEqual(
      result.events.map((event) => event.id),
      [3, 4, 5]
    );
    assert.equal(result.oldestCursor, 3);
    assert.equal(result.missed, 2);
    assert.equal(result.dropped, 2);
  });

  it("keeps an empty read from inventing missed events", () => {
    const log = new EventLog({ maxEvents: 2, ttlMs: 0 });
    for (let index = 0; index < 4; index += 1) {
      log.push({ kind: "tab", phase: "closed", title: "Closed" });
    }
    const caughtUp = log.read(4);
    assert.deepEqual(caughtUp.events, []);
    assert.equal(caughtUp.cursor, 4);
    assert.equal(caughtUp.missed, 0);
  });

  it("dedupes repeated keys only inside the window", () => {
    const time = clock();
    const log = new EventLog({ now: time.now });
    const accepted = log.push(
      { kind: "navigation", phase: "committed", title: "Committed", url: "https://a.test/" },
      { dedupeKey: "nav|https://a.test/", dedupeWindowMs: 2_000 }
    );
    assert.ok(accepted);
    const duplicate = log.push(
      { kind: "navigation", phase: "committed", title: "Committed", url: "https://a.test/" },
      { dedupeKey: "nav|https://a.test/", dedupeWindowMs: 2_000 }
    );
    assert.equal(duplicate, null);
    assert.equal(log.sequence, 1);

    time.advance(2_000);
    const later = log.push(
      { kind: "navigation", phase: "committed", title: "Committed", url: "https://a.test/" },
      { dedupeKey: "nav|https://a.test/", dedupeWindowMs: 2_000 }
    );
    assert.ok(later);
    assert.equal(later.id, 2);
  });

  it("keeps different dedupe keys independent", () => {
    const log = new EventLog();
    log.push({ kind: "tab", phase: "opened", title: "Opened", tabId: "a" }, { dedupeKey: "a" });
    const other = log.push(
      { kind: "tab", phase: "opened", title: "Opened", tabId: "b" },
      { dedupeKey: "b" }
    );
    assert.equal(other?.id, 2);
  });

  it("expires browser observations but keeps control events", () => {
    const time = clock();
    const log = new EventLog({ now: time.now });
    log.push({ kind: "stop", title: "Stop" });
    log.push({ kind: "tab", phase: "opened", title: "Opened", tabId: "t1" });
    time.advance(EVENT_TTL_MS + 1);
    log.push({ kind: "navigation", phase: "started", title: "Started", tabId: "t1" });

    const result = log.read(0);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ["stop", "navigation"]
    );
    assert.equal(result.oldestCursor, 1);
    assert.equal(result.dropped, 1);
  });

  it("does not let an old control event pin newer observations", () => {
    const time = clock();
    const log = new EventLog({ now: time.now });
    log.push({ kind: "tab", phase: "opened", title: "Opened", tabId: "t1" });
    log.push({ kind: "pause", title: "Pause" });
    time.advance(EVENT_TTL_MS + 1);
    log.push({ kind: "document", phase: "replaced", title: "Replaced", tabId: "t1" });
    const result = log.read(0);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ["pause", "document"]
    );
    assert.equal(result.dropped, 1);
  });

  it("caps the buffer and tracks drops", () => {
    const log = new EventLog({ ttlMs: 0 });
    for (let index = 0; index < MAX_EVENTS + 20; index += 1) {
      log.push({ kind: "tab", phase: "selected", title: "Selected" });
    }
    assert.equal(log.size, MAX_EVENTS);
    assert.equal(log.dropped, 20);
    const result = log.read(0);
    assert.equal(result.missed, 20);
    assert.equal(result.oldestCursor, 21);
  });

  it("clears events and dedupe keys", () => {
    const log = new EventLog();
    log.push({ kind: "stop", title: "Stop" }, { dedupeKey: "k" });
    log.clear();
    assert.equal(log.size, 0);
    assert.deepEqual(log.read(0).events, []);
    const accepted = log.push({ kind: "stop", title: "Stop" }, { dedupeKey: "k" });
    assert.ok(accepted, "a cleared log forgets the dedupe key");
  });

  it("counts a TTL gap between retained control events as missed", () => {
    const time = clock();
    const log = new EventLog({ now: time.now });
    log.push({ kind: "stop", title: "Stop" });
    log.push({ kind: "tab", phase: "opened", title: "Opened", tabId: "t1" });
    time.advance(EVENT_TTL_MS + 1);
    log.push({ kind: "document", phase: "replaced", title: "Replaced", tabId: "t1" });
    const result = log.read(0);
    assert.deepEqual(
      result.events.map((event) => event.id),
      [1, 3]
    );
    assert.equal(result.missed, 1);
  });

  it("hides browser observations while paused but keeps control events", () => {
    const log = new EventLog();
    log.push({ kind: "stop", title: "Stop" });
    log.push({ kind: "tab", phase: "opened", title: "Opened", tabId: "t1" });
    log.push({ kind: "dialog", phase: "shown", title: "Dialog shown" });
    log.push({ kind: "pause", title: "Pause" });
    const events = log.read(0).events;
    assert.deepEqual(
      filterPausedEvents(events, false).map((event) => event.kind),
      ["stop", "tab", "dialog", "pause"]
    );
    assert.deepEqual(
      filterPausedEvents(events, true).map((event) => event.kind),
      ["stop", "pause"]
    );
  });

  it("clamps a cursor ahead of the sequence", () => {
    const log = new EventLog();
    log.push({ kind: "stop", title: "Stop" });
    const result = log.read(10);
    assert.deepEqual(result.events, []);
    assert.equal(result.cursor, 1);
    assert.equal(result.missed, 0);
    assert.equal(result.lastEventAt, null);
  });
});

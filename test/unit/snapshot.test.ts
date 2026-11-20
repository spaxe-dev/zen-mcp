import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SNAPSHOT_DEFAULT_ELEMENTS,
  SNAPSHOT_MAX_ELEMENTS,
  SNAPSHOT_MAX_LIMITATIONS,
  clampSnapshotElements,
  snapshotCompleteness,
} from "../../src/shared/snapshot.js";

const base = {
  selectorUsed: false,
  relevantFrames: 0,
  scannedFrames: 0,
  failedFrames: 0,
  listedTruncated: false,
  listedSkipped: 0,
};

describe("snapshot control cap", () => {
  it("defaults to 100 and clamps to 1-200", () => {
    assert.equal(clampSnapshotElements(undefined), SNAPSHOT_DEFAULT_ELEMENTS);
    assert.equal(clampSnapshotElements(null), SNAPSHOT_DEFAULT_ELEMENTS);
    assert.equal(clampSnapshotElements(""), SNAPSHOT_DEFAULT_ELEMENTS);
    assert.equal(clampSnapshotElements("nope"), SNAPSHOT_DEFAULT_ELEMENTS);
    assert.equal(clampSnapshotElements(0), 1);
    assert.equal(clampSnapshotElements(-20), 1);
    assert.equal(clampSnapshotElements(17.9), 17);
    assert.equal(clampSnapshotElements(999), SNAPSHOT_MAX_ELEMENTS);
  });
});

describe("snapshot completeness", () => {
  it("is complete when every reachable frame was scanned", () => {
    const result = snapshotCompleteness({ ...base, relevantFrames: 3, scannedFrames: 3 });
    assert.equal(result.framesComplete, true);
    assert.equal(result.snapshotComplete, true);
    assert.deepEqual(result.limitations, []);
  });

  it("treats selector scope as complete but explains missing frames", () => {
    const result = snapshotCompleteness({
      ...base,
      selectorUsed: true,
      relevantFrames: 5,
    });
    assert.equal(result.framesComplete, true);
    assert.equal(result.snapshotComplete, true);
    assert.equal(result.limitations.length, 1);
    assert.match(result.limitations[0], /selector scoped/);
  });

  it("is incomplete when the frame listing was truncated", () => {
    const result = snapshotCompleteness({ ...base, listedTruncated: true });
    assert.equal(result.framesComplete, false);
    assert.equal(result.snapshotComplete, false);
    assert.match(result.limitations[0], /listing hit its cap/);
  });

  it("is incomplete when frames were skipped", () => {
    const result = snapshotCompleteness({ ...base, listedSkipped: 2 });
    assert.equal(result.framesComplete, false);
    assert.match(result.limitations[0], /2 child frame\(s\) were skipped/);
  });

  it("is incomplete when the scan cap left frames unscanned", () => {
    const result = snapshotCompleteness({
      ...base,
      relevantFrames: 12,
      scannedFrames: 10,
      scanCap: 10,
    });
    assert.equal(result.framesComplete, false);
    assert.match(result.limitations[0], /first 10 child frames/);
  });

  it("is incomplete when a frame read failed", () => {
    const result = snapshotCompleteness({
      ...base,
      relevantFrames: 1,
      scannedFrames: 1,
      failedFrames: 1,
    });
    assert.equal(result.framesComplete, false);
    assert.match(result.limitations[0], /1 child frame\(s\) could not be read/);
  });

  it("bounds the limitation list", () => {
    const result = snapshotCompleteness({
      ...base,
      relevantFrames: 20,
      scannedFrames: 0,
      failedFrames: 20,
      listedTruncated: true,
      listedSkipped: 4,
    });
    assert.equal(result.snapshotComplete, false);
    assert.ok(result.limitations.length <= SNAPSHOT_MAX_LIMITATIONS);
  });
});

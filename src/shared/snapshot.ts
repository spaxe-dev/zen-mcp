/** Fixed output caps for the snapshot read format. */
export const SNAPSHOT_TEXT_CHARS = 4_000;
export const SNAPSHOT_DEFAULT_ELEMENTS = 100;
export const SNAPSHOT_MAX_ELEMENTS = 200;
export const SNAPSHOT_MAX_HEADINGS = 80;
export const SNAPSHOT_HEADING_CHARS = 160;
export const SNAPSHOT_MAX_LIMITATIONS = 5;

/** Clamps a caller-supplied snapshot control cap to 1-200, defaulting to 100. */
export function clampSnapshotElements(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return SNAPSHOT_DEFAULT_ELEMENTS;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SNAPSHOT_DEFAULT_ELEMENTS;
  return Math.min(
    SNAPSHOT_MAX_ELEMENTS,
    Math.max(1, Math.floor(numeric))
  );
}

export interface SnapshotCompletenessInput {
  /** A selector scoped the snapshot to one subtree. */
  selectorUsed: boolean;
  /** Frames that were listed and whose path is inside the read target. */
  relevantFrames: number;
  /** Frames actually attempted, after the scan cap. */
  scannedFrames: number;
  /** Maximum frames the caller was willing to scan. */
  scanCap?: number;
  /** Frames that were attempted but could not be read. */
  failedFrames: number;
  /** The frame listing itself hit its cap. */
  listedTruncated: boolean;
  /** Frames omitted from the listing, such as non-http or unreadable ones. */
  listedSkipped: number;
}

export interface SnapshotCompletenessResult {
  framesComplete: boolean;
  snapshotComplete: boolean;
  limitations: string[];
}

/**
 * Separates collection completeness from output truncation. Text, element and
 * outline caps never make a snapshot incomplete; an unreadable or unlisted
 * frame does, because controls may exist there that were never seen.
 */
export function snapshotCompleteness(
  input: SnapshotCompletenessInput
): SnapshotCompletenessResult {
  if (input.selectorUsed) {
    return {
      framesComplete: true,
      snapshotComplete: true,
      limitations: [
        "Frame controls were not included because selector scoped the snapshot " +
          "to one subtree.",
      ],
    };
  }

  const limitations: string[] = [];
  if (input.listedTruncated) {
    limitations.push(
      "The child-frame listing hit its cap; controls in unlisted frames were " +
        "not scanned."
    );
  }
  if (input.listedSkipped > 0) {
    limitations.push(
      `${input.listedSkipped} child frame(s) were skipped because they were ` +
        "not http(s) or could not be inspected; their controls are absent."
    );
  }
  const scanCap = input.scanCap ?? 10;
  if (input.relevantFrames > input.scannedFrames && input.relevantFrames > 0) {
    limitations.push(
      `Only the first ${scanCap} child frames were scanned; controls in ` +
        `${input.relevantFrames - input.scannedFrames} deeper frame(s) are absent.`
    );
  }
  if (input.failedFrames > 0) {
    limitations.push(
      `${input.failedFrames} child frame(s) could not be read; their controls ` +
        "are absent."
    );
  }

  const framesComplete = limitations.length === 0;
  return {
    framesComplete,
    snapshotComplete: framesComplete,
    limitations: limitations.slice(0, SNAPSHOT_MAX_LIMITATIONS),
  };
}

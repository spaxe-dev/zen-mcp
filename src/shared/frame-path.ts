/**
 * Frame targeting shared by reads and page actions. Ref paths use the same
 * child indexes as the framePath read option: "f0-e3" is the third control in
 * the first child frame, "f0.1-e2" the second control in its second child.
 */
export const MAX_FRAME_DEPTH = 3;

const ACTION_REF_PATTERN = /^(?:f([0-9]+(?:\.[0-9]+){0,2})-)?(e[0-9]{1,4})$/;

export function parseFrameRef(
  value: string
): { path: number[]; ref: string } | null {
  if (typeof value !== "string") return null;
  const match = ACTION_REF_PATTERN.exec(value);
  if (!match) return null;
  const path = match[1] ? match[1].split(".").map(Number) : [];
  if (path.length > MAX_FRAME_DEPTH) return null;
  return { path, ref: match[2] };
}

export function frameRefPrefix(path: number[]): string {
  return path.length ? `f${path.join(".")}-` : "";
}

/** Returns null when the path is malformed, [] for the top document. */
export function normalizeFramePath(value: unknown): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_FRAME_DEPTH) return null;
  const path: number[] = [];
  for (const entry of value) {
    const index = Number(entry);
    if (!Number.isInteger(index) || index < 0) return null;
    path.push(index);
  }
  return path;
}

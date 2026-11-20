/**
 * Target normalization shared by every page interaction. A target names one
 * control in exactly one way: a read ref, an accessibility pair, visible text,
 * an associated label, a placeholder, or a CSS selector.
 */
export const TARGET_REF_CHARS = 20;
export const TARGET_ROLE_CHARS = 200;
export const TARGET_NAME_CHARS = 200;
export const TARGET_TEXT_CHARS = 500;
export const TARGET_LABEL_CHARS = 200;
export const TARGET_PLACEHOLDER_CHARS = 200;
export const TARGET_SELECTOR_CHARS = 500;
export const TARGET_MAX_CANDIDATES = 5;

export type TargetMatchMode = "exact" | "contains";

export interface PageTargetSpec {
  /** Ref from a snapshot or interactive read, such as "e12". */
  ref?: string;
  /** ARIA role, or the bridge's pragmatic tag mapping. */
  role?: string;
  /** Accessible name; required with role. */
  name?: string;
  /** Visible element text. */
  text?: string;
  /** Associated label or aria-labelledby text. */
  label?: string;
  /** Placeholder attribute. */
  placeholder?: string;
  /** CSS selector in the document light DOM. */
  selector?: string;
  /** Exact (default) or contains matching for semantic text fields. */
  match?: TargetMatchMode;
}

export type NormalizedTarget =
  | { kind: "ref"; ref: string; legacy: boolean }
  | { kind: "selector"; selector: string; legacy: boolean }
  | {
      kind: "role";
      role: string;
      name: string;
      match: TargetMatchMode;
      legacy: false;
    }
  | { kind: "text"; text: string; match: TargetMatchMode; legacy: false }
  | { kind: "label"; label: string; legacy: false }
  | { kind: "placeholder"; placeholder: string; legacy: false };

export interface TargetInput {
  ref?: string;
  selector?: string;
  target?: PageTargetSpec;
}

export class TargetInputError extends Error {
  readonly code = "invalid_target";
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TargetInputError";
    this.details = details;
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
}

function bounded(
  value: string,
  field: string,
  max: number
): string {
  if (value.length > max) {
    throw new TargetInputError(
      `${field} must be ${max} characters or fewer.`,
      { field, limit: max, length: value.length }
    );
  }
  return value;
}

/**
 * Accepts either the legacy top-level ref/selector or the additive target
 * object. Mixing them is always an error; a target names exactly one strategy.
 */
export function normalizeTargetInput(input: TargetInput): NormalizedTarget {
  const topRef = trimmed(input?.ref);
  const topSelector = trimmed(input?.selector);
  const target = input?.target;

  if (target !== undefined && target !== null) {
    if (topRef || topSelector) {
      throw new TargetInputError(
        "Provide target or a top-level ref/selector, not both."
      );
    }
    if (typeof target !== "object" || Array.isArray(target)) {
      throw new TargetInputError("target must be an object.");
    }
    return normalizeTargetObject(target);
  }

  if (!topRef === !topSelector) {
    throw new TargetInputError("Provide exactly one of ref or selector.");
  }
  if (topRef) {
    bounded(topRef, "ref", TARGET_REF_CHARS);
    return { kind: "ref", ref: topRef, legacy: true };
  }
  bounded(topSelector, "selector", TARGET_SELECTOR_CHARS);
  return { kind: "selector", selector: topSelector, legacy: true };
}

function normalizeTargetObject(target: PageTargetSpec): NormalizedTarget {
  const ref = trimmed(target.ref);
  const role = clean(target.role);
  const name = clean(target.name);
  const text = clean(target.text);
  const label = clean(target.label);
  const placeholder = clean(target.placeholder);
  const selector = trimmed(target.selector);
  const match = target.match;
  if (match !== undefined && match !== "exact" && match !== "contains") {
    throw new TargetInputError('match must be "exact" or "contains".');
  }

  const forms = [
    ref ? "ref" : "",
    role || name ? "role" : "",
    text ? "text" : "",
    label ? "label" : "",
    placeholder ? "placeholder" : "",
    selector ? "selector" : "",
  ].filter(Boolean);
  if (forms.length !== 1) {
    throw new TargetInputError(
      "target must contain exactly one of ref, role+name, text, label, " +
        "placeholder, or selector.",
      { forms }
    );
  }

  if (ref) {
    if (match !== undefined) {
      throw new TargetInputError("match applies only to role+name or text.");
    }
    bounded(ref, "target.ref", TARGET_REF_CHARS);
    return { kind: "ref", ref, legacy: false };
  }

  if (role || name) {
    if (!role || !name) {
      throw new TargetInputError(
        "role and name must be provided together."
      );
    }
    bounded(role, "target.role", TARGET_ROLE_CHARS);
    bounded(name, "target.name", TARGET_NAME_CHARS);
    return {
      kind: "role",
      role: role.toLowerCase(),
      name,
      match: match ?? "exact",
      legacy: false,
    };
  }

  if (text) {
    bounded(text, "target.text", TARGET_TEXT_CHARS);
    return {
      kind: "text",
      text,
      match: match ?? "exact",
      legacy: false,
    };
  }

  if (label) {
    if (match !== undefined) {
      throw new TargetInputError("match applies only to role+name or text.");
    }
    bounded(label, "target.label", TARGET_LABEL_CHARS);
    return { kind: "label", label, legacy: false };
  }

  if (placeholder) {
    if (match !== undefined) {
      throw new TargetInputError("match applies only to role+name or text.");
    }
    bounded(placeholder, "target.placeholder", TARGET_PLACEHOLDER_CHARS);
    return { kind: "placeholder", placeholder, legacy: false };
  }

  if (match !== undefined) {
    throw new TargetInputError("match applies only to role+name or text.");
  }
  bounded(selector, "target.selector", TARGET_SELECTOR_CHARS);
  return { kind: "selector", selector, legacy: false };
}

/** Normalizes an accessible name, visible text, or label for comparison. */
export function normalizeTargetText(value: unknown): string {
  return clean(value).toLowerCase();
}

export function targetTextMatches(
  candidate: unknown,
  wanted: string,
  mode: TargetMatchMode
): boolean {
  const haystack = normalizeTargetText(candidate);
  const needle = normalizeTargetText(wanted);
  if (!needle) return false;
  return mode === "contains"
    ? haystack.includes(needle)
    : haystack === needle;
}

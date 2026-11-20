/**
 * Stable structured metadata attached to MCP error results. The text block
 * keeps the historical "message (code)" form; this adds recovery guidance
 * without changing any public code.
 */
export type ErrorCategory =
  | "not_found"
  | "stale_reference"
  | "document_changed"
  | "ambiguous"
  | "not_actionable"
  | "invalid_target"
  | "unsupported"
  | "permission"
  | "browser"
  | "action_failed"
  | "internal";

export interface ErrorMetadata {
  category: ErrorCategory;
  retryable: boolean;
  stateChanged: boolean | null;
  recovery: string;
}

const CATEGORIES = new Set<ErrorCategory>([
  "not_found",
  "stale_reference",
  "document_changed",
  "ambiguous",
  "not_actionable",
  "invalid_target",
  "unsupported",
  "permission",
  "browser",
  "action_failed",
  "internal",
]);

function categoryFromDetails(
  details: Record<string, unknown> | undefined
): ErrorCategory | null {
  const value = details?.category;
  return typeof value === "string" && CATEGORIES.has(value as ErrorCategory)
    ? (value as ErrorCategory)
    : null;
}

export function errorMetadata(
  code: string,
  details?: Record<string, unknown>
): ErrorMetadata {
  const override = categoryFromDetails(details);
  switch (code) {
    case "element_not_found":
      return {
        category: override ?? "not_found",
        retryable: true,
        stateChanged: false,
        recovery: "Read the page again or refine the target.",
      };
    case "stale_reference":
      return {
        category: "stale_reference",
        retryable: false,
        stateChanged: false,
        recovery:
          'Call zen_read_page with format="snapshot" and use a new ref.',
      };
    case "document_changed":
      return {
        category: "document_changed",
        retryable: false,
        stateChanged: false,
        recovery:
          'The document navigated. Call zen_read_page again and use a new ref.',
      };
    case "target_not_found":
      return {
        category: "not_found",
        retryable: true,
        stateChanged: false,
        recovery: "Wait for the content or refine the target.",
      };
    case "target_ambiguous":
      return {
        category: "ambiguous",
        retryable: false,
        stateChanged: false,
        recovery: "Use a ref or a more specific target.",
      };
    case "target_not_actionable":
    case "element_disabled":
    case "element_readonly":
    case "unsupported_target":
      return {
        category: "not_actionable",
        retryable: false,
        stateChanged: false,
        recovery: "Inspect the element's state or wait for it to change.",
      };
    case "invalid_target":
      return {
        category: "invalid_target",
        retryable: false,
        stateChanged: false,
        recovery:
          "Use exactly one target: ref, role+name, text, label, placeholder, " +
          "or selector.",
      };
    case "unsupported_operation":
      return {
        category: "unsupported",
        retryable: false,
        stateChanged: false,
        recovery: "Use a snapshot ref or a narrower selector.",
      };
    case "read_only":
    case "domain_not_allowed":
    case "paused":
    case "cancelled":
      return {
        category: "permission",
        retryable: false,
        stateChanged: false,
        recovery: "Adjust policy or ask the user before retrying.",
      };
    case "browser_disconnected":
    case "bridge_unavailable":
    case "bridge_timeout":
    case "tab_not_found":
    case "tab_not_loaded":
    case "actor_unavailable":
      return {
        category: "browser",
        retryable: false,
        stateChanged: false,
        recovery: "Check zen_status; relaunch if the browser session is gone.",
      };
    case "click_failed":
    case "type_failed":
      return {
        category: "action_failed",
        retryable: false,
        stateChanged: null,
        recovery: "Inspect the page state before retrying the action.",
      };
    default:
      return {
        category: override ?? "internal",
        retryable: false,
        stateChanged: null,
        recovery: "Inspect the error message before retrying.",
      };
  }
}

/**
 * Identity of the top-level document in a tab.
 *
 * `innerWindowId` changes with every new document, including same-site
 * navigations, and is readable from chrome for both local and remote frames.
 * It is deliberately opaque to agents; they only compare it for equality.
 *
 * A navigation that swaps content processes exposes the new process's initial
 * about:blank as `currentWindowGlobal` before the real document commits. That
 * placeholder is not the page, and its id is replaced moments later, so it is
 * reported as no identity. Otherwise a `document_changed` wait can resolve to
 * a placeholder that no later observation can ever match.
 */
export function documentIdForTab(
  tab:
    | {
        linkedBrowser?: {
          browsingContext?: {
            currentWindowGlobal?: {
              innerWindowId?: unknown;
              isInitialDocument?: unknown;
            } | null;
          } | null;
        } | null;
      }
    | null
    | undefined
): string {
  try {
    const global: any =
      tab?.linkedBrowser?.browsingContext?.currentWindowGlobal;
    if (global?.isInitialDocument === true) return "";
    const id = global?.innerWindowId;
    return typeof id === "number" && Number.isFinite(id) ? `doc-${id}` : "";
  } catch {
    return "";
  }
}

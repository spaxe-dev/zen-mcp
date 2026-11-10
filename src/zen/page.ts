import type { BridgeHub } from "../bridge/host.js";
import type { PageReadResult, ReadFormat } from "../shared/protocol.js";

const MIN_CHARS = 500;
const MAX_CHARS = 60_000;
const DEFAULT_CHARS = 24_000;

export interface PageReadOptions {
  windowId?: string;
  maxChars?: number;
  /** Character offset into the text or markdown stream. */
  offset?: number;
  /** Read this tab instead of the active one, without selecting it. */
  tabId?: string;
  format?: ReadFormat;
  selector?: string;
  /** Child-frame indexes to read instead of the top document. */
  framePath?: number[];
  /** Client cancellation for the underlying bridge request. */
  signal?: AbortSignal;
}

function clampMaxChars(value: number | undefined): number {
  return Math.max(MIN_CHARS, Math.min(MAX_CHARS, value ?? DEFAULT_CHARS));
}

/**
 * Reads the page the user is currently looking at, without changing the tab
 * selection or focusing the window.
 *
 * The authenticated bridge is the only read path. It never attaches to private
 * windows and only reads http(s) pages, so a Marionette content script cannot
 * reach a page the bridge would not expose.
 */
export async function readActivePage(
  hub: BridgeHub,
  options: PageReadOptions = {}
): Promise<PageReadResult> {
  const status = await hub.status(options.windowId);
  const active = status.activeTab;
  if (!active?.id) {
    throw new Error("There is no active tab to read");
  }
  return hub.readTab(
    {
      tabId: active.id,
      maxChars: clampMaxChars(options.maxChars),
      offset: options.offset,
      format: options.format,
      selector: options.selector,
      framePath: options.framePath,
    },
    options.windowId,
    { signal: options.signal }
  );
}

/**
 * Reads one specific tab without selecting it. This is what makes background
 * research non-disruptive: the agent can read every tab it opened in another
 * space while the user stays on their current page.
 */
export async function readTabPage(
  hub: BridgeHub,
  tabId: string,
  options: PageReadOptions = {}
): Promise<PageReadResult> {
  if (!tabId) throw new Error("tabId is required");
  return hub.readTab(
    {
      tabId,
      maxChars: clampMaxChars(options.maxChars),
      offset: options.offset,
      format: options.format,
      selector: options.selector,
      framePath: options.framePath,
    },
    options.windowId,
    { signal: options.signal }
  );
}

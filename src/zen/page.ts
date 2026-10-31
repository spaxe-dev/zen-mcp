import {
  BridgeRequestError,
  BridgeUnavailableError,
  type BridgeHub,
} from "../bridge/host.js";
import type { PageReadResult } from "../shared/protocol.js";
import {
  buildReadScript,
  coercePageSnapshot,
  toPageReadResult,
  type PageSnapshot,
} from "../shared/read-script.js";
import { createLogger } from "../utils/logger.js";
import type { MarionetteClient } from "./marionette.js";

const logger = createLogger("page");
const MIN_CHARS = 500;
const MAX_CHARS = 60_000;
const DEFAULT_CHARS = 24_000;

export interface PageReadOptions {
  windowId?: string;
  maxChars?: number;
  /** Read this tab instead of the active one, without selecting it. */
  tabId?: string;
}

/** Page reads share one Marionette context, so serialize them. */
let readQueue: Promise<unknown> = Promise.resolve();

function serializeRead<T>(operation: () => Promise<T>): Promise<T> {
  const result = readQueue.then(operation, operation);
  readQueue = result.catch(() => undefined);
  return result;
}

function clampMaxChars(value: number | undefined): number {
  return Math.max(MIN_CHARS, Math.min(MAX_CHARS, value ?? DEFAULT_CHARS));
}

/**
 * Reads the page the user is currently looking at, without changing the tab
 * selection or focusing the window.
 *
 * The bridge reads through the browser's Marionette content actor, which can
 * reach any loaded tab. When that is unavailable we fall back to switching
 * Marionette's content context to the handle whose URL matches the active tab.
 */
export function readActivePage(
  marionette: MarionetteClient,
  hub: BridgeHub,
  options: PageReadOptions = {}
): Promise<PageReadResult> {
  return serializeRead(() => readActivePageNow(marionette, hub, options));
}

async function readActivePageNow(
  marionette: MarionetteClient,
  hub: BridgeHub,
  options: PageReadOptions
): Promise<PageReadResult> {
  const status = await hub.status(options.windowId);
  const active = status.activeTab;
  if (!active) {
    throw new Error("There is no active tab to read");
  }

  const maxChars = clampMaxChars(options.maxChars);

  if (active.id) {
    try {
      return await hub.readTab(
        { tabId: active.id, maxChars },
        options.windowId
      );
    } catch (error) {
      if (!shouldTryContentHandles(error)) throw error;
      logger.debug(
        `bridge read of the active tab failed (${errorMessage(error)}); ` +
          "trying content handles"
      );
    }
  }

  // GetWindowHandles must be issued while the session is in chrome context.
  await marionette.setContext("chrome");
  const windowHandles = await marionette.getWindowHandles();
  if (!windowHandles.length) {
    throw new Error("Marionette did not report any windows to read from");
  }

  const script = buildReadScript(maxChars);
  const failures: string[] = [];

  for (const handle of windowHandles) {
    try {
      const page = coercePageSnapshot(
        await marionette.executeInContent<unknown>(handle, script, {
          timeoutMs: 10_000,
        })
      );
      if (!page) continue;
      if (samePage(page.url, active.url)) {
        return toPageReadResult(page, maxChars);
      }
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  const detail = failures.length ? ` (${failures[0]})` : "";
  throw new Error(
    `Could not read the active tab (${active.url}). It may be a privileged page, ` +
      `a PDF viewer, or still loading${detail}.`
  );
}

/**
 * Reads one specific tab without selecting it. This is what makes background
 * research non-disruptive: the agent can read every tab it opened in another
 * space while the user stays on their current page.
 */
export function readTabPage(
  marionette: MarionetteClient,
  hub: BridgeHub,
  tabId: string,
  options: PageReadOptions = {}
): Promise<PageReadResult> {
  return serializeRead(() => readTabPageNow(marionette, hub, tabId, options));
}

async function readTabPageNow(
  marionette: MarionetteClient,
  hub: BridgeHub,
  tabId: string,
  options: PageReadOptions
): Promise<PageReadResult> {
  if (!tabId) throw new Error("tabId is required");

  const maxChars = clampMaxChars(options.maxChars);
  let bridgeFailure = "";

  try {
    return await hub.readTab({ tabId, maxChars }, options.windowId);
  } catch (error) {
    if (!shouldTryContentHandles(error)) throw error;
    bridgeFailure = ` Bridge read failed: ${errorMessage(error)}.`;
    logger.debug(
      `bridge read for tab ${tabId} failed (${errorMessage(error)}); ` +
        "trying content handles"
    );
  }

  const listing = await hub.listTabs({ limit: 2_000 }, options.windowId);
  const target = listing.tabs.find((tab) => tab.id === tabId);
  if (!target) {
    throw new Error(
      `No open tab matches id "${tabId}". Tab ids change when a tab closes; ` +
        "call zen_tabs_list again for current ids."
    );
  }
  if (!target.url) {
    throw new Error(`Tab "${target.title}" has no URL to read yet`);
  }

  const script = buildReadScript(maxChars);

  await marionette.setContext("content");
  const handles = await marionette.getWindowHandles();
  await marionette.setContext("chrome");
  if (!handles.length) {
    throw new Error("Marionette did not report any windows to read from");
  }

  let titleMatch: PageSnapshot | null = null;
  const failures: string[] = [];

  for (const handle of handles) {
    try {
      const page = coercePageSnapshot(
        await marionette.executeInContent<unknown>(handle, script, {
          timeoutMs: 10_000,
        })
      );
      if (!page) continue;
      if (samePage(page.url, target.url)) {
        return toPageReadResult(page, maxChars);
      }
      if (!titleMatch && page.title && page.title === target.title) {
        titleMatch = page;
      }
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  if (titleMatch) {
    logger.debug(
      `tab ${tabId} URL moved from ${target.url}; matched its title ${target.title}`
    );
    return toPageReadResult(titleMatch, maxChars);
  }

  const detail = failures.length ? ` (${failures[0]})` : "";
  throw new Error(
    `Could not read tab "${target.title}" (${target.url}). It may be a ` +
      `privileged page, a PDF viewer, or still loading${detail}.${bridgeFailure}`
  );
}

/**
 * Only fall back to Marionette content handles when the bridge could not read
 * the tab for an environmental reason. A missing tab id is definitive.
 */
function shouldTryContentHandles(error: unknown): boolean {
  if (error instanceof BridgeRequestError) {
    return error.code !== "tab_not_found" && error.code !== "no_tab";
  }
  return error instanceof BridgeUnavailableError;
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function samePage(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.protocol === right.protocol &&
      left.host === right.host &&
      left.pathname === right.pathname &&
      left.search === right.search
    );
  } catch {
    return false;
  }
}

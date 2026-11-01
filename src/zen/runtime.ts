import { createHash, randomUUID } from "node:crypto";
import {
  BridgeHub,
  BridgeRequestError,
  BridgeUnavailableError,
  type AskOptions,
  type InjectionSummary,
  type NotifyOptions,
  type ProgressOptions,
  type ProgressResult,
} from "../bridge/host.js";
import type { ZenMcpConfig } from "../config.js";
import type {
  AnswersResult,
  AskResult,
  BatchReadEntry,
  BatchReadResult,
  BridgeMethod,
  BridgeMethodMap,
  BridgeStatus,
  EvidenceBatchOptions,
  EvidenceBatchResult,
  EvidenceCitation,
  EvidenceClearOutcome,
  EvidenceErrorCode,
  EvidenceFailure,
  EvidenceOpResult,
  EvidenceShowResult,
  EventsResult,
  PageReadResult,
  ReadFormat,
  SearchTabsEntry,
  SearchTabsResult,
  TabInfo,
  TextSearchResult,
  UiConsent,
  UiOption,
  WatchInfo,
  WatchParams,
} from "../shared/protocol.js";
import { hostOf, isUrlAllowed } from "../shared/url-policy.js";
import { createLogger, type Logger } from "../utils/logger.js";
import {
  isPortOpen,
  launchZen,
  resolvedProfilePath,
  terminateZenProcess,
  waitForProcessExit,
  ZenLaunchError,
} from "./launcher.js";
import { MarionetteClient } from "./marionette.js";
import { readActivePage, readTabPage } from "./page.js";

const MAX_WATCH_SAMPLE_CHARS = 60_000;
const MAX_WATCHES = 50;
const MAX_BATCH_READ = 10;
const BATCH_CONCURRENCY = 3;
const AUTO_ATTACH_MS = 20_000;
const SEARCH_TABS_CONCURRENCY = 2;
const SEARCH_TAB_TIMEOUT_MS = 12_000;
const MAX_SEARCH_TOTAL_MATCHES = 200;
const MAX_EVIDENCE_BATCH = 20;
const MAX_BATCH_CONCURRENCY = 3;
const MAX_QUOTES_PER_SOURCE = 5;
const MAX_BATCH_CARD_FAILURES = 3;

export interface ConnectResult {
  launched: boolean;
  injection: InjectionSummary;
}

export interface ZenRuntimeOptions {
  config: ZenMcpConfig;
  bridgeScriptPath?: string;
  logger?: Logger;
}

export class ZenAccessError extends Error {
  override name = "ZenAccessError";
}

interface Ownership {
  nonce: string;
  launchedPid: number;
  browserPid: number | null;
  profile: string | null;
  launchedAt: number;
}

export interface SessionInfo {
  ownsBrowser: boolean;
  browserPid: number | null;
  profile: string | null;
  launchedAt: number | null;
  lockedDown: boolean;
  paused: boolean;
  consent: "none" | "pending" | "granted" | "denied";
}

export interface ShowEvidenceOptions {
  url: string;
  quote: string;
  claim?: string;
  context?: string;
  sourceTitle?: string;
  tabId?: string;
  minConfidence?: number;
  highlightMs?: number;
  /** Bring the source tab and window to the front. Defaults to false. */
  focus?: boolean;
  signal?: AbortSignal;
}

export interface ShowEvidenceBatchOptions extends EvidenceBatchOptions {
  signal?: AbortSignal;
  /** Called once per finished citation, including failures. */
  onProgress?: (completed: number, total: number) => void;
}

export interface ClearEvidenceOptions {
  tabId?: string;
}

export interface FindTextOptions {
  tabId: string;
  query: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextChars?: number;
}

export interface SearchTabsOptions {
  query: string;
  space?: string;
  tabIds?: string[];
  maxTabs?: number;
  maxMatchesPerTab?: number;
  contextChars?: number;
  caseSensitive?: boolean;
}

interface EvidenceTarget {
  windowId: string;
  updatedAt: number;
}

interface WatchRuntime {
  info: WatchInfo;
  timer: NodeJS.Timeout | null;
  running: boolean;
  previousText: string | null;
  previousHash: string;
  previousFound: boolean;
  notify: boolean;
  windowId?: string;
}

export class ZenRuntime {
  readonly config: ZenMcpConfig;
  readonly marionette: MarionetteClient;
  readonly hub: BridgeHub;
  readonly #logger: Logger;

  #ensurePromise: Promise<ConnectResult> | null = null;
  #closed = false;
  #ownership: Ownership | null = null;
  #identityVerified = false;
  #lockedDown = false;
  #autoAttachTimer: NodeJS.Timeout | null = null;
  #autoAttaching = false;
  readonly #watches = new Map<string, WatchRuntime>();
  #watchReservations = 0;
  readonly #evidenceTargets = new Map<string, EvidenceTarget>();

  constructor(options: ZenRuntimeOptions) {
    this.config = options.config;
    this.#logger = options.logger ?? createLogger("runtime");
    this.marionette = new MarionetteClient({
      port: options.config.marionettePort,
      logger: this.#logger,
    });
    this.hub = new BridgeHub({
      marionette: this.marionette,
      bridgeScriptPath: options.bridgeScriptPath,
      logger: this.#logger,
      allowedDomains: options.config.allowedDomains,
    });
  }

  async start(): Promise<void> {
    await this.hub.start();
  }

  /**
   * Makes sure Zen is running with agent access, a Marionette session exists
   * and at least one browser window has the Zen MCP bridge attached.
   */
  connect(options: { allowLaunch?: boolean } = {}): Promise<ConnectResult> {
    if (this.#closed) {
      return Promise.reject(new Error("Zen MCP has shut down"));
    }
    if (!this.#ensurePromise) {
      // Read-only mode must not spawn a browser or create a profile as a side
      // effect of a read. zen_launch is blocked there and explicit callers
      // (the CLI) still pass allowLaunch.
      const allowLaunch =
        options.allowLaunch ??
        (!this.config.readOnly && this.config.autoLaunch);
      this.#ensurePromise = this.#connectOnce(allowLaunch).finally(() => {
        this.#ensurePromise = null;
      });
    }
    return this.#ensurePromise;
  }

  get paused(): boolean {
    return this.hub.paused;
  }

  sessionInfo(): SessionInfo {
    return {
      ownsBrowser: this.#ownership !== null,
      browserPid: this.#ownership?.browserPid ?? null,
      profile: this.#ownership?.profile ?? null,
      launchedAt: this.#ownership?.launchedAt ?? null,
      lockedDown: this.#lockedDown,
      paused: this.hub.paused,
      consent: this.hub.consentState,
    };
  }

  async #connectOnce(allowLaunch: boolean): Promise<ConnectResult> {
    await this.hub.start();
    let launched = false;

    if (!this.marionette.isConnected) {
      if (this.#ownership) {
        // The loopback socket is gone and lockdown closed the listener, so this
        // browser can never be re-attached. It is safe to leave open because no
        // remote session exists; it is the user's browser to close.
        this.#logger.warn(
          "the Marionette session for the owned browser was lost"
        );
        this.#ownership = null;
        this.#lockedDown = false;
        await this.marionette.disconnect().catch(() => undefined);
        throw new ZenLaunchError(
          "Zen MCP lost its Marionette session with the browser it started. " +
            "Agent access is already closed, but this server cannot re-attach " +
            "because the port stays shut. Quit that Zen window and call " +
            "zen_launch again."
        );
      }

      if (await isPortOpen(this.config.marionettePort)) {
        throw new ZenLaunchError(
          `Marionette is listening on port ${this.config.marionettePort}, but ` +
            "Zen MCP only controls a browser it launched itself. It does not " +
            "attach to an existing session. Quit that Zen instance (or stop the " +
            "tool using the port) and try again."
        );
      }
      if (!allowLaunch) {
        throw new ZenLaunchError(
          "Zen is not running. Zen MCP launches its own browser with agent " +
            "access, so start it with zen_launch or keep the zen-mcp MCP " +
            "server running."
        );
      }
      await this.#launchOwnedBrowser();
      launched = true;
    }

    let injection: InjectionSummary;
    try {
      injection = await this.hub.ensureInjected({
        force: launched,
        waitMs: 30_000,
      });
      if (this.hub.connectionCount === 0) {
        const detail = injection.errors.length
          ? ` Last error: ${injection.errors[0]}`
          : "";
        throw new BridgeUnavailableError(
          "Zen is running, but the agent bridge could not attach to a browser " +
            `window.${detail} Run \`zen-mcp doctor\` for details.`
        );
      }
    } catch (error) {
      await this.#closeOwnedBrowser("the agent bridge could not attach");
      throw error;
    }

    await this.#ensureConsent();
    this.#startAutoAttach();
    return { launched, injection };
  }

  /**
   * Launches a browser, proves through the launch nonce that it is the one on
   * the Marionette port, then closes every other connection and the listener.
   */
  async #launchOwnedBrowser(): Promise<void> {
    const result = await launchZen({ config: this.config, wait: false });
    const ownership: Ownership = {
      nonce: result.nonce,
      launchedPid: result.pid,
      browserPid: null,
      profile: resolvedProfilePath(this.config),
      launchedAt: Date.now(),
    };
    this.#ownership = ownership;

    try {
      await this.#connectOwnedSession(ownership);
    } catch (error) {
      if (this.#ownership === ownership) {
        await this.#closeOwnedBrowser("startup failed");
      }
      if (error instanceof ZenLaunchError) throw error;
      throw new ZenLaunchError(
        `Zen started, but Zen MCP could not take ownership of it: ${errorText(
          error
        )}`
      );
    }
  }

  async #connectOwnedSession(ownership: Ownership): Promise<void> {
    const deadline = Date.now() + this.config.launchTimeoutMs;
    let lastError: unknown = null;
    for (;;) {
      try {
        await this.marionette.connect();
        break;
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) {
          throw new ZenLaunchError(
            `Zen started, but Marionette did not accept a session within ` +
              `${Math.round(this.config.launchTimeoutMs / 1000)}s: ${errorText(
                lastError
              )}`
          );
        }
        await sleep(250);
      }
    }

    let nonce: string | null = null;
    try {
      nonce = await this.marionette.executeChrome<string | null>(
        'return Services.env.get("ZEN_MCP_LAUNCH_NONCE") ?? null;',
        { timeoutMs: 10_000 }
      );
    } catch (error) {
      throw new ZenLaunchError(
        `Zen accepted a Marionette session, but its identity could not be ` +
          `read: ${errorText(error)}`
      );
    }
    if (!nonce || nonce !== ownership.nonce) {
      // Do not record the connected pid: it may belong to another browser.
      throw new ZenLaunchError(
        "The browser answering on the Marionette port was not the one Zen MCP " +
          "just started, so it was not attached. Another process may be racing " +
          "for the same port. Quit Zen and try again."
      );
    }

    ownership.browserPid = this.marionette.browserProcessId;
    this.#identityVerified = true;

    try {
      await this.marionette.lockdown();
    } catch (error) {
      throw new ZenLaunchError(
        "Zen was started by Zen MCP, but the Marionette port could not be " +
          `locked down, so agent access was closed: ${errorText(error)}`
      );
    }
    this.#lockedDown = true;
    this.#logger.info(
      `took exclusive control of Zen${
        ownership.browserPid ? ` (pid ${ownership.browserPid})` : ""
      }`
    );
  }

  /**
   * Shows the approval card. A denial closes the browser. A timeout keeps the
   * card visible and lets a later tool call wait again.
   */
  async #ensureConsent(): Promise<void> {
    this.hub.configureActiveBanner({
      text: "Zen MCP is connected",
      detail: "Press Pause to block reads and changes immediately.",
    });

    if (
      this.hub.consentState === "granted" ||
      !this.config.requireConsent
    ) {
      this.hub.grantAccess();
      return;
    }

    const profile = resolvedProfilePath(this.config);
    const consent: UiConsent = {
      id: `c-${randomUUID().slice(0, 8)}`,
      title: "Let Zen MCP control Zen?",
      detail: [
        "This MCP session can read tabs, open pages and organize spaces when you ask it to.",
        profile
          ? "It runs in a separate agent profile, so your normal browsing profile stays isolated."
          : "It uses your normal Zen profile, so it can see pages where you are signed in.",
        "Only this session can connect: the Marionette port is already closed to everything else. Press Pause in the banner at any time.",
      ].join("\n\n"),
      allowLabel: "Allow this session",
      denyLabel: "Not now",
    };
    const timeoutSeconds = Math.max(1, this.config.consentTimeoutSeconds);
    const outcome = await this.hub.requestConsent({
      consent,
      timeoutMs: timeoutSeconds * 1000,
    });

    if (outcome === "granted") {
      this.hub.grantAccess();
      return;
    }
    if (outcome === "denied") {
      await this.#closeOwnedBrowser("access was declined in the browser");
      throw new ZenAccessError(
        "Browser access was declined in Zen. The browser Zen MCP started was " +
          "closed. Call zen_launch to ask again."
      );
    }
    throw new ZenAccessError(
      `Zen MCP is waiting for approval in Zen. Approve the card in the browser ` +
        `within ${timeoutSeconds}s, then call the tool again.`
    );
  }

  /**
   * Quits the browser this server started. When identity was never verified,
   * only the spawned launcher is touched, never whatever owns the port.
   */
  async #closeOwnedBrowser(reason: string): Promise<void> {
    const ownership = this.#ownership;
    const verified = this.#identityVerified;
    const browserPid =
      (verified ? this.marionette.browserProcessId : null) ??
      ownership?.browserPid ??
      null;

    this.#ownership = null;
    this.#identityVerified = false;
    this.#lockedDown = false;

    try {
      if (this.marionette.isConnected) {
        if (verified) {
          await this.marionette.quit().catch(() => undefined);
          if (await waitForProcessExit(browserPid, 2_500)) return;
          await this.marionette.quit({ force: true }).catch(() => undefined);
          if (await waitForProcessExit(browserPid, 2_000)) return;
        }
        await this.marionette.disconnect().catch(() => undefined);
      }
      const pid = browserPid ?? ownership?.launchedPid ?? null;
      if (pid) {
        terminateZenProcess(pid);
        await waitForProcessExit(pid, 3_000);
      }
    } catch {
      // Best effort; the browser is already gone or unreachable.
    } finally {
      await this.marionette.disconnect().catch(() => undefined);
    }
    if (reason) {
      this.#logger.debug(`closed the agent browser (${reason})`);
    }
  }

  /**
   * New Zen windows do not have the bridge until it is injected there. Tool
   * calls already re-inject on demand, but a light timer also attaches while
   * the agent is idle so a second window works immediately.
   */
  #startAutoAttach(): void {
    if (this.#autoAttachTimer || !this.config.autoAttachWindows) {
      return;
    }
    this.#autoAttachTimer = setInterval(() => {
      if (this.#closed || this.#autoAttaching || this.hub.busy) return;
      this.#autoAttaching = true;
      this.hub
        .ensureInjected({ force: true, waitMs: 6_000 })
        .catch((error) => {
          this.#logger.debug(
            `auto-attach failed: ${(error as Error)?.message ?? error}`
          );
        })
        .finally(() => {
          this.#autoAttaching = false;
        });
    }, AUTO_ATTACH_MS);
    this.#autoAttachTimer.unref?.();
  }

  async request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options: {
      windowId?: string;
      timeoutMs?: number;
      allowLaunch?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<BridgeMethodMap[T]["result"]> {
    await this.connect({ allowLaunch: options.allowLaunch });
    return this.hub.request(method, params, {
      windowId: options.windowId,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  async status(windowId?: string): Promise<BridgeStatus> {
    await this.connect();
    return this.hub.status(windowId);
  }

  async ask(
    question: string,
    options: UiOption[],
    askOptions: AskOptions = {}
  ): Promise<AskResult> {
    const connection = await this.connect().catch((error) => {
      this.#logger.warn(`cannot show question: ${(error as Error).message}`);
      return null;
    });
    if (!connection) {
      return {
        status: "unavailable",
        questionId: "",
        message:
          "Zen is not attached, so the question could not be shown in the browser.",
      };
    }
    return this.hub.ask(question, options, askOptions);
  }

  async notify(options: NotifyOptions): Promise<{ delivered: boolean; windowId?: string }> {
    const connection = await this.connect().catch(() => null);
    if (!connection) return { delivered: false };
    return this.hub.notify(options);
  }

  answers(): AnswersResult {
    return this.hub.answers();
  }

  progress(options: ProgressOptions): ProgressResult {
    return this.hub.progress(options);
  }

  events(options: { after?: number; waitSeconds?: number } = {}): Promise<EventsResult> {
    return this.hub.events(options);
  }

  async readPage(
    options: {
      windowId?: string;
      maxChars?: number;
      offset?: number;
      tabId?: string;
      format?: ReadFormat;
      selector?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<PageReadResult> {
    await this.connect();
    const page = options.tabId
      ? await readTabPage(this.hub, options.tabId, options)
      : await readActivePage(this.hub, options);
    if (page.url) {
      this.#assertUrlAllowed(page.url, "Refusing to return content from");
    }
    return page;
  }

  /**
   * Reads up to 10 tabs with limited concurrency. Each tab succeeds or fails
   * independently so one slow page cannot spoil a research batch.
   */
  async readPages(
    options: {
      tabIds: string[];
      windowId?: string;
      maxChars?: number;
      offset?: number;
      format?: ReadFormat;
      selector?: string;
      signal?: AbortSignal;
      /** Called once per finished tab, including failures. */
      onProgress?: (completed: number, total: number) => void;
    }
  ): Promise<BatchReadResult> {
    await this.connect();
    const tabIds = [...new Set(options.tabIds)].slice(0, MAX_BATCH_READ);
    const pages: BatchReadEntry[] = new Array(tabIds.length);
    let next = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= tabIds.length) return;
        const tabId = tabIds[index];
        try {
          const page = await this.hub.readTab(
            {
              tabId,
              maxChars: options.maxChars,
              offset: options.offset,
              format: options.format,
              selector: options.selector,
            },
            options.windowId,
            { signal: options.signal }
          );
          pages[index] = {
            tabId,
            ok: true,
            title: page.title,
            url: page.url,
            page,
          };
        } catch (error) {
          pages[index] = {
            tabId,
            ok: false,
            error: String((error as Error)?.message ?? error),
          };
        } finally {
          completed += 1;
          options.onProgress?.(completed, tabIds.length);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, tabIds.length) }, worker)
    );
    return { pages: pages.filter(Boolean) };
  }

  /** Finds literal text in one tab without selecting or changing it. */
  async findText(options: FindTextOptions): Promise<TextSearchResult> {
    await this.connect();
    const tabId = String(options.tabId ?? "").trim();
    const query = String(options.query ?? "").trim();
    if (!tabId) throw new Error("tabId is required");
    if (!query) throw new Error("query is required");

    const found = await this.findTab(tabId);
    if (!found) {
      return {
        ok: false,
        tabId,
        url: "",
        title: "",
        query,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: {
          code: "PAGE_NOT_FOUND",
          message:
            `No open tab matches id "${tabId}". Call zen_tabs_list for ` +
            "current ids.",
        },
      };
    }
    if (!this.#urlPermitted(found.tab.url)) {
      return {
        ok: false,
        tabId,
        url: found.tab.url,
        title: found.tab.title,
        query,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: {
          code: "UNSUPPORTED_PAGE",
          message:
            `Tab "${found.tab.title}" is outside the configured domain ` +
            "allowlist, so its text was not searched.",
        },
      };
    }

    try {
      return await this.hub.findText(
        {
          tabId,
          query,
          caseSensitive: options.caseSensitive === true,
          maxMatches: options.maxMatches,
          contextChars: options.contextChars,
        },
        found.windowId
      );
    } catch (error) {
      return {
        ok: false,
        tabId,
        url: found.tab.url,
        title: found.tab.title,
        query,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: evidenceFailureFromError(error),
      };
    }
  }

  /**
   * Searches several tabs with bounded concurrency. Per-tab failures are
   * reported in the result instead of failing the whole search.
   */
  async searchTabs(options: SearchTabsOptions): Promise<SearchTabsResult> {
    await this.connect();
    const query = String(options.query ?? "").trim();
    if (!query) throw new Error("query is required");

    const maxTabs = clampInt(options.maxTabs, 1, 30, 20);
    const maxMatchesPerTab = clampInt(options.maxMatchesPerTab, 1, 20, 5);
    const contextChars = clampInt(options.contextChars, 0, 300, 80);
    const results: SearchTabsEntry[] = [];
    const candidates: Array<{ tab: TabInfo; windowId: string }> = [];
    let skipped = 0;

    const requested = Array.isArray(options.tabIds)
      ? [...new Set(options.tabIds.map((id) => String(id).trim()))]
          .filter(Boolean)
          .slice(0, maxTabs)
      : [];

    if (requested.length > 0) {
      for (const tabId of requested) {
        const found = await this.findTab(tabId);
        if (!found) {
          results.push({
            tabId,
            ok: false,
            url: "",
            title: "",
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: {
              code: "PAGE_NOT_FOUND",
              message: `No open tab matches id "${tabId}".`,
            },
          });
          continue;
        }
        if (!this.#urlPermitted(found.tab.url)) {
          skipped += 1;
          results.push({
            tabId,
            ok: false,
            url: found.tab.url,
            title: found.tab.title,
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: {
              code: "UNSUPPORTED_PAGE",
              message:
                "This tab is outside the configured domain allowlist, so " +
                "its text was not searched.",
            },
          });
          continue;
        }
        candidates.push(found);
      }
    } else {
      const windows = [...this.hub.connectedWindows()].sort(
        (left, right) => Number(right.focused) - Number(left.focused)
      );
      for (const window of windows) {
        let listing;
        try {
          listing = await this.hub.listTabs(
            { space: options.space, limit: 2_000 },
            window.windowId
          );
        } catch {
          continue;
        }
        for (const tab of listing.tabs) {
          if (!isHttpPageUrl(tab.url) || !this.#urlPermitted(tab.url)) {
            skipped += 1;
            continue;
          }
          candidates.push({ tab, windowId: window.windowId });
          if (candidates.length >= maxTabs) break;
        }
        if (candidates.length >= maxTabs) break;
      }
    }

    const entries: Array<SearchTabsEntry | null> = new Array(candidates.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        try {
          const result = await this.hub.findText(
            {
              tabId: candidate.tab.id,
              query,
              caseSensitive: options.caseSensitive === true,
              maxMatches: maxMatchesPerTab,
              contextChars,
            },
            candidate.windowId,
            SEARCH_TAB_TIMEOUT_MS
          );
          entries[index] = searchEntry(result);
        } catch (error) {
          entries[index] = {
            tabId: candidate.tab.id,
            ok: false,
            url: candidate.tab.url,
            title: candidate.tab.title,
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: evidenceFailureFromError(error),
          };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SEARCH_TABS_CONCURRENCY, candidates.length) },
        worker
      )
    );

    const all = [
      ...results,
      ...entries.filter((entry): entry is SearchTabsEntry => entry !== null),
    ].sort(
      (left, right) =>
        Number(right.matches.length > 0) - Number(left.matches.length > 0)
    );
    let totalMatches = 0;
    for (const entry of all) {
      totalMatches += entry.totalMatches;
    }
    let remaining = MAX_SEARCH_TOTAL_MATCHES;
    for (const entry of all) {
      if (entry.matches.length > remaining) {
        entry.matches = entry.matches.slice(0, Math.max(0, remaining));
        entry.truncated = true;
      }
      remaining -= entry.matches.length;
    }

    return {
      query,
      tabsSearched: candidates.length,
      tabsMatched: all.filter((entry) => entry.matches.length > 0).length,
      totalMatches,
      skipped,
      truncated:
        totalMatches > MAX_SEARCH_TOTAL_MATCHES ||
        all.some((entry) => entry.truncated),
      results: all,
    };
  }

  /**
   * Opens (or reuses) the source tab, asks the bridge to locate and mark the
   * quote, then shows the same activity card used by zen_notify.
   */
  async showEvidence(
    options: ShowEvidenceOptions
  ): Promise<EvidenceShowResult> {
    await this.connect();
    const requestedUrl = String(options.url ?? "").trim();
    const sourceUrl = normalizeEvidenceUrl(requestedUrl);
    const claim = options.claim?.trim() || undefined;
    const focus = options.focus === true;
    if (!sourceUrl) {
      return {
        ok: false,
        tabId: null,
        tabReused: false,
        focused: false,
        sourceUrl: requestedUrl,
        url: requestedUrl,
        title: options.sourceTitle?.trim() || "",
        claim,
        error: {
          code: "UNSUPPORTED_PAGE",
          message:
            "Evidence Mode only opens and inspects http(s) URLs. " +
            "Browser-internal and local-file pages are not supported.",
        },
      };
    }
    if (!this.#urlPermitted(sourceUrl)) {
      return {
        ok: false,
        tabId: null,
        tabReused: false,
        focused: false,
        sourceUrl,
        url: sourceUrl,
        title: options.sourceTitle?.trim() || "",
        claim,
        error: {
          code: "UNSUPPORTED_PAGE",
          message:
            `${sourceUrl} is outside the configured domain allowlist, so ` +
            "Evidence Mode did not open or inspect it.",
        },
      };
    }

    let target: { tab: TabInfo; windowId: string; reused: boolean } | null = null;
    const requestedTab = options.tabId?.trim();
    if (requestedTab) {
      const found = await this.findTab(requestedTab);
      // A stale or mismatched tab id must not make us mark a different page.
      if (found && tabMatchesUrl(found.tab, sourceUrl)) {
        target = { ...found, reused: true };
      }
    }
    if (!target) {
      const found = await this.#findTabByUrl(sourceUrl);
      if (found) target = { ...found, reused: true };
    }
    if (!target) {
      try {
        const opened = await this.hub.openTabs({
          urls: [sourceUrl],
          background: !focus,
          switchTo: focus,
        });
        const tab = opened.tabs[0];
        if (!tab) throw new Error("Zen did not return the opened tab");
        target = { tab, windowId: tab.windowId, reused: false };
      } catch (error) {
        return {
          ok: false,
          tabId: null,
          tabReused: false,
          focused: false,
          sourceUrl,
          url: sourceUrl,
          title: options.sourceTitle?.trim() || "",
          claim,
          error: {
            code: "PAGE_NOT_FOUND",
            message: `Could not open ${sourceUrl}: ${errorText(error)}`,
          },
        };
      }
    }

    if (!this.#urlPermitted(target.tab.url)) {
      return {
        ok: false,
        tabId: null,
        tabReused: target.reused,
        focused: false,
        sourceUrl,
        url: target.tab.url,
        title: target.tab.title,
        claim,
        error: {
          code: "UNSUPPORTED_PAGE",
          message:
            "The source tab is outside the configured domain allowlist, so " +
            "Evidence Mode did not inspect it.",
        },
      };
    }

    if (focus) {
      await this.hub
        .selectTab({ tabId: target.tab.id, focusWindow: true }, target.windowId)
        .catch(() => undefined);
    }
    this.#rememberEvidence(target.tab.id, target.windowId);

    let op: EvidenceOpResult;
    try {
      op = await this.hub.showEvidence(
        {
          tabId: target.tab.id,
          quote: options.quote,
          context: options.context?.trim() || undefined,
          minConfidence: options.minConfidence,
          highlightMs: options.highlightMs,
        },
        target.windowId,
        { signal: options.signal }
      );
    } catch (error) {
      op = {
        ok: false,
        tabId: target.tab.id,
        url: target.tab.url,
        title: target.tab.title,
        error: evidenceFailureFromError(error),
      };
    }

    const result: EvidenceShowResult = {
      ...op,
      tabId: op.tabId ?? target.tab.id,
      url: op.url || target.tab.url,
      title: op.title || target.tab.title || options.sourceTitle?.trim() || "",
      tabReused: target.reused,
      focused: focus,
      sourceUrl,
      claim,
    };

    const delivered = await this.hub
      .notify({
        title: evidenceCardTitle(result),
        detail: evidenceCardDetail(
          result,
          options.quote,
          options.sourceTitle
        ),
        tone: result.ok ? (result.highlighted ? "success" : "warning") : "warning",
        action:
          !focus && result.tabId
            ? { label: "Show source", tab: result.tabId }
            : undefined,
        autoHideMs: Math.max(
          10_000,
          Math.min(120_000, Number(options.highlightMs) || 25_000)
        ),
        windowId: target.windowId,
      })
      .then((response) => response.delivered)
      .catch(() => false);
    if (!delivered) {
      result.limitation = joinLimitation(
        result.limitation,
        "The in-browser summary card could not be shown."
      );
    }
    return result;
  }

  /**
   * Verifies several citations with bounded concurrency, reusing one tab per
   * source URL and reporting per-citation results even when some fail.
   */
  async showEvidenceBatch(
    options: ShowEvidenceBatchOptions
  ): Promise<EvidenceBatchResult> {
    await this.connect();
    const focus = options.focus === true;
    const requested = Array.isArray(options.citations) ? options.citations : [];
    const total = requested.length;
    const rejected = (error: EvidenceFailure): EvidenceBatchResult => ({
      ok: false,
      total,
      matched: 0,
      verified: 0,
      failed: total,
      openedTabs: 0,
      reusedTabs: 0,
      focused: focus,
      results: [],
      error,
    });

    if (total === 0) {
      return rejected({
        code: "UNSUPPORTED_PAGE",
        message: "Provide at least one citation.",
      });
    }
    if (total > MAX_EVIDENCE_BATCH) {
      return rejected({
        code: "UNSUPPORTED_PAGE",
        message:
          `A batch holds at most ${MAX_EVIDENCE_BATCH} citations. ` +
          "Split it into smaller calls.",
      });
    }

    const citations: EvidenceCitation[] = [];
    for (let index = 0; index < requested.length; index += 1) {
      const citation = requested[index];
      const url = normalizeEvidenceUrl(String(citation?.url ?? ""));
      if (!url) {
        return rejected({
          code: "UNSUPPORTED_PAGE",
          message:
            `Citation ${index + 1} (${String(citation?.url ?? "")}) is not an ` +
            "http(s) URL. Evidence Mode cannot inspect it.",
        });
      }
      if (!this.#urlPermitted(url)) {
        return rejected({
          code: "UNSUPPORTED_PAGE",
          message:
            `Citation ${index + 1} (${url}) is outside the configured domain ` +
            "allowlist. Evidence Mode cannot inspect it.",
        });
      }
      const quote =
        typeof citation?.quote === "string" ? citation.quote.trim() : "";
      if (!quote) {
        throw new Error(`Citation ${index + 1} has an empty quote.`);
      }
      citations.push({
        ...citation,
        url,
        quote,
        ...(citation.tabId ? { tabId: String(citation.tabId).trim() } : {}),
      });
    }

    const quotesPerSource = new Map<string, number>();
    for (const citation of citations) {
      const key = comparableUrl(citation.url);
      quotesPerSource.set(key, (quotesPerSource.get(key) ?? 0) + 1);
    }
    for (const [url, count] of quotesPerSource) {
      if (count > MAX_QUOTES_PER_SOURCE) {
        throw new Error(
          `A batch may verify at most ${MAX_QUOTES_PER_SOURCE} quotes from ` +
            `one source (${url} has ${count}). Split the citations.`
        );
      }
    }

    const concurrency = clampInt(
      options.concurrency,
      1,
      MAX_BATCH_CONCURRENCY,
      2
    );
    const windows = [...this.hub.connectedWindows()].sort(
      (left, right) => Number(right.focused) - Number(left.focused)
    );
    const listings = await Promise.all(
      windows.map(async (window) => {
        try {
          const listing = await this.hub.listTabs(
            { limit: 2_000 },
            window.windowId
          );
          return { windowId: window.windowId, tabs: listing.tabs };
        } catch {
          return { windowId: window.windowId, tabs: [] as TabInfo[] };
        }
      })
    );

    const byUrl = new Map<string, { tab: TabInfo; windowId: string }>();
    const byId = new Map<string, { tab: TabInfo; windowId: string }>();
    for (const listing of listings) {
      for (const tab of listing.tabs) {
        if (!isHttpPageUrl(tab.url) || !this.#urlPermitted(tab.url)) continue;
        const entry = { tab, windowId: listing.windowId };
        const key = comparableUrl(tab.url);
        const current = byUrl.get(key);
        if (!current || (tab.active && !current.tab.active)) {
          byUrl.set(key, entry);
        }
        byId.set(tab.id, entry);
      }
    }

    const targets: Array<{
      tab: TabInfo;
      windowId: string;
      reused: boolean;
    } | null> = new Array(total).fill(null);
    const missing = new Set<string>();
    for (let index = 0; index < citations.length; index += 1) {
      const citation = citations[index];
      const requestedTabId = citation.tabId?.trim();
      if (requestedTabId) {
        const found = byId.get(requestedTabId);
        if (found && tabMatchesUrl(found.tab, citation.url)) {
          targets[index] = { ...found, reused: true };
          continue;
        }
      }
      const found = byUrl.get(comparableUrl(citation.url));
      if (found) {
        targets[index] = { ...found, reused: true };
        continue;
      }
      missing.add(citation.url);
    }

    const openedByUrl = new Map<
      string,
      { tab: TabInfo; windowId: string }
    >();
    let openError = "";
    if (missing.size > 0) {
      try {
        const opened = await this.hub.openTabs({
          urls: [...missing],
          background: !focus,
          switchTo: focus,
        });
        for (const tab of opened.tabs) {
          const entry = { tab, windowId: tab.windowId };
          openedByUrl.set(comparableUrl(tab.url), entry);
          if (tab.requestedUrl) {
            openedByUrl.set(comparableUrl(tab.requestedUrl), entry);
          }
        }
      } catch (error) {
        openError = errorText(error);
      }
    }
    for (let index = 0; index < citations.length; index += 1) {
      if (targets[index]) continue;
      const opened = openedByUrl.get(comparableUrl(citations[index].url));
      if (opened) targets[index] = { ...opened, reused: false };
    }

    const firstTargetIndex = targets.findIndex((target) => target !== null);
    const firstTarget =
      firstTargetIndex >= 0 ? targets[firstTargetIndex] : null;
    if (focus && firstTarget) {
      await this.hub
        .selectTab(
          { tabId: firstTarget.tab.id, focusWindow: true },
          firstTarget.windowId
        )
        .catch(() => undefined);
    }

    const openedTabIds = new Set<string>();
    const reusedTabIds = new Set<string>();
    for (const target of targets) {
      if (!target) continue;
      this.#rememberEvidence(target.tab.id, target.windowId);
      if (target.reused) reusedTabIds.add(target.tab.id);
      else openedTabIds.add(target.tab.id);
    }

    const highlightMs = clampInt(options.highlightMs, 1_000, 120_000, 25_000);
    const results: EvidenceShowResult[] = new Array(total);
    let next = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= citations.length) return;
        try {
          const citation = citations[index];
          const target = targets[index];
          const claim = citation.claim?.trim() || undefined;
          if (!target) {
            results[index] = {
              ok: false,
              tabId: null,
              tabReused: false,
              focused: false,
              sourceUrl: citation.url,
              url: citation.url,
              title: citation.sourceTitle?.trim() || "",
              claim,
              error: {
                code: "PAGE_NOT_FOUND",
                message:
                  `Could not open ${citation.url}.` +
                  (openError ? ` ${openError}` : ""),
              },
            };
            continue;
          }

          let op: EvidenceOpResult;
          try {
            op = await this.hub.showEvidence(
              {
                tabId: target.tab.id,
                quote: citation.quote,
                ...(citation.context?.trim()
                  ? { context: citation.context.trim() }
                  : {}),
                ...(options.minConfidence !== undefined
                  ? { minConfidence: options.minConfidence }
                  : {}),
                highlightMs,
              },
              target.windowId,
              { signal: options.signal }
            );
          } catch (error) {
            op = {
              ok: false,
              tabId: target.tab.id,
              url: target.tab.url,
              title: target.tab.title,
              error: evidenceFailureFromError(error),
            };
          }

          results[index] = {
            ...op,
            tabId: op.tabId ?? target.tab.id,
            url: op.url || target.tab.url,
            title:
              op.title ||
              target.tab.title ||
              citation.sourceTitle?.trim() ||
              "",
            tabReused: target.reused,
            focused:
              focus && firstTarget?.tab.id === target.tab.id,
            sourceUrl: citation.url,
            claim,
          };
        } finally {
          completed += 1;
          options.onProgress?.(completed, total);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, citations.length) },
        worker
      )
    );

    const matched = results.filter((result) => result.ok).length;
    const verified = results.filter((result) => result.verified === true).length;
    const unverified = matched - verified;
    const failed = total - matched;
    let limitation: string | undefined;

    const failures = results
      .filter((result) => !result.ok)
      .slice(0, MAX_BATCH_CARD_FAILURES)
      .map(
        (result) =>
          `${truncateText(
            collapseText(result.claim || result.sourceUrl),
            90
          )} (${result.error?.code ?? "FAILED"})`
      );
    const cardWindow =
      firstTarget?.windowId ??
      this.hub.connectedWindows().find((window) => window.focused)?.windowId;
    const delivered = await this.hub
      .notify({
        title:
          failed === 0 && unverified === 0
            ? `All ${total} citations verified`
            : `${verified} of ${total} citations verified`,
        detail: [
          `${matched} matched, ${failed} failed.`,
          unverified > 0
            ? `${unverified} fuzzy match(es) need a manual check.`
            : "",
          failures.length ? `Failed: ${failures.join("; ")}` : "",
          openedTabIds.size
            ? `${openedTabIds.size} source tab(s) opened in the background.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        tone: failed === 0 && unverified === 0 ? "success" : "warning",
        action:
          !focus && firstTarget
            ? { label: "Show source", tab: firstTarget.tab.id }
            : undefined,
        autoHideMs: Math.max(10_000, Math.min(120_000, highlightMs)),
        windowId: cardWindow,
      })
      .then((response) => response.delivered)
      .catch(() => false);
    if (!delivered) {
      limitation = "The in-browser summary card could not be shown.";
    }

    return {
      ok: failed === 0 && unverified === 0,
      total,
      matched,
      verified,
      failed,
      openedTabs: openedTabIds.size,
      reusedTabs: reusedTabIds.size,
      focused: focus,
      results,
      ...(limitation ? { limitation } : {}),
    };
  }

  /** Removes evidence overlays from one tracked tab, or from all of them. */
  async clearEvidence(
    options: ClearEvidenceOptions = {}
  ): Promise<EvidenceClearOutcome> {
    await this.connect();
    const requestedTab = options.tabId?.trim();
    const targets: Array<{ tabId: string; windowId?: string }> = [];
    if (requestedTab) {
      const tracked = this.#evidenceTargets.get(requestedTab);
      const found = tracked ? null : await this.findTab(requestedTab);
      targets.push({
        tabId: requestedTab,
        windowId: tracked?.windowId ?? found?.windowId,
      });
    } else {
      for (const [tabId, entry] of this.#evidenceTargets) {
        targets.push({ tabId, windowId: entry.windowId });
      }
    }
    if (!targets.length) {
      return { cleared: false, tabId: null, removed: 0 };
    }

    let removed = 0;
    let lastTab: string | null = null;
    let failure: EvidenceFailure | undefined;
    for (const target of targets) {
      try {
        const cleared = await this.hub.clearEvidence(
          { tabId: target.tabId },
          target.windowId
        );
        removed += cleared.removed;
        lastTab = target.tabId;
        this.#evidenceTargets.delete(target.tabId);
      } catch (error) {
        failure = evidenceFailureFromError(error);
        if (failure.code === "PAGE_NOT_FOUND") {
          this.#evidenceTargets.delete(target.tabId);
        }
      }
    }

    return {
      cleared: removed > 0,
      tabId: lastTab ?? requestedTab ?? targets[0]?.tabId ?? null,
      removed,
      ...(failure ? { error: failure } : {}),
    };
  }

  #urlPermitted(url: string): boolean {
    return isUrlAllowed(url, this.config.allowedDomains);
  }

  #assertUrlAllowed(url: string, action: string): void {
    if (this.#urlPermitted(url)) return;
    throw new BridgeRequestError(
      "domain_not_allowed",
      `${action} ${hostOf(url) ?? url}, which is outside the configured ` +
        "domain allowlist."
    );
  }

  /** Finds an open tab and the window that holds it. */
  async findTab(
    tabId: string
  ): Promise<{ tab: TabInfo; windowId: string } | null> {
    for (const window of this.hub.connectedWindows()) {
      try {
        const listing = await this.hub.listTabs(
          { limit: 2_000 },
          window.windowId
        );
        const tab = listing.tabs.find((candidate) => candidate.id === tabId);
        if (tab) return { tab, windowId: window.windowId };
      } catch {
        // A window can disappear between enumerating and listing.
      }
    }
    return null;
  }

  async #findTabByUrl(
    url: string
  ): Promise<{ tab: TabInfo; windowId: string } | null> {
    const wanted = comparableUrl(url);
    const windows = [...this.hub.connectedWindows()].sort(
      (left, right) => Number(right.focused) - Number(left.focused)
    );
    let fallback: { tab: TabInfo; windowId: string } | null = null;
    for (const window of windows) {
      try {
        const listing = await this.hub.listTabs(
          { limit: 2_000 },
          window.windowId
        );
        for (const tab of listing.tabs) {
          if (!tabMatchesUrl(tab, wanted)) continue;
          if (tab.active) return { tab, windowId: window.windowId };
          if (!fallback) fallback = { tab, windowId: window.windowId };
        }
      } catch {
        // Keep looking in other windows.
      }
    }
    return fallback;
  }

  #rememberEvidence(tabId: string, windowId: string): void {
    this.#evidenceTargets.set(tabId, { windowId, updatedAt: Date.now() });
    while (this.#evidenceTargets.size > 20) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.#evidenceTargets) {
        if (entry.updatedAt < oldestAt) {
          oldestAt = entry.updatedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.#evidenceTargets.delete(oldestId);
    }
  }

  async addWatch(
    params: WatchParams,
    options: { windowId?: string } = {}
  ): Promise<WatchInfo> {
    // Reserved synchronously so parallel calls cannot all pass the cap check
    // before any of them registers a timer.
    if (this.#watches.size + this.#watchReservations >= MAX_WATCHES) {
      throw new Error(
        `At most ${MAX_WATCHES} watches can run at once. ` +
          "Remove one with zen_watch_remove first."
      );
    }
    this.#watchReservations += 1;
    try {
      return await this.#createWatch(params, options);
    } finally {
      this.#watchReservations -= 1;
    }
  }

  async #createWatch(
    params: WatchParams,
    options: { windowId?: string } = {}
  ): Promise<WatchInfo> {
    await this.connect();
    const mode = params.mode ?? "change";
    if ((mode === "appear" || mode === "disappear") && !params.selector?.trim()) {
      throw new Error("selector is required for appear and disappear watches");
    }
    const listing = await this.hub.listTabs({ limit: 2_000 }, options.windowId);
    let tabId = params.tabId?.trim();
    if (!tabId) {
      const status = await this.hub.status(options.windowId);
      tabId = status.activeTab?.id ?? undefined;
    }
    if (!tabId) throw new Error("There is no active tab to watch");
    const tab = listing.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new Error(
        `No open tab matches id "${tabId}". Call zen_tabs_list for current ids.`
      );
    }
    this.#assertUrlAllowed(tab.url, "Refusing to watch");

    const intervalSeconds = Math.max(
      this.config.watchMinIntervalSeconds || 15,
      Math.min(3_600, Math.trunc(params.intervalSeconds ?? 60))
    );
    const maxMinutes = Math.max(
      1,
      Math.min(24 * 60, Math.trunc(params.maxMinutes ?? 120))
    );
    const now = Date.now();
    const id = `w-${randomUUID().slice(0, 8)}`;
    const selector = params.selector?.trim() || null;
    const info: WatchInfo = {
      id,
      tabId,
      title: tab.title,
      url: tab.url,
      spaceId: tab.spaceId,
      mode,
      selector,
      contains: params.contains?.trim() || null,
      label: params.label?.trim() || tab.title || tab.url,
      intervalSeconds,
      createdAt: now,
      expiresAt: now + maxMinutes * 60_000,
      lastCheckedAt: null,
      lastError: null,
      changes: 0,
    };

    const entry: WatchRuntime = {
      info,
      timer: null,
      running: false,
      previousText: null,
      previousHash: "",
      previousFound: false,
      notify: params.notify !== false,
      windowId: options.windowId,
    };

    const baseline = await this.#readWatchSample(entry).catch(() => null);
    if (baseline) {
      entry.previousFound = baseline.found;
      if (baseline.page) {
        entry.previousText = baseline.page.text;
        entry.previousHash = hashText(baseline.page.text);
        info.lastCheckedAt = Date.now();
      }
    }

    entry.timer = setInterval(() => {
      void this.#checkWatch(id);
    }, intervalSeconds * 1000);
    entry.timer.unref?.();
    this.#watches.set(id, entry);
    return { ...info };
  }

  listWatches(): WatchInfo[] {
    return [...this.#watches.values()]
      .map((entry) => ({ ...entry.info }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  removeWatch(id: string): boolean {
    const entry = this.#watches.get(id);
    if (!entry) return false;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    this.#watches.delete(id);
    return true;
  }

  async #readWatchSample(
    entry: WatchRuntime
  ): Promise<{ page: PageReadResult | null; found: boolean }> {
    try {
      const page = await this.hub.readTab(
        {
          tabId: entry.info.tabId,
          maxChars: MAX_WATCH_SAMPLE_CHARS,
          format: "text",
          selector: entry.info.selector ?? undefined,
        },
        entry.windowId
      );
      return { page, found: true };
    } catch (error) {
      if (
        error instanceof BridgeRequestError &&
        error.code === "selector_not_found"
      ) {
        return { page: null, found: false };
      }
      throw error;
    }
  }

  async #checkWatch(id: string): Promise<void> {
    const entry = this.#watches.get(id);
    if (!entry || entry.running || this.#closed) return;
    if (this.hub.paused) return;
    if (Date.now() >= entry.info.expiresAt) {
      this.#stopWatch(id, "Watch expired", `"${entry.info.label}" reached its time limit.`);
      return;
    }
    entry.running = true;
    try {
      const sample = await this.#readWatchSample(entry);
      entry.info.lastCheckedAt = Date.now();
      entry.info.lastError = null;

      if (entry.info.mode === "change") {
        if (!sample.page) return;
        const text = sample.page.text;
        const hash = hashText(text);
        if (entry.previousText === null && !entry.previousHash) {
          entry.previousText = text;
          entry.previousHash = hash;
          return;
        }
        if (hash === entry.previousHash) return;
        const phrase = entry.info.contains?.toLowerCase();
        entry.previousText = text;
        entry.previousHash = hash;
        if (phrase && !text.toLowerCase().includes(phrase)) return;
        this.#fireWatch(
          entry,
          `Watch: ${entry.info.label} changed`,
          previewText(text)
        );
        return;
      }

      const appearing =
        entry.info.mode === "appear" ? sample.found : !sample.found;
      const changed = sample.found !== entry.previousFound;
      entry.previousFound = sample.found;
      if (!changed || !appearing) return;
      this.#fireWatch(
        entry,
        entry.info.mode === "appear"
          ? `Watch: ${entry.info.label} appeared`
          : `Watch: ${entry.info.label} disappeared`,
        entry.info.selector
          ? `Selector "${entry.info.selector}" ${
              entry.info.mode === "appear" ? "appeared" : "disappeared"
            } on ${entry.info.title}.`
          : `Page state changed on ${entry.info.title}.`
      );
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const code =
        error instanceof BridgeRequestError ? error.code : "";
      if (code === "domain_not_allowed") {
        this.#stopWatch(
          id,
          "Watch stopped",
          `"${entry.info.label}" left the allowed domains, so watching stopped.`
        );
        return;
      }
      if (
        code === "tab_not_found" ||
        code === "bridge_disconnected" ||
        code === "no_tab"
      ) {
        this.#stopWatch(
          id,
          "Watch stopped",
          `"${entry.info.label}" stopped because the tab closed or disconnected.`
        );
        return;
      }
      entry.info.lastError = message.slice(0, 300);
    } finally {
      entry.running = false;
    }
  }

  #fireWatch(entry: WatchRuntime, title: string, detail: string): void {
    entry.info.changes += 1;
    this.hub.pushEvent({
      kind: "watch",
      title,
      detail: detail.slice(0, 400),
      tabId: entry.info.tabId,
      watchId: entry.info.id,
      windowId: entry.windowId,
    });
    if (!entry.notify) return;
    void this.hub
      .notify({
        title,
        detail: detail.slice(0, 220),
        tone: "info",
        autoHideMs: 20_000,
        windowId: entry.windowId,
        action: entry.info.spaceId
          ? { label: "Open space", space: entry.info.spaceId }
          : undefined,
      })
      .catch(() => undefined);
  }

  #stopWatch(id: string, title: string, detail: string): void {
    const entry = this.#watches.get(id);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    this.#watches.delete(id);
    this.hub.pushEvent({
      kind: "watch",
      title,
      detail,
      tabId: entry.info.tabId,
      watchId: entry.info.id,
      windowId: entry.windowId,
    });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#autoAttachTimer) clearInterval(this.#autoAttachTimer);
    this.#autoAttachTimer = null;
    for (const entry of this.#watches.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    this.#watches.clear();
    await this.hub.stop().catch(() => undefined);
    await this.#closeOwnedBrowser("the server is shutting down");
  }
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(page text is now empty)";
  return `${compact.slice(0, 240)}${compact.length > 240 ? "..." : ""} (${
    text.length
  } chars)`;
}

function searchEntry(result: TextSearchResult): SearchTabsEntry {
  return {
    tabId: result.tabId,
    ok: result.ok,
    url: result.url,
    title: result.title,
    matches: result.matches,
    totalMatches: result.totalMatches,
    truncated: result.truncated,
    ...(result.limitation ? { limitation: result.limitation } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function isHttpPageUrl(value: string): boolean {
  try {
    const scheme = new URL(value).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

function clampInt(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function normalizeEvidenceUrl(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/** Hash-insensitive, trailing-slash-insensitive URL identity for tab reuse. */
function comparableUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return String(value).trim();
  }
}

function tabMatchesUrl(tab: TabInfo, url: string): boolean {
  const wanted = comparableUrl(url);
  return [tab.url, tab.requestedUrl]
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0
    )
    .some((candidate) => comparableUrl(candidate) === wanted);
}

function evidenceFailureFromError(error: unknown): EvidenceFailure {
  const message = errorText(error);
  if (error instanceof BridgeUnavailableError) {
    return { code: "ACTOR_UNAVAILABLE", message };
  }
  if (error instanceof BridgeRequestError) {
    switch (error.code) {
      case "tab_not_found":
      case "no_tab":
        return { code: "PAGE_NOT_FOUND", message };
      case "tab_not_loaded":
        return { code: "PAGE_STILL_LOADING", message };
      case "actor_unavailable":
        return { code: "ACTOR_UNAVAILABLE", message };
      case "bridge_timeout":
        return {
          code: "PAGE_STILL_LOADING",
          message: `The page did not settle in time. ${message}`,
        };
      case "bridge_disconnected":
        return {
          code: "PAGE_NOT_FOUND",
          message: `The browser session disconnected. ${message}`,
        };
      case "unknown_method":
        return {
          code: "ACTOR_UNAVAILABLE",
          message: `${message} Re-run zen_launch so the bridge is updated.`,
        };
      case "invalid_url":
      case "domain_not_allowed":
        return { code: "UNSUPPORTED_PAGE", message };
      default:
        return { code: "PAGE_NOT_FOUND", message };
    }
  }
  return { code: "PAGE_NOT_FOUND", message };
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function evidenceCardTitle(result: EvidenceShowResult): string {
  const claim = result.claim ? collapseText(result.claim) : "";
  if (claim) return truncateText(claim, 140);
  if (result.ok) return "Evidence located";
  const titles: Partial<Record<EvidenceErrorCode, string>> = {
    PAGE_NOT_FOUND: "Source page is unavailable",
    PAGE_STILL_LOADING: "Source page is still loading",
    QUOTE_NOT_FOUND: "Evidence not found",
    AMBIGUOUS_MATCH: "Evidence match is ambiguous",
    LOW_MATCH_CONFIDENCE: "Evidence match is too weak",
    HIGHLIGHT_FAILED: "Evidence could not be marked",
    PRIVILEGED_PAGE: "Source page cannot be inspected",
    ACTOR_UNAVAILABLE: "Browser bridge is unavailable",
    UNSUPPORTED_PAGE: "Source page is not supported",
  };
  return (
    (result.error?.code ? titles[result.error.code] : undefined) ??
    "Evidence check failed"
  );
}

function evidenceCardDetail(
  result: EvidenceShowResult,
  requestedQuote: string,
  sourceTitle?: string
): string {
  const lines: string[] = [];
  const source =
    sourceTitle?.trim() || result.title?.trim() || result.sourceUrl;
  lines.push(`Source: ${truncateText(source, 160)}`);
  const excerpt = collapseText(result.matchedQuote || requestedQuote);
  if (excerpt) lines.push(`“${truncateText(excerpt, 220)}”`);

  if (result.ok) {
    const status = [
      result.matchMethod ? `${result.matchMethod} match` : "match",
      typeof result.confidence === "number"
        ? `${Math.round(result.confidence * 100)}% confidence`
        : "",
      result.occurrences && result.occurrences > 1
        ? `${result.occurrences} occurrences`
        : "",
      result.highlighted ? "highlighted" : "not highlighted",
      result.scrolled ? "scrolled into view" : "",
    ].filter(Boolean);
    lines.push(`Status: ${status.join(" · ")}`);
  } else {
    lines.push(`Status: ${result.error?.code ?? "FAILED"}`);
    if (result.error?.message) {
      lines.push(truncateText(collapseText(result.error.message), 240));
    }
  }
  if (result.limitation) {
    lines.push(`Note: ${truncateText(collapseText(result.limitation), 240)}`);
  }
  return lines.join("\n").slice(0, 800);
}

function collapseText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max: number): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function joinLimitation(
  current: string | undefined,
  extra: string
): string {
  const base = current?.trim();
  return base ? `${base} ${extra}` : extra;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

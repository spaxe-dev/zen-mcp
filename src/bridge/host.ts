import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket, WebSocketServer as WsServer } from "ws";
import { WebSocketServer } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  SERVER_VERSION,
} from "../shared/brand.js";
import { BRIDGE_PATH } from "../shared/protocol.js";
import type {
  ActivityTone,
  AnswerInboxEntry,
  AnswersResult,
  AskResult,
  BridgeMethod,
  BridgeMethodMap,
  BridgeResponse,
  BridgeStatus,
  BridgeToServer,
  CreateSpaceResult,
  OpenTabsResult,
  PageReadResult,
  ServerToBridge,
  UiActivity,
  UiActivityAction,
  UiOption,
  UiQuestion,
} from "../shared/protocol.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { MarionetteClient } from "../zen/marionette.js";

const RESOURCE_ALIAS = "zen-sidekick-bridge";
const CONNECTION_PING_MS = 20_000;
const REQUEST_TIMEOUT_MS = 25_000;
const RESEND_QUESTION_MAX_AGE_MS = 30 * 60_000;
const WS_OPEN = 1;

export class BridgeUnavailableError extends Error {
  override name = "BridgeUnavailableError";
}

export class BridgeRequestError extends Error {
  override name = "BridgeRequestError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface BridgeHubOptions {
  marionette: MarionetteClient;
  /** Path to the bundled bridge.js. Defaults to the file next to the CLI. */
  bridgeScriptPath?: string;
  logger?: Logger;
  serverVersion?: string;
}

interface BridgeConnection {
  ws: WebSocket;
  windowId: string;
  focused: boolean;
  appVersion: string;
  platform: string;
  connectedAt: number;
  alive: boolean;
}

interface PendingRequest {
  id: string;
  method: string;
  windowId: string | null;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface PendingQuestion {
  question: UiQuestion;
  askedAt: number;
  status: "pending" | "deferred" | "answered";
  deferred: boolean;
  answer?: string;
  selectedLabels?: string[];
  freeform?: boolean;
  answeredAt?: number;
  windowId: string | null;
  resolve: ((result: AskResult) => void) | null;
  timer: NodeJS.Timeout | null;
}

export interface InjectionSummary {
  windows: number;
  injected: number;
  reused: number;
  reconnected: number;
  pending: number;
  errors: string[];
}

export interface AskOptions {
  waitSeconds?: number;
  context?: string;
  allowFreeform?: boolean;
  multiSelect?: boolean;
  /** Restrict the question to one window. */
  windowId?: string;
}

export interface NotifyOptions {
  title: string;
  detail?: string;
  tone?: ActivityTone;
  action?: { label: string; space: string };
  autoHideMs?: number;
  id?: string;
  windowId?: string;
}

export class BridgeHub {
  readonly #marionette: MarionetteClient;
  readonly #logger: Logger;
  readonly #serverVersion: string;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #bridgeScriptPath: string;
  readonly #bridgeDir: string;
  readonly #bridgeFile: string;

  #server: WsServer | null = null;
  #url: string | null = null;
  #port = 0;
  #pingTimer: NodeJS.Timeout | null = null;

  readonly #connections = new Map<string, BridgeConnection>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pendingQuestions = new Map<string, PendingQuestion>();
  readonly #answeredQuestions: AnswerInboxEntry[] = [];

  #primaryWindowId: string | null = null;
  #requestSeq = 0;
  #lastInjectAt = 0;
  #lastInjection: InjectionSummary | null = null;
  #started = false;

  constructor(options: BridgeHubOptions) {
    this.#marionette = options.marionette;
    this.#logger = options.logger ?? createLogger("bridge");
    this.#serverVersion = options.serverVersion ?? SERVER_VERSION;
    this.#bridgeScriptPath =
      options.bridgeScriptPath ?? resolveBridgeScriptPath();
    this.#bridgeDir = dirname(this.#bridgeScriptPath);
    this.#bridgeFile = basename(this.#bridgeScriptPath);
  }

  get port(): number {
    return this.#port;
  }

  get isStarted(): boolean {
    return this.#started;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get primaryWindowId(): string | null {
    return this.#primaryWindowId;
  }

  get bridgeScriptPath(): string {
    return this.#bridgeScriptPath;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (!existsSync(this.#bridgeScriptPath)) {
      throw new Error(
        `Bridge bundle not found at ${this.#bridgeScriptPath}. Run "npm run build" ` +
          "(or reinstall Zen Sidekick) before starting the server."
      );
    }

    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: BRIDGE_PATH,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not determine the bridge WebSocket port");
    }
    this.#server = server;
    this.#port = address.port;
    this.#url = `ws://127.0.0.1:${this.#port}${BRIDGE_PATH}?token=${encodeURIComponent(
      this.#token
    )}`;
    this.#started = true;

    server.on("connection", (ws, request) => this.#onConnection(ws, request));
    server.on("error", (error: Error) => {
      this.#logger.error(`bridge server error: ${error.message}`);
    });

    this.#pingTimer = setInterval(() => this.#heartbeat(), CONNECTION_PING_MS);
    this.#pingTimer.unref?.();

    this.#logger.info(`bridge listening on 127.0.0.1:${this.#port}`);
  }

  #onConnection(ws: WebSocket, request: import("node:http").IncomingMessage): void {
    const remote = request.socket.remoteAddress ?? "";
    if (!isLoopback(remote)) {
      this.#logger.warn(`rejecting non-loopback bridge connection from ${remote}`);
      ws.close(4003, "loopback only");
      return;
    }

    let token = "";
    try {
      token = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(
        "token"
      ) ?? "";
    } catch {
      token = "";
    }
    if (!tokensEqual(token, this.#token)) {
      this.#logger.warn("rejecting bridge connection with a bad token");
      ws.close(4003, "invalid token");
      return;
    }

    let connection: BridgeConnection | null = null;
    let registered = false;
    const helloTimer = setTimeout(() => {
      if (!registered) ws.close(4008, "hello timeout");
    }, 10_000);
    helloTimer.unref?.();
    ws.on("pong", () => {
      if (connection) connection.alive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message: BridgeToServer | BridgeResponse;
      try {
        message = JSON.parse(data.toString("utf8")) as
          | BridgeToServer
          | BridgeResponse;
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;

      if (message.type === "hello") {
        if (!tokensEqual(String(message.token ?? ""), this.#token)) {
          ws.close(4003, "invalid token");
          return;
        }
        if (Number(message.protocol) !== BRIDGE_PROTOCOL_VERSION) {
          ws.close(4001, "bridge protocol mismatch");
          return;
        }
        if (String(message.bridgeVersion) !== this.#serverVersion) {
          ws.close(4002, "bridge version mismatch");
          return;
        }
        if (!message.windowId) return;

        const existing = this.#connections.get(message.windowId);
        if (existing && existing.ws !== ws) {
          existing.ws.close(4000, "replaced by a newer bridge");
        }

        registered = true;
        clearTimeout(helloTimer);
        connection = {
          ws,
          windowId: String(message.windowId),
          focused: message.focused === true,
          appVersion: String(message.appVersion ?? ""),
          platform: String(message.platform ?? ""),
          connectedAt: Date.now(),
          alive: true,
        };
        this.#connections.set(connection.windowId, connection);
        if (connection.focused || !this.#primaryWindowId) {
          this.#primaryWindowId = connection.windowId;
        }
        this.#logger.info(
          `bridge connected from window ${connection.windowId}${
            connection.focused ? " (focused)" : ""
          }`
        );
        this.#send(connection, {
          type: "welcome",
          protocol: BRIDGE_PROTOCOL_VERSION,
          serverVersion: this.#serverVersion,
        });
        this.#resendPendingQuestions(connection);
        return;
      }

      if (!registered || !connection) return;
      connection.alive = true;

      switch (message.type) {
        case "bridge.focus":
          connection.focused = message.focused === true;
          if (connection.focused) {
            this.#primaryWindowId = connection.windowId;
          }
          return;
        case "bridge.pong":
          return;
        case "ui.answer":
          this.#onAnswer(String(message.id ?? ""), message);
          return;
        case "ui.action":
          this.#logger.debug(
            `activity ${String(message.activityId)} action ${String(
              message.actionId
            )}: ${message.ok ? "ok" : message.error ?? "failed"}`
          );
          return;
        case "res": {
          const pending = this.#pendingRequests.get(String(message.id ?? ""));
          if (!pending) return;
          if (pending.windowId && pending.windowId !== connection.windowId) {
            this.#logger.warn(
              `response for ${pending.id} arrived from an unexpected window`
            );
            return;
          }
          this.#pendingRequests.delete(pending.id);
          clearTimeout(pending.timer);
          if (message.ok) {
            pending.resolve(message.result);
          } else {
            pending.reject(
              new BridgeRequestError(
                message.error?.code ?? "bridge_error",
                message.error?.message ?? "The bridge request failed"
              )
            );
          }
          return;
        }
        case "bridge.error":
          this.#logger.warn(`bridge error: ${String(message.message)}`);
          return;
        default:
          return;
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (connection && this.#connections.get(connection.windowId) === connection) {
        this.#connections.delete(connection.windowId);
        if (this.#primaryWindowId === connection.windowId) {
          this.#primaryWindowId = this.#connections.keys().next().value ?? null;
        }
        this.#logger.info(`bridge disconnected from window ${connection.windowId}`);
        for (const [id, pending] of this.#pendingRequests) {
          if (pending.windowId === connection.windowId) {
            clearTimeout(pending.timer);
            this.#pendingRequests.delete(id);
            pending.reject(
              new BridgeRequestError(
                "bridge_disconnected",
                "The Zen window disconnected before the request finished"
              )
            );
          }
        }
      }
    });

    ws.on("error", (error: Error) => {
      this.#logger.debug(`bridge socket error: ${error.message}`);
    });
  }

  #heartbeat(): void {
    for (const connection of this.#connections.values()) {
      if (!connection.alive) {
        this.#logger.warn(
          `terminating unresponsive bridge in window ${connection.windowId}`
        );
        connection.ws.terminate();
        continue;
      }
      connection.alive = false;
      try {
        connection.ws.ping();
      } catch {
        connection.ws.terminate();
      }
    }
  }

  #send(connection: BridgeConnection, message: ServerToBridge): boolean {
    if (connection.ws.readyState !== WS_OPEN) return false;
    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #sendToWindow(windowId: string | null, message: ServerToBridge): boolean {
    const connection = windowId
      ? this.#connections.get(windowId)
      : this.#primaryConnection();
    if (!connection) return false;
    return this.#send(connection, message);
  }

  #primaryConnection(): BridgeConnection | null {
    if (this.#primaryWindowId) {
      const primary = this.#connections.get(this.#primaryWindowId);
      if (primary) return primary;
    }
    const first = this.#connections.values().next();
    return first.done ? null : first.value;
  }

  #connectionFor(windowId?: string): BridgeConnection {
    if (windowId) {
      const connection = this.#connections.get(windowId);
      if (!connection) {
        throw new BridgeUnavailableError(
          `No Zen Sidekick bridge is connected for window ${windowId}`
        );
      }
      return connection;
    }
    const connection = this.#primaryConnection();
    if (!connection) {
      throw new BridgeUnavailableError(
        "No Zen window is connected to Zen Sidekick. Launch Zen through the " +
          "sidekick (zen_launch) so the agent bridge can attach."
      );
    }
    return connection;
  }

  async request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options: { windowId?: string; timeoutMs?: number } = {}
  ): Promise<BridgeMethodMap[T]["result"]> {
    const connection = this.#connectionFor(options.windowId);
    const id = `r-${++this.#requestSeq}-${randomUUID().slice(0, 8)}`;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<BridgeMethodMap[T]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(id);
        reject(
          new BridgeRequestError(
            "bridge_timeout",
            `The Zen window did not finish "${method}" within ${Math.round(
              timeoutMs / 1000
            )}s`
          )
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pendingRequests.set(id, {
        id,
        method,
        windowId: connection.windowId,
        timer,
        resolve: (value) =>
          resolve(value as BridgeMethodMap[T]["result"]),
        reject,
      });
      const sent = this.#send(connection, {
        type: "req",
        id,
        method,
        params: params as unknown,
      });
      if (!sent) {
        this.#pendingRequests.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeUnavailableError(
            "The Zen window closed its agent connection. Reconnecting may fix this."
          )
        );
      }
    });
  }

  async status(windowId?: string): Promise<BridgeStatus> {
    return this.request("status", undefined, { windowId });
  }

  async listSpaces(windowId?: string) {
    return this.request("spaces.list", undefined, { windowId });
  }

  async createSpace(
    params: BridgeMethodMap["spaces.create"]["params"],
    windowId?: string
  ): Promise<CreateSpaceResult> {
    return this.request("spaces.create", params, {
      windowId,
      timeoutMs: 35_000,
    });
  }

  async switchSpace(
    params: BridgeMethodMap["spaces.switch"]["params"],
    windowId?: string
  ) {
    return this.request("spaces.switch", params, {
      windowId,
      timeoutMs: 30_000,
    });
  }

  async deleteSpace(
    params: BridgeMethodMap["spaces.delete"]["params"],
    windowId?: string
  ) {
    return this.request("spaces.delete", params, {
      windowId,
      timeoutMs: 30_000,
    });
  }

  async listTabs(
    params: BridgeMethodMap["tabs.list"]["params"],
    windowId?: string
  ) {
    return this.request("tabs.list", params, { windowId });
  }

  async openTabs(
    params: BridgeMethodMap["tabs.open"]["params"],
    windowId?: string
  ): Promise<OpenTabsResult> {
    return this.request("tabs.open", params, {
      windowId,
      timeoutMs: 35_000,
    });
  }

  async closeTabs(
    params: BridgeMethodMap["tabs.close"]["params"],
    windowId?: string
  ) {
    return this.request("tabs.close", params, { windowId });
  }

  async selectTab(
    params: BridgeMethodMap["tabs.select"]["params"],
    windowId?: string
  ) {
    return this.request("tabs.select", params, {
      windowId,
      timeoutMs: 30_000,
    });
  }

  async readTab(
    params: BridgeMethodMap["tabs.read"]["params"],
    windowId?: string
  ): Promise<PageReadResult> {
    return this.request("tabs.read", params, {
      windowId,
      timeoutMs: 25_000,
    });
  }

  async listFolders(windowId?: string) {
    return this.request("folders.list", undefined, { windowId });
  }

  async createFolder(
    params: BridgeMethodMap["folders.create"]["params"],
    windowId?: string
  ) {
    return this.request("folders.create", params, {
      windowId,
      timeoutMs: 30_000,
    });
  }

  async addTabsToFolder(
    params: BridgeMethodMap["folders.addTabs"]["params"],
    windowId?: string
  ) {
    return this.request("folders.addTabs", params, { windowId });
  }

  async searchHistory(
    params: BridgeMethodMap["history.search"]["params"],
    windowId?: string
  ) {
    return this.request("history.search", params, { windowId });
  }

  async searchBookmarks(
    params: BridgeMethodMap["bookmarks.search"]["params"],
    windowId?: string
  ) {
    return this.request("bookmarks.search", params, { windowId });
  }

  async ask(
    question: string,
    options: UiOption[],
    askOptions: AskOptions = {}
  ): Promise<AskResult> {
    const connection = (() => {
      try {
        return this.#connectionFor(askOptions.windowId);
      } catch {
        return null;
      }
    })();
    if (!connection) {
      return {
        status: "unavailable",
        questionId: "",
        message:
          "No Zen window is attached, so the question could not be shown in the browser.",
      };
    }

    const id = `q-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const payload: UiQuestion = {
      id,
      question: question.trim(),
      context: askOptions.context?.trim() || undefined,
      options,
      allowFreeform: askOptions.allowFreeform !== false,
      multiSelect: askOptions.multiSelect === true,
      createdAt: now,
    };
    const waitSeconds = Math.max(
      0,
      Math.min(600, askOptions.waitSeconds ?? 120)
    );

    const entry: PendingQuestion = {
      question: payload,
      askedAt: now,
      status: "pending",
      deferred: false,
      windowId: connection.windowId,
      resolve: null,
      timer: null,
    };
    this.#pendingQuestions.set(id, entry);

    const sent = this.#send(connection, { type: "ui.ask", question: payload });
    if (!sent) {
      return {
        status: "unavailable",
        questionId: id,
        message:
          "The Zen window closed its agent connection before the question could be shown.",
      };
    }

    if (waitSeconds === 0) {
      return {
        status: "pending",
        questionId: id,
        message: "Question shown in Zen. Poll zen_answers for the reply.",
      };
    }

    return new Promise<AskResult>((resolve) => {
      entry.resolve = (result) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        resolve(result);
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const waiter = entry.resolve;
        entry.resolve = null;
        waiter?.({
          status: "pending",
          questionId: id,
          waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1000),
          message:
            "No answer yet. The question is still open in Zen; use zen_answers to check for a late reply.",
        });
      }, waitSeconds * 1000);
      entry.timer.unref?.();
    });
  }

  async notify(options: NotifyOptions): Promise<{ delivered: boolean; windowId?: string }> {
    const connection = (() => {
      try {
        return this.#connectionFor(options.windowId);
      } catch {
        return null;
      }
    })();
    if (!connection) return { delivered: false };

    const actions: UiActivityAction[] = [];
    if (options.action?.space) {
      actions.push({
        id: "open-space",
        label: options.action.label || "Open space",
        kind: "space",
        target: options.action.space,
      });
    }
    const activity: UiActivity = {
      id: options.id || `a-${randomUUID().slice(0, 8)}`,
      title: options.title.trim(),
      detail: options.detail?.trim() || undefined,
      tone: options.tone ?? "info",
      actions,
      autoHideMs: Math.max(0, Math.min(120_000, options.autoHideMs ?? 12_000)),
    };
    const delivered = this.#send(connection, {
      type: "ui.activity",
      activity,
    });
    return { delivered, windowId: connection.windowId };
  }

  answers(): AnswersResult {
    const pending: AnswerInboxEntry[] = [...this.#pendingQuestions.values()]
      .sort((a, b) => a.askedAt - b.askedAt)
      .map((entry) => ({
        question: entry.question,
        status: entry.deferred ? "deferred" : "pending",
        askedAt: entry.askedAt,
      }));
    return {
      pending,
      answered: [...this.#answeredQuestions],
    };
  }

  connectedWindows(): Array<{
    windowId: string;
    focused: boolean;
    appVersion: string;
    platform: string;
  }> {
    return [...this.#connections.values()].map((connection) => ({
      windowId: connection.windowId,
      focused: connection.focused,
      appVersion: connection.appVersion,
      platform: connection.platform,
    }));
  }

  #onAnswer(
    id: string,
    message: Extract<BridgeToServer, { type: "ui.answer" }>
  ): void {
    const entry = this.#pendingQuestions.get(id);
    if (!entry) return;
    const status = message.status === "deferred" ? "deferred" : "answered";
    if (status === "deferred") {
      entry.deferred = true;
      entry.status = "pending";
      if (entry.resolve) {
        const waiter = entry.resolve;
        entry.resolve = null;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        waiter({
          status: "deferred",
          questionId: id,
          message:
            "The user asked to answer later. The question is still open in Zen.",
          waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1000),
        });
      }
      return;
    }

    entry.status = "answered";
    entry.answer = typeof message.answer === "string" ? message.answer : undefined;
    entry.selectedLabels = Array.isArray(message.selectedLabels)
      ? message.selectedLabels.map(String).slice(0, 20)
      : undefined;
    entry.freeform = message.freeform === true;
    entry.answeredAt = Date.now();

    const entryForInbox: AnswerInboxEntry = {
      question: entry.question,
      status: "answered",
      askedAt: entry.askedAt,
      answeredAt: entry.answeredAt,
      answer: entry.answer,
      selectedLabels: entry.selectedLabels,
      freeform: entry.freeform,
    };
    this.#answeredQuestions.unshift(entryForInbox);
    if (this.#answeredQuestions.length > 50) {
      this.#answeredQuestions.length = 50;
    }
    this.#pendingQuestions.delete(id);

    if (entry.resolve) {
      const waiter = entry.resolve;
      entry.resolve = null;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      waiter({
        status: "answered",
        questionId: id,
        answer: entry.answer,
        selectedLabels: entry.selectedLabels,
        freeform: entry.freeform,
        waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1000),
      });
    }
  }

  #resendPendingQuestions(connection: BridgeConnection): void {
    if (this.#primaryWindowId && this.#primaryWindowId !== connection.windowId) {
      return;
    }
    const cutoff = Date.now() - RESEND_QUESTION_MAX_AGE_MS;
    let count = 0;
    for (const entry of this.#pendingQuestions.values()) {
      if (entry.status !== "pending" || entry.deferred) continue;
      if (entry.askedAt < cutoff) continue;
      if (count >= 5) break;
      const sent = this.#send(connection, {
        type: "ui.ask",
        question: entry.question,
      });
      if (sent) {
        entry.windowId = connection.windowId;
        count++;
      }
    }
    if (count) {
      this.#logger.debug(`re-sent ${count} pending question(s) to the browser`);
    }
  }

  async ensureInjected(options: { force?: boolean; waitMs?: number } = {}): Promise<InjectionSummary> {
    const now = Date.now();
    if (
      !options.force &&
      this.#lastInjection &&
      this.#connections.size > 0 &&
      now - this.#lastInjectAt < 5_000
    ) {
      return this.#lastInjection;
    }

    const deadline = now + (options.waitMs ?? 25_000);
    let summary: InjectionSummary = emptySummary();
    while (Date.now() < deadline) {
      summary = await this.#injectOnce();
      this.#lastInjection = summary;
      this.#lastInjectAt = Date.now();

      if (summary.injected > 0 || summary.reconnected > 0) {
        const connected = await this.#waitForConnection(2_000);
        if (connected) return summary;
      }
      if (summary.pending === 0 && this.#connections.size > 0) {
        return summary;
      }
      if (summary.windows === 0) {
        // Zen has no browser window yet; keep waiting for startup.
        await sleep(400);
        continue;
      }
      if (summary.pending === 0 && summary.injected === 0 && summary.reused === 0) {
        return summary;
      }
      await sleep(350);
    }
    return summary;
  }

  async #injectOnce(): Promise<InjectionSummary> {
    if (!this.#url) {
      throw new Error("BridgeHub.start() must be called before injecting");
    }
    const config = {
      url: this.#url,
      token: this.#token,
      bridgeVersion: this.#serverVersion,
      serverVersion: this.#serverVersion,
    };
    const script = buildInjectionScript(
      config,
      {
        alias: RESOURCE_ALIAS,
        bridgeDir: this.#bridgeDir,
        bridgeFile: this.#bridgeFile,
      }
    );

    try {
      const raw = await this.#marionette.executeChrome<InjectionSummary>(script, {
        timeoutMs: 25_000,
      });
      return normalizeInjectionSummary(raw);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      this.#logger.warn(`bridge injection failed: ${message}`);
      return { ...emptySummary(), errors: [message] };
    }
  }

  async #waitForConnection(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.#connections.size > 0) return true;
      await sleep(120);
    }
    return this.#connections.size > 0;
  }

  async stop(): Promise<void> {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;

    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BridgeUnavailableError("Zen Sidekick is shutting down")
      );
    }
    this.#pendingRequests.clear();

    for (const entry of this.#pendingQuestions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.resolve?.({
        status: "unavailable",
        questionId: entry.question.id,
        message: "Zen Sidekick stopped before the question was answered.",
      });
      entry.resolve = null;
    }

    for (const connection of this.#connections.values()) {
      try {
        if (connection.ws.readyState === 1) {
          connection.ws.send(
            JSON.stringify({ type: "shutdown", reason: "server stopping" })
          );
        }
        connection.ws.close(1001, "server stopping");
      } catch {
        connection.ws.terminate();
      }
    }
    this.#connections.clear();
    this.#primaryWindowId = null;

    const server = this.#server;
    this.#server = null;
    this.#started = false;
    this.#url = null;
    if (server) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function emptySummary(): InjectionSummary {
  return {
    windows: 0,
    injected: 0,
    reused: 0,
    reconnected: 0,
    pending: 0,
    errors: [],
  };
}

function normalizeInjectionSummary(raw: unknown): InjectionSummary {
  const value = (raw ?? {}) as Partial<InjectionSummary>;
  const number = (input: unknown): number =>
    Number.isFinite(Number(input)) ? Number(input) : 0;
  return {
    windows: number(value.windows),
    injected: number(value.injected),
    reused: number(value.reused),
    reconnected: number(value.reconnected),
    pending: number(value.pending),
    errors: Array.isArray(value.errors) ? value.errors.map(String).slice(0, 10) : [],
  };
}

function buildInjectionScript(
  config: {
    url: string;
    token: string;
    bridgeVersion: string;
    serverVersion: string;
  },
  resource: { alias: string; bridgeDir: string; bridgeFile: string }
): string {
  const payload = JSON.stringify({
    config,
    resourceAlias: resource.alias,
    bridgeDir: resource.bridgeDir,
    bridgeFile: resource.bridgeFile,
  });
  return `
const __cfg = ${payload};
const results = { windows: 0, injected: 0, reused: 0, reconnected: 0, pending: 0, errors: [] };
const enumerator = Services.wm.getEnumerator("navigator:browser");
const windows = [];
while (enumerator.hasMoreElements()) windows.push(enumerator.getNext());
results.windows = windows.length;
let resourceReady = false;

for (const target of windows) {
  try {
    if (!target || target.closed) continue;
    const existing = target.__zenSidekickBridge;
    if (existing) {
      if (
        existing.version === __cfg.config.bridgeVersion &&
        existing.token === __cfg.config.token
      ) {
        if (existing.isConnected()) {
          results.reused++;
          continue;
        }
        existing.reconnect();
        results.reconnected++;
        continue;
      }
      try { existing.destroy(); } catch (e) {}
    }
    if (!target.gZenStartup || !target.gZenStartup.isReady) {
      results.pending++;
      continue;
    }
    if (!resourceReady) {
      const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
      file.initWithPath(__cfg.bridgeDir);
      const protocol = Services.io.getProtocolHandler("resource")
        .QueryInterface(Components.interfaces.nsIResProtocolHandler);
      protocol.setSubstitution(__cfg.resourceAlias, Services.io.newFileURI(file));
      resourceReady = true;
    }
    target.__zenSidekickConfig = {
      url: __cfg.config.url,
      token: __cfg.config.token,
      bridgeVersion: __cfg.config.bridgeVersion,
      serverVersion: __cfg.config.serverVersion,
    };
    Services.scriptloader.loadSubScript(
      "resource://" + __cfg.resourceAlias + "/" + __cfg.bridgeFile,
      target,
      "UTF-8"
    );
    results.injected++;
  } catch (error) {
    results.errors.push(String((error && (error.stack || error.message)) || error));
  }
}
return results;
`;
}

function resolveBridgeScriptPath(): string {
  const candidates: string[] = [];
  if (process.env.ZEN_SIDEKICK_BRIDGE_SCRIPT) {
    candidates.push(process.env.ZEN_SIDEKICK_BRIDGE_SCRIPT);
  }
  try {
    candidates.push(fileURLToPath(new URL("./bridge.js", import.meta.url)));
  } catch {
    // import.meta is unavailable in some odd bundler modes.
  }
  try {
    candidates.push(fileURLToPath(new URL("../../dist/bridge.js", import.meta.url)));
  } catch {
    // Ignore.
  }
  candidates.push(join(process.cwd(), "dist", "bridge.js"));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? join(process.cwd(), "dist", "bridge.js");
}

function isLoopback(address: string): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

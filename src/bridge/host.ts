import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket, WebSocketServer as WsServer } from "ws";
import { WebSocketServer } from "ws";
import { BRIDGE_PROTOCOL_VERSION, SERVER_VERSION } from "../shared/brand.js";
import {
  AUTH_FAILED_CLOSE_CODE,
  AUTH_NONCE_BYTES,
  AUTH_REQUIRED_CLOSE_CODE,
  AUTH_TIMEOUT_CLOSE_CODE,
  AUTH_TIMEOUT_MS,
  clientAuthMessage,
  serverAuthMessage,
} from "../shared/bridge-auth.js";
import { BRIDGE_PATH } from "../shared/protocol.js";
import type {
  ActivityTone,
  AgentEvent,
  AnswerInboxEntry,
  AnswersResult,
  AskResult,
  BridgeMethod,
  BridgeMethodMap,
  BridgeResponse,
  BridgeStatus,
  BridgeToServer,
  ContainerInfo,
  CreateSpaceResult,
  EventsResult,
  EvidenceClearResult,
  EvidenceOpResult,
  OpenTabsResult,
  PageReadResult,
  ServerToBridge,
  TextSearchResult,
  UiActivity,
  UiActivityAction,
  UiBanner,
  UiConsent,
  UiOption,
  UiProgress,
  UiQuestion,
} from "../shared/protocol.js";
import {
  hostOf,
  isUrlAllowed,
  normalizeWebUrl,
} from "../shared/url-policy.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { MarionetteClient } from "../zen/marionette.js";

const RESOURCE_ALIAS = "zen-mcp-bridge";
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
  /** Hostname allowlist applied to navigation and page content. */
  allowedDomains?: string[];
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
  /** Removes the timeout and any abort listener; safe to call twice. */
  cleanup(): void;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const CANCELLED_MESSAGE = "The request was cancelled by the client.";

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

export type NotifyAction =
  | { label: string; space: string }
  | { label: string; tab: string };

export interface NotifyOptions {
  title: string;
  detail?: string;
  tone?: ActivityTone;
  action?: NotifyAction;
  autoHideMs?: number;
  id?: string;
  windowId?: string;
}

export interface ProgressOptions {
  title?: string;
  step?: string;
  detail?: string;
  progress?: number;
  tone?: ActivityTone;
  stoppable?: boolean;
  /** Hide the card and acknowledge a Stop request. */
  done?: boolean;
  id?: string;
  windowId?: string;
}

export interface ProgressResult {
  delivered: boolean;
  windowId?: string;
  progress: UiProgress | null;
}

export type ConsentOutcome = "granted" | "denied" | "timeout";

interface PendingConsent {
  consent: UiConsent;
  state: "pending" | "granted" | "denied";
}

const MAX_EVENTS = 200;
const MAX_EVENT_WAIT_SECONDS = 25;

export class BridgeHub {
  readonly #marionette: MarionetteClient;
  readonly #logger: Logger;
  readonly #serverVersion: string;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #bridgeScriptPath: string;
  readonly #bridgeDir: string;
  readonly #bridgeFile: string;
  readonly #allowedDomains: string[];

  #server: WsServer | null = null;
  #url: string | null = null;
  #port = 0;
  #pingTimer: NodeJS.Timeout | null = null;

  readonly #connections = new Map<string, BridgeConnection>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pendingQuestions = new Map<string, PendingQuestion>();
  readonly #answeredQuestions: AnswerInboxEntry[] = [];

  readonly #events: AgentEvent[] = [];
  #eventSeq = 0;
  #eventWaiters: Array<() => void> = [];
  #progress: UiProgress | null = null;
  #stopRequestedAt: number | null = null;

  #paused = false;
  #pausedAt: number | null = null;
  #accessGranted = false;
  #consent: PendingConsent | null = null;
  readonly #consentWaiters = new Set<(outcome: ConsentOutcome) => void>();
  #banner: UiBanner | null = null;
  #activeBanner: UiBanner = {
    state: "active",
    text: "Zen MCP is controlling this window",
    detail: "Press Pause to block every read and change immediately.",
  };

  #primaryWindowId: string | null = null;
  #requestSeq = 0;
  #lastInjectAt = 0;
  #lastInjection: InjectionSummary | null = null;
  #started = false;

  constructor(options: BridgeHubOptions) {
    this.#marionette = options.marionette;
    this.#logger = options.logger ?? createLogger("bridge");
    this.#serverVersion = options.serverVersion ?? SERVER_VERSION;
    this.#bridgeScriptPath = resolve(
      options.bridgeScriptPath ?? resolveBridgeScriptPath()
    );
    this.#bridgeDir = dirname(this.#bridgeScriptPath);
    this.#bridgeFile = basename(this.#bridgeScriptPath);
    this.#allowedDomains = [...(options.allowedDomains ?? [])];
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

  /** True while a bridge request is in flight. */
  get busy(): boolean {
    return this.#pendingRequests.size > 0;
  }

  /** True after the user pressed Pause in the browser. */
  get paused(): boolean {
    return this.#paused;
  }

  get pausedAt(): number | null {
    return this.#pausedAt;
  }

  get consentState(): "none" | "pending" | "granted" | "denied" {
    if (this.#accessGranted) return "granted";
    return this.#consent?.state ?? "none";
  }

  get banner(): UiBanner | null {
    return this.#banner;
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
          "(or reinstall Zen MCP) before starting the server."
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
    this.#url = `ws://127.0.0.1:${this.#port}${BRIDGE_PATH}`;
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
      ws.close(AUTH_FAILED_CLOSE_CODE, "loopback only");
      return;
    }

    // A fresh nonce per connection makes every proof single-use. A hostile
    // listener that captured an earlier handshake cannot replay it here.
    const serverNonce = randomBytes(AUTH_NONCE_BYTES).toString("base64url");
    const expectedClientProof = this.#proof(clientAuthMessage(serverNonce));

    let connection: BridgeConnection | null = null;
    let authenticated = false;
    let registered = false;
    const handshakeTimer = setTimeout(() => {
      if (!registered) ws.close(AUTH_TIMEOUT_CLOSE_CODE, "handshake timeout");
    }, AUTH_TIMEOUT_MS);
    handshakeTimer.unref?.();

    if (!sendRaw(ws, { type: "auth.challenge", nonce: serverNonce })) {
      clearTimeout(handshakeTimer);
      ws.terminate();
      return;
    }

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

      if (!authenticated) {
        // Nothing but the proof is accepted before the handshake completes.
        // This is what stops a crashed-then-hijacked port from issuing
        // commands to a bridge that reconnects on its own.
        if (message.type !== "auth.response") {
          ws.close(AUTH_REQUIRED_CLOSE_CODE, "authentication required");
          return;
        }
        const clientNonce =
          typeof message.nonce === "string" ? message.nonce : "";
        const proof = typeof message.proof === "string" ? message.proof : "";
        if (!clientNonce || clientNonce.length > 512) {
          ws.close(AUTH_FAILED_CLOSE_CODE, "authentication failed");
          return;
        }
        if (!tokensEqual(proof, expectedClientProof)) {
          this.#logger.warn("rejecting bridge connection with a bad auth proof");
          ws.close(AUTH_FAILED_CLOSE_CODE, "authentication failed");
          return;
        }
        authenticated = true;
        if (
          !sendRaw(ws, {
            type: "auth.confirm",
            nonce: clientNonce,
            proof: this.#proof(serverAuthMessage(clientNonce)),
          })
        ) {
          ws.terminate();
        }
        return;
      }

      if (message.type === "hello") {
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
        clearTimeout(handshakeTimer);
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
        if (this.#banner) {
          this.#send(connection, { type: "ui.banner", banner: this.#banner });
        }
        if (this.#consent?.state === "pending") {
          this.#send(connection, {
            type: "ui.consent",
            consent: this.#consent.consent,
          });
        }
        if (this.#progress) {
          this.#send(connection, { type: "ui.progress", progress: this.#progress });
        }
        return;
      }

      if (!registered || !connection) {
        ws.close(AUTH_REQUIRED_CLOSE_CODE, "hello required");
        return;
      }
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
        case "ui.stop": {
          this.#onStop(
            connection,
            message as Extract<BridgeToServer, { type: "ui.stop" }>
          );
          return;
        }
        case "ui.consentResult": {
          this.#onConsentResult(
            String(message.id ?? ""),
            message.granted === true
          );
          return;
        }
        case "ui.bannerAction": {
          if (message.action === "pause") {
            this.pause("The user paused Zen MCP from the browser banner.");
          } else if (message.action === "resume") {
            this.resume();
          }
          return;
        }
        case "res": {
          const pending = this.#pendingRequests.get(String(message.id ?? ""));
          if (!pending) return;
          if (pending.windowId && pending.windowId !== connection.windowId) {
            this.#logger.warn(
              `response for ${pending.id} arrived from an unexpected window`
            );
            return;
          }
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
      clearTimeout(handshakeTimer);
      if (connection && this.#connections.get(connection.windowId) === connection) {
        this.#connections.delete(connection.windowId);
        if (this.#primaryWindowId === connection.windowId) {
          this.#primaryWindowId = this.#connections.keys().next().value ?? null;
        }
        this.#logger.info(`bridge disconnected from window ${connection.windowId}`);
        for (const pending of [...this.#pendingRequests.values()]) {
          if (pending.windowId === connection.windowId) {
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
          `No Zen MCP bridge is connected for window ${windowId}`
        );
      }
      return connection;
    }
    const connection = this.#primaryConnection();
    if (!connection) {
      throw new BridgeUnavailableError(
        "No Zen window is connected to Zen MCP. Launch Zen through " +
          "Zen MCP (zen_launch) so the agent bridge can attach."
      );
    }
    return connection;
  }

  #broadcast(message: ServerToBridge): void {
    for (const connection of this.#connections.values()) {
      this.#send(connection, message);
    }
  }

  #setBanner(banner: UiBanner | null): void {
    this.#banner = banner;
    this.#broadcast({ type: "ui.banner", banner });
  }

  /** Sets the wording of the banner shown while access is granted. */
  configureActiveBanner(banner: { text: string; detail?: string }): void {
    this.#activeBanner = {
      state: "active",
      text: banner.text.trim(),
      detail: banner.detail?.trim() || undefined,
    };
    if (this.#accessGranted && !this.#paused) {
      this.#setBanner(this.#activeBanner);
    }
  }

  /** Marks access approved without a card (consent disabled by config). */
  grantAccess(): void {
    this.#accessGranted = true;
    if (!this.#paused) {
      this.#setBanner(this.#activeBanner);
    }
  }

  /**
   * Shows the consent card and resolves once the user clicks, or "timeout"
   * when the wait expires. A timeout leaves the card visible and the session
   * unapproved, so a later tool call can wait again.
   */
  requestConsent(options: {
    consent: UiConsent;
    timeoutMs?: number;
  }): Promise<ConsentOutcome> {
    if (this.#accessGranted) {
      return Promise.resolve("granted");
    }
    if (this.#consent?.state === "granted") {
      return Promise.resolve("granted");
    }
    if (this.#consent?.state === "denied") {
      return Promise.resolve("denied");
    }
    if (!this.#consent) {
      this.#consent = { consent: options.consent, state: "pending" };
      this.#setBanner({
        state: "pending",
        text: "Zen MCP is waiting for your approval",
        detail: "Approve the card before any page is read or changed.",
      });
    }
    this.#broadcast({ type: "ui.consent", consent: this.#consent.consent });

    return new Promise<ConsentOutcome>((resolve) => {
      const finish = (outcome: ConsentOutcome) => {
        this.#consentWaiters.delete(finish);
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish("timeout"),
        Math.max(1, options.timeoutMs ?? 90_000)
      );
      timer.unref?.();
      this.#consentWaiters.add(finish);
    });
  }

  #onConsentResult(id: string, granted: boolean): void {
    const entry = this.#consent;
    if (!entry || entry.state !== "pending" || entry.consent.id !== id) {
      return;
    }
    entry.state = granted ? "granted" : "denied";
    this.#accessGranted = granted;
    this.#broadcast({ type: "ui.consentCancel", id });
    if (granted) {
      this.#setBanner(this.#paused ? this.#pausedBanner() : this.#activeBanner);
    } else {
      this.#setBanner({
        state: "pending",
        text: "Access declined",
        detail: "Zen MCP is closing this browser.",
      });
    }
    const waiters = [...this.#consentWaiters];
    this.#consentWaiters.clear();
    for (const waiter of waiters) {
      waiter(granted ? "granted" : "denied");
    }
    this.#logger.info(
      granted ? "browser access approved" : "browser access declined"
    );
  }

  #pausedBanner(): UiBanner {
    return {
      state: "paused",
      text: "Zen MCP is paused",
      detail: "The agent cannot read or change pages. Press Resume to allow it again.",
    };
  }

  /**
   * Global stop. Rejects in-flight work, hides progress, and blocks every
   * operation until the user presses Resume in the browser.
   */
  pause(reason: string): void {
    if (this.#paused || !this.#accessGranted) return;
    this.#paused = true;
    this.#pausedAt = Date.now();
    this.#setBanner(this.#pausedBanner());

    const message =
      "The user paused Zen MCP in the browser. No reads or changes are " +
      "allowed until they press Resume.";
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeRequestError("paused", message));
    }
    this.#pendingRequests.clear();
    this.#progress = null;
    this.#stopRequestedAt = null;
    this.#broadcast({ type: "ui.progress", progress: null });
    this.#deferPendingQuestions(message);
    this.pushEvent({
      kind: "pause",
      title: "Agent paused in Zen",
      detail: reason,
    });
    this.#logger.info("agent access paused in the browser");
  }

  resume(): void {
    if (!this.#paused || !this.#accessGranted) return;
    this.#paused = false;
    this.#pausedAt = null;
    this.#setBanner(this.#activeBanner);
    this.pushEvent({
      kind: "resume",
      title: "Agent resumed in Zen",
      detail: "The user pressed Resume in the browser.",
    });
    this.#logger.info("agent access resumed in the browser");
  }

  #assertActive(): void {
    if (!this.#accessGranted) {
      throw new BridgeRequestError(
        "consent_required",
        "Zen access has not been approved in the browser yet. Approve the card " +
          "in Zen and call the tool again."
      );
    }
    if (!this.#paused) return;
    throw new BridgeRequestError(
      "paused",
      "The user paused Zen MCP in the browser. No reads or changes are " +
        "allowed until they press Resume."
    );
  }

  #proof(message: string): string {
    return createHmac("sha256", this.#token).update(message).digest("base64url");
  }

  /** Throws when a URL is outside the configured domain allowlist. */
  #assertUrlAllowed(url: string, action: string): void {
    if (isUrlAllowed(url, this.#allowedDomains)) return;
    const target = hostOf(url) ?? url;
    throw new BridgeRequestError(
      "domain_not_allowed",
      `${action} ${target}, which is outside the configured domain allowlist. ` +
        "Update allowedDomains in the Zen MCP config to permit it."
    );
  }

  #deferPendingQuestions(reason: string): void {
    for (const entry of [...this.#pendingQuestions.values()]) {
      if (entry.status !== "pending" || entry.deferred) continue;
      entry.deferred = true;
      this.#sendToWindow(entry.windowId, {
        type: "ui.cancel",
        id: entry.question.id,
      });
      const waiter = entry.resolve;
      entry.resolve = null;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      waiter?.({
        status: "deferred",
        questionId: entry.question.id,
        message: `The user paused Zen MCP, so the question was put aside. ${reason}`,
        waitedSeconds: Math.round((Date.now() - entry.askedAt) / 1000),
      });
    }
  }


  async request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options: {
      windowId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<BridgeMethodMap[T]["result"]> {
    this.#assertActive();
    if (options.signal?.aborted) {
      throw new BridgeRequestError("cancelled", CANCELLED_MESSAGE);
    }
    const connection = this.#connectionFor(options.windowId);
    const id = `r-${++this.#requestSeq}-${randomUUID().slice(0, 8)}`;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const signal = options.signal;

    return new Promise<BridgeMethodMap[T]["result"]>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#pendingRequests.delete(id);
        fn();
      };
      const onAbort = () => {
        // The Marionette command may keep running in the browser; stop waiting
        // and record that it was abandoned rather than reporting success.
        this.#logger.debug(`abandoned "${method}" after client cancellation`);
        settle(() => reject(new BridgeRequestError("cancelled", CANCELLED_MESSAGE)));
      };
      timer = setTimeout(() => {
        settle(() =>
          reject(
            new BridgeRequestError(
              "bridge_timeout",
              `The Zen window did not finish "${method}" within ${Math.round(
                timeoutMs / 1000
              )}s`
            )
          )
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pendingRequests.set(id, {
        id,
        method,
        windowId: connection.windowId,
        timer,
        cleanup,
        resolve: (value) => settle(() => resolve(value as BridgeMethodMap[T]["result"])),
        reject: (error) => settle(() => reject(error)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const sent = this.#send(connection, {
        type: "req",
        id,
        method,
        params: params as unknown,
      });
      if (!sent) {
        settle(() =>
          reject(
            new BridgeUnavailableError(
              "The Zen window closed its agent connection. Reconnecting may fix this."
            )
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
    const requested = Array.isArray(params?.urls) ? params.urls : [];
    for (const url of requested) {
      this.#assertUrlAllowed(String(url ?? ""), "Refusing to open");
    }
    const result = await this.request("tabs.open", params, {
      windowId,
      timeoutMs: 35_000,
    });
    // A requested URL can redirect somewhere else. Close those tabs instead
    // of leaving the agent with a window into a domain it may not touch.
    const blocked = result.tabs.filter((tab) => {
      const final = normalizeWebUrl(tab.url)
        ? tab.url
        : (tab.requestedUrl || tab.url);
      return !isUrlAllowed(final, this.#allowedDomains);
    });
    if (blocked.length > 0) {
      await this.closeTabs({
        tabIds: blocked.map((tab) => tab.id),
      }).catch(() => undefined);
      const hosts = [
        ...new Set(
          blocked.map(
            (tab) =>
              hostOf(tab.url) ??
              hostOf(tab.requestedUrl ?? "") ??
              tab.url
          )
        ),
      ].join(", ");
      throw new BridgeRequestError(
        "domain_not_allowed",
        `Refusing to keep tabs that ended up on ${hosts}, which is outside ` +
          "the configured domain allowlist. The tab(s) were closed."
      );
    }
    return result;
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
    windowId?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<PageReadResult> {
    const page = await this.request("tabs.read", params, {
      windowId,
      // PDF extraction waits for the viewer, and rich formats do more work.
      timeoutMs: 40_000,
      signal: options.signal,
    });
    if (page.url) {
      this.#assertUrlAllowed(page.url, "Refusing to return content from");
    }
    return page;
  }

  async showEvidence(
    params: BridgeMethodMap["tabs.evidence"]["params"],
    windowId?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<EvidenceOpResult> {
    const result = await this.request("tabs.evidence", params, {
      windowId,
      // The bridge waits for the page to load and may retry a stale match.
      timeoutMs: 45_000,
      signal: options.signal,
    });
    if (result.url) {
      this.#assertUrlAllowed(result.url, "Refusing to return evidence from");
    }
    return result;
  }

  async findText(
    params: BridgeMethodMap["tabs.findText"]["params"],
    windowId?: string,
    timeoutMs = 20_000
  ): Promise<TextSearchResult> {
    const result = await this.request("tabs.findText", params, {
      windowId,
      timeoutMs,
    });
    if (result.url) {
      this.#assertUrlAllowed(result.url, "Refusing to return text from");
    }
    return result;
  }

  async clearEvidence(
    params: BridgeMethodMap["tabs.evidenceClear"]["params"],
    windowId?: string
  ): Promise<EvidenceClearResult> {
    return this.request("tabs.evidenceClear", params, { windowId });
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

  async pinTabs(
    params: BridgeMethodMap["tabs.pin"]["params"],
    windowId?: string
  ) {
    return this.request("tabs.pin", params, { windowId, timeoutMs: 30_000 });
  }

  async addEssentials(
    params: BridgeMethodMap["essentials.add"]["params"],
    windowId?: string
  ) {
    return this.request("essentials.add", params, {
      windowId,
      timeoutMs: 30_000,
    });
  }

  async removeEssentials(
    params: BridgeMethodMap["essentials.remove"]["params"],
    windowId?: string
  ) {
    return this.request("essentials.remove", params, {
      windowId,
      timeoutMs: 30_000,
    });
  }

  async listContainers(windowId?: string): Promise<{ containers: ContainerInfo[] }> {
    return this.request("containers.list", undefined, { windowId });
  }

  async openGlance(
    params: BridgeMethodMap["glance.open"]["params"],
    windowId?: string
  ) {
    if (params?.url) {
      this.#assertUrlAllowed(String(params.url), "Refusing to preview");
    }
    const result = await this.request(
      "glance.open",
      { ...params, allowedDomains: this.#allowedDomains },
      {
        windowId,
        timeoutMs: 30_000,
      }
    );
    if (result.url) {
      this.#assertUrlAllowed(result.url, "Refusing to preview");
    }
    return result;
  }

  async openSplit(
    params: BridgeMethodMap["split.open"]["params"],
    windowId?: string
  ) {
    return this.request("split.open", params, { windowId, timeoutMs: 30_000 });
  }

  async closeSplit(
    params: BridgeMethodMap["split.close"]["params"],
    windowId?: string
  ) {
    return this.request("split.close", params, { windowId, timeoutMs: 30_000 });
  }

  async recentlyClosed(windowId?: string) {
    return this.request("history.recentlyClosed", undefined, { windowId });
  }

  async writeClipboard(
    params: BridgeMethodMap["clipboard.write"]["params"],
    windowId?: string
  ) {
    return this.request("clipboard.write", params, { windowId });
  }

  async ask(
    question: string,
    options: UiOption[],
    askOptions: AskOptions = {}
  ): Promise<AskResult> {
    if (!this.#accessGranted) {
      return {
        status: "unavailable",
        questionId: "",
        message:
          "Zen MCP has not been approved in the browser yet, so the question " +
          "was not shown. Approve the card in Zen and ask again.",
      };
    }
    if (this.#paused) {
      return {
        status: "unavailable",
        questionId: "",
        message:
          "Zen MCP is paused in the browser, so the question was not shown. " +
          "Ask again after the user presses Resume.",
      };
    }
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
    if (!this.#accessGranted || this.#paused) return { delivered: false };
    const connection = (() => {
      try {
        return this.#connectionFor(options.windowId);
      } catch {
        return null;
      }
    })();
    if (!connection) return { delivered: false };

    const actions: UiActivityAction[] = [];
    if (options.action && "space" in options.action && options.action.space) {
      actions.push({
        id: "open-space",
        label: options.action.label || "Open space",
        kind: "space",
        target: options.action.space,
      });
    } else if (options.action && "tab" in options.action && options.action.tab) {
      actions.push({
        id: "show-source",
        label: options.action.label || "Show source",
        kind: "tab",
        target: options.action.tab,
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

  progress(options: ProgressOptions): ProgressResult {
    if (!this.#accessGranted && !options.done) {
      return { delivered: false, progress: null };
    }
    if (this.#paused && !options.done) {
      return { delivered: false, progress: null };
    }
    const connection = (() => {
      try {
        return this.#connectionFor(options.windowId);
      } catch {
        return null;
      }
    })();
    if (!connection) {
      return { delivered: false, progress: null };
    }

    if (options.done) {
      const previous = this.#progress;
      this.#progress = null;
      this.#stopRequestedAt = null;
      this.#send(connection, { type: "ui.progress", progress: null });
      return {
        delivered: true,
        windowId: connection.windowId,
        progress: previous,
      };
    }

    const previous = this.#progress;
    const title = options.title?.trim() || previous?.title || "Working";
    const progress: UiProgress = {
      id: options.id || previous?.id || `p-${randomUUID().slice(0, 8)}`,
      title,
      step: options.step?.trim() || undefined,
      detail: options.detail?.trim() || undefined,
      progress: Number.isFinite(options.progress)
        ? Math.max(0, Math.min(1, Number(options.progress)))
        : undefined,
      tone: options.tone ?? previous?.tone ?? "info",
      startedAt: previous?.startedAt ?? Date.now(),
      stoppable: options.stoppable ?? previous?.stoppable ?? true,
      stopRequested: previous?.stopRequested === true,
    };
    this.#progress = progress;
    const delivered = this.#send(connection, {
      type: "ui.progress",
      progress,
    });
    return { delivered, windowId: connection.windowId, progress };
  }

  /**
   * Adds an event for agents that poll `events()`. Events are retained for the
   * life of the server so a later tool call can still see a Stop request.
   */
  pushEvent(
    input: {
      kind: AgentEvent["kind"];
      title: string;
      detail?: string;
      windowId?: string;
      tabId?: string;
      watchId?: string;
      questionId?: string;
    }
  ): AgentEvent {
    const event: AgentEvent = {
      id: ++this.#eventSeq,
      at: Date.now(),
      ...input,
    };
    this.#events.push(event);
    while (this.#events.length > MAX_EVENTS) this.#events.shift();
    const waiters = this.#eventWaiters;
    this.#eventWaiters = [];
    for (const waiter of waiters) {
      try {
        waiter();
      } catch {
        // Waiter cleanup is best effort.
      }
    }
    return event;
  }

  async events(
    options: { after?: number; waitSeconds?: number } = {}
  ): Promise<EventsResult> {
    const after = Number.isFinite(options.after) ? Number(options.after) : 0;
    const waitSeconds = Math.max(
      0,
      Math.min(MAX_EVENT_WAIT_SECONDS, options.waitSeconds ?? 0)
    );
    if (waitSeconds > 0 && !this.#events.some((event) => event.id > after)) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, waitSeconds * 1000);
        timer.unref?.();
        this.#eventWaiters.push(() => {
          clearTimeout(timer);
          finish();
        });
      });
    }
    return this.#eventsResult(after);
  }

  #eventsResult(after: number): EventsResult {
    const events = this.#events.filter((event) => event.id > after);
    const last = events[events.length - 1];
    return {
      events,
      cursor: last ? last.id : Math.max(after, this.#eventSeq),
      stopped: this.#paused || this.#stopRequestedAt !== null,
      paused: this.#paused,
      lastEventAt:
        this.#events.length > 0
          ? this.#events[this.#events.length - 1].at
          : null,
    };
  }

  #onStop(
    connection: BridgeConnection,
    message: Extract<BridgeToServer, { type: "ui.stop" }>
  ): void {
    const progress = this.#progress;
    if (!progress) {
      this.#logger.debug("ignoring Stop with no active progress card");
      return;
    }
    if (message.progressId && message.progressId !== progress.id) {
      this.#logger.debug("ignoring Stop for a replaced progress card");
      return;
    }
    this.#stopRequestedAt = Date.now();
    this.#progress = { ...progress, stopRequested: true };
    this.#send(connection, {
      type: "ui.progress",
      progress: this.#progress,
    });
    this.pushEvent({
      kind: "stop",
      title: "Stop requested in Zen",
      detail: progress.title,
      windowId: connection.windowId,
    });
    this.#logger.info(`user requested Stop for "${progress.title}"`);
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
      this.pushEvent({
        kind: "question",
        title: "User deferred a question",
        detail: entry.question.question.slice(0, 200),
        questionId: id,
        windowId: entry.windowId ?? undefined,
      });
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
    this.pushEvent({
      kind: "question",
      title: "Answer received in Zen",
      detail: (
        entry.selectedLabels?.join(", ") ||
        entry.answer ||
        entry.question.question
      ).slice(0, 300),
      questionId: id,
      windowId: entry.windowId ?? undefined,
    });

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

    const waiters = this.#eventWaiters;
    this.#eventWaiters = [];
    for (const waiter of waiters) {
      try {
        waiter();
      } catch {
        // Best effort.
      }
    }
    this.#progress = null;
    this.#stopRequestedAt = null;

    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BridgeUnavailableError("Zen MCP is shutting down")
      );
    }
    this.#pendingRequests.clear();

    for (const entry of this.#pendingQuestions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.resolve?.({
        status: "unavailable",
        questionId: entry.question.id,
        message: "Zen MCP stopped before the question was answered.",
      });
      entry.resolve = null;
    }

    const consentWaiters = [...this.#consentWaiters];
    this.#consentWaiters.clear();
    for (const waiter of consentWaiters) {
      waiter("timeout");
    }
    this.#consent = null;
    this.#banner = null;
    this.#accessGranted = false;
    this.#paused = false;
    this.#pausedAt = null;

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
let privateUtils = null;
try {
  privateUtils = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
  ).PrivateBrowsingUtils;
} catch (error) {
  try {
    privateUtils = ChromeUtils.import(
      "resource://gre/modules/PrivateBrowsingUtils.jsm"
    ).PrivateBrowsingUtils;
  } catch (fallbackError) {
    privateUtils = null;
  }
}
const isPrivateWindow = (target) => {
  try {
    if (target.document?.documentElement?.getAttribute("privatebrowsingmode")) {
      return true;
    }
  } catch (error) {
    // Fall through to the official helper.
  }
  if (!privateUtils) return false;
  try {
    return privateUtils.isWindowPrivate(target);
  } catch (error) {
    return true;
  }
};
const enumerator = Services.wm.getEnumerator("navigator:browser");
const windows = [];
let privateWindows = 0;
while (enumerator.hasMoreElements()) {
  const target = enumerator.getNext();
  if (isPrivateWindow(target)) {
    privateWindows++;
    try { target.__zenMcpBridge?.destroy(); } catch (error) {}
    continue;
  }
  windows.push(target);
}
results.windows = windows.length;
if (windows.length === 0 && privateWindows > 0) {
  results.errors.push(
    "Zen MCP never attaches to private browsing windows. Open a normal " +
      "window to let the agent connect."
  );
}
let resourceReady = false;

for (const target of windows) {
  try {
    if (!target || target.closed) continue;
    const existing = target.__zenMcpBridge;
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
    target.__zenMcpConfig = {
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
    const message = String((error && (error.message || error)) || error);
    const name = String((error && error.name) || "");
    const stack = String((error && error.stack) || "");
    results.errors.push(
      (name && name !== "Error" ? name + ": " : "") +
        message +
        (stack ? "\\n" + stack : "")
    );
  }
}
return results;
`;
}

export function resolveBridgeScriptPath(): string {
  const candidates: string[] = [];
  if (process.env.ZEN_MCP_BRIDGE_SCRIPT) {
    candidates.push(process.env.ZEN_MCP_BRIDGE_SCRIPT);
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

function sendRaw(ws: WebSocket, message: ServerToBridge): boolean {
  if (ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

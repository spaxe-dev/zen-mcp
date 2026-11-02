import net from "node:net";
import { createLogger, type Logger } from "../utils/logger.js";

/**
 * Minimal, dependency-free client for Firefox's Marionette protocol (v3).
 *
 * Zen/Firefox only exposes its chrome scope over Marionette when it is started
 * with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, so this client is intended for
 * harness-owned launches. See `launcher.ts`.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 2828;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export type MarionetteContext = "chrome" | "content";

export interface MarionetteErrorPayload {
  error?: string;
  message?: string;
  stacktrace?: string;
}

export class MarionetteError extends Error {
  override name = "MarionetteError";
  readonly code: string;

  constructor(payload: MarionetteErrorPayload | string) {
    const message =
      typeof payload === "string"
        ? payload
        : payload.message || payload.error || "Marionette command failed";
    super(message);
    this.code =
      typeof payload === "string" ? "command" : payload.error ?? "command";
    if (typeof payload !== "string" && payload.stacktrace) {
      this.stack = payload.stacktrace;
    }
  }
}

export class MarionetteConnectionError extends Error {
  override name = "MarionetteConnectionError";
}

export interface MarionetteClientOptions {
  host?: string;
  port?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  scriptTimeoutMs?: number;
  logger?: Logger;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  name: string;
}

interface MarionetteSession {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

/**
 * The shape returned by `WebDriver:ExecuteAsyncScript` after the Zen MCP
 * wrapper has run.
 */
interface WrappedScriptResult {
  __zenMcpOk?: boolean;
  value?: unknown;
  error?: string;
}

export interface LockdownResult {
  ok: boolean;
  reason?: string;
  competingSessions?: number;
  closedConnections?: number;
  listenerClosed?: boolean;
  mySession?: number;
  connections?: number;
  error?: string;
}

function describeLockdown(result: LockdownResult | null | undefined): string {
  if (!result) return "the browser returned no result";
  const parts = [result.reason ?? "unknown reason"];
  if (typeof result.competingSessions === "number") {
    parts.push(`${result.competingSessions} competing session(s)`);
  }
  if (typeof result.mySession === "number") {
    parts.push(`own session count ${result.mySession}`);
  }
  if (result.error) parts.push(result.error);
  return parts.join(", ");
}

export class MarionetteClient {
  readonly host: string;
  readonly port: number;

  readonly #connectTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #scriptTimeoutMs: number;
  readonly #logger: Logger;

  #socket: net.Socket | null = null;
  #buffer = Buffer.alloc(0);
  #pending = new Map<number, PendingCommand>();
  #nextCommandId = 1;
  #handshake: Promise<Record<string, unknown>> | null = null;
  #session: MarionetteSession | null = null;
  #context: MarionetteContext = "content";
  #connecting: Promise<void> | null = null;
  #closed = false;
  #handshakePacket: Record<string, unknown> | null = null;

  /** Serializes content-context switching, which is global session state. */
  #contentQueue: Promise<unknown> = Promise.resolve();

  constructor(options: MarionetteClientOptions = {}) {
    this.host = options.host ?? process.env.ZEN_MCP_MARIONETTE_HOST ?? DEFAULT_HOST;
    this.port =
      options.port ?? Number(process.env.ZEN_MCP_MARIONETTE_PORT ?? DEFAULT_PORT);
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 8_000;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.#scriptTimeoutMs = options.scriptTimeoutMs ?? 120_000;
    this.#logger = options.logger ?? createLogger("marionette");
  }

  get isConnected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  get context(): MarionetteContext {
    return this.#context;
  }

  get sessionId(): string | null {
    return this.#session?.sessionId ?? null;
  }

  /** Capabilities returned by `WebDriver:NewSession`. */
  get capabilities(): Record<string, unknown> {
    return this.#session?.capabilities ?? {};
  }

  /**
   * The browser process id reported by Gecko. On Windows the spawned pid can
   * belong to a short-lived launcher, so this is the pid to watch or kill.
   */
  get browserProcessId(): number | null {
    const value = this.capabilities["moz:processID"];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  get profilePath(): string | null {
    const value = this.capabilities["moz:profile"];
    return typeof value === "string" && value ? value : null;
  }

  /**
   * Connects, completes the protocol handshake and creates a chrome-context
   * session. Safe to call repeatedly.
   */
  async connect(): Promise<void> {
    if (this.#session && this.isConnected) return;
    if (this.#connecting) return this.#connecting;

    this.#connecting = this.#doConnect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #doConnect(): Promise<void> {
    this.#closed = false;
    this.#handshakePacket = null;
    this.#handshake = null;
    this.#logger.debug(`connecting to ${this.host}:${this.port}`);
    const socket = await this.#openSocket();
    this.#socket = socket;
    this.#buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("close", () => this.#onClose(socket));
    socket.on("error", (error: Error) => {
      this.#logger.debug(`socket error: ${error.message}`);
    });

    try {
      await this.#waitForHandshake();
      await this.#startSession();
    } catch (error) {
      socket.destroy();
      if (this.#socket === socket) {
        this.#socket = null;
        this.#session = null;
        this.#handshake = null;
        this.#handshakePacket = null;
      }
      throw error;
    }

    this.#logger.info(`Marionette session ready on ${this.host}:${this.port}`);
  }

  #openSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new MarionetteConnectionError(
            `Timed out connecting to Marionette at ${this.host}:${this.port}. ` +
              "Zen must be launched by Zen MCP (or with -marionette and " +
              "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1)."
          )
        );
      }, this.#connectTimeoutMs);

      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        reject(
          new MarionetteConnectionError(
            `Could not reach Marionette at ${this.host}:${this.port}: ${error.message}`
          )
        );
      };
      const onConnect = () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(socket);
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  #waitForHandshake(): Promise<Record<string, unknown>> {
    if (this.#handshakePacket) {
      return Promise.resolve(this.#handshakePacket);
    }
    if (this.#handshake) return this.#handshake;
    this.#handshake = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new MarionetteConnectionError("Marionette did not send a handshake packet")
        );
      }, this.#connectTimeoutMs);
      const finish = (packet: Record<string, unknown>) => {
        clearTimeout(timer);
        this.#handshakePacket = packet;
        this.#handshake = null;
        this.#handshakeResolve = null;
        resolve(packet);
      };
      this.#handshakeResolve = finish;
    });
    return this.#handshake;
  }

  #handshakeResolve: ((packet: Record<string, unknown>) => void) | null = null;

  async #startSession(): Promise<void> {
    const session = (await this.sendRaw("WebDriver:NewSession", {
      capabilities: {},
    })) as MarionetteSession;
    if (!session?.sessionId) {
      throw new MarionetteConnectionError("Marionette refused to create a session");
    }
    this.#session = session;
    await this.sendRaw("WebDriver:SetTimeouts", {
      script: this.#scriptTimeoutMs,
      pageLoad: this.#commandTimeoutMs,
      implicit: 0,
    });
    await this.setContext("chrome");
  }

  /**
   * Sends a raw Marionette command. Most callers should prefer `executeChrome`
   * or `executeScript`, which unwrap the WebDriver `{ value }` envelope.
   */
  sendRaw<T = unknown>(
    name: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.#commandTimeoutMs
  ): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new MarionetteConnectionError("Marionette is not connected")
      );
    }
    if (!this.#session && name !== "WebDriver:NewSession") {
      return Promise.reject(
        new MarionetteConnectionError("Marionette session is not ready")
      );
    }

    const id = this.#nextCommandId++;
    const payload = JSON.stringify([0, id, name, params]);
    const length = Buffer.byteLength(payload, "utf8");

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new MarionetteError(
            `Marionette command "${name}" timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        name,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });

      socket.write(`${length}:${payload}`);
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const colon = this.#buffer.indexOf(0x3a);
      if (colon === -1) return;

      const header = this.#buffer.subarray(0, colon).toString("ascii");
      if (!/^\d+$/.test(header)) {
        // A stray byte stream means the protocol is out of sync. Drop the
        // connection; the next tool call reconnects.
        this.#logger.warn(`Unexpected Marionette frame header "${header.slice(0, 32)}"`);
        this.#socket?.destroy();
        return;
      }

      const length = Number(header);
      if (length > MAX_FRAME_BYTES) {
        this.#logger.error(`Refusing oversized Marionette frame (${length} bytes)`);
        this.#socket?.destroy();
        return;
      }

      const start = colon + 1;
      if (this.#buffer.length < start + length) return;

      const raw = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);

      let packet: unknown;
      try {
        packet = JSON.parse(raw);
      } catch (error) {
        this.#logger.warn(`Malformed Marionette packet: ${(error as Error).message}`);
        continue;
      }

      this.#dispatch(packet);
    }
  }

  #dispatch(packet: unknown): void {
    if (Array.isArray(packet)) {
      const [kind, id, error, result] = packet as [
        number,
        number,
        MarionetteErrorPayload | null,
        unknown,
      ];
      if (kind === 1) {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (error) {
          this.#logger.debug(
            `command ${pending.name} [${id}] failed: ${
              typeof error === "string" ? error : error.message
            }`
          );
          pending.reject(new MarionetteError(error));
        } else {
          pending.resolve(result);
        }
        return;
      }
      // Incoming commands (kind 0) are not used by Zen MCP.
      this.#logger.debug(`Ignoring Marionette packet array: ${JSON.stringify(packet).slice(0, 200)}`);
      return;
    }

    if (packet && typeof packet === "object" && "applicationType" in packet) {
      const info = packet as Record<string, unknown>;
      this.#logger.debug(
        `handshake from ${String(info.applicationType)} protocol ${String(
          info.marionetteProtocol
        )}`
      );
      this.#handshakeResolve?.(info);
      return;
    }

    this.#logger.debug(`Ignoring Marionette packet: ${JSON.stringify(packet).slice(0, 200)}`);
  }

  #onClose(socket: net.Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#session = null;
    const error = new MarionetteConnectionError("Marionette connection closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#handshake = null;
    this.#handshakePacket = null;
    if (!this.#closed) {
      this.#logger.debug("Marionette connection closed");
    }
  }

  async setContext(context: MarionetteContext): Promise<void> {
    if (this.#context === context && this.#session) return;
    await this.sendRaw("Marionette:SetContext", { value: context });
    this.#context = context;
  }

  getWindowHandles(): Promise<string[]> {
    return this.sendRaw<string[]>("WebDriver:GetWindowHandles", {});
  }

  async getWindowHandle(): Promise<string> {
    const handle = await this.sendRaw<string>("WebDriver:GetWindowHandle", {});
    return handle;
  }

  async switchToWindow(handle: string, options: { focus?: boolean } = {}): Promise<void> {
    // Reads must never steal the user's selection or window focus. Gecko
    // defaults SwitchToWindow to focus=true, which selects the tab, so pass
    // focus:false explicitly.
    await this.sendRaw("WebDriver:SwitchToWindow", {
      handle,
      focus: options.focus === true,
    });
  }

  /**
   * Runs a script body in the current content context. The body is the inside
   * of an async function; use `return` to produce a value. This always uses
   * the async command because the wrapper resolves a promise, and Gecko's
   * synchronous command would only return the (null) promise object.
   */
  async executeScript<T = unknown>(
    body: string,
    args: unknown[] = [],
    timeoutMs = this.#commandTimeoutMs
  ): Promise<T> {
    const result = await this.#sendScriptCommand(
      "WebDriver:ExecuteAsyncScript",
      body,
      args,
      timeoutMs
    );
    return result as T;
  }

  async executeAsyncScript<T = unknown>(
    body: string,
    args: unknown[] = [],
    timeoutMs = this.#commandTimeoutMs
  ): Promise<T> {
    const result = await this.#sendScriptCommand(
      "WebDriver:ExecuteAsyncScript",
      body,
      args,
      timeoutMs
    );
    return result as T;
  }

  async #sendScriptCommand(
    command: string,
    body: string,
    args: unknown[],
    timeoutMs: number
  ): Promise<unknown> {
    const response = await this.sendRaw<{ value?: unknown }>(
      command,
      {
        script: wrapScript(body),
        args,
      },
      timeoutMs
    );
    const wrapped = (response?.value ?? response) as WrappedScriptResult | null;
    if (wrapped && typeof wrapped === "object" && "__zenMcpOk" in wrapped) {
      if (wrapped.__zenMcpOk) return wrapped.value;
      throw new MarionetteError(
        typeof wrapped.error === "string"
          ? wrapped.error
          : "Script threw an unknown error"
      );
    }
    return wrapped;
  }

  async #withTimeout<T>(
    name: string,
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new MarionetteError(`${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs a script body in browser chrome. Chrome scripts can reach Zen's
   * internals (`gZenWorkspaces`, `gBrowser`, ...) and must return values that
   * are JSON-serializable.
   */
  async executeChrome<T = unknown>(
    body: string,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    await this.setContext("chrome");
    return this.executeAsyncScript<T>(
      body,
      [],
      options.timeoutMs ?? this.#commandTimeoutMs
    );
  }

  /**
   * Temporarily switches to a content window and runs `body` there. Calls are
   * serialized because the Marionette context is shared by the whole session.
   */
  executeInContent<T = unknown>(
    handle: string,
    body: string,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const previous = this.#context;
      try {
        await this.setContext("content");
        await this.switchToWindow(handle);
        return await this.executeScript<T>(body, [], options.timeoutMs ?? this.#commandTimeoutMs);
      } finally {
        // Restore chrome context even if the script failed. The window
        // selection is left alone; chrome scripts target windows explicitly.
        if (previous === "chrome") {
          try {
            await this.setContext("chrome");
          } catch {
            // The connection may be gone; the next call reconnects.
          }
        }
      }
    };

    const result = this.#contentQueue.then(run, run);
    this.#contentQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Closes every Marionette connection except this session, then stops the
   * browser from accepting new ones. Zen has no Marionette authentication, so
   * any local process that reaches the port before this runs could create a
   * chrome session. The lockdown makes this session the only one and removes
   * the listening socket for the rest of the browser's life.
   */
  async lockdown(): Promise<LockdownResult> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new MarionetteConnectionError(
        "Cannot lock down Marionette before a session exists"
      );
    }
    const result = await this.executeChrome<LockdownResult>(
      `
      const mod = ChromeUtils.importESModule(
        "chrome://remote/content/components/Marionette.sys.mjs"
      );
      const server = mod.Marionette && mod.Marionette.server;
      if (!server) return { ok: false, reason: "no-server" };
      const ours = ${JSON.stringify(sessionId)};
      const conns = Array.from(server.conns || []);
      const mine = conns.filter(
        (conn) => conn.driver && conn.driver.currentSession &&
          conn.driver.currentSession.id === ours
      );
      if (mine.length !== 1) {
        return {
          ok: false,
          reason: "session-not-found",
          mySession: mine.length,
          connections: conns.length,
        };
      }
      const others = conns.filter((conn) => conn !== mine[0]);
      const competing = others.filter(
        (conn) => conn.driver && conn.driver.currentSession
      );
      let closed = 0;
      for (const conn of others) {
        try {
          conn.conn.close();
          closed++;
        } catch (error) {}
      }
      try {
        await server.setAcceptConnections(false);
      } catch (error) {
        return {
          ok: false,
          reason: "listener-close-failed",
          error: String((error && error.message) || error),
          competingSessions: competing.length,
          closedConnections: closed,
        };
      }
      return {
        ok: competing.length === 0 && !server.socket,
        competingSessions: competing.length,
        closedConnections: closed,
        listenerClosed: !server.socket,
      };
      `,
      { timeoutMs: 15_000 }
    );
    if (!result?.ok) {
      throw new MarionetteConnectionError(
        `Marionette lockdown failed: ${describeLockdown(result)}`
      );
    }
    return result;
  }

  /**
   * Asks Gecko to quit. The socket usually closes before the reply arrives,
   * so callers should treat a connection error as success and verify the
   * process id instead.
   */
  async quit(options: { force?: boolean } = {}): Promise<void> {
    await this.sendRaw(
      "Marionette:Quit",
      { flags: [options.force ? "eForceQuit" : "eAttemptQuit"] },
      5_000
    );
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#session = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }
}

/**
 * Wraps a script body so that both sync return values and async rejections are
 * reported faithfully. The wrapper receives the WebDriver async callback as
 * its last argument.
 */
export function wrapScript(body: string): string {
  return [
    "const __zenMcpDone = arguments[arguments.length - 1];",
    // Gecko's Error.stack contains frames only, with no name or message line,
    // so report all three. Otherwise a sandbox failure arrives as line numbers
    // with no explanation.
    "const __zenMcpDescribe = (error) => {",
    "  try {",
    "    if (!error || typeof error !== 'object') return String(error);",
    "    const name = error.name ? String(error.name) : 'Error';",
    "    const message = error.message ? String(error.message) : String(error);",
    "    const stack = error.stack ? String(error.stack) : '';",
    "    return stack ? name + ': ' + message + '\\n' + stack : name + ': ' + message;",
    "  } catch (describeError) {",
    "    return 'Script threw an error that could not be described';",
    "  }",
    "};",
    "(async () => {",
    body,
    "})().then(",
    "  (value) => __zenMcpDone({ __zenMcpOk: true, value }),",
    "  (error) => __zenMcpDone({",
    "    __zenMcpOk: false,",
    "    error: __zenMcpDescribe(error),",
    "  })",
    ");",
  ].join("\n");
}

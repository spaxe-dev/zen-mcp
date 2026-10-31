import {
  BridgeHub,
  BridgeUnavailableError,
  type AskOptions,
  type InjectionSummary,
  type NotifyOptions,
} from "../bridge/host.js";
import type { SidekickConfig } from "../config.js";
import type {
  AnswersResult,
  AskResult,
  BridgeMethod,
  BridgeMethodMap,
  BridgeStatus,
  PageReadResult,
  UiOption,
} from "../shared/protocol.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { isPortOpen, launchZen, ZenLaunchError } from "./launcher.js";
import { MarionetteClient } from "./marionette.js";
import { readActivePage, readTabPage } from "./page.js";

export interface ConnectResult {
  launched: boolean;
  injection: InjectionSummary;
}

export interface ZenRuntimeOptions {
  config: SidekickConfig;
  bridgeScriptPath?: string;
  logger?: Logger;
}

export class ZenRuntime {
  readonly config: SidekickConfig;
  readonly marionette: MarionetteClient;
  readonly hub: BridgeHub;
  readonly #logger: Logger;

  #ensurePromise: Promise<ConnectResult> | null = null;
  #closed = false;

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
    });
  }

  async start(): Promise<void> {
    await this.hub.start();
  }

  /**
   * Makes sure Zen is running with agent access, a Marionette session exists
   * and at least one browser window has the sidekick bridge attached.
   */
  connect(options: { allowLaunch?: boolean } = {}): Promise<ConnectResult> {
    if (this.#closed) {
      return Promise.reject(new Error("Zen Sidekick has shut down"));
    }
    if (!this.#ensurePromise) {
      const allowLaunch = options.allowLaunch ?? this.config.autoLaunch;
      this.#ensurePromise = this.#connectOnce(allowLaunch).finally(() => {
        this.#ensurePromise = null;
      });
    }
    return this.#ensurePromise;
  }

  async #connectOnce(allowLaunch: boolean): Promise<ConnectResult> {
    await this.hub.start();
    let launched = false;

    if (!this.marionette.isConnected) {
      // Marionette briefly stops accepting connections while it tears down a
      // probe or a previous session, so give an existing server a real chance
      // before deciding that Zen is not running.
      let lastError: unknown = null;
      const probeUntil = Date.now() + 2_500;
      let connected = false;
      for (;;) {
        try {
          await this.marionette.connect();
          connected = true;
          break;
        } catch (error) {
          lastError = error;
          if (Date.now() >= probeUntil) break;
          await sleep(300);
        }
      }

      if (!connected) {
        if (await isPortOpen(this.config.marionettePort)) {
          throw new ZenLaunchError(
            `Marionette is listening on port ${this.config.marionettePort}, ` +
              `but the session could not be created: ${
                (lastError as Error)?.message ?? lastError
              }. Zen must be started by Zen Sidekick so this session has ` +
              "chrome access."
          );
        }
        if (!allowLaunch) {
          throw new ZenLaunchError(
            `Zen is not running. Start it with Zen Sidekick (zen_launch, or ` +
              `"zen-sidekick launch") so Marionette is enabled for this session.`
          );
        }
        await launchZen({ config: this.config });
        launched = true;

        const deadline = Date.now() + 20_000;
        for (;;) {
          try {
            await this.marionette.connect();
            break;
          } catch (error) {
            lastError = error;
            if (Date.now() >= deadline) {
              throw new ZenLaunchError(
                `Marionette is listening on port ${this.config.marionettePort}, ` +
                  `but the session could not be created: ${
                    (error as Error)?.message ?? error
                  }`
              );
            }
            await sleep(400);
          }
        }
      }
    }

    const injection = await this.hub.ensureInjected({
      force: launched,
      waitMs: 30_000,
    });

    if (this.hub.connectionCount === 0) {
      const detail = injection.errors.length
        ? ` Last error: ${injection.errors[0]}`
        : "";
      throw new BridgeUnavailableError(
        "Zen is running, but the agent bridge could not attach to a browser " +
          `window.${detail} If Zen was already open before Zen Sidekick launched ` +
          "it, quit Zen and run zen_launch again. Otherwise run `zen-sidekick doctor`."
      );
    }

    return { launched, injection };
  }

  async request<T extends BridgeMethod>(
    method: T,
    params: BridgeMethodMap[T]["params"],
    options: { windowId?: string; timeoutMs?: number; allowLaunch?: boolean } = {}
  ): Promise<BridgeMethodMap[T]["result"]> {
    await this.connect({ allowLaunch: options.allowLaunch });
    return this.hub.request(method, params, options);
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

  async readPage(
    options: { windowId?: string; maxChars?: number; tabId?: string } = {}
  ): Promise<PageReadResult> {
    await this.connect();
    if (options.tabId) {
      return readTabPage(this.marionette, this.hub, options.tabId, options);
    }
    return readActivePage(this.marionette, this.hub, options);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.hub.stop().catch(() => undefined);
    await this.marionette.disconnect().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import type {
  ProcessIdentity,
  ProcessProbe,
  ProcessProbeResult,
} from "./process-identity.js";

export type BrowserLifecycleState =
  | "none"
  | "owned_connected"
  | "lost_process_alive"
  | "lost_process_unknown"
  | "confirmed_exited"
  | "relaunch_in_progress"
  | "recovery_failed";

export interface LaunchIdentity {
  launchedPid: number;
  browserPid: number | null;
  profile: string | null;
  launchedAt: number;
  launchedIdentity?: ProcessIdentity;
  browserIdentity?: ProcessIdentity;
}

/**
 * The minimal record kept after a locked-down Marionette session is lost.
 * Deliberately excludes the launch nonce, bridge token, sockets and session
 * ids: those are authentication/connection state and must not outlive it.
 */
export interface RecoveryRecord {
  state: BrowserLifecycleState;
  previousLaunchedPid: number;
  previousBrowserPid: number | null;
  profile: string | null;
  launchedAt: number;
  launchedIdentity?: ProcessIdentity;
  browserIdentity?: ProcessIdentity;
  lostAt: string;
  lossReason: string;
  lastError?: string;
}

export interface BrowserRecoveryInfo {
  state: BrowserLifecycleState;
  previousBrowserPid: number | null;
  processAlive: "alive" | "exited" | "unknown";
  canRelaunch: boolean;
  lostAt: string | null;
  lastError: string | null;
}

export interface ConnectDecision {
  allowed: boolean;
  /** True when the caller must be an explicit zen_launch, not a normal tool. */
  explicitRequired: boolean;
  reason: string;
}

export class BrowserLifecycle {
  #state: BrowserLifecycleState = "none";
  #record: RecoveryRecord | null = null;
  #processAlive: "alive" | "exited" | "unknown" = "exited";

  constructor(private readonly probe: ProcessProbe) {}

  get state(): BrowserLifecycleState {
    return this.#state;
  }

  get record(): RecoveryRecord | null {
    return this.#record;
  }

  markConnected(): void {
    this.#state = "owned_connected";
    this.#record = null;
    this.#processAlive = "alive";
  }

  markNone(): void {
    this.#state = "none";
    this.#record = null;
    this.#processAlive = "exited";
  }

  /**
   * Called when the locked-down Marionette socket closes. The caller has
   * already discarded its Ownership object and connection secrets.
   */
  async markLost(
    launch: LaunchIdentity,
    reason: string
  ): Promise<RecoveryRecord> {
    const record: RecoveryRecord = {
      state: "lost_process_unknown",
      previousLaunchedPid: launch.launchedPid,
      previousBrowserPid: launch.browserPid,
      profile: launch.profile,
      launchedAt: launch.launchedAt,
      launchedIdentity: launch.launchedIdentity,
      browserIdentity: launch.browserIdentity,
      lostAt: new Date().toISOString(),
      lossReason: reason,
    };
    let browser: ProcessProbeResult = { status: "unknown", reason: "no browser identity" };
    let launched: ProcessProbeResult = { status: "unknown", reason: "no launcher identity" };

    if (record.browserIdentity) {
      browser = await this.probe.verify(record.browserIdentity);
    }
    if (record.launchedIdentity) {
      launched = await this.probe.verify(record.launchedIdentity);
    }

    if (browser.status === "unknown" || !record.browserIdentity) {
      record.state = "lost_process_unknown";
      this.#processAlive = "unknown";
    } else if (browser.status === "alive") {
      record.state = "lost_process_alive";
      this.#processAlive = "alive";
    } else if (launched.status === "alive") {
      // The browser PID is gone but the launched wrapper is still alive. It
      // may still hold the profile; fail closed rather than race it.
      record.state = "lost_process_alive";
      this.#processAlive = "alive";
    } else if (launched.status === "unknown") {
      record.state = "lost_process_unknown";
      this.#processAlive = "unknown";
    } else {
      record.state = "confirmed_exited";
      this.#processAlive = "exited";
    }

    this.#state = record.state;
    this.#record = record;
    return record;
  }

  /** Re-probes a previous process before an explicit relaunch. */
  async refresh(): Promise<RecoveryRecord | null> {
    const record = this.#record;
    if (!record) return null;
    if (!record.browserIdentity) {
      record.state = "lost_process_unknown";
      this.#state = record.state;
      this.#processAlive = "unknown";
      return record;
    }
    const browser = await this.probe.verify(record.browserIdentity);
    if (browser.status === "unknown") {
      record.state = "lost_process_unknown";
      this.#processAlive = "unknown";
    } else if (browser.status === "alive") {
      record.state = "lost_process_alive";
      this.#processAlive = "alive";
    } else {
      const launched = record.launchedIdentity
        ? await this.probe.verify(record.launchedIdentity)
        : ({ status: "exited" } as ProcessProbeResult);
      if (launched.status === "alive") {
        record.state = "lost_process_alive";
        this.#processAlive = "alive";
      } else if (launched.status === "unknown") {
        record.state = "lost_process_unknown";
        this.#processAlive = "unknown";
      } else {
        record.state = "confirmed_exited";
        this.#processAlive = "exited";
      }
    }
    this.#state = record.state;
    return record;
  }

  markRelaunching(): void {
    this.#state = "relaunch_in_progress";
    if (this.#record) this.#record.state = this.#state;
  }

  markRelaunchFailed(error: unknown): void {
    this.#state = "recovery_failed";
    if (this.#record) {
      this.#record.state = this.#state;
      this.#record.lastError = String((error as Error)?.message ?? error).slice(
        0,
        300
      );
    }
  }

  decision(explicitLaunch: boolean): ConnectDecision {
    switch (this.#state) {
      case "none":
        return { allowed: true, explicitRequired: false, reason: "no owned browser yet" };
      case "owned_connected":
        return { allowed: true, explicitRequired: false, reason: "already connected" };
      case "relaunch_in_progress":
        return {
          allowed: true,
          explicitRequired: true,
          reason: "a relaunch is already in progress",
        };
      case "confirmed_exited":
        return {
          allowed: explicitLaunch,
          explicitRequired: true,
          reason: explicitLaunch
            ? "previous process confirmed exited"
            : "the previous owned browser exited; call zen_launch to recover",
        };
      case "recovery_failed":
        return {
          allowed: explicitLaunch,
          explicitRequired: true,
          reason: explicitLaunch
            ? "retrying an explicit recovery"
            : "the previous recovery failed; call zen_launch to retry",
        };
      case "lost_process_alive":
        return {
          allowed: false,
          explicitRequired: true,
          reason:
            "the previously owned browser is still running; quit it before calling zen_launch",
        };
      case "lost_process_unknown":
        return {
          allowed: false,
          explicitRequired: true,
          reason:
            "the previously owned browser's exit cannot be verified; quit it before calling zen_launch",
        };
    }
  }

  info(): BrowserRecoveryInfo {
    return {
      state: this.#state,
      previousBrowserPid: this.#record?.previousBrowserPid ?? null,
      processAlive: this.#processAlive,
      canRelaunch:
        this.#state === "confirmed_exited" ||
        this.#state === "recovery_failed" ||
        this.#state === "none",
      lostAt: this.#record?.lostAt ?? null,
      lastError: this.#record?.lastError ?? null,
    };
  }
}

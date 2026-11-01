import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ProgressReporter {
  /** False when the client did not supply a progress token. */
  readonly enabled: boolean;
  /**
   * Sends one progress notification. Values must rise; regressions and
   * duplicates are dropped. Everything is best effort and never throws.
   */
  report(progress: number, total?: number, message?: string): void;
}

const NOOP: ProgressReporter = {
  enabled: false,
  report() {
    // Intentionally empty: the client did not ask for progress.
  },
};

/**
 * Builds a reporter bound to one request. The same token is reused for the
 * whole call, as the MCP progress contract requires.
 */
export function createProgressReporter(
  extra?: Pick<ToolExtra, "sendNotification" | "_meta">
): ProgressReporter {
  const token = extra?._meta?.progressToken;
  if (extra === undefined || token === undefined || token === null) {
    return NOOP;
  }
  let last = Number.NEGATIVE_INFINITY;
  return {
    enabled: true,
    report(progress, total, message) {
      if (!Number.isFinite(progress) || progress <= last) return;
      last = progress;
      const params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      } = { progressToken: token, progress };
      if (typeof total === "number" && Number.isFinite(total)) {
        params.total = total;
      }
      if (message) {
        params.message = message;
      }
      try {
        void Promise.resolve(
          extra.sendNotification({
            method: "notifications/progress",
            params,
          })
        ).catch(() => undefined);
      } catch {
        // Notification failures must never surface as tool failures.
      }
    },
  };
}

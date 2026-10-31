export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(prefix = "zen-mcp"): Logger {
  const rawLevel = (process.env.ZEN_MCP_LOG ?? "info").toLowerCase();
  const level: LogLevel =
    rawLevel in LEVELS ? (rawLevel as LogLevel) : "info";
  const min = LEVELS[level];

  const write =
    (lvl: LogLevel) =>
    (message: string, ...args: unknown[]): void => {
      if (LEVELS[lvl] < min) return;
      const stamp = new Date().toISOString().slice(11, 19);
      const line = `[${prefix} ${stamp}] ${message}`;
      // stdout belongs to the MCP transport. Diagnostics go to stderr.
      if (lvl === "error") console.error(line, ...args);
      else if (lvl === "warn") console.warn(line, ...args);
      else console.error(line, ...args);
    };

  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

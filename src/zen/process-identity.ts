import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  /** Platform-specific process start token. Equal tokens identify one process. */
  startToken: string;
  source: "win32" | "posix" | "test";
}

export type ProcessProbeResult =
  | { status: "alive"; identity: ProcessIdentity }
  | { status: "exited" }
  | { status: "unknown"; reason: string };

export interface ProcessProbe {
  probe(pid: number): Promise<ProcessProbeResult>;
  verify(identity: ProcessIdentity): Promise<ProcessProbeResult>;
}

/**
 * Reads PID plus a process-start token. A PID alone is never enough: Windows
 * and POSIX both reuse PIDs, so the start token is what distinguishes the
 * browser this server launched from a later process that inherited its number.
 */
export class SystemProcessProbe implements ProcessProbe {
  async probe(pid: number): Promise<ProcessProbeResult> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { status: "exited" };
    }
    if (process.platform === "win32") return this.#probeWindows(pid);
    if (process.platform === "linux") return this.#probeLinux(pid);
    return this.#probePosix(pid);
  }

  async verify(identity: ProcessIdentity): Promise<ProcessProbeResult> {
    const current = await this.probe(identity.pid);
    if (current.status !== "alive") return current;
    return current.identity.startToken === identity.startToken
      ? current
      : { status: "exited" };
  }

  async #probeWindows(pid: number): Promise<ProcessProbeResult> {
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
            "$p.StartTime.ToUniversalTime().ToString('o')",
        ],
        { timeout: 5_000, windowsHide: true, encoding: "utf8" }
      );
      const started = String(stdout).trim();
      if (!started) return { status: "unknown", reason: "empty process start time" };
      return {
        status: "alive",
        identity: { pid, startToken: `win32:${started}`, source: "win32" },
      };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (/cannot find a process|no process|not found|does not exist/i.test(message)) {
        return { status: "exited" };
      }
      return { status: "unknown", reason: message.slice(0, 200) };
    }
  }

  async #probeLinux(pid: number): Promise<ProcessProbeResult> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return { status: "unknown", reason: "malformed /proc stat" };
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      // After comm, index 0 is state (field 3); starttime is field 22.
      const start = fields[19];
      if (!start) return { status: "unknown", reason: "missing starttime" };
      return {
        status: "alive",
        identity: { pid, startToken: `linux:${start}`, source: "posix" },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return { status: "exited" };
      return {
        status: "unknown",
        reason: String((error as Error)?.message ?? error).slice(0, 200),
      };
    }
  }

  async #probePosix(pid: number): Promise<ProcessProbeResult> {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
        timeout: 5_000,
        encoding: "utf8",
      });
      const started = String(stdout).trim();
      if (!started) return { status: "exited" };
      return {
        status: "alive",
        identity: { pid, startToken: `ps:${started}`, source: "posix" },
      };
    } catch (error) {
      const code = (error as { code?: number | string })?.code;
      if (code === 1 || code === "1") return { status: "exited" };
      return {
        status: "unknown",
        reason: String((error as Error)?.message ?? error).slice(0, 200),
      };
    }
  }
}

/** Test seam used by lifecycle tests. */
export class StaticProcessProbe implements ProcessProbe {
  constructor(
    private readonly results: Map<number, ProcessProbeResult> = new Map()
  ) {}

  set(pid: number, result: ProcessProbeResult): void {
    this.results.set(pid, result);
  }

  async probe(pid: number): Promise<ProcessProbeResult> {
    return this.results.get(pid) ?? { status: "exited" };
  }

  async verify(identity: ProcessIdentity): Promise<ProcessProbeResult> {
    const result = await this.probe(identity.pid);
    if (result.status !== "alive") return result;
    return result.identity.startToken === identity.startToken
      ? result
      : { status: "exited" };
  }
}

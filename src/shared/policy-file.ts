/**
 * Atomic persistence for `policy.json`: bounded reads, strict validation,
 * revision checks, a short-lived single-writer lock and owner-only writes.
 *
 * No MCP tool may call this module. The CLI and, later, the chrome Control
 * Center are its only writers.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configFilePath } from "../config.js";
import {
  atomicWritePrivate,
  ensurePrivateDir,
  readFileTextBounded,
  PRIVATE_FILE_MODE,
} from "../utils/safe-file.js";
import {
  POLICY_MAX_BYTES,
  parsePolicyText,
  serializePolicy,
  validatePolicy,
  type PolicyValidationCode,
} from "./policy-schema.js";
import { policyDigest } from "./policy-digest.js";
import {
  createRestrictedPolicy,
  policyFromLegacyConfig,
  type LegacyPolicyConfig,
  type Policy,
  type PolicySnapshot,
  type PolicyWriter,
} from "./policy.js";

export const POLICY_FILE_NAME = "policy.json";
export const POLICY_LOCK_STALE_MS = 10_000;

export type PolicyFileErrorCode =
  | "policy_exists"
  | "policy_missing"
  | "invalid_policy"
  | "revision_conflict"
  | "locked"
  | "io_error";

export class PolicyFileError extends Error {
  readonly code: PolicyFileErrorCode;

  constructor(code: PolicyFileErrorCode, message: string) {
    super(message);
    this.name = "PolicyFileError";
    this.code = code;
  }
}

/** `<configDir>/policy.json`, beside `config.json`. */
export function policyFilePath(): string {
  return join(dirname(configFilePath()), POLICY_FILE_NAME);
}

export function policyLockFilePath(file: string = policyFilePath()): string {
  return `${file}.lock`;
}

export type PolicyReadResult =
  | { status: "missing" }
  | { status: "valid"; policy: Policy }
  | {
      status: "invalid";
      code: PolicyValidationCode | "io_error";
      message: string;
    };

export function readPolicyFile(file: string = policyFilePath()): PolicyReadResult {
  let text: string;
  try {
    text = readFileTextBounded(file, POLICY_MAX_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      code: "io_error",
      message: `Could not read the policy file (${code ?? "unknown error"}).`,
    };
  }
  const parsed = parsePolicyText(text);
  return parsed.ok
    ? { status: "valid", policy: parsed.policy }
    : {
        status: "invalid",
        code: parsed.code,
        message: parsed.message,
      };
}

function hasLegacySettings(legacy: LegacyPolicyConfig | undefined): boolean {
  return Boolean(
    legacy &&
      (legacy.readOnly === true || (legacy.allowedDomains ?? []).length > 0)
  );
}

function snapshotOf(
  policy: Policy,
  source: PolicySnapshot["source"],
  options: {
    revision?: number;
    warnings?: readonly string[];
    error?: string;
    errorCode?: string;
  } = {}
): PolicySnapshot {
  return {
    policy,
    source,
    revision: options.revision ?? policy.revision,
    digest: policyDigest(policy),
    updatedAt: policy.updatedAt,
    warnings: [...(options.warnings ?? [])],
    ...(options.error ? { error: options.error } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
  };
}

function invalidSnapshot(
  code: string,
  message: string,
  now: Date
): PolicySnapshot {
  return snapshotOf(createRestrictedPolicy(now), "invalid", {
    revision: 0,
    error: message,
    errorCode: code,
    warnings: [
      "The policy file could not be applied, so browser tools are denied. " +
        "Fix it or remove it and run `zen-mcp policy init`.",
    ],
  });
}

/**
 * Loads the effective policy. Missing policy files never widen access:
 * a default config runs restricted, while an explicit legacy `readOnly` or
 * `allowedDomains` is translated in memory for compatibility.
 */
export function loadPolicySnapshot(options: {
  file?: string;
  legacy?: LegacyPolicyConfig;
  now?: Date;
} = {}): PolicySnapshot {
  const file = options.file ?? policyFilePath();
  const now = options.now ?? new Date();
  const read = readPolicyFile(file);
  if (read.status === "valid") {
    return snapshotOf(read.policy, "file", {
      warnings: hasLegacySettings(options.legacy)
        ? [
            "config.json still sets readOnly or allowedDomains. The policy " +
              "file is authoritative for tools, but the legacy runtime checks " +
              "still apply and may deny more. Remove those keys from " +
              "config.json when the policy file should be the only rule set.",
          ]
        : [],
    });
  }
  if (read.status === "invalid") {
    return invalidSnapshot(read.code, read.message, now);
  }
  if (hasLegacySettings(options.legacy)) {
    const policy = policyFromLegacyConfig(options.legacy, now);
    return snapshotOf(policy, "legacy", {
      revision: 1,
      warnings: [
        "No policy file; using an in-memory policy derived from the legacy " +
          "readOnly/allowedDomains settings. Run `zen-mcp policy init` to " +
          "persist it.",
      ],
    });
  }
  return snapshotOf(createRestrictedPolicy(now), "default", {
    revision: 0,
    warnings: [
      "No policy file; browser access is restricted. Run `zen-mcp policy init` " +
        "to create one.",
    ],
  });
}

function policyFileSignature(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
}

/**
 * Polls the policy file's metadata and reports a new snapshot when it changes.
 * The browser bridge reads the same file independently, so this only keeps the
 * MCP guard and resources aligned; it is not the enforcement boundary.
 */
export function watchPolicySnapshot(options: {
  file?: string;
  legacy?: LegacyPolicyConfig;
  intervalMs?: number;
  onChange: (snapshot: PolicySnapshot) => void;
}): () => void {
  const file = options.file ?? policyFilePath();
  let signature = policyFileSignature(file);
  const interval = Math.max(200, options.intervalMs ?? 500);
  const timer = setInterval(() => {
    const next = policyFileSignature(file);
    if (next === signature) return;
    signature = next;
    try {
      options.onChange(loadPolicySnapshot({ file, legacy: options.legacy }));
    } catch {
      // A read failure leaves the previous snapshot enforced until it recovers.
    }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

function acquirePolicyLock(file: string): () => void {
  const lock = policyLockFilePath(file);
  ensurePrivateDir(dirname(lock));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", PRIVATE_FILE_MODE);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          // A missing lock is already released.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw new PolicyFileError(
          "io_error",
          `Could not lock the policy file (${(error as NodeJS.ErrnoException)?.code ?? "unknown error"}).`
        );
      }
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > POLICY_LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale && attempt === 0) {
        try {
          unlinkSync(lock);
        } catch {
          // Another writer may have released or reclaimed it.
        }
        continue;
      }
      throw new PolicyFileError(
        "locked",
        "Another Zen MCP process is writing the policy file. Try again."
      );
    }
  }
  throw new PolicyFileError(
    "locked",
    "Another Zen MCP process is writing the policy file. Try again."
  );
}

function writeUnderLock(
  file: string,
  policy: Policy,
  expectedRevision: number | undefined
): PolicySnapshot {
  const checked = validatePolicy(policy);
  if (!checked.ok) {
    throw new PolicyFileError(
      "invalid_policy",
      `Refusing to write an invalid policy: ${checked.message}`
    );
  }
  const current = readPolicyFile(file);
  if (current.status === "invalid") {
    throw new PolicyFileError(
      "invalid_policy",
      `The current policy file is invalid: ${current.message}`
    );
  }
  if (current.status === "missing") {
    if (expectedRevision !== undefined || checked.policy.revision !== 1) {
      throw new PolicyFileError(
        "revision_conflict",
        "The policy file changed while the update was prepared. Reload and try again."
      );
    }
  } else {
    const expected = expectedRevision ?? current.policy.revision;
    if (
      current.policy.revision !== expected ||
      checked.policy.revision !== current.policy.revision + 1
    ) {
      throw new PolicyFileError(
        "revision_conflict",
        "The policy file changed while the update was prepared. Reload and try again."
      );
    }
  }
  atomicWritePrivate(file, serializePolicy(checked.policy));
  return snapshotOf(checked.policy, "file");
}

export function savePolicyFile(
  policy: Policy,
  options: { file?: string; expectedRevision?: number } = {}
): PolicySnapshot {
  const file = options.file ?? policyFilePath();
  const release = acquirePolicyLock(file);
  try {
    return writeUnderLock(file, policy, options.expectedRevision);
  } finally {
    release();
  }
}

/** Applies a mutation to the current file with revision-conflict detection. */
export function updatePolicyFile(
  mutate: (policy: Policy) => void,
  options: {
    file?: string;
    now?: Date;
    writer?: PolicyWriter;
  } = {}
): PolicySnapshot {
  const file = options.file ?? policyFilePath();
  const now = options.now ?? new Date();
  const release = acquirePolicyLock(file);
  try {
    const current = readPolicyFile(file);
    if (current.status === "missing") {
      throw new PolicyFileError(
        "policy_missing",
        "No policy file exists. Run `zen-mcp policy init` first."
      );
    }
    if (current.status === "invalid") {
      throw new PolicyFileError(
        "invalid_policy",
        `The current policy file is invalid: ${current.message}`
      );
    }
    const draft = structuredClone(current.policy);
    mutate(draft);
    draft.revision = current.policy.revision + 1;
    draft.updatedAt = now.toISOString();
    draft.writer = options.writer ?? "cli";
    return writeUnderLock(file, draft, current.policy.revision);
  } finally {
    release();
  }
}

/** Explicit migration. Never runs on startup and never overwrites a file. */
export function initPolicyFile(
  options: {
    file?: string;
    legacy?: LegacyPolicyConfig;
    now?: Date;
  } = {}
): PolicySnapshot {
  const file = options.file ?? policyFilePath();
  const now = options.now ?? new Date();
  if (readPolicyFile(file).status !== "missing") {
    throw new PolicyFileError(
      "policy_exists",
      "A policy file already exists. Edit it, or remove it before initializing."
    );
  }
  const policy = policyFromLegacyConfig(options.legacy, now);
  return savePolicyFile(policy, { file });
}

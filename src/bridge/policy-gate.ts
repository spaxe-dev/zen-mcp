/**
 * Browser-side enforcement of the capability and website policy.
 *
 * The server sends a snapshot at injection time and on every change, but this
 * gate also reads the policy file itself when IOUtils is available. A missing
 * or unreadable file after one was seen fails closed, and an invalid file
 * denies every browser capability. Site checks always use the actual URL the
 * browser owns, never a URL supplied by the caller alone.
 */

import {
  CAPABILITIES,
  bridgeCapabilitiesForOperation,
  createRestrictedPolicy,
  evaluate,
  evaluateCapability,
  type CapabilityId,
  type Policy,
  type PolicySnapshot,
} from "../shared/policy.js";
import {
  canonicalPolicyJson,
  parsePolicyText,
  validatePolicy,
} from "../shared/policy-schema.js";

export const POLICY_REFRESH_MS = 700;

export type PolicyFileObservation =
  | { status: "unchanged" }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "changed"; text: string };

export type PolicyFileReader = () => Promise<PolicyFileObservation>;

export class BridgePolicyError extends Error {
  override name = "BridgePolicyError";
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface BridgePolicyGateOptions {
  initial?: PolicySnapshot;
  readFile?: PolicyFileReader;
  now?: () => Date;
}

function restrictedSnapshot(now: Date): PolicySnapshot {
  const policy = createRestrictedPolicy(now);
  return {
    policy,
    source: "default",
    revision: 0,
    digest: "",
    updatedAt: policy.updatedAt,
    warnings: [],
  };
}

function invalidSnapshot(
  now: Date,
  code: string,
  message: string
): PolicySnapshot {
  const snapshot = restrictedSnapshot(now);
  return {
    ...snapshot,
    source: "invalid",
    digest: "",
    error: message,
    errorCode: code,
    warnings: [
      "The browser policy could not be applied, so browser tools are denied.",
    ],
  };
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function digestPolicy(policy: Policy): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "";
  try {
    const bytes = new TextEncoder().encode(canonicalPolicyJson(policy));
    return toHex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
  } catch {
    return "";
  }
}

function validSnapshotShape(value: unknown): value is PolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.revision === "number" &&
    Number.isInteger(snapshot.revision) &&
    snapshot.revision >= 0 &&
    typeof snapshot.digest === "string" &&
    typeof snapshot.updatedAt === "string" &&
    ["file", "legacy", "default", "invalid"].includes(
      String(snapshot.source)
    ) &&
    !!snapshot.policy &&
    typeof snapshot.policy === "object"
  );
}

export class BridgePolicyGate {
  #snapshot: PolicySnapshot;
  readonly #readFile?: PolicyFileReader;
  readonly #now: () => Date;
  /** True once a policy file has existed in this bridge session. */
  #sawFile: boolean;
  #refreshing: Promise<void> | null = null;

  constructor(options: BridgePolicyGateOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#snapshot = options.initial
      ? { ...options.initial, policy: { ...options.initial.policy } }
      : restrictedSnapshot(this.#now());
    this.#readFile = options.readFile;
    this.#sawFile =
      this.#snapshot.source === "file" || this.#snapshot.source === "invalid";
  }

  snapshot(): PolicySnapshot {
    return this.#snapshot;
  }

  /** Reloads the policy file when it changed. Never widens on failure. */
  async refresh(): Promise<void> {
    if (!this.#readFile) return;
    if (this.#refreshing) return this.#refreshing;
    const work = this.#refreshOnce().finally(() => {
      this.#refreshing = null;
    });
    this.#refreshing = work;
    return work;
  }

  async #refreshOnce(): Promise<void> {
    let observation: PolicyFileObservation;
    try {
      observation = await this.#readFile!();
    } catch {
      observation = { status: "unreadable" };
    }
    if (observation.status === "unchanged") return;
    if (observation.status === "missing") {
      if (this.#sawFile) {
        this.#snapshot = invalidSnapshot(
          this.#now(),
          "policy_missing",
          "The policy file was removed while Zen MCP was running."
        );
      }
      return;
    }
    if (observation.status === "unreadable") {
      this.#sawFile = true;
      this.#snapshot = invalidSnapshot(
        this.#now(),
        "policy_unavailable",
        "The policy file could not be read."
      );
      return;
    }

    this.#sawFile = true;
    const parsed = parsePolicyText(observation.text);
    if (!parsed.ok) {
      this.#snapshot = invalidSnapshot(
        this.#now(),
        parsed.code,
        parsed.message
      );
      return;
    }
    const digest = await digestPolicy(parsed.policy);
    const next: PolicySnapshot = {
      policy: parsed.policy,
      source: "file",
      revision: parsed.policy.revision,
      digest,
      updatedAt: parsed.policy.updatedAt,
      warnings: [],
    };
    // A hand-edited rollback or rewrite must not lower the revision the
    // browser enforces, even when the file keeps the old revision number.
    if (
      this.#snapshot.source !== "invalid" &&
      (next.revision < this.#snapshot.revision ||
        (next.revision === this.#snapshot.revision &&
          !!next.digest &&
          !!this.#snapshot.digest &&
          next.digest !== this.#snapshot.digest))
    ) {
      return;
    }
    this.#snapshot = next;
  }

  /** Applies an authenticated update from the owning server. */
  acceptUpdate(value: unknown): boolean {
    if (!validSnapshotShape(value)) return false;
    const parsed = validatePolicy(
      (value as PolicySnapshot).policy
    );
    if (!parsed.ok) return false;
    const update = value as PolicySnapshot;
    if (update.revision < this.#snapshot.revision) return false;
    if (
      update.revision === this.#snapshot.revision &&
      update.digest &&
      this.#snapshot.digest &&
      update.digest !== this.#snapshot.digest
    ) {
      return false;
    }
    this.#snapshot = {
      ...update,
      policy: parsed.policy,
      warnings: Array.isArray(update.warnings) ? [...update.warnings] : [],
    };
    if (update.source === "file" || update.source === "invalid") {
      this.#sawFile = true;
    }
    return true;
  }

  /**
   * The bridge must not run work for a policy revision it has not seen. A
   * stale or missing revision is denied rather than treated as current.
   */
  assertRequest(revision: unknown, digest: unknown): void {
    if (
      typeof revision !== "number" ||
      !Number.isInteger(revision) ||
      revision < 0
    ) {
      throw new BridgePolicyError(
        "policy_stale",
        "This bridge request did not carry a policy revision, so it was denied."
      );
    }
    if (revision > this.#snapshot.revision) {
      throw new BridgePolicyError(
        "policy_stale",
        "The browser has not received the current policy revision yet. Retry " +
          "after Zen MCP reloads the policy."
      );
    }
    if (revision < this.#snapshot.revision) {
      throw new BridgePolicyError(
        "policy_stale",
        "The bridge rejected work based on an older policy revision. Retry " +
          "after Zen MCP reloads the policy."
      );
    }
    if (
      typeof digest !== "string" ||
      !digest ||
      (this.#snapshot.digest && digest !== this.#snapshot.digest)
    ) {
      throw new BridgePolicyError(
        "policy_stale",
        "The bridge policy changed while this request was prepared. Re-read " +
          "the policy and retry."
      );
    }
  }

  #capabilityFor(method: string): CapabilityId {
    const capabilities = bridgeCapabilitiesForOperation(method);
    if (capabilities.length === 0) {
      throw new BridgePolicyError(
        "unknown_capability",
        `Bridge operation "${String(method).slice(0, 80)}" has no capability ` +
          "in the policy registry, so it was denied."
      );
    }
    return capabilities[0];
  }

  /**
   * Denies an operation by capability alone, before its target URL is known.
   * Site rules are checked later with browser-owned URLs.
   */
  assertCapability(method: string): void {
    const capability = this.#capabilityFor(method);
    const decision = evaluateCapability(this.#snapshot, capability);
    if (!decision.allowed) {
      throw new BridgePolicyError(
        decision.code ?? "capability_denied",
        decision.reason ?? `Capability "${capability}" is denied by policy.`
      );
    }
  }

  /**
   * Denies an operation unless its capability and every supplied actual URL
   * are allowed. `requireUrl` is used by operations whose target URL must be
   * resolved from browser state; an empty list then fails closed.
   */
  assertOperation(
    method: string,
    urls: readonly string[] = [],
    options: { requireUrl?: boolean } = {}
  ): void {
    const capability = this.#capabilityFor(method);
    const decision = evaluate(this.#snapshot, { capability, urls });
    if (!decision.allowed) {
      throw new BridgePolicyError(
        decision.site?.code ?? decision.code ?? "capability_denied",
        decision.site?.reason ??
          decision.reason ??
          `Capability "${capability}" is denied by policy.`
      );
    }
    if (
      options.requireUrl &&
      CAPABILITIES[capability].siteScoped &&
      urls.length === 0
    ) {
      throw new BridgePolicyError(
        "unscoped_url",
        `Capability "${capability}" needs a URL resolved from browser state, ` +
          "and none was available."
      );
    }
  }

  /** True when a capability may act on this exact actual URL. */
  allows(capability: CapabilityId, url: string): boolean {
    return evaluate(this.#snapshot, { capability, urls: [url] }).allowed;
  }

  /** True when tab metadata for this URL may be shown to the agent. */
  allowsMetadata(url: string): boolean {
    return this.allows("tab.list", url);
  }
}

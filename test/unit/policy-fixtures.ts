import {
  createPolicy,
  policyFromLegacyConfig,
  type CreatePolicyOptions,
  type LegacyPolicyConfig,
  type Policy,
  type PolicySnapshot,
  type PolicySource,
} from "../../src/shared/policy.js";
import { policyDigest } from "../../src/shared/policy-digest.js";

/** A snapshot around any validated policy, for deterministic unit tests. */
export function snapshotOfPolicy(
  policy: Policy,
  source: PolicySource = "file"
): PolicySnapshot {
  return {
    policy,
    source,
    revision: policy.revision,
    digest: policyDigest(policy),
    updatedAt: policy.updatedAt,
    warnings: [],
  };
}

/** Full access unless a test overrides a capability or a website rule. */
export function fullPolicySnapshot(
  overrides: CreatePolicyOptions = {}
): PolicySnapshot {
  return snapshotOfPolicy(
    createPolicy({
      mode: "full",
      now: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    })
  );
}

/** The in-memory compatibility policy used for legacy config tests. */
export function legacyPolicySnapshot(
  legacy: LegacyPolicyConfig
): PolicySnapshot {
  return snapshotOfPolicy(
    policyFromLegacyConfig(legacy, new Date("2026-01-01T00:00:00.000Z")),
    "legacy"
  );
}

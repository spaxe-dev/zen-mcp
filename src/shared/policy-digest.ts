/**
 * Server-side policy digest. The browser bridge computes the same value with
 * Web Crypto; this module stays Node-only so the strict schema can be bundled
 * into the bridge.
 */

import { createHash } from "node:crypto";
import type { Policy } from "./policy.js";
import { canonicalPolicyJson } from "./policy-schema.js";

/** sha256 over the canonical document, for staleness and change detection. */
export function policyDigest(policy: Policy): string {
  return createHash("sha256")
    .update(canonicalPolicyJson(policy), "utf8")
    .digest("hex");
}

import { BridgePolicyGate } from "../../src/bridge/policy-gate.js";
import {
  createPolicy,
  type PolicyMode,
  type WebsiteRule,
} from "../../src/shared/policy.js";

/** A gate that allows everything except permanent denies, for op tests. */
export function testGate(
  options: {
    mode?: PolicyMode;
    websites?: {
      default?: "allow" | "deny";
      allow?: string[];
      block?: string[];
      rules?: WebsiteRule[];
    };
  } = {}
): BridgePolicyGate {
  const policy = createPolicy({
    mode: options.mode ?? "permissive",
    ...(options.websites ? { websites: options.websites } : {}),
  });
  return new BridgePolicyGate({
    initial: {
      policy,
      source: "file",
      revision: policy.revision,
      digest: "",
      updatedAt: policy.updatedAt,
      warnings: [],
    },
  });
}

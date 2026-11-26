/**
 * Strict parsing and semantic validation for `policy.json`.
 *
 * The schema is closed at every level: unknown keys, unknown capabilities and
 * non-`deny` restriction values are errors, not warnings. A typo in an access
 * value must never quietly widen access.
 */

import { z } from "zod";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  POLICY_MODES,
  POLICY_SCHEMA_VERSION,
  isCapabilityId,
  isPermanentDeny,
  type CapabilityOverrides,
  type CapabilityRestrictions,
  type Policy,
  type WebsitePolicy,
  type WebsiteRule,
} from "./policy.js";
import {
  MAX_HOST_LIST_ENTRIES,
  MAX_HOST_RULE_LENGTH,
  isValidHostRule,
  normalizeHostRule,
} from "./url-policy.js";

export const POLICY_MAX_BYTES = 1024 * 1024;
export const MAX_POLICY_RULES = 500;

export type PolicyValidationCode =
  | "invalid_json"
  | "unsupported_schema"
  | "schema_invalid"
  | "unknown_capability"
  | "permanent_deny"
  | "invalid_host"
  | "duplicate_host";

export type PolicyValidation =
  | { ok: true; policy: Policy }
  | { ok: false; code: PolicyValidationCode; message: string; path?: string };

function accessShape(value: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(
    CAPABILITY_IDS.map((id) => [id, value])
  ) as Record<string, z.ZodTypeAny>;
}

const capabilityOverridesSchema = z.strictObject(
  accessShape(z.enum(["allow", "deny"]).optional())
);

const capabilityRestrictionsSchema = z.strictObject(
  accessShape(z.literal("deny").optional())
);

const hostSchema = z
  .string()
  .min(1)
  .max(MAX_HOST_RULE_LENGTH)
  .refine(
    isValidHostRule,
    `Use a host like example.com or *.example.com (no scheme, port or path).`
  )
  .transform(normalizeHostRule);

const websiteRuleSchema = z.strictObject({
  host: hostSchema,
  capabilities: capabilityOverridesSchema.optional(),
});

const websitesSchema = z.strictObject({
  default: z.enum(["allow", "deny"]),
  allow: z.array(hostSchema).max(MAX_HOST_LIST_ENTRIES).default([]),
  block: z.array(hostSchema).max(MAX_HOST_LIST_ENTRIES).default([]),
  rules: z.array(websiteRuleSchema).max(MAX_POLICY_RULES).default([]),
});

const policySchema = z.strictObject({
  schemaVersion: z.literal(POLICY_SCHEMA_VERSION),
  revision: z.number().int().min(1).max(2_147_483_647),
  updatedAt: z.iso.datetime(),
  writer: z
    .enum(["cli", "control-center", "json", "migration"])
    .optional(),
  mode: z.enum(POLICY_MODES),
  capabilities: capabilityOverridesSchema.optional(),
  restrictions: capabilityRestrictionsSchema.optional(),
  websites: websitesSchema,
});

/**
 * Normalizes a validated document into the runtime `Policy` shape. Callers
 * only reach this after schema and semantic validation.
 */
function toPolicy(value: z.infer<typeof policySchema>): Policy {
  return {
    schemaVersion: value.schemaVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...(value.writer ? { writer: value.writer } : {}),
    mode: value.mode,
    capabilities: (value.capabilities ?? {}) as CapabilityOverrides,
    restrictions: (value.restrictions ?? {}) as CapabilityRestrictions,
    websites: {
      default: value.websites.default,
      allow: [...value.websites.allow],
      block: [...value.websites.block],
      rules: value.websites.rules.map(
        (rule): WebsiteRule => ({
          host: rule.host,
          capabilities: (rule.capabilities ?? {}) as CapabilityOverrides,
        })
      ),
    } satisfies WebsitePolicy,
  };
}

function firstDuplicate(entries: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) return entry;
    seen.add(entry);
  }
  return undefined;
}

function semanticProblem(policy: Policy): PolicyValidation | undefined {
  for (const id of CAPABILITY_IDS) {
    if (policy.capabilities[id] === "allow" && isPermanentDeny(id)) {
      return {
        ok: false,
        code: "permanent_deny",
        path: `capabilities.${id}`,
        message: `"${id}" is permanently denied and cannot be allowed.`,
      };
    }
  }

  for (const [index, rule] of policy.websites.rules.entries()) {
    for (const id of CAPABILITY_IDS) {
      if (rule.capabilities[id] === "allow" && isPermanentDeny(id)) {
        return {
          ok: false,
          code: "permanent_deny",
          path: `websites.rules[${index}].capabilities.${id}`,
          message: `"${id}" is permanently denied and cannot be allowed.`,
        };
      }
    }
  }

  const allowDuplicate = firstDuplicate(policy.websites.allow);
  if (allowDuplicate !== undefined) {
    return {
      ok: false,
      code: "duplicate_host",
      path: "websites.allow",
      message: `Site "${allowDuplicate}" is listed more than once.`,
    };
  }
  const blockDuplicate = firstDuplicate(policy.websites.block);
  if (blockDuplicate !== undefined) {
    return {
      ok: false,
      code: "duplicate_host",
      path: "websites.block",
      message: `Site "${blockDuplicate}" is listed more than once.`,
    };
  }
  const ambiguous = policy.websites.allow.find((host) =>
    policy.websites.block.includes(host)
  );
  if (ambiguous !== undefined) {
    return {
      ok: false,
      code: "duplicate_host",
      path: "websites",
      message: `Site "${ambiguous}" is both allowed and blocked; deny wins, so remove one.`,
    };
  }

  const ruleDuplicate = firstDuplicate(
    policy.websites.rules.map((rule) => rule.host)
  );
  if (ruleDuplicate !== undefined) {
    return {
      ok: false,
      code: "duplicate_host",
      path: "websites.rules",
      message: `Site rule "${ruleDuplicate}" appears more than once.`,
    };
  }

  return undefined;
}

export function validatePolicy(value: unknown): PolicyValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      code: "schema_invalid",
      message: "The policy must be a JSON object.",
    };
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (
    typeof schemaVersion === "number" &&
    schemaVersion !== POLICY_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      code: "unsupported_schema",
      message:
        schemaVersion > POLICY_SCHEMA_VERSION
          ? `Policy schema version ${schemaVersion} is newer than this Zen MCP supports. Upgrade Zen MCP.`
          : `Policy schema version ${schemaVersion} is not supported.`,
    };
  }

  const parsed = policySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : undefined;
    return {
      ok: false,
      code: "schema_invalid",
      ...(path ? { path } : {}),
      message: issue?.message ?? "The policy does not match the schema.",
    };
  }

  const policy = toPolicy(parsed.data);
  const problem = semanticProblem(policy);
  return problem ?? { ok: true, policy };
}

export function parsePolicyText(text: string): PolicyValidation {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    // Do not echo the parser message: it can quote policy content.
    return {
      ok: false,
      code: "invalid_json",
      message: "The policy file is not valid JSON.",
    };
  }
  return validatePolicy(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

/** Stable JSON for digests; key order never changes the digest. */
export function canonicalPolicyJson(policy: Policy): string {
  return JSON.stringify(canonical(policy));
}

/** Human-editable serialization used by every writer. */
export function serializePolicy(policy: Policy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** True for capability ids used by tests and the CLI help text. */
export function knownCapability(value: string): value is keyof typeof CAPABILITIES {
  return isCapabilityId(value);
}

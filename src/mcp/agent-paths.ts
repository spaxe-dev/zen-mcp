/**
 * Agent-facing output never carries absolute storage locations. The real paths
 * stay available to the operator through `zen-mcp status` and `zen-mcp doctor`,
 * and a future `diagnostics.detail` capability can opt in explicitly. Until
 * then every tool and resource returns these placeholders.
 */
export const AGENT_PROFILE_PLACEHOLDER = "<profile>";
export const AGENT_DATA_DIR_PLACEHOLDER = "<data>";
export const AGENT_AUDIT_PATH_PLACEHOLDER = "<data>/audit.jsonl";
export const AGENT_POLICY_PATH_PLACEHOLDER = "<config>/policy.json";

export function redactProfilePath(value: string | null): string | null {
  return value ? AGENT_PROFILE_PLACEHOLDER : value;
}

export function redactDataDirPath(value: string): string {
  return value ? AGENT_DATA_DIR_PLACEHOLDER : value;
}

export function redactAuditPath(value: string): string {
  return value ? AGENT_AUDIT_PATH_PLACEHOLDER : value;
}

export function redactSessionProfile<T extends { profile: string | null }>(
  session: T
): T {
  return { ...session, profile: redactProfilePath(session.profile) };
}

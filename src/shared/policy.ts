/**
 * The authoritative capability registry and deterministic policy evaluation.
 *
 * Phase 1 evaluates at the MCP tool boundary. Browser-side enforcement and
 * site filtering of tab-, history- and bookmark-based results are Phase 2; the
 * registry already names every bridge operation so that work has one map.
 */

import {
  hostMatchesRule,
  normalizeDomainEntry,
  normalizeWebUrl,
} from "./url-policy.js";

export const POLICY_SCHEMA_VERSION = 1;

export const POLICY_MODES = [
  "restricted",
  "normal",
  "permissive",
  "full",
] as const;

export type PolicyMode = (typeof POLICY_MODES)[number];
export type PolicyAccess = "allow" | "deny";
export type PolicyWriter = "cli" | "control-center" | "json" | "migration";
export type PolicySource = "file" | "legacy" | "default" | "invalid";

export const CAPABILITY_IDS = [
  "browser.launch",
  "browser.status",
  "browser.internalPages",
  "tab.list",
  "tab.close",
  "tab.select",
  "tab.pin",
  "page.read",
  "page.find",
  "page.wait",
  "page.click",
  "page.type",
  "page.evidence",
  "page.evidenceClear",
  "nav.open",
  "nav.glance",
  "space.read",
  "space.create",
  "space.switch",
  "space.delete",
  "folder.read",
  "folder.create",
  "folder.addTabs",
  "essentials.write",
  "layout.split",
  "window.focus",
  "history.read",
  "bookmarks.read",
  "containers.read",
  "clipboard.write",
  "download.write",
  "ui.card",
  "ui.ask",
  "ui.answers",
  "session.read",
  "session.write",
  "template.read",
  "template.write",
  "watch.read",
  "watch.write",
  "events.read",
  "tools.discover",
  "diagnostics.read",
  "audit.read",
  "cookies.read",
  "password.read",
  "settings.write",
  "extensions.manage",
  "browsingData.write",
  "profileFilesystem.read",
  "devtools.use",
  "upload.write",
  "software.install",
  "screenshot.capture",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityMeta {
  /** Lowest mode that allows the capability by default. */
  minMode: PolicyMode;
  /** Denied in every mode and unable to be allowed by an override. */
  permanentDeny: boolean;
  /** Off, plus per-site rules may deny it. */
  siteScoped: boolean;
  /** Deny when the call resolves no URL at all. */
  requireUrl: boolean;
  tools: readonly string[];
  ops: readonly string[];
}

/** Registry without the id; the id is added below so the two cannot drift. */
const CAPABILITY_DEFINITIONS: Record<
  CapabilityId,
  Omit<CapabilityMeta, "permanentDeny" | "siteScoped" | "requireUrl"> &
    Partial<Pick<CapabilityMeta, "permanentDeny" | "siteScoped" | "requireUrl">>
> = {
  "browser.launch": {
    minMode: "normal",
    tools: ["zen_launch"],
    ops: [],
  },
  "browser.status": {
    minMode: "restricted",
    tools: ["zen_status"],
    ops: ["status"],
  },
  "browser.internalPages": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "tab.list": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_tabs_list", "zen_tabs_audit"],
    ops: ["tabs.list"],
  },
  "tab.close": {
    minMode: "normal",
    tools: ["zen_tabs_close"],
    ops: ["tabs.close"],
  },
  "tab.select": {
    minMode: "normal",
    tools: ["zen_tab_select"],
    ops: ["tabs.select"],
  },
  "tab.pin": {
    minMode: "normal",
    tools: ["zen_pin_tabs"],
    ops: ["tabs.pin"],
  },
  "page.read": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_read_page", "zen_read_pages"],
    ops: ["tabs.read"],
  },
  "page.find": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_find_text", "zen_search_tabs"],
    ops: ["tabs.findText"],
  },
  "page.wait": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_wait_for"],
    ops: ["tabs.waitFor"],
  },
  "page.click": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_click"],
    ops: ["tabs.click"],
  },
  "page.type": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_type"],
    ops: ["tabs.type"],
  },
  "page.evidence": {
    minMode: "permissive",
    siteScoped: true,
    requireUrl: true,
    tools: ["zen_show_evidence", "zen_show_evidence_batch"],
    ops: ["tabs.evidence"],
  },
  "page.evidenceClear": {
    minMode: "permissive",
    siteScoped: true,
    tools: ["zen_clear_evidence"],
    ops: ["tabs.evidenceClear"],
  },
  "nav.open": {
    minMode: "normal",
    siteScoped: true,
    requireUrl: true,
    tools: ["zen_tabs_open"],
    ops: ["tabs.open"],
  },
  "nav.glance": {
    minMode: "normal",
    siteScoped: true,
    tools: ["zen_glance"],
    ops: ["glance.open"],
  },
  "space.read": {
    minMode: "normal",
    tools: ["zen_spaces_list"],
    ops: ["spaces.list"],
  },
  "space.create": {
    minMode: "normal",
    tools: ["zen_space_create"],
    ops: ["spaces.create"],
  },
  "space.switch": {
    minMode: "normal",
    tools: ["zen_space_switch"],
    ops: ["spaces.switch"],
  },
  "space.delete": {
    minMode: "permissive",
    tools: ["zen_space_delete"],
    ops: ["spaces.delete"],
  },
  "folder.read": {
    minMode: "normal",
    tools: ["zen_folders_list"],
    ops: ["folders.list"],
  },
  "folder.create": {
    minMode: "normal",
    tools: ["zen_folder_create"],
    ops: ["folders.create"],
  },
  "folder.addTabs": {
    minMode: "normal",
    tools: ["zen_folder_add_tabs", "zen_tabs_group"],
    ops: ["folders.addTabs"],
  },
  "essentials.write": {
    minMode: "normal",
    tools: ["zen_essentials"],
    ops: ["essentials.add", "essentials.remove"],
  },
  "layout.split": {
    minMode: "normal",
    tools: ["zen_split_view", "zen_split_close"],
    ops: ["split.open", "split.close"],
  },
  "window.focus": {
    minMode: "normal",
    tools: [],
    ops: [],
  },
  "history.read": {
    minMode: "permissive",
    siteScoped: true,
    tools: ["zen_history_search", "zen_history_recently_closed"],
    ops: ["history.search", "history.recentlyClosed"],
  },
  "bookmarks.read": {
    minMode: "permissive",
    siteScoped: true,
    tools: ["zen_bookmarks_search"],
    ops: ["bookmarks.search"],
  },
  "containers.read": {
    minMode: "normal",
    tools: ["zen_containers_list"],
    ops: ["containers.list"],
  },
  "clipboard.write": {
    minMode: "permissive",
    tools: ["zen_clipboard_write"],
    ops: ["clipboard.write"],
  },
  "download.write": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "ui.card": {
    minMode: "normal",
    tools: ["zen_progress", "zen_notify"],
    ops: [],
  },
  "ui.ask": {
    minMode: "normal",
    tools: ["zen_ask"],
    ops: [],
  },
  "ui.answers": {
    minMode: "normal",
    tools: ["zen_answers"],
    ops: [],
  },
  "session.read": {
    minMode: "normal",
    tools: ["zen_session_list"],
    ops: [],
  },
  "session.write": {
    minMode: "permissive",
    siteScoped: true,
    tools: ["zen_session_save", "zen_session_restore", "zen_session_delete"],
    ops: [],
  },
  "template.read": {
    minMode: "normal",
    tools: ["zen_space_templates"],
    ops: [],
  },
  "template.write": {
    minMode: "permissive",
    siteScoped: true,
    tools: ["zen_template_apply", "zen_template_save", "zen_template_delete"],
    ops: [],
  },
  "watch.read": {
    minMode: "normal",
    tools: ["zen_watch_list"],
    ops: [],
  },
  "watch.write": {
    minMode: "normal",
    tools: ["zen_watch_add", "zen_watch_remove"],
    ops: [],
  },
  "events.read": {
    minMode: "restricted",
    tools: ["zen_events"],
    ops: [],
  },
  "tools.discover": {
    minMode: "restricted",
    tools: ["zen_tools_search", "zen_tools_use"],
    ops: [],
  },
  "diagnostics.read": {
    minMode: "restricted",
    tools: ["zen_config"],
    ops: [],
  },
  "audit.read": {
    minMode: "restricted",
    tools: ["zen_audit_tail"],
    ops: [],
  },
  "cookies.read": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "password.read": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "settings.write": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "extensions.manage": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "browsingData.write": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "profileFilesystem.read": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "devtools.use": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "upload.write": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "software.install": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
  "screenshot.capture": {
    minMode: "full",
    permanentDeny: true,
    tools: [],
    ops: [],
  },
};

export const CAPABILITIES: Readonly<Record<CapabilityId, CapabilityMeta>> =
  Object.fromEntries(
    CAPABILITY_IDS.map((id) => {
      const definition = CAPABILITY_DEFINITIONS[id];
      return [
        id,
        {
          ...definition,
          permanentDeny: definition.permanentDeny ?? false,
          siteScoped: definition.siteScoped ?? false,
          requireUrl: definition.requireUrl ?? false,
        },
      ];
    })
  ) as Record<CapabilityId, CapabilityMeta>;

export function isCapabilityId(value: string): value is CapabilityId {
  return Object.hasOwn(CAPABILITIES, value);
}

export function isPermanentDeny(id: CapabilityId): boolean {
  return CAPABILITIES[id].permanentDeny;
}

const MODE_RANK: Record<PolicyMode, number> = {
  restricted: 0,
  normal: 1,
  permissive: 2,
  full: 3,
};

export function isPolicyMode(value: string): value is PolicyMode {
  return (POLICY_MODES as readonly string[]).includes(value);
}

export function modeAllows(mode: PolicyMode, id: CapabilityId): boolean {
  const meta = CAPABILITIES[id];
  if (!meta || meta.permanentDeny) return false;
  return MODE_RANK[mode] >= MODE_RANK[meta.minMode];
}

export const MODE_MATRIX: Readonly<
  Record<PolicyMode, Readonly<Record<CapabilityId, boolean>>>
> = Object.fromEntries(
  POLICY_MODES.map((mode) => [
    mode,
    Object.fromEntries(
      CAPABILITY_IDS.map((id) => [id, modeAllows(mode, id)])
    ),
  ])
) as Record<PolicyMode, Record<CapabilityId, boolean>>;

export type CapabilityOverrides = Partial<Record<CapabilityId, PolicyAccess>>;
export type CapabilityRestrictions = Partial<
  Record<CapabilityId, Extract<PolicyAccess, "deny">>
>;

export interface WebsiteRule {
  host: string;
  capabilities: CapabilityOverrides;
}

export interface WebsitePolicy {
  default: PolicyAccess;
  allow: string[];
  block: string[];
  rules: WebsiteRule[];
}

export interface Policy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  writer?: PolicyWriter;
  mode: PolicyMode;
  capabilities: CapabilityOverrides;
  restrictions: CapabilityRestrictions;
  websites: WebsitePolicy;
}

export interface PolicySnapshot {
  policy: Policy;
  source: PolicySource;
  revision: number;
  digest: string;
  updatedAt: string;
  warnings: readonly string[];
  error?: string;
  errorCode?: string;
}

export interface LegacyPolicyConfig {
  readOnly?: boolean;
  allowedDomains?: readonly string[];
}

export interface CreatePolicyOptions {
  mode?: PolicyMode;
  revision?: number;
  now?: Date;
  writer?: PolicyWriter;
  capabilities?: CapabilityOverrides;
  restrictions?: CapabilityRestrictions;
  websites?: Partial<WebsitePolicy>;
}

export function createPolicy(options: CreatePolicyOptions = {}): Policy {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    revision: options.revision ?? 1,
    updatedAt: (options.now ?? new Date()).toISOString(),
    ...(options.writer ? { writer: options.writer } : {}),
    mode: options.mode ?? "restricted",
    capabilities: { ...(options.capabilities ?? {}) },
    restrictions: { ...(options.restrictions ?? {}) },
    websites: {
      default: options.websites?.default ?? "allow",
      allow: [...(options.websites?.allow ?? [])],
      block: [...(options.websites?.block ?? [])],
      rules: (options.websites?.rules ?? []).map((rule) => ({
        host: rule.host,
        capabilities: { ...rule.capabilities },
      })),
    },
  };
}

export function createRestrictedPolicy(now: Date = new Date()): Policy {
  return createPolicy({ mode: "restricted", now });
}

/**
 * Capabilities that the legacy `readOnly` flag blocked, expressed as
 * deny-only restrictions so reads and metadata stay available exactly as they
 * were before migration.
 */
export const LEGACY_READ_ONLY_CAPABILITIES: readonly CapabilityId[] = [
  "browser.launch",
  "space.create",
  "space.switch",
  "space.delete",
  "nav.open",
  "nav.glance",
  "tab.close",
  "tab.select",
  "tab.pin",
  "folder.create",
  "folder.addTabs",
  "essentials.write",
  "layout.split",
  "window.focus",
  "clipboard.write",
  "watch.write",
  "session.write",
  "template.write",
  "page.click",
  "page.type",
  "page.evidence",
  "page.evidenceClear",
  "ui.card",
  "ui.ask",
];

/**
 * Builds the policy that `zen-mcp policy init` persists from `config.json`.
 * A default legacy config becomes restricted; an explicit legacy restriction
 * (`readOnly` or a non-empty `allowedDomains`) is preserved exactly.
 */
export function policyFromLegacyConfig(
  legacy: LegacyPolicyConfig = {},
  now: Date = new Date()
): Policy {
  const readOnly = legacy.readOnly === true;
  const domains = (legacy.allowedDomains ?? []).map((entry) =>
    normalizeDomainEntry(entry)
  );
  const hasConfiguredDomains = (legacy.allowedDomains ?? []).length > 0;
  const normalizedDomains = [...new Set(domains.filter(Boolean))];
  const hasLegacySettings = readOnly || hasConfiguredDomains;
  // The old model had no modes: everything not blocked by readOnly was
  // allowed, and permanent denies are new. Permissive reproduces that surface
  // exactly while keeping the permanent denies in force.
  return createPolicy({
    mode: hasLegacySettings ? "permissive" : "restricted",
    now,
    writer: "migration",
    restrictions: readOnly
      ? Object.fromEntries(
          LEGACY_READ_ONLY_CAPABILITIES.map((id) => [id, "deny" as const])
        )
      : {},
    websites: hasConfiguredDomains
      ? {
          // An allowlist whose entries all normalize away must keep denying,
          // not fall back to allow-all.
          default: "deny",
          allow: normalizedDomains,
          block: [],
          rules: [],
        }
      : { default: "allow", allow: [], block: [], rules: [] },
  });
}

const CONDITIONAL_TOOL_CAPABILITIES: Record<
  string,
  (args: Record<string, unknown> | undefined) => CapabilityId[]
> = {
  zen_tab_select: (args) => (args?.focusWindow === true ? ["window.focus"] : []),
  zen_split_view: (args) =>
    args?.activate === false ? [] : ["window.focus"],
};

/** Tool name to its primary capability, built from the registry. */
export const CAPABILITY_BY_TOOL: ReadonlyMap<string, CapabilityId> = (() => {
  const map = new Map<string, CapabilityId>();
  for (const id of CAPABILITY_IDS) {
    for (const tool of CAPABILITIES[id].tools) {
      if (map.has(tool)) {
        throw new Error(`Capability registry maps ${tool} twice`);
      }
      map.set(tool, id);
    }
  }
  return map;
})();

/** Bridge operation to its capability, built from the registry. */
export const CAPABILITY_BY_BRIDGE_OPERATION: ReadonlyMap<string, CapabilityId> =
  (() => {
    const map = new Map<string, CapabilityId>();
    for (const id of CAPABILITY_IDS) {
      for (const op of CAPABILITIES[id].ops) {
        if (map.has(op)) {
          throw new Error(`Capability registry maps bridge op ${op} twice`);
        }
        map.set(op, id);
      }
    }
    return map;
  })();

/** Every capability a tool call must satisfy, in deterministic order. */
export function capabilitiesForTool(
  tool: string,
  args?: Record<string, unknown>
): CapabilityId[] {
  const primary = CAPABILITY_BY_TOOL.get(tool);
  if (!primary) return [];
  const extras = CONDITIONAL_TOOL_CAPABILITIES[tool]?.(args) ?? [];
  return [primary, ...extras.filter((id) => id !== primary)];
}

export function bridgeCapabilitiesForOperation(
  operation: string
): CapabilityId[] {
  const capability = CAPABILITY_BY_BRIDGE_OPERATION.get(operation);
  return capability ? [capability] : [];
}

export function allRegisteredTools(): string[] {
  return [...CAPABILITY_BY_TOOL.keys()].sort();
}

export function allRegisteredBridgeOperations(): string[] {
  return [...CAPABILITY_BY_BRIDGE_OPERATION.keys()].sort();
}

export type PolicyDenyCode =
  | "policy_invalid"
  | "unknown_capability"
  | "permanently_denied"
  | "restricted"
  | "capability_denied"
  | "mode_denied"
  | "unscoped_url"
  | "invalid_url"
  | "internal_page"
  | "site_blocked"
  | "site_rule_denied"
  | "site_default_denied";

export interface SiteDecision {
  allowed: boolean;
  code?: PolicyDenyCode;
  host?: string;
  reason?: string;
}

export interface Decision {
  allowed: boolean;
  capability: string;
  mode: PolicyMode;
  source: PolicySource;
  code?: PolicyDenyCode;
  reason?: string;
  site?: SiteDecision;
}

export interface PolicyRequest {
  capability: string;
  urls?: readonly string[];
}

/** Capabilities that stay available when the policy file cannot be applied. */
export const INVALID_POLICY_ALLOWED: ReadonlySet<CapabilityId> = new Set([
  "diagnostics.read",
  "audit.read",
  "events.read",
  "tools.discover",
]);

function hostOfUrl(raw: string): string | null {
  const normalized = normalizeWebUrl(raw);
  return normalized
    ? normalized.hostname.toLowerCase().replace(/\.+$/, "")
    : null;
}

/**
 * Site rules for one URL. Block first, then per-host rule (deny before allow),
 * then the allow list, then the default. `about:blank` is the only non-http(s)
 * destination allowed, and only for navigation; every other internal page is
 * denied.
 */
export function siteDecision(
  websites: WebsitePolicy,
  rawUrl: string,
  capability: string
): SiteDecision {
  const raw = String(rawUrl ?? "").trim();
  const host = hostOfUrl(raw);
  if (!host) {
    if (capability === "nav.open" && /^about:blank$/i.test(raw)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "internal_page",
      reason: "Only http(s) URLs are allowed; internal browser pages are denied.",
    };
  }

  if (websites.block.some((rule) => hostMatchesRule(host, rule))) {
    return {
      allowed: false,
      code: "site_blocked",
      host,
      reason: `Site "${host}" is blocked by policy.`,
    };
  }

  const matchingRules = websites.rules.filter((rule) =>
    hostMatchesRule(host, rule.host)
  );
  if (
    matchingRules.some(
      (rule) => rule.capabilities[capability as CapabilityId] === "deny"
    )
  ) {
    return {
      allowed: false,
      code: "site_rule_denied",
      host,
      reason: `Site "${host}" denies "${capability}" by policy.`,
    };
  }
  if (
    matchingRules.some(
      (rule) => rule.capabilities[capability as CapabilityId] === "allow"
    )
  ) {
    return { allowed: true, host };
  }

  if (websites.allow.some((rule) => hostMatchesRule(host, rule))) {
    return { allowed: true, host };
  }

  if (websites.default === "deny") {
    return {
      allowed: false,
      code: "site_default_denied",
      host,
      reason: `Site "${host}" is not in the allowed website list.`,
    };
  }
  return { allowed: true, host };
}

/**
 * Checks only the capability itself: invalid policy, unknown capability,
 * permanent deny, override, mode and restrictions. Site rules are deliberately
 * skipped so a caller can reject a denied operation before it has resolved the
 * browser-owned URL that the site check needs.
 */
export function evaluateCapability(
  snapshot: PolicySnapshot,
  capability: string
): Decision {
  const { policy, source } = snapshot;
  const base = {
    capability,
    mode: policy.mode,
    source,
  };

  if (
    source === "invalid" &&
    !INVALID_POLICY_ALLOWED.has(capability as CapabilityId)
  ) {
    return {
      ...base,
      allowed: false,
      code: "policy_invalid",
      reason:
        "The policy file is invalid, so browser access is denied. Fix the " +
        "policy file or run `zen-mcp policy init`.",
    };
  }

  if (!isCapabilityId(capability)) {
    return {
      ...base,
      allowed: false,
      code: "unknown_capability",
      reason: `Unknown capability "${String(capability).slice(0, 80)}".`,
    };
  }

  const meta = CAPABILITIES[capability];
  if (meta.permanentDeny) {
    return {
      ...base,
      allowed: false,
      code: "permanently_denied",
      reason: `Capability "${capability}" is permanently denied.`,
    };
  }

  if (policy.restrictions[capability] === "deny") {
    return {
      ...base,
      allowed: false,
      code: "restricted",
      reason: `Capability "${capability}" is permanently restricted.`,
    };
  }

  const override = policy.capabilities[capability];
  if (override === "deny") {
    return {
      ...base,
      allowed: false,
      code: "capability_denied",
      reason: `Capability "${capability}" is denied in the policy file.`,
    };
  }

  const allowed = override === "allow" || modeAllows(policy.mode, capability);
  if (!allowed) {
    return {
      ...base,
      allowed: false,
      code: "mode_denied",
      reason:
        `Capability "${capability}" is not enabled in ${policy.mode} mode. ` +
        "Raise the mode or allow the capability explicitly.",
    };
  }

  return { ...base, allowed: true };
}

export function evaluate(
  snapshot: PolicySnapshot,
  request: PolicyRequest
): Decision {
  const capability = request.capability;
  const decision = evaluateCapability(snapshot, capability);
  if (!decision.allowed) return decision;
  if (!isCapabilityId(capability)) return decision;

  const { policy } = snapshot;
  const meta = CAPABILITIES[capability];
  const base = {
    capability,
    mode: policy.mode,
    source: snapshot.source,
  };
  if (meta.siteScoped) {
    const urls = request.urls ?? [];
    if (urls.length === 0) {
      if (meta.requireUrl) {
        return {
          ...base,
          allowed: false,
          code: "unscoped_url",
          reason: `Capability "${capability}" needs an http(s) URL to check.`,
        };
      }
    } else {
      for (const url of urls) {
        const site = siteDecision(policy.websites, url, capability);
        if (!site.allowed) {
          return { ...base, allowed: false, site };
        }
      }
    }
  }

  return { ...base, allowed: true };
}

/** Restriction summary for agent-facing output: capability names only. */
export function restrictedCapabilities(policy: Policy): CapabilityId[] {
  return CAPABILITY_IDS.filter(
    (id) => policy.restrictions[id] === "deny"
  );
}

export interface PolicyAuditFields {
  capability?: string;
  mode: PolicyMode;
  policyRevision: number;
  policySource: PolicySource;
}

export function policyAuditFields(
  snapshot: PolicySnapshot,
  tool: string,
  args?: Record<string, unknown>
): PolicyAuditFields {
  const capabilities = capabilitiesForTool(tool, args);
  return {
    ...(capabilities[0] ? { capability: capabilities[0] } : {}),
    mode: snapshot.policy.mode,
    policyRevision: snapshot.revision,
    policySource: snapshot.source,
  };
}

/**
 * URL policy shared by the MCP guard and the runtime. Normalization mirrors
 * the bridge opener so the URL that is checked is the URL that will be used.
 */

/** Trim, add https:// when the scheme is missing, and accept only http(s). */
export function normalizeWebUrl(input: string | null | undefined): URL | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeDomainEntry(entry: string): string {
  return String(entry ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

export function normalizeDomainList(
  entries: readonly string[] | null | undefined
): string[] {
  return (entries ?? [])
    .map(normalizeDomainEntry)
    .filter((entry) => entry.length > 0);
}

/** Hostname of an http(s) URL, lowercased and without a trailing dot. */
export function hostOf(url: string): string | null {
  const parsed = normalizeWebUrl(url);
  return parsed ? parsed.hostname.toLowerCase().replace(/\.+$/, "") : null;
}

/**
 * True when the URL host matches one of the allowlist entries exactly or as a
 * subdomain on a label boundary. An empty list allows everything; a list whose
 * entries all normalize away denies everything.
 */
export function isUrlAllowed(
  url: string,
  allowedDomains: readonly string[] | null | undefined
): boolean {
  const configured = allowedDomains ?? [];
  if (configured.length === 0) return true;
  const host = hostOf(url);
  if (!host) return false;
  const list = normalizeDomainList(configured);
  return list.some((entry) => hostMatchesRule(host, entry));
}

export const MAX_HOST_RULE_LENGTH = 253;
export const MAX_HOST_LIST_ENTRIES = 1000;

const HOST_RULE_PATTERN =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * A policy host rule is a bare host (`example.com`, matching the host and its
 * subdomains) or a wildcard (`*.example.com`, matching subdomains only). No
 * ports, paths, schemes or regular expressions.
 */
export function isValidHostRule(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_HOST_RULE_LENGTH &&
    HOST_RULE_PATTERN.test(trimmed)
  );
}

/** Lowercases and strips empty leading dots, preserving a leading `*.`. */
export function normalizeHostRule(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const base = normalizeDomainEntry(trimmed);
  return wildcard ? `*.${base}` : base;
}

/** True when a normalized host matches a bare or wildcard policy rule. */
export function hostMatchesRule(host: string, rule: string): boolean {
  const wildcard = rule.trim().startsWith("*.");
  const entry = normalizeDomainEntry(rule);
  if (!entry) return false;
  const normalizedHost = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalizedHost) return false;
  if (wildcard) {
    return normalizedHost.endsWith(`.${entry}`);
  }
  return normalizedHost === entry || normalizedHost.endsWith(`.${entry}`);
}

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
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

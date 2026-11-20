/**
 * Broad sensitivity classification for form fields. False positives are
 * acceptable and privacy-safe: a field classified sensitive only loses its
 * value, never its label or ref. The generated page scripts embed the same
 * source strings, so this module stays the one place the patterns live.
 */
export const SENSITIVE_HINT_SOURCE =
  "(?:^|[^a-z0-9])(?:pass(?:word|wd|code|phrase)|pwd|secret|token|otp|" +
  "one[\\s_-]?time|verification|security[\\s_-]?code|cvv|cvc|" +
  "card[\\s_-]?(?:number|no)|credit[\\s_-]?card|debit[\\s_-]?card|iban|" +
  "routing|account[\\s_-]?(?:number|no)|ssn|social[\\s_-]?security|" +
  "national[\\s_-]?id|tax[\\s_-]?id|pin|e-?mail|phone|telephone|tel|" +
  "mobile|contact)";

/** Matches sensitive hints in a name, id, placeholder, or label. */
export const SENSITIVE_HINT_PATTERN = new RegExp(SENSITIVE_HINT_SOURCE, "i");

export const SENSITIVE_AUTOCOMPLETE_SOURCE =
  "(?:^|[\\s_-])(?:current-password|new-password|one-time-code|cc-number|" +
  "cc-csc|cc-exp|cc-name|cc-type|email|tel-national|tel|username|" +
  "street-address|address-line[1-3])(?:[\\s_-]|$)";

/** Matches sensitive autocomplete tokens. */
export const SENSITIVE_AUTOCOMPLETE_PATTERN = new RegExp(
  SENSITIVE_AUTOCOMPLETE_SOURCE,
  "i"
);

export interface SensitivityParts {
  type?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
  placeholder?: string | null;
  label?: string | null;
  inputMode?: string | null;
}

/** Node-side mirror of the generated script classifier, used by tests. */
export function isSensitiveDescriptor(parts: SensitivityParts): boolean {
  const type = String(parts.type ?? "").trim().toLowerCase();
  if (type === "password" || type === "file" || type === "email" || type === "tel") {
    return true;
  }
  const autocomplete = String(parts.autocomplete ?? "").trim().toLowerCase();
  if (autocomplete && SENSITIVE_AUTOCOMPLETE_PATTERN.test(autocomplete)) {
    return true;
  }
  const inputMode = String(parts.inputMode ?? "").trim().toLowerCase();
  if (inputMode === "email" || inputMode === "tel") return true;
  const haystack = [parts.name, parts.id, parts.placeholder, parts.label]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ");
  return SENSITIVE_HINT_PATTERN.test(haystack);
}

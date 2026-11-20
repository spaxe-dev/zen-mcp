import type {
  PageClassification,
  SemanticCollection,
  SemanticCollectionKind,
  SemanticDialog,
  SemanticHeading,
  SemanticPage,
  SemanticRegion,
  SemanticRegionRole,
} from "./protocol.js";

/** Fixed caps for the semantic read format. */
export const SEMANTIC_MAX_REGIONS = 40;
export const SEMANTIC_MAX_HEADINGS_LIST = 40;
export const SEMANTIC_MAX_COLLECTIONS = 12;
export const SEMANTIC_MAX_DIALOGS = 5;
export const SEMANTIC_MAX_SIGNALS = 6;
export const SEMANTIC_MAX_SAMPLES = 3;
export const SEMANTIC_MAX_NODES = 6_000;
export const SEMANTIC_MAX_CONTROLS = 120;
export const SEMANTIC_MAX_SHADOW_ROOTS = 40;
export const SEMANTIC_MAX_DEPTH = 10;
export const SEMANTIC_LABEL_CHARS = 120;
export const SEMANTIC_HEADING_CHARS = 160;
export const SEMANTIC_MAX_LIMITATIONS = 5;

export const PAGE_CLASSIFICATIONS = [
  "article",
  "search-results",
  "product",
  "listing",
  "dashboard",
  "login",
  "form",
  "documentation",
  "discussion",
  "generic",
] as const satisfies readonly PageClassification[];

export const SEMANTIC_REGION_ROLES: readonly SemanticRegionRole[] = [
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "form",
  "article",
  "section",
  "dialog",
  "table",
  "list",
];

const COLLECTION_KINDS: readonly SemanticCollectionKind[] = [
  "cards",
  "results",
  "links",
  "items",
];

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nullableText(value: unknown, max: number): string | null {
  const result = text(value, max).trim();
  return result ? result : null;
}

function count(value: unknown, max = 1_000_000): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(max, Math.max(0, Math.floor(numeric)));
}

function bool(value: unknown): boolean {
  return value === true;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function coerceRegion(value: unknown, index: number): SemanticRegion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 16) || `r${index + 1}`;
  return {
    id,
    role: oneOf(raw.role, SEMANTIC_REGION_ROLES, "section"),
    label: nullableText(raw.label, SEMANTIC_LABEL_CHARS),
    labelSource: oneOf(
      raw.labelSource,
      ["aria", "html", "heading", "inferred"] as const,
      "inferred"
    ),
    heading: nullableText(raw.heading, SEMANTIC_HEADING_CHARS),
    parent: nullableText(raw.parent, 16),
    ref: nullableText(raw.ref, 24),
    controls: count(raw.controls),
    links: count(raw.links),
    items:
      raw.items === null || raw.items === undefined ? null : count(raw.items),
    itemKind:
      raw.itemKind === null || raw.itemKind === undefined
        ? null
        : oneOf(raw.itemKind, COLLECTION_KINDS, "items"),
  };
}

function coerceCollection(value: unknown): SemanticCollection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const regionId = text(raw.regionId, 16);
  if (!regionId) return null;
  const sample = Array.isArray(raw.sample)
    ? raw.sample
        .slice(0, SEMANTIC_MAX_SAMPLES)
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const ref = text(item.ref, 24);
          if (!ref) return null;
          return { ref, label: text(item.label, SEMANTIC_LABEL_CHARS) };
        })
        .filter((entry): entry is { ref: string; label: string } => !!entry)
    : [];
  return {
    regionId,
    kind: oneOf(raw.kind, COLLECTION_KINDS, "items"),
    count: count(raw.count),
    sample,
  };
}

function coerceDialog(value: unknown): SemanticDialog | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const ref = text(raw.ref, 24);
  if (!ref) return null;
  return {
    ref,
    label: text(raw.label, SEMANTIC_LABEL_CHARS) || "dialog",
    modal: bool(raw.modal),
  };
}

function coerceHeading(value: unknown): SemanticHeading | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const content = text(raw.text, SEMANTIC_HEADING_CHARS).trim();
  if (!content) return null;
  const level = count(raw.level, 6);
  return {
    level: level >= 1 && level <= 6 ? level : 2,
    text: content,
    ref: nullableText(raw.ref, 24),
  };
}

/**
 * Serialization form for page reads. Drops region fields that restate another
 * field or carry no information; the in-memory model keeps the full shape so
 * classification and relation checks still see every field.
 */
export function leanSemanticPage(page: SemanticPage): SemanticPage {
  return {
    ...page,
    regions: page.regions.map((region) => {
      const lean: SemanticRegion = { id: region.id, role: region.role };
      const heading = region.heading ?? null;
      const label = region.label ?? null;
      if (label && label !== heading) {
        lean.label = label;
        lean.labelSource = region.labelSource;
      }
      if (heading) lean.heading = heading;
      if (region.parent) lean.parent = region.parent;
      if (region.ref) lean.ref = region.ref;
      if ((region.controls ?? 0) > 0) lean.controls = region.controls;
      if ((region.links ?? 0) > 0) lean.links = region.links;
      if ((region.items ?? 0) > 0) {
        lean.items = region.items;
        if (region.itemKind) lean.itemKind = region.itemKind;
      }
      return lean;
    }),
  };
}

/**
 * Defensive coercion for the semantic model. Values, hidden text and page
 * scripts never enter this shape: the payload is counts, labels and refs.
 */
export function coerceSemanticPage(value: unknown): SemanticPage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const regions = Array.isArray(raw.regions)
    ? raw.regions
        .slice(0, SEMANTIC_MAX_REGIONS)
        .map((entry, index) => coerceRegion(entry, index))
        .filter((entry): entry is SemanticRegion => !!entry)
    : [];
  const headings = Array.isArray(raw.headings)
    ? raw.headings
        .slice(0, SEMANTIC_MAX_HEADINGS_LIST)
        .map(coerceHeading)
        .filter((entry): entry is SemanticHeading => !!entry)
    : [];
  const collections = Array.isArray(raw.collections)
    ? raw.collections
        .slice(0, SEMANTIC_MAX_COLLECTIONS)
        .map(coerceCollection)
        .filter((entry): entry is SemanticCollection => !!entry)
    : [];
  const dialogs = Array.isArray(raw.dialogs)
    ? raw.dialogs
        .slice(0, SEMANTIC_MAX_DIALOGS)
        .map(coerceDialog)
        .filter((entry): entry is SemanticDialog => !!entry)
    : [];
  const coverageRaw =
    raw.coverage && typeof raw.coverage === "object"
      ? (raw.coverage as Record<string, unknown>)
      : {};
  const confidence = Number(raw.confidence);
  return {
    classification: oneOf(raw.classification, PAGE_CLASSIFICATIONS, "generic"),
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    signals: Array.isArray(raw.signals)
      ? raw.signals
          .slice(0, SEMANTIC_MAX_SIGNALS)
          .map((signal) => text(signal, 80))
          .filter(Boolean)
      : [],
    primaryRegion: nullableText(raw.primaryRegion, 16),
    regions,
    headings,
    collections,
    dialogs,
    coverage: {
      complete: raw.coverage === undefined ? false : bool(coverageRaw.complete),
      nodes: count(coverageRaw.nodes),
      regions: count(coverageRaw.regions, SEMANTIC_MAX_REGIONS),
      regionsTruncated: bool(coverageRaw.regionsTruncated),
      controls: count(coverageRaw.controls),
      links: count(coverageRaw.links),
      headings: count(coverageRaw.headings),
      tables: count(coverageRaw.tables),
      images: count(coverageRaw.images),
      missingAlt: count(coverageRaw.missingAlt),
      shadowRoots: count(coverageRaw.shadowRoots),
    },
    limitations: Array.isArray(raw.limitations)
      ? raw.limitations
          .slice(0, SEMANTIC_MAX_LIMITATIONS)
          .map((limitation) => text(limitation, 300))
          .filter(Boolean)
      : [],
  };
}

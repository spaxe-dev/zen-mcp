import type { PageElement } from "../shared/protocol.js";

export interface RefDescriptor {
  tag: string;
  role: string;
  type: string | null;
  label: string;
  href: string | null;
}

export interface StoredRef {
  ref: string;
  /** Marionette WebElement, held only server-side. */
  element: unknown;
  /** Same-node change guard; never an identity. */
  digest: string;
  descriptor: RefDescriptor;
  snapshotId: string;
  capturedAt: number;
}

export interface ResolvedRef extends StoredRef {
  /** documentElement WebElement captured with the snapshot. */
  root: unknown;
  framePath: number[];
}

interface DocumentRecord {
  tabId: string;
  framePath: number[];
  snapshotId: string;
  root: unknown;
  refs: Map<string, StoredRef>;
  capturedAt: number;
}

export interface RefRegistryOptions {
  maxDocuments?: number;
  maxRefsPerDocument?: number;
}

const DEFAULT_MAX_DOCUMENTS = 64;
const DEFAULT_MAX_REFS = 200;

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFramePath(framePath: readonly unknown[] | undefined): number[] {
  if (!Array.isArray(framePath)) return [];
  return framePath
    .slice(0, 3)
    .map((index) => Math.max(0, Math.floor(Number(index) || 0)));
}

/** Stable same-node guard. Excludes values and state by design. */
export function elementDigest(element: {
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  label?: string | null;
  href?: string | null;
}): string {
  const parts = [
    element?.tag,
    element?.role,
    element?.type,
    element?.label,
    element?.href,
  ].map(normalizeText);
  let hash = 2166136261;
  for (const part of parts) {
    const text = `${part}\u0000`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Reads the UUID out of a Marionette WebElement without interpreting it. */
export function webElementId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith("element-")) continue;
    const id = record[key];
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * True only when both roots are known WebElements and their ids differ. A
 * missing id cannot prove a change, so it never rejects an action.
 */
export function documentChanged(storedRoot: unknown, freshRoot: unknown): boolean {
  const before = webElementId(storedRoot);
  const after = webElementId(freshRoot);
  return before !== null && after !== null && before !== after;
}

/**
 * Bounded, per-window store of refs. A document is one tab plus one frame
 * path. A new snapshot or interactive read replaces that document's refs;
 * other frames keep theirs until their own read or the tab closes.
 */
export class RefRegistry {
  readonly #documents = new Map<string, DocumentRecord>();
  readonly #maxDocuments: number;
  readonly #maxRefsPerDocument: number;

  constructor(options: RefRegistryOptions = {}) {
    this.#maxDocuments = Math.max(
      1,
      Math.floor(options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS)
    );
    this.#maxRefsPerDocument = Math.max(
      1,
      Math.floor(options.maxRefsPerDocument ?? DEFAULT_MAX_REFS)
    );
  }

  static key(tabId: string, framePath: readonly number[]): string {
    const path = normalizeFramePath(framePath);
    return `${tabId}|${path.length ? path.join(".") : "top"}`;
  }

  /**
   * Replaces one document's ref set. Elements without a ref or WebElement are
   * skipped; the caller already capped the list.
   */
  beginSnapshot(
    tabId: string,
    framePath: readonly number[],
    snapshotId: string,
    root: unknown,
    elements: ReadonlyArray<Partial<PageElement> & { element?: unknown }>
  ): number {
    if (!tabId) return 0;
    const path = normalizeFramePath(framePath);
    const key = RefRegistry.key(tabId, path);
    const refs = new Map<string, StoredRef>();
    const now = Date.now();
    for (const element of elements) {
      if (refs.size >= this.#maxRefsPerDocument) break;
      const ref = normalizeText(element?.ref).slice(0, 24);
      if (!ref || element?.element === undefined || element.element === null) {
        continue;
      }
      const descriptor: RefDescriptor = {
        tag: normalizeText(element.tag).slice(0, 40),
        role: normalizeText(element.role).slice(0, 40) || "generic",
        type: element.type == null ? null : normalizeText(element.type).slice(0, 40),
        label: normalizeText(element.label).slice(0, 300),
        href: element.href == null ? null : String(element.href).slice(0, 8_000),
      };
      if (!descriptor.tag) continue;
      refs.set(ref, {
        ref,
        element: element.element,
        digest: elementDigest(descriptor),
        descriptor,
        snapshotId,
        capturedAt: now,
      });
    }

    this.#documents.delete(key);
    this.#documents.set(key, {
      tabId,
      framePath: path,
      snapshotId,
      root,
      refs,
      capturedAt: now,
    });
    this.#evictOverflow();
    return refs.size;
  }

  resolve(
    tabId: string,
    framePath: readonly number[],
    ref: string
  ): ResolvedRef | null {
    const key = RefRegistry.key(tabId, framePath);
    const record = this.#documents.get(key);
    if (!record) return null;
    const entry = record.refs.get(normalizeText(ref));
    if (!entry) return null;
    this.#touch(key, record);
    return {
      ...entry,
      root: record.root,
      framePath: [...record.framePath],
    };
  }

  /** Forgets every frame of one tab, called when the tab closes. */
  clearTab(tabId: string): void {
    for (const [key, record] of this.#documents) {
      if (record.tabId === tabId) this.#documents.delete(key);
    }
  }

  clearAll(): void {
    this.#documents.clear();
  }

  get documentCount(): number {
    return this.#documents.size;
  }

  refCount(tabId: string, framePath: readonly number[]): number {
    return this.#documents.get(RefRegistry.key(tabId, framePath))?.refs.size ?? 0;
  }

  #touch(key: string, record: DocumentRecord): void {
    this.#documents.delete(key);
    this.#documents.set(key, record);
  }

  #evictOverflow(): void {
    while (this.#documents.size > this.#maxDocuments) {
      const oldest = this.#documents.keys().next().value;
      if (oldest === undefined) return;
      this.#documents.delete(oldest);
    }
  }
}

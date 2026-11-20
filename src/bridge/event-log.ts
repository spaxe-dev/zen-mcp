import type { AgentEvent } from "../shared/protocol.js";
import { BROWSER_EVENT_KINDS } from "../shared/protocol.js";

/** Browser observations expire; user control events (stop, pause, watch) stay. */
export const EVENT_TTL_MS = 10 * 60_000;
export const MAX_EVENTS = 200;
const MAX_DEDUPE_KEYS = 500;
const DEFAULT_DEDUPE_MS = 2_000;
const BROWSER_KINDS: ReadonlySet<AgentEvent["kind"]> = new Set(
  BROWSER_EVENT_KINDS
);

/** Browser observations: they expire and Pause suppresses them. */
export function isBrowserObservation(kind: AgentEvent["kind"]): boolean {
  return BROWSER_KINDS.has(kind);
}

export function filterPausedEvents(
  events: readonly AgentEvent[],
  paused: boolean
): AgentEvent[] {
  if (!paused) return [...events];
  return events.filter((event) => !isBrowserObservation(event.kind));
}

export interface EventInput {
  kind: AgentEvent["kind"];
  title: string;
  detail?: string;
  windowId?: string;
  tabId?: string;
  watchId?: string;
  questionId?: string;
  phase?: AgentEvent["phase"];
  url?: string;
  documentId?: string;
  source?: AgentEvent["source"];
}

export interface EventLogRead {
  events: AgentEvent[];
  cursor: number;
  oldestCursor: number | null;
  /** Sequence numbers the caller can no longer read. */
  missed: number;
  dropped: number;
  lastEventAt: number | null;
}

/**
 * Bounded, deduped, expiring event buffer. Sequence ids are the only cursor:
 * they are monotonically increasing and never reused. A consumer that falls
 * behind learns how many events it missed instead of silently skipping them.
 */
export class EventLog {
  readonly #events: AgentEvent[] = [];
  readonly #dedupe = new Map<string, number>();
  readonly #maxEvents: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #seq = 0;
  #dropped = 0;

  constructor(
    options: {
      maxEvents?: number;
      ttlMs?: number;
      now?: () => number;
    } = {}
  ) {
    this.#maxEvents = Math.max(1, Math.floor(options.maxEvents ?? MAX_EVENTS));
    this.#ttlMs = Math.max(0, Math.floor(options.ttlMs ?? EVENT_TTL_MS));
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    this.#prune();
    return this.#events.length;
  }

  get sequence(): number {
    return this.#seq;
  }

  get dropped(): number {
    return this.#dropped;
  }

  push(
    input: EventInput,
    options: { dedupeKey?: string; dedupeWindowMs?: number } = {}
  ): AgentEvent | null {
    this.#prune();
    const now = this.#now();
    const key = options.dedupeKey;
    if (key) {
      const seenAt = this.#dedupe.get(key);
      const window = options.dedupeWindowMs ?? DEFAULT_DEDUPE_MS;
      if (seenAt !== undefined && now - seenAt < window) return null;
      this.#dedupe.delete(key);
      this.#dedupe.set(key, now);
      while (this.#dedupe.size > MAX_DEDUPE_KEYS) {
        const oldest = this.#dedupe.keys().next().value;
        if (oldest === undefined) break;
        this.#dedupe.delete(oldest);
      }
    }

    const event: AgentEvent = {
      id: ++this.#seq,
      at: now,
      ...input,
    };
    this.#events.push(event);
    while (this.#events.length > this.#maxEvents) {
      // Evict the oldest browser observation first so control events survive
      // a burst of tab or navigation noise.
      const index = this.#events.findIndex((entry) =>
        isBrowserObservation(entry.kind)
      );
      if (index >= 0) this.#events.splice(index, 1);
      else this.#events.shift();
      this.#dropped += 1;
    }
    return event;
  }

  read(after: number): EventLogRead {
    this.#prune();
    const afterValue = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    const events = this.#events.filter((event) => event.id > afterValue);
    const last = events[events.length - 1];
    const oldest = this.#events[0];
    // A cursor beyond the sequence is clamped: ids are never handed out in
    // advance, so a timestamp-valued cursor must not starve later reads.
    const effectiveAfter = Math.min(this.#seq, afterValue);
    return {
      events,
      cursor: last ? last.id : this.#seq,
      oldestCursor: oldest ? oldest.id : null,
      // Every issued id above the cursor is either retained or lost, whatever
      // removed it: the cap, the TTL, or a gap between retained entries.
      missed: Math.max(0, this.#seq - effectiveAfter - events.length),
      dropped: this.#dropped,
      lastEventAt: last ? last.at : null,
    };
  }

  clear(): void {
    this.#events.length = 0;
    this.#dedupe.clear();
  }

  #prune(): void {
    if (this.#ttlMs === 0) return;
    const cutoff = this.#now() - this.#ttlMs;
    // Browser observations expire wherever they sit; a control event keeps its
    // own entry but must not pin newer observations past the TTL.
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index];
      if (isBrowserObservation(event.kind) && event.at < cutoff) {
        this.#events.splice(index, 1);
        this.#dropped += 1;
      }
    }
  }
}

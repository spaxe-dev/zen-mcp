/** A Stop press that could not be delivered to the host yet. */
export interface PendingStop {
  progressId: string;
  ts: number;
}

/**
 * One-slot queue for a Stop press that the bridge could not send.
 *
 * Only one progress card exists at a time and its Stop button disables after a
 * press, so a single slot is enough: a newer press replaces an older one and
 * the store can never grow without bound. The press is kept until the host
 * echoes `stopRequested` or the card is replaced or cleared.
 */
export class PendingStopStore {
  #pending: PendingStop | null = null;

  /** Takes at most one entry; the latest press wins. */
  get size(): number {
    return this.#pending ? 1 : 0;
  }

  /** Queues a press, replacing any earlier queued press. */
  set(progressId: string, ts: number = Date.now()): void {
    if (!progressId) return;
    this.#pending = { progressId, ts };
  }

  /** Returns the queued press without removing it, or null when empty. */
  peek(): PendingStop | null {
    return this.#pending ? { ...this.#pending } : null;
  }

  clear(): void {
    this.#pending = null;
  }

  /**
   * Drops the queued press when the card it belongs to disappeared (null) or
   * was replaced by a different progress id. Stops for replaced cards must not
   * be resent.
   */
  clearIfProgressMoved(progressId: string | null): void {
    if (this.#pending && this.#pending.progressId !== progressId) {
      this.#pending = null;
    }
  }
}

export type StopSender = (stop: PendingStop) => boolean;

/**
 * Attempts to deliver one Stop press. A failed delivery is queued for the
 * next authenticated reconnect; a successful one clears older presses and
 * returns true. Returns false when the press could not be sent.
 */
export function deliverStop(
  store: PendingStopStore,
  progressId: string,
  sender: StopSender,
  ts: number = Date.now()
): boolean {
  if (sender({ progressId, ts })) {
    store.clear();
    return true;
  }
  store.set(progressId, ts);
  return false;
}

/**
 * EventBus — in-process publish/subscribe seam (T3, specs/005-notification-center).
 *
 * Behind an interface so a Postgres LISTEN/NOTIFY-backed implementation can be
 * swapped in later without an application rewrite (plan.md Risk R2). v1 ships the
 * in-process implementation only — correct for exactly one `notify-api` instance
 * (Railway `numReplicas: 1` pin, see railway.json / T17).
 *
 * Every open SSE connection for a `sub` (T7) registers one listener via subscribe().
 * publish() fans an event out to every listener currently registered for that sub —
 * this is how "two connections for one sub both receive fan-out" (tasks.md T7 done-
 * when) and "unread-reset broadcasts to all of sub's open streams" (US-3) are
 * implemented.
 *
 * connectionCount() exposes the total listener count across all subs — reused by
 * GET /health (plan.md §API contracts: "additionally report … active SSE connection
 * count for ops visibility").
 */

/** The two SSE event kinds the stream emits (plan.md §API contracts). */
export type NotifyEvent =
  | { type: "notification"; data: NotificationEventData }
  | { type: "unread-reset"; data: { count: number } };

/** Shape of the `notification` SSE event payload. */
export type NotificationEventData = {
  id: string;
  title: string;
  body: string;
  severity: string;
  originApp: string;
  link?: { href: string; label?: string | undefined } | undefined;
  toastWorthy: boolean;
  readAt: string | null;
  createdAt: string;
};

export type NotifyEventListener = (event: NotifyEvent) => void;

/**
 * EventBus interface — publish/subscribe scoped by `sub` (the JWT subject / recipient id).
 * Kept narrow and swap-friendly: any implementation (in-process, Postgres LISTEN/NOTIFY,
 * Redis pub/sub) only needs to satisfy this shape.
 */
export interface EventBus {
  /** Publish an event to every listener currently subscribed for `sub`. */
  publish(sub: string, event: NotifyEvent): void;
  /**
   * Register a listener for `sub`'s events. Returns an unsubscribe function —
   * callers (the SSE stream handler) MUST call it on disconnect to avoid leaking
   * listeners.
   */
  subscribe(sub: string, listener: NotifyEventListener): () => void;
  /** Total number of currently-registered listeners across all subs (ops visibility). */
  connectionCount(): number;
}

/**
 * In-process EventBus — a `Map<sub, Set<listener>>`. Correct for a single instance
 * only (plan.md Risk R2 / ADR-0008 consequences); publish() is synchronous and
 * fire-and-forget (SSE push is best-effort — plan.md Risk R5).
 */
export class InProcessEventBus implements EventBus {
  private readonly listenersBySub = new Map<string, Set<NotifyEventListener>>();

  publish(sub: string, event: NotifyEvent): void {
    const listeners = this.listenersBySub.get(sub);
    if (!listeners || listeners.size === 0) return;
    // Snapshot to an array before iterating — a listener that synchronously
    // unsubscribes during dispatch must not mutate the Set mid-iteration.
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }

  subscribe(sub: string, listener: NotifyEventListener): () => void {
    let listeners = this.listenersBySub.get(sub);
    if (!listeners) {
      listeners = new Set();
      this.listenersBySub.set(sub, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.listenersBySub.get(sub);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listenersBySub.delete(sub);
      }
    };
  }

  connectionCount(): number {
    let total = 0;
    for (const listeners of this.listenersBySub.values()) {
      total += listeners.size;
    }
    return total;
  }
}

/** Process-wide singleton — every route module imports this same instance. */
export const eventBus: EventBus = new InProcessEventBus();

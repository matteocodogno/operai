/**
 * TicketStore — SSE stream-handshake ticket seam (T3, specs/005-notification-center,
 * ADR-0008).
 *
 * `EventSource` cannot send an Authorization header, so the SSE handshake is
 * authenticated by a short-lived, single-use, sub-bound ticket instead (ADR-0008):
 *   1. POST /notifications/stream-ticket (Bearer/JWKS-authed, T7) calls mint(sub)
 *      and returns the opaque ticket to the client.
 *   2. GET /notifications/stream?ticket=… (T7) calls consume(ticket); a valid,
 *      unexpired, not-yet-used ticket resolves to the bound sub — exactly once.
 *
 * Behind an interface so a shared store (Postgres table, Redis) can replace the
 * in-process Map when notify-api scales beyond one replica (plan.md Risk R2) —
 * the mint↔consume ticket must be visible across instances at that point, which
 * the v1 in-process store cannot provide.
 *
 * SECURITY (ADR-0008 "Ticket replay within the TTL window"): consume() MUST be a
 * single atomic get-and-delete, not a separate read then write — otherwise two
 * near-simultaneous stream-open requests for the same ticket could both observe
 * "not yet consumed". The in-process implementation achieves this by relying on
 * JS's single-threaded execution: `Map.get` + `Map.delete` inside one synchronous
 * function body has no await between them, so no other consume() call can
 * interleave.
 */

export interface TicketStore {
  /** Mint a fresh single-use ticket bound to `sub`. Returns the opaque ticket string. */
  mint(sub: string): string;
  /**
   * Atomically consume a ticket: if it exists, is unexpired, and has not already
   * been consumed, returns the bound `sub` and removes the ticket (single-use).
   * Otherwise returns `undefined` (unknown / expired / already-used ticket — the
   * caller MUST treat all three identically as a 401, per ADR-0008 — never leak
   * which case occurred).
   */
  consume(ticket: string): string | undefined;
}

type TicketEntry = {
  sub: string;
  expiresAt: number; // epoch ms
};

/** Ticket TTL — ADR-0008: "~30 seconds". */
export const TICKET_TTL_MS = 30_000;

/**
 * In-process ticket store — a `Map<ticket, {sub, expiresAt}>`. Correct for a
 * single `notify-api` instance only (ADR-0008 Consequences / plan.md Risk R2).
 */
export class InProcessTicketStore implements TicketStore {
  private readonly tickets = new Map<string, TicketEntry>();

  constructor(private readonly ttlMs: number = TICKET_TTL_MS) {}

  mint(sub: string): string {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { sub, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  consume(ticket: string): string | undefined {
    // Atomic get-and-delete: one synchronous get() + delete(), no await between
    // them — a concurrent consume() for the same ticket cannot observe the entry
    // after this call has removed it (see file header SECURITY note).
    const entry = this.tickets.get(ticket);
    if (!entry) return undefined;
    this.tickets.delete(ticket); // single-use — removed regardless of expiry outcome below

    if (Date.now() > entry.expiresAt) {
      return undefined; // expired — treated identically to "unknown" by callers
    }

    return entry.sub;
  }
}

/** Process-wide singleton — every route module imports this same instance. */
export const ticketStore: TicketStore = new InProcessTicketStore();

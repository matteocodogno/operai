/**
 * auth client for the holders of `purchase-order:receive` (specs/022 T24; AC-4.1, AC-4.2, T18 M4,
 * L4): who may be the ops-manager of a purchase order taken from a deal of an entity. It backs both
 * the picker (`GET /queue/{dealId}/ops-managers`) and the take's re-validation of the choice.
 *
 * Asked of `auth GET /authz/users/holders` with the CALLER's own Bearer header, as `identities.ts`
 * does — no new credential — and always live: nothing is cached, because a role change must show on
 * the next take (and the admin gate of the listing is the caller's `handoff:take`, which projects-api
 * has already checked). Fails CLOSED: auth unreachable, slow, refusing (403, 429) or answering a
 * body it cannot read is a 503 `identity_unavailable`, never an empty list and never "valid".
 *
 * Only `{ id, name, unconditioned }` is read from each entry (T18 M4: auth sends no email and no
 * entity, and nothing else would be carried if it did).
 */

import type { Entity } from "../authz/conditions";
import { env } from "./env";
import { ProblemError } from "./problem";

/** A user who may receive purchase orders for an entity; `unconditioned` = holds it for every entity (an admin). */
export interface Holder {
  readonly id: string;
  readonly name: string;
  readonly unconditioned: boolean;
}

const REQUEST_TIMEOUT_MS = 5_000;

const identityUnavailable = (): ProblemError =>
  new ProblemError({
    status: 503,
    code: "identity_unavailable",
    detail: "The identity service is unavailable; the ops-manager could not be looked up",
  });

/** One entry of auth's answer, or `null` when it is not `{ id: string, name: string, unconditioned: boolean }`. */
function toHolder(raw: unknown): Holder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, name, unconditioned } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || typeof name !== "string" || typeof unconditioned !== "boolean") return null;
  return { id, name, unconditioned };
}

/** The active holders of `purchase-order:receive` for `entity` who hold `projects:access`, in auth's (name) order. */
export async function opsManagerCandidates(authorizationHeader: string, entity: Entity): Promise<Holder[]> {
  const params = new URLSearchParams({ resource: "purchase-order", action: "receive", entity });
  try {
    const res = await fetch(`${env.AUTH_BASE_URL}/authz/users/holders?${params}`, {
      headers: { Authorization: authorizationHeader },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`auth GET /authz/users/holders responded with HTTP ${res.status}`);
    const body = (await res.json()) as { users?: unknown } | null;
    if (!Array.isArray(body?.users)) throw new Error("auth returned an unreadable body");
    return body.users.flatMap((raw) => {
      const holder = toHolder(raw);
      return holder ? [holder] : [];
    });
  } catch (error) {
    console.error(
      "[holders] could not list the holders of purchase-order:receive from auth — refusing (fail-closed):",
      error instanceof Error ? error.message : error,
    );
    throw identityUnavailable();
  }
}

/**
 * Proves the `refund-admin` role's seeded grant shape (auth/src/authz/
 * seed.ts's `seedRefundAdminRole`, post-close follow-up to specs/007-refund-
 * service) actually authorizes refund-api's real enforcement predicates for
 * EVERY refund route — including reading and deciding a request that is
 * neither owned by the caller nor in the caller's own entity.
 *
 * `auth GET /authz/resolve` is out of process for refund-api (ADR-0014) — it
 * is not re-tested here. This file instead takes the EXACT (resource,
 * action, conditions) shape `seedRefundAdminRole` writes (7 grants, every
 * one carrying `conditions: null`) as a fixture standing in for what
 * `/authz/resolve` would return for a caller holding only that role, and
 * runs it through refund-api's own local evaluators (`conditions.ts`,
 * `requests.service.ts`'s `canReadRequest`, `review.service.ts`'s
 * `scopeForReviewAction`/`filterQueueInScope`) — the SAME functions the real
 * routes call. If this ever regresses (e.g. someone "fixes" the seed to
 * attach an entity condition, believing it more correct), these assertions
 * fail loudly instead of the role silently 403/404-ing in production.
 */

import { describe, it, expect } from "bun:test";
import type { AuthzContext } from "../auth/authz.middleware";
import {
  hasCapability,
  entityScopeForPermission,
  findPermission,
  GLOBAL_ENTITY_SCOPE,
} from "./conditions";
import type { ResolvedPermission } from "./resolveClient";
import { canReadRequest, canMutateAsOwner, type LineRow } from "../requests/requests.service";
import { scopeForReviewAction, filterQueueInScope } from "../review/review.service";
import type { QueueRequestRow } from "../review/review.repo";

let lineCounter = 0;

/** A full LineRow fixture for a given entity — only `entity` varies across this file's tests. */
function mkLine(entity: string): LineRow {
  lineCounter += 1;
  return {
    id: `line-${lineCounter}`,
    date: new Date("2026-07-01T00:00:00Z"),
    type: "meal",
    motivo: "test line",
    entity,
    currency: "EUR",
    requestedAmountCents: 1000,
    km: null,
    approvedTotalCents: null,
  };
}

// The exact 7-grant shape `seedRefundAdminRole` writes — refund:access plus
// all 6 request actions, every one unconditioned (conditions: null).
const REFUND_ADMIN_PERMISSIONS: readonly ResolvedPermission[] = [
  { resource: "refund", action: "access", conditions: null },
  { resource: "request", action: "create", conditions: null },
  { resource: "request", action: "read", conditions: null },
  { resource: "request", action: "review", conditions: null },
  { resource: "request", action: "set-approved-total", conditions: null },
  { resource: "request", action: "approve", conditions: null },
  { resource: "request", action: "reject", conditions: null },
];

// A refund-admin whose OWN resolved entity is WellD IT — deliberately
// different from the requests/lines under test below, which all belong to a
// different owner AND a different entity (WellD CH). If the role only worked
// for the caller's own entity, every assertion below would fail.
const REFUND_ADMIN_AUTHZ: AuthzContext = {
  permissions: REFUND_ADMIN_PERMISSIONS,
  entity: "welld_it",
};

const OUT_OF_SCOPE_OWNER_ID = "some-other-employee";
const CALLER_SUB = "refund-admin-user";

describe("refund-admin role grants (post-close follow-up, specs/007-refund-service)", () => {
  it("holds every refund capability at all (hasCapability true for all 7 grants)", () => {
    expect(hasCapability(REFUND_ADMIN_PERMISSIONS, "refund", "access")).toBe(true);
    for (const action of [
      "create",
      "read",
      "review",
      "set-approved-total",
      "approve",
      "reject",
    ]) {
      expect(hasCapability(REFUND_ADMIN_PERMISSIONS, "request", action)).toBe(true);
    }
  });

  it("every entity-scoped grant (review/set-approved-total/approve/reject) resolves to GLOBAL_ENTITY_SCOPE, not the caller's own entity", () => {
    for (const action of ["review", "set-approved-total", "approve", "reject"] as const) {
      const grant = findPermission(REFUND_ADMIN_PERMISSIONS, "request", action);
      const scope = entityScopeForPermission(grant?.conditions ?? null, REFUND_ADMIN_AUTHZ.entity);
      expect(scope).toBe(GLOBAL_ENTITY_SCOPE);
    }
  });

  it("scopeForReviewAction resolves GLOBAL_ENTITY_SCOPE (not undefined/403, not null/scoped-to-nothing) for every decision action", () => {
    for (const action of ["review", "set-approved-total", "approve", "reject"] as const) {
      expect(scopeForReviewAction(REFUND_ADMIN_AUTHZ, action)).toBe(GLOBAL_ENTITY_SCOPE);
    }
  });

  it("canReadRequest: GET /requests/:id succeeds for a request owned by someone else, in a different entity than the caller's own", () => {
    const outOfScopeRequest = {
      ownerUserId: OUT_OF_SCOPE_OWNER_ID,
      lines: [mkLine("welld_ch")],
    };
    expect(canReadRequest(outOfScopeRequest, REFUND_ADMIN_AUTHZ, CALLER_SUB)).toBe(true);
  });

  it("canReadRequest: also succeeds for a request with lines split across BOTH entities (whole-request access, not per-line)", () => {
    const mixedEntityRequest = {
      ownerUserId: OUT_OF_SCOPE_OWNER_ID,
      lines: [mkLine("welld_it"), mkLine("welld_ch")],
    };
    expect(canReadRequest(mixedEntityRequest, REFUND_ADMIN_AUTHZ, CALLER_SUB)).toBe(true);
  });

  it("filterQueueInScope (GET /review/requests) keeps a submitted request for a NON-caller entity — the queue is global, not just the caller's own entity", () => {
    const queueRows: QueueRequestRow[] = [
      {
        id: "req-ch",
        ownerUserId: OUT_OF_SCOPE_OWNER_ID,
        ownerEmail: "someone@welld.ch",
        ownerName: null,
        submittedAt: new Date("2026-07-01T00:00:00Z"),
        lines: [mkLine("welld_ch")],
      },
    ];

    const scope = scopeForReviewAction(REFUND_ADMIN_AUTHZ, "review");
    expect(scope).toBe(GLOBAL_ENTITY_SCOPE);
    if (scope === undefined || scope === null) {
      throw new Error("unreachable — asserted above");
    }
    const inScope = filterQueueInScope(queueRows, scope);
    expect(inScope).toHaveLength(1);
    expect(inScope[0]?.id).toBe("req-ch");
  });

  it("the approve/reject/set-approved-total routes' scope check would pass for an out-of-scope request (decide.routes.ts feeds `scope` straight into decide.repo.ts's query)", () => {
    // decide.routes.ts's handlers all short-circuit to 403 only when
    // scopeForReviewAction returns `undefined`; anything else (including
    // GLOBAL_ENTITY_SCOPE) is passed through to decide.repo.ts, which then
    // gates the actual DB row via the same requestInScope predicate
    // canReadRequest/filterQueueInScope already proved passes above.
    for (const action of ["set-approved-total", "approve", "reject"] as const) {
      const scope = scopeForReviewAction(REFUND_ADMIN_AUTHZ, action);
      expect(scope).toBe(GLOBAL_ENTITY_SCOPE);
    }
  });

  it("canMutateAsOwner still correctly denies the refund-admin acting as owner on someone else's draft (this role is a reviewer superuser, not an ownership bypass)", () => {
    const someoneElsesDraft = { ownerUserId: OUT_OF_SCOPE_OWNER_ID };
    expect(canMutateAsOwner(someoneElsesDraft, REFUND_ADMIN_AUTHZ, CALLER_SUB)).toBe(false);
  });

  it("the refund-admin CAN still create/read their own requests (request:create + request:read, ownership branch)", () => {
    const ownRequest = { ownerUserId: CALLER_SUB, lines: [mkLine("welld_it")] };
    expect(canReadRequest(ownRequest, REFUND_ADMIN_AUTHZ, CALLER_SUB)).toBe(true);
    expect(canMutateAsOwner(ownRequest, REFUND_ADMIN_AUTHZ, CALLER_SUB)).toBe(true);
  });
});

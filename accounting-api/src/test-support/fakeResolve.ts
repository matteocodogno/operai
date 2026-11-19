/**
 * A fake `auth GET /authz/resolve` (T4, specs/20261119-accounting): the callers every test file
 * uses, as literal permission sets. Scopes are literals written out here, never computed by the
 * code under test, so a bug in `coverage.ts` cannot hide in a persona that shares it.
 *
 *   harness.setResolve(fakeResolve(PERSONAS.accountingCh));
 *
 * The shapes are those of auth's `GET /authz/resolve` (auth/src/authz/resolve.routes.ts):
 * `conditions: null` is an unconditioned grant; `{ attributes: [{ key: "entity", match: "user" }] }`
 * narrows a grant to the holder's own entity (the suite's `REFUND_ENTITY_CONDITION`).
 */

import type { ResolveConditions, ResolvedPermission, ResolveResponse } from "../authz/resolveClient";

/** The entity condition of the `accounting` role's grants (auth's `REFUND_ENTITY_CONDITION`). */
export const ENTITY_CONDITION: ResolveConditions = { attributes: [{ key: "entity", match: "user" }] };

/** One `accounting:<action>` grant; `conditions` defaults to unconditioned. */
export const accountingGrant = (
  action: "read" | "manage",
  conditions: ResolveConditions | null = null,
): ResolvedPermission => ({ resource: "accounting", action, conditions });

export interface Persona {
  readonly sub: string;
  /** The caller's own entity, as auth resolves it (`null` = no entity attribute). */
  readonly entity: string | null;
  readonly permissions: readonly ResolvedPermission[];
}

/** The callers of the accounting tests. */
export const PERSONAS = {
  /** `admin`: read and manage, unconditioned: both entities. */
  admin: {
    sub: "user-admin",
    entity: null,
    permissions: [accountingGrant("read"), accountingGrant("manage")],
  },
  /** `accounting` attributed to welld_ch: read and manage, entity-conditioned. */
  accountingCh: {
    sub: "user-accounting-ch",
    entity: "welld_ch",
    permissions: [accountingGrant("read", ENTITY_CONDITION), accountingGrant("manage", ENTITY_CONDITION)],
  },
  /** `accounting` attributed to welld_it. */
  accountingIt: {
    sub: "user-accounting-it",
    entity: "welld_it",
    permissions: [accountingGrant("read", ENTITY_CONDITION), accountingGrant("manage", ENTITY_CONDITION)],
  },
  /** A reader of welld_ch: `accounting:read` entity-conditioned, no manage. */
  readerCh: {
    sub: "user-reader-ch",
    entity: "welld_ch",
    permissions: [accountingGrant("read", ENTITY_CONDITION)],
  },
  /** A holder of `accounting:manage` alone (it covers read, AC-3.2), entity-conditioned. */
  managerOnlyCh: {
    sub: "user-manager-only-ch",
    entity: "welld_ch",
    permissions: [accountingGrant("manage", ENTITY_CONDITION)],
  },
  /** No accounting grant at all (a Refund reviewer, an employee). */
  outsider: { sub: "user-outsider", entity: "welld_ch", permissions: [] },
  /** An entity-conditioned grant whose holder has no entity: covers nothing (fail closed). */
  noEntity: {
    sub: "user-no-entity",
    entity: null,
    permissions: [accountingGrant("read", ENTITY_CONDITION), accountingGrant("manage", ENTITY_CONDITION)],
  },
  /** A grant with a condition this service does not know: covers nothing (fail closed). */
  unknownCondition: {
    sub: "user-unknown-condition",
    entity: "welld_ch",
    permissions: [
      accountingGrant("read", { attributes: [{ key: "department", match: "user" }] }),
      accountingGrant("manage", { ownership: "own" }),
    ],
  },
} as const satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

/** The `GET /authz/resolve` body for a persona (epoch fixed at 1). */
export const resolveBodyFor = (persona: Persona): ResolveResponse => ({
  sub: persona.sub,
  epoch: 1,
  permissions: persona.permissions,
  entity: persona.entity,
  jobTitle: null,
});

/** A resolver for `harness.setResolve`: answers the persona's grants whatever the Bearer token. */
export const fakeResolve =
  (persona: Persona) =>
  async (_authorizationHeader: string): Promise<ResolveResponse> =>
    resolveBodyFor(persona);

/** A resolver that fails as an unreachable `auth` does (the middleware must answer 503). */
export const failingResolve = async (_authorizationHeader: string): Promise<ResolveResponse> => {
  throw new Error("simulated auth outage");
};

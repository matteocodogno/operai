/**
 * Refund's declared permission catalog (T2, specs/007-refund-service — refs
 * AC-1.1, AC-5.4, AC-7.5, AC-8.2; plan.md "Authz integration"; ADR-0007 §7).
 * Extended by T1, specs/009-mileage-rate (plan.md "Architecture §auth",
 * Decision 2) with a third resource, `rate` — see below.
 *
 * Mirrors `catalogs/estimai.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `refund-api` enforces
 * server-side (ADR-0014) — NOT a database row. `../seed.ts`'s
 * `seedRefundCatalog` registers it via `upsertAppCatalog` (one full-replace
 * upsert keyed by `appId`), so the admin-ui rule composer can build roles
 * against it and `refund-api`'s `authzMiddleware` (T6) can gate real routes
 * against the SAME declared (resource, action) pairs.
 *
 * `refund` was previously an access-only stub registered by
 * `seedAppAccessCatalog`'s `SUITE_APPS` list (spec 004). This is refund's
 * FULL catalog — `refund` moves OUT of `SUITE_APPS` (exactly as `estimai`
 * was excluded there) so its `access` action is registered exactly once,
 * here, alongside its own domain resources, not via two potentially-
 * conflicting full-replace upserts.
 *
 * Three resources:
 *   - `refund` (the app-access resource, keyed by the app id itself) — a
 *     single `access` action, no conditions. Same shape every suite app's
 *     access resource gets.
 *   - `request` — the domain resource — with the six actions plan.md's
 *     "Authz integration" section enumerates. `supportedConditions` per
 *     action, exactly as specified there:
 *       - `create`             — `[]` (an employee owns whatever they create;
 *                                  no condition needed to gate creation itself)
 *       - `read`                — `["ownership"]` (an employee reads their
 *                                  own requests; `ownership:own`)
 *       - `review`              — `["entity"]` (accounting: queue + full
 *                                  detail, entity-scoped per ADR-0015)
 *       - `set-approved-total`  — `["entity"]`
 *       - `approve`             — `["entity"]`
 *       - `reject`              — `["entity"]`
 *     Submit/withdraw/edit/delete of a draft are authorized by `create` +
 *     ownership of the request (the creator) per plan.md — they are
 *     deliberately NOT separate catalog actions.
 *   - `rate` (T1, specs/009-mileage-rate) — the mileage-rate configuration
 *     resource, with `read`/`manage` actions. BOTH deliberately declare NO
 *     `supportedConditions` — a stark contrast with `request`'s entity-scoped
 *     accounting actions (ADR-0015): rate configuration is suite-wide, not
 *     per-entity, so there is no attribute to condition on (plan.md
 *     "Architecture §auth", Decision 2). Rate storage/logic itself lives
 *     entirely in `refund-api` — this catalog only declares the permission
 *     surface; `auth` never gains a rate data table or API.
 *
 * Declaration only: registering this catalog does NOT itself grant anything
 * — `seedRefundCatalog` (catalog) and the SEPARATE `accounting`/`admin`/
 * `refund-admin` role grants (`seed.ts`'s `seedAccountingRoleGrants`/
 * `seedAdminRoleGrants`/`seedRefundAdminRole`/`seedRateAdminGrants`) are
 * independent steps, exactly as `seedEstimaiCatalog`/`seedAdminRoleGrants`
 * are for EstimAI/admin.
 */

import type { AppCatalogInput } from "../catalog";

/** Refund's app id across the Operai suite catalog/role system. */
export const REFUND_APP_ID = "refund";

/** The `request` resource's entity-scoped accounting actions (ADR-0015). */
const ENTITY_SCOPED_CONDITIONS = ["entity"];

/** Refund's full declared catalog — registered by `seedRefundCatalog` (T2). */
export const REFUND_CATALOG: AppCatalogInput = {
  appId: REFUND_APP_ID,
  resources: [
    {
      key: REFUND_APP_ID,
      label: "Refund",
      actions: [{ key: "access", label: "Access", supportedConditions: [] }],
    },
    {
      key: "request",
      label: "Refund request",
      actions: [
        { key: "create", label: "Create", supportedConditions: [] },
        { key: "read", label: "Read", supportedConditions: ["ownership"] },
        { key: "review", label: "Review", supportedConditions: ENTITY_SCOPED_CONDITIONS },
        {
          key: "set-approved-total",
          label: "Set approved total",
          supportedConditions: ENTITY_SCOPED_CONDITIONS,
        },
        { key: "approve", label: "Approve", supportedConditions: ENTITY_SCOPED_CONDITIONS },
        { key: "reject", label: "Reject", supportedConditions: ENTITY_SCOPED_CONDITIONS },
      ],
    },
    {
      key: "rate",
      label: "Mileage rate",
      actions: [
        { key: "read", label: "Read", supportedConditions: [] },
        { key: "manage", label: "Manage", supportedConditions: [] },
      ],
    },
  ],
};

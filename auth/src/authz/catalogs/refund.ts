/**
 * Refund's declared permission catalog (T2, specs/20260716-refund-service — refs
 * AC-1.1, AC-5.4, AC-7.5, AC-8.2; plan.md "Authz integration"; ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims §7).
 * Extended by T1, specs/20260720-mileage-rate (plan.md "Architecture §auth",
 * Decision 2) with a third resource, `rate` — see below.
 *
 * Mirrors `catalogs/estimai.ts`'s shape: a plain constant describing the
 * (resource, action, supportedConditions) surface `refund-api` enforces
 * server-side (ADR 20260716-refund-api-authorization-enforcing-resource-server) — NOT a database row. `../seed.ts`'s
 * `seedRefundCatalog` registers it via `upsertAppCatalog` (one full-replace
 * upsert keyed by `appId`), so the admin-ui rule composer can build roles
 * against it and `refund-api`'s `authzMiddleware` (T6) can gate real routes
 * against the SAME declared (resource, action) pairs.
 *
 * Extended by T1, specs/20260721-self-approval-control (plan.md Decision D1;
 * ADR 20260721-self-approval-condition-and-403-exception): `request.approve` gains a SECOND supported condition,
 * `self-approval` — a segregation-of-duties deny-carve-out
 * (`{key:"self-approval", match:"deny"}`, opposite polarity from `entity`'s
 * `match:"user"`), declared on `approve` ONLY (D3/AC-4.3) — never on
 * `reject`/`set-approved-total`/`review`/`read`/`create`. This is the ONLY
 * code change specs/20260721-self-approval-control makes in `auth`: the attribute rides the existing
 * free-form `attributes[]` machinery (resolver `toRuleConditions`, the wire
 * schemas, and `findRuleViolations`'s catalog gate) unchanged.
 *
 * Extended by T1, specs/20260722-refund-settings (plan.md "Architecture §auth",
 * Decision D2; ADR 20260722-settings-catalog-permission-config-not-rate) with a FOURTH resource, `settings` — see below.
 *
 * Extended by T2, specs/20261118-refund-accounting-export (plan.md "auth", Decision D5;
 * ADR 20261118-accounting-classification-is-live-until-approval-then-frozen-and-...):
 * `request` gains a SEVENTH action, `reclassify` — changing the accounting
 * classification (ledger account, VAT code) of a line of an `approved`, not yet
 * `paid` request. Before approval the same change needs `set-approved-total`;
 * after approval it needs this one, so that who may re-book an approved line is a
 * role edit in admin-ui, with no deploy (open question 5 of that spec). Entity
 * condition only, like `approve`; never `self-approval`. DEPLOY ORDER: auth goes
 * out BEFORE refund-api (plan R13): until this catalog is registered nobody holds
 * `reclassify`, so refund-api fails closed (403) on a post-approval change.
 *
 * `refund` was previously an access-only stub registered by
 * `seedAppAccessCatalog`'s `SUITE_APPS` list (spec 004). This is refund's
 * FULL catalog — `refund` moves OUT of `SUITE_APPS` (exactly as `estimai`
 * was excluded there) so its `access` action is registered exactly once,
 * here, alongside its own domain resources, not via two potentially-
 * conflicting full-replace upserts.
 *
 * Four resources:
 *   - `refund` (the app-access resource, keyed by the app id itself) — a
 *     single `access` action, no conditions. Same shape every suite app's
 *     access resource gets.
 *   - `request` — the domain resource — with the six actions plan.md's
 *     "Authz integration" section enumerates (plus `reclassify`, T2 of
 *     specs/20261118-refund-accounting-export, described above). `supportedConditions` per
 *     action, exactly as specified there:
 *       - `create`             — `[]` (an employee owns whatever they create;
 *                                  no condition needed to gate creation itself)
 *       - `read`                — `["ownership"]` (an employee reads their
 *                                  own requests; `ownership:own`)
 *       - `review`              — `["entity"]` (accounting: queue + full
 *                                  detail, entity-scoped per ADR 20260716-entity-scoped-abac-refund-api)
 *       - `set-approved-total`  — `["entity"]`
 *       - `approve`             — `["entity", "self-approval"]` (specs/20260721-self-approval-control,
 *                                  ADR 20260721-self-approval-condition-and-403-exception — the self-approval SoD condition
 *                                  is declared here ONLY)
 *       - `reject`              — `["entity"]`
 *       - `reclassify`          — `["entity"]` (specs/20261118-refund-accounting-export;
 *                                  granted to the same holders as `approve`, WITHOUT
 *                                  `self-approval`: it is not an approval)
 *     Submit/withdraw/edit/delete of a draft are authorized by `create` +
 *     ownership of the request (the creator) per plan.md — they are
 *     deliberately NOT separate catalog actions.
 *   - `rate` (T1, specs/20260720-mileage-rate) — the mileage-rate configuration
 *     resource, with `read`/`manage` actions. BOTH deliberately declare NO
 *     `supportedConditions` — a stark contrast with `request`'s entity-scoped
 *     accounting actions (ADR 20260716-entity-scoped-abac-refund-api): rate configuration is suite-wide, not
 *     per-entity, so there is no attribute to condition on (plan.md
 *     "Architecture §auth", Decision 2). Rate storage/logic itself lives
 *     entirely in `refund-api` — this catalog only declares the permission
 *     surface; `auth` never gains a rate data table or API.
 *   - `settings` (T1, specs/20260722-refund-settings; ADR 20260722-settings-catalog-permission-config-not-rate) — the refund
 *     config resource (currently one setting: the accounting distribution
 *     email), with `read`/`manage` actions. Both deliberately declare NO
 *     `supportedConditions` — global/unconditioned, the same shape as `rate`
 *     (plan.md "Architecture §auth", Decision D2) — but this is a DISTINCT
 *     resource from `rate`, not a third action on it: a distribution mailbox
 *     is not a rate, and conflating the two would make the two admin
 *     surfaces un-separable/un-auditable in isolation (ADR 20260722-settings-catalog-permission-config-not-rate). Unlike
 *     `rate:read` (deliberately ungated for `GET /rates/effective`'s
 *     employee-facing read, ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition), `settings:read` IS a real
 *     authorization boundary — a non-holder must not even learn the mailbox
 *     exists (AC-3.2). Settings storage/logic itself lives entirely in
 *     `refund-api` (the `refund_setting` table, ADR 20260722-refund-settings-append-only-self-auditing-store) — this catalog
 *     only declares the permission surface; `auth` never gains a settings
 *     data table or API.
 *
 * Declaration only: registering this catalog does NOT itself grant anything
 * — `seedRefundCatalog` (catalog) and the SEPARATE `accounting`/`admin`/
 * `refund-admin` role grants (`seed.ts`'s `seedAccountingRoleGrants`/
 * `seedAdminRoleGrants`/`seedRefundAdminRole`/`seedRateAdminGrants`/
 * `seedSettingsAdminGrants`) are independent steps, exactly as
 * `seedEstimaiCatalog`/`seedAdminRoleGrants` are for EstimAI/admin.
 */

import type { AppCatalogInput } from "../catalog";

/** Refund's app id across the Operai suite catalog/role system. */
export const REFUND_APP_ID = "refund";

/** The `request` resource's entity-scoped accounting actions (ADR 20260716-entity-scoped-abac-refund-api). */
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
        {
          key: "approve",
          label: "Approve",
          // `self-approval` (specs/20260721-self-approval-control, ADR 20260721-self-approval-condition-and-403-exception) is declared on `approve`
          // ONLY — never spread onto review/set-approved-total/reject, which
          // keep `ENTITY_SCOPED_CONDITIONS` unchanged (D3/AC-4.3).
          supportedConditions: [...ENTITY_SCOPED_CONDITIONS, "self-approval"],
        },
        { key: "reject", label: "Reject", supportedConditions: ENTITY_SCOPED_CONDITIONS },
        {
          key: "reclassify",
          label: "Reclassify approved line",
          // Entity condition only (D5, AC-3.6): the same scope as the other
          // accounting actions. `self-approval` stays on `approve` ONLY.
          supportedConditions: ENTITY_SCOPED_CONDITIONS,
        },
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
    {
      key: "settings",
      label: "Refund settings",
      actions: [
        { key: "read", label: "Read", supportedConditions: [] },
        { key: "manage", label: "Manage", supportedConditions: [] },
      ],
    },
  ],
};

/**
 * Catalog management routes (T8, specs/20261119-accounting, plan § API contracts; moved from refund-api's
 * `src/accounting/catalog.routes.ts`; AC-1.1 to AC-1.4, AC-1.9, AC-1.11 to AC-1.13, AC-3.4 to AC-3.6, AC-8.3; T9 adds
 * the VAT codes, AC-1.5 to AC-1.8 and AC-1.10, to this router).
 *
 *   GET  /v1/entities/{entity}/ledger-accounts                        read
 *   POST /v1/entities/{entity}/ledger-accounts                        manage   { number, name }
 *   POST /v1/entities/{entity}/ledger-accounts/{number}/deactivate    manage
 *   POST /v1/entities/{entity}/ledger-accounts/{number}/reactivate    manage
 *   GET  /v1/entities/{entity}/vat-codes                              read
 *   POST /v1/entities/{entity}/vat-codes                              manage   { code, label, ratePercent }
 *   POST /v1/entities/{entity}/vat-codes/{code}/deactivate | reactivate          manage ({code} upper-cased first)
 *
 * An entry is keyed by its natural key in the URL, never by an id (D24). There is NO PUT, PATCH or DELETE: the router
 * answers 404 for them (AC-1.12), whoever asks. A wrong number or name means a new account; a wrong rate means a new VAT code (AC-1.7).
 *
 * Authorization is `requireEntityAccess` (T6), and it runs in a middleware BEFORE the body is validated, so a caller
 * without `manage` always gets 403 and never learns what a valid body looks like, and a refused request writes and
 * audits nothing (AC-3.4). In its order: no read coverage at all -> 403 `accounting_forbidden` with no data; an entity
 * that does not exist or is outside the caller's read coverage -> 404 `not_found`, one body for both (AC-3.5); a write
 * without manage -> 403 `accounting_manage_required`. A method with no route (PUT, PATCH, DELETE) is not gated: it
 * falls through to the app's 404, behind the login of the path like every other method.
 *
 * `createdBy*` come from the verified JWT, never the body. Responses are the minimal projection of D18.
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "../authz/authz.middleware";
import { requireEntityAccess } from "../authz/coverage";
import type { Entity } from "../entities";
import { ProblemError, validationHook } from "../lib/problem";
import {
  createLedgerAccount,
  createVatCode,
  listLedgerAccounts,
  listVatCodes,
  percentToBasisPoints,
  setLedgerAccountActive,
  setVatCodeActive,
  type Actor,
} from "./catalog.repo";
import {
  AddLedgerAccountBodySchema,
  AddVatCodeBodySchema,
  CatalogProblemSchema,
  EntityParamsSchema,
  LedgerAccountItemSchema,
  LedgerAccountListSchema,
  LedgerAccountParamsSchema,
  VatCodeItemSchema,
  VatCodeListSchema,
  VatCodeParamsSchema,
} from "./catalog.schemas";
import {
  CATALOG_CAPS,
  checkLedgerName,
  checkLedgerNumber,
  checkVatCode,
  checkVatLabel,
  checkVatRatePercent,
  describeRefusal,
  upperCaseCode,
  type FieldReason,
  type FieldRefusal,
} from "./limits";

type CatalogVariables = AuthzVariables & { entity: Entity };

// ─── Refusals ────────────────────────────────────────────────────────────────

const REASONS: readonly FieldReason[] = ["empty", "format", "too_long", "range"];

/** 422 with `fields[{ field, reason }]`, naming every refused field (AC-1.2). */
const refusedFields = (code: string, fields: readonly FieldRefusal[]): ProblemError =>
  new ProblemError({
    status: 422,
    code,
    detail: `Nothing was saved: ${fields.map(describeRefusal).join("; ")}`,
    extras: { fields },
  });

/** A schema failure of a body: only a field that is missing or not a string gets here (`empty` or `format`, see the schema). */
function bodyFailure(code: string, issues: readonly { path: readonly PropertyKey[]; message: string }[], known: readonly string[]) {
  const fields: FieldRefusal[] = [];
  for (const issue of issues) {
    const field = String(issue.path[0] ?? "");
    if (!known.includes(field) || fields.some((f) => f.field === field)) continue;
    const reason = (REASONS as readonly string[]).includes(issue.message) ? (issue.message as FieldReason) : "format";
    fields.push({ field, reason });
  }
  // A body that is not an object at all (`null`, a list, a string): every field is wrong.
  return refusedFields(code, fields.length > 0 ? fields : known.map((field) => ({ field, reason: "format" as const })));
}

/**
 * 409 `catalog_full`: the entity holds as many entries as it may (deactivated ones count: nothing is ever deleted), so
 * nothing was added (security-review F-01). The reader of the catalog, Refund, takes the whole of it in one body.
 */
const catalogFull = (what: string, entity: Entity, limit: number): ProblemError =>
  new ProblemError({
    status: 409,
    code: "catalog_full",
    detail: `Nothing was added: ${entity} already has the most ${what} it can hold (${limit}, deactivated ones included)`,
    extras: { limit },
  });

// ─── Router ──────────────────────────────────────────────────────────────────

export const catalogRouter = new OpenAPIHono<{ Variables: CatalogVariables }>({
  defaultHook: (result, c) => {
    if (result.success) return undefined;
    if (result.target === "json" && c.req.path.endsWith("/ledger-accounts")) {
      return bodyFailure("invalid_ledger_account", result.error.issues, ["number", "name"]).toResponse(c.req.path);
    }
    if (result.target === "json" && c.req.path.endsWith("/vat-codes")) {
      return bodyFailure("invalid_vat_code", result.error.issues, ["code", "label", "ratePercent"]).toResponse(c.req.path);
    }
    return validationHook(result, c);
  },
});

/** The gate of every catalog path: login, live permissions, then the entity (and manage for a write). */
const entityGate = createMiddleware<{ Variables: CatalogVariables }>(async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "POST") {
    c.set("entity", requireEntityAccess(c, c.req.param("entity") ?? "", method === "POST" ? "manage" : "read"));
  }
  await next();
});

// Only these paths: a router mounted at "/" must not put a login in front of an unknown URL's 404.
for (const resource of ["ledger-accounts", "vat-codes"] as const) {
  catalogRouter.use(`/v1/entities/:entity/${resource}`, jwtMiddleware, authzMiddleware, entityGate);
  catalogRouter.use(`/v1/entities/:entity/${resource}/*`, jwtMiddleware, authzMiddleware, entityGate);
}

const actorOf = (c: { get(key: "userId"): string; get(key: "email"): string }): Actor => ({
  userId: c.get("userId"),
  email: c.get("email"),
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const problemResponse = (description: string) => json(CatalogProblemSchema, description);

const COMMON_REFUSALS = {
  401: problemResponse("No valid token"),
  403: problemResponse("`accounting_forbidden` (no read for any entity, no data) or `accounting_manage_required` (a write without manage)"),
  404: problemResponse("`not_found`: the entity does not exist or is outside the caller's coverage, or the entry does not exist"),
  503: problemResponse("The authorization service is unavailable (fail closed)"),
} as const;

// ─── Ledger accounts ─────────────────────────────────────────────────────────

const listAccountsRoute = createRoute({
  method: "get",
  path: "/v1/entities/{entity}/ledger-accounts",
  tags: ["Ledger accounts"],
  summary: "List the ledger accounts of an entity, active and deactivated",
  description: "Ordered by number, segment by segment. An entity with none entered yet answers an empty list, not an error (AC-8.3).",
  security: [{ Bearer: [] }],
  request: { params: EntityParamsSchema },
  responses: { 200: json(LedgerAccountListSchema, "The accounts of the entity"), ...COMMON_REFUSALS },
});

catalogRouter.openapi(listAccountsRoute, async (c) => {
  const entity = c.get("entity");
  return c.json({ entity, items: await listLedgerAccounts(entity) }, 200);
});

const addAccountRoute = createRoute({
  method: "post",
  path: "/v1/entities/{entity}/ledger-accounts",
  tags: ["Ledger accounts"],
  summary: "Add a ledger account to an entity",
  description:
    "The number is digits separated by single dots (1 to 20 characters), the name 1 to 120 characters; blanks around " +
    "either are removed first (AC-1.2). The same number in the same entity is refused whether the first is active or " +
    "deactivated (AC-1.3); the same number in the other entity is accepted. An entity holds at most " +
    `${CATALOG_CAPS.ledgerAccountsPerEntity} accounts, deactivated ones included (409 \`catalog_full\`).`,
  security: [{ Bearer: [] }],
  request: {
    params: EntityParamsSchema,
    body: { required: true, content: { "application/json": { schema: AddLedgerAccountBodySchema } } },
  },
  responses: {
    201: json(LedgerAccountItemSchema, "The new, active account (AC-1.1)"),
    409: problemResponse(
      "`ledger_account_duplicate` with `number` and `reactivate` (true when the existing entry is deactivated), or `catalog_full` with `limit` (the entity holds the most it may, deactivated ones included)",
    ),
    422: problemResponse("`invalid_ledger_account` with `fields[{ field, reason }]`"),
    ...COMMON_REFUSALS,
  },
});

catalogRouter.openapi(addAccountRoute, async (c) => {
  const entity = c.get("entity");
  const body = c.req.valid("json");
  const number = checkLedgerNumber(body.number);
  const name = checkLedgerName(body.name);
  const fields: FieldRefusal[] = [
    ...(number.ok ? [] : [{ field: "number", reason: number.reason }]),
    ...(name.ok ? [] : [{ field: "name", reason: name.reason }]),
  ];
  if (!number.ok || !name.ok) throw refusedFields("invalid_ledger_account", fields);

  const outcome = await createLedgerAccount(entity, { number: number.value, name: name.value }, actorOf(c));
  if (outcome.kind === "full") throw catalogFull("ledger accounts", entity, outcome.limit);
  if (outcome.kind === "duplicate") {
    throw new ProblemError({
      status: 409,
      code: "ledger_account_duplicate",
      detail: `Account ${number.value} already exists`,
      extras: { number: number.value, reactivate: outcome.reactivate },
    });
  }
  return c.json(outcome.item, 201);
});

function statusRoute(action: "deactivate" | "reactivate") {
  return createRoute({
    method: "post",
    path: `/v1/entities/{entity}/ledger-accounts/{number}/${action}`,
    tags: ["Ledger accounts"],
    summary: `${action === "deactivate" ? "Deactivate" : "Reactivate"} a ledger account`,
    description:
      "Appends one status row with the actor, the time and the entity (AC-1.13). Asking for the state the entry is " +
      `already in is a 409 \`${action === "deactivate" ? "already_inactive" : "already_active"}\` and writes nothing (AC-1.11).`,
    security: [{ Bearer: [] }],
    request: { params: LedgerAccountParamsSchema },
    responses: {
      200: json(LedgerAccountItemSchema, "The entry in its new state"),
      409: problemResponse("`already_inactive` / `already_active`: nothing written"),
      ...COMMON_REFUSALS,
    },
  });
}

for (const action of ["deactivate", "reactivate"] as const) {
  catalogRouter.openapi(statusRoute(action), async (c) => {
    const entity = c.get("entity");
    const { number } = c.req.valid("param");
    const outcome = await setLedgerAccountActive(entity, number, action === "reactivate", actorOf(c));
    if (outcome.kind === "not_found") throw new ProblemError({ status: 404, code: "not_found", detail: "Not found" });
    if (outcome.kind === "unchanged") {
      const state = outcome.active ? "active" : "inactive";
      throw new ProblemError({
        status: 409,
        code: `already_${state}`,
        detail: `Account ${outcome.item.number} is already ${state}`,
      });
    }
    return c.json(outcome.item, 200);
  });
}

// ─── VAT codes ───────────────────────────────────────────────────────────────

const listVatCodesRoute = createRoute({
  method: "get",
  path: "/v1/entities/{entity}/vat-codes",
  tags: ["VAT codes"],
  summary: "List the VAT codes of an entity, active and deactivated",
  description:
    "In code order. The rate is shown as a percentage string and in basis points. An entity with none entered yet " +
    "answers an empty list, not an error (AC-8.3).",
  security: [{ Bearer: [] }],
  request: { params: EntityParamsSchema },
  responses: { 200: json(VatCodeListSchema, "The VAT codes of the entity"), ...COMMON_REFUSALS },
});

catalogRouter.openapi(listVatCodesRoute, async (c) => {
  const entity = c.get("entity");
  return c.json({ entity, items: await listVatCodes(entity) }, 200);
});

const addVatCodeRoute = createRoute({
  method: "post",
  path: "/v1/entities/{entity}/vat-codes",
  tags: ["VAT codes"],
  summary: "Add a VAT code to an entity (its rate can never change afterwards)",
  description:
    "The code is 1 to 16 capital letters, digits, `_` or `-` (lower case is converted first), the label 1 to 80 " +
    "characters, the rate 0 to 100 percent with at most two decimals (AC-1.5). A code equal to an existing one " +
    "ignoring case, active or deactivated, is refused naming it (AC-1.6); the same code in the other entity is accepted. " +
    `An entity holds at most ${CATALOG_CAPS.vatCodesPerEntity} codes, deactivated ones included (409 \`catalog_full\`).`,
  security: [{ Bearer: [] }],
  request: {
    params: EntityParamsSchema,
    body: { required: true, content: { "application/json": { schema: AddVatCodeBodySchema } } },
  },
  responses: {
    201: json(VatCodeItemSchema, "The new, active code (AC-1.5)"),
    409: problemResponse(
      "`vat_code_duplicate` with `vatCode` and `reactivate` (true when the existing code is deactivated), or `catalog_full` with `limit` (the entity holds the most it may, deactivated ones included)",
    ),
    422: problemResponse("`invalid_vat_code` with `fields[{ field, reason }]`"),
    ...COMMON_REFUSALS,
  },
});

catalogRouter.openapi(addVatCodeRoute, async (c) => {
  const entity = c.get("entity");
  const body = c.req.valid("json");
  const code = checkVatCode(body.code);
  const label = checkVatLabel(body.label);
  const rate = checkVatRatePercent(body.ratePercent);
  const fields: FieldRefusal[] = [
    ...(code.ok ? [] : [{ field: "code", reason: code.reason }]),
    ...(label.ok ? [] : [{ field: "label", reason: label.reason }]),
    ...(rate.ok ? [] : [{ field: "ratePercent", reason: rate.reason }]),
  ];
  if (!code.ok || !label.ok || !rate.ok) throw refusedFields("invalid_vat_code", fields);

  const outcome = await createVatCode(
    entity,
    { code: code.value, label: label.value, rateBasisPoints: percentToBasisPoints(rate.value) },
    actorOf(c),
  );
  if (outcome.kind === "full") throw catalogFull("VAT codes", entity, outcome.limit);
  if (outcome.kind === "duplicate") {
    throw new ProblemError({
      status: 409,
      code: "vat_code_duplicate",
      detail: `VAT code ${code.value} already exists`,
      extras: { vatCode: code.value, reactivate: outcome.reactivate },
    });
  }
  return c.json(outcome.item, 201);
});

function vatStatusRoute(action: "deactivate" | "reactivate") {
  return createRoute({
    method: "post",
    path: `/v1/entities/{entity}/vat-codes/{code}/${action}`,
    tags: ["VAT codes"],
    summary: `${action === "deactivate" ? "Deactivate" : "Reactivate"} a VAT code`,
    description:
      "`{code}` is converted to capital letters before the lookup. Appends one status row with the actor, the time and " +
      "the entity (AC-1.13). Asking for the state the entry is already in is a 409 " +
      `\`${action === "deactivate" ? "already_inactive" : "already_active"}\` and writes nothing (AC-1.11).`,
    security: [{ Bearer: [] }],
    request: { params: VatCodeParamsSchema },
    responses: {
      200: json(VatCodeItemSchema, "The code in its new state"),
      409: problemResponse("`already_inactive` / `already_active`: nothing written"),
      ...COMMON_REFUSALS,
    },
  });
}

for (const action of ["deactivate", "reactivate"] as const) {
  catalogRouter.openapi(vatStatusRoute(action), async (c) => {
    const entity = c.get("entity");
    const code = upperCaseCode(c.req.valid("param").code);
    const outcome = await setVatCodeActive(entity, code, action === "reactivate", actorOf(c));
    if (outcome.kind === "not_found") throw new ProblemError({ status: 404, code: "not_found", detail: "Not found" });
    if (outcome.kind === "unchanged") {
      const state = outcome.active ? "active" : "inactive";
      throw new ProblemError({
        status: 409,
        code: `already_${state}`,
        detail: `VAT code ${outcome.item.code} is already ${state}`,
      });
    }
    return c.json(outcome.item, 200);
  });
}

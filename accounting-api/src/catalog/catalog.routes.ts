/**
 * Catalog management endpoints (T6, specs/20261118-refund-accounting-export,
 * plan § API contracts "Catalog: management"; AC-1.1 to AC-1.11).
 *
 *   GET  /accounting/ledger-accounts                      settings:read
 *   POST /accounting/ledger-accounts                      settings:manage
 *   POST /accounting/ledger-accounts/{id}/deactivate      settings:manage
 *   POST /accounting/ledger-accounts/{id}/reactivate      settings:manage
 *   GET/POST /accounting/vat-codes, .../{id}/deactivate|reactivate   (same)
 *
 * There is NO PUT, PATCH or DELETE for either resource (AC-1.5): the router
 * answers 404 for them. A VAT rate is fixed at creation, and a wrong rate means
 * a new code.
 *
 * Gating mirrors `/settings/{key}` (ADR 20260722-settings-catalog-permission-
 * config-not-rate): `settings:read` for GET, `settings:manage` for writes, and
 * the two are independent (manage does not imply read). The capability is
 * checked in a middleware, BEFORE the body is validated, so a caller without
 * `manage` always gets 403 and never learns what a valid body looks like.
 * `createdBy*` come from the verified JWT, never the body.
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
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
  CatalogIdParamSchema,
  CatalogProblemSchema,
  LedgerAccountItemSchema,
  LedgerAccountListSchema,
  VatCodeItemSchema,
  VatCodeListSchema,
} from "./catalog.schemas";

// ─── Problem JSON helpers ────────────────────────────────────────────────────

const problem = <S extends number>(status: S, title: string, path: string, detail: string, code?: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance: path,
  ...(code !== undefined ? { code } : {}),
});

const CATALOG_BODY_SIZE_LIMIT = 4 * 1024; // 4 KiB: a number and a name, or a code, a label and a rate

// ─── Router ──────────────────────────────────────────────────────────────────

export const catalogRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      const code = c.req.path.startsWith("/accounting/vat-codes") ? "invalid_vat_code" : "invalid_ledger_account";
      return c.json(
        problem(
          422,
          "Unprocessable Entity",
          c.req.path,
          result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          code,
        ),
        422,
      );
    }
    return undefined;
  },
});

for (const prefix of ["/accounting/ledger-accounts", "/accounting/vat-codes"]) {
  catalogRouter.use(
    `${prefix}/*`,
    bodyLimit({
      maxSize: CATALOG_BODY_SIZE_LIMIT,
      onError: (c) => c.json(problem(413, "Payload Too Large", c.req.path, "Request body is too large."), 413),
    }),
    jwtMiddleware,
    authzMiddleware,
    // GET needs settings:read, every other method settings:manage. A method with
    // no route (PUT, PATCH, DELETE) still passes through this gate and ends as the 404.
    createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
      const need = c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "manage";
      if (!hasCapability(c.get("authz").permissions, "settings", need)) {
        return c.json(
          problem(
            403,
            "Forbidden",
            c.req.path,
            need === "read"
              ? "You do not have permission to view the accounting catalog"
              : "You do not have permission to manage the accounting catalog",
          ),
          403,
        );
      }
      await next();
      return undefined;
    }),
  );
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

// ─── Ledger accounts ─────────────────────────────────────────────────────────

const listAccountsRoute = createRoute({
  method: "get",
  path: "/accounting/ledger-accounts",
  tags: ["Accounting catalog"],
  summary: "List the ledger accounts, active and deactivated, with their history",
  security: [{ Bearer: [] }],
  responses: {
    200: json(LedgerAccountListSchema, "Accounts by number; `history` is oldest first, the first step being the creation (AC-1.8)"),
    403: problemResponse("Caller lacks `settings:read` (AC-1.7)"),
  },
});

catalogRouter.openapi(listAccountsRoute, async (c) => c.json({ items: await listLedgerAccounts() }, 200));

const addAccountRoute = createRoute({
  method: "post",
  path: "/accounting/ledger-accounts",
  tags: ["Accounting catalog"],
  summary: "Add a ledger account",
  security: [{ Bearer: [] }],
  request: { body: { required: true, content: { "application/json": { schema: AddLedgerAccountBodySchema } } } },
  responses: {
    201: json(LedgerAccountItemSchema, "The new, active account (AC-1.1)"),
    403: problemResponse("Caller lacks `settings:manage`"),
    409: problemResponse("`ledger_account_duplicate`: the number exists, active or deactivated (AC-1.2)"),
    422: problemResponse("`invalid_ledger_account`"),
  },
});

catalogRouter.openapi(addAccountRoute, async (c) => {
  const body = c.req.valid("json");
  const outcome = await createLedgerAccount(body, actorOf(c));
  if (outcome.kind === "duplicate") {
    return c.json(
      problem(409, "Conflict", c.req.path, `Account ${body.number} already exists`, "ledger_account_duplicate"),
      409,
    );
  }
  return c.json(outcome.item, 201);
});

function statusRoute(kind: "ledger-accounts" | "vat-codes", action: "deactivate" | "reactivate") {
  const item = kind === "ledger-accounts" ? LedgerAccountItemSchema : VatCodeItemSchema;
  return createRoute({
    method: "post",
    path: `/accounting/${kind}/{id}/${action}`,
    tags: ["Accounting catalog"],
    summary: `${action === "deactivate" ? "Deactivate" : "Reactivate"} a ${kind === "ledger-accounts" ? "ledger account" : "VAT code"}`,
    description:
      "Appends one status row with the actor and the time (AC-1.8). Asking for the state the entry is already in " +
      `is a 409 \`${action === "deactivate" ? "already_inactive" : "already_active"}\` and writes nothing (AC-1.11).`,
    security: [{ Bearer: [] }],
    request: { params: CatalogIdParamSchema },
    responses: {
      200: json(item, "The entry in its new state"),
      403: problemResponse("Caller lacks `settings:manage` (AC-1.7)"),
      404: problemResponse("Unknown entry"),
      409: problemResponse("`already_inactive` / `already_active`: nothing written"),
    },
  });
}

for (const action of ["deactivate", "reactivate"] as const) {
  catalogRouter.openapi(statusRoute("ledger-accounts", action), async (c) => {
    const { id } = c.req.valid("param");
    const outcome = await setLedgerAccountActive(id, action === "reactivate", actorOf(c));
    if (outcome.kind === "not_found") {
      return c.json(problem(404, "Not Found", c.req.path, `Ledger account ${id} not found`), 404);
    }
    if (outcome.kind === "unchanged") {
      const state = outcome.active ? "active" : "inactive";
      return c.json(
        problem(409, "Conflict", c.req.path, `Account ${outcome.item.number} is already ${state}`, `already_${state}`),
        409,
      );
    }
    return c.json(outcome.item, 200);
  });
}

// ─── VAT codes ───────────────────────────────────────────────────────────────

const listVatCodesRoute = createRoute({
  method: "get",
  path: "/accounting/vat-codes",
  tags: ["Accounting catalog"],
  summary: "List the VAT codes, active and deactivated, with their history",
  security: [{ Bearer: [] }],
  responses: {
    200: json(VatCodeListSchema, "Codes alphabetically; the rate is shown as basis points and as a percentage string"),
    403: problemResponse("Caller lacks `settings:read` (AC-1.7)"),
  },
});

catalogRouter.openapi(listVatCodesRoute, async (c) => c.json({ items: await listVatCodes() }, 200));

const addVatCodeRoute = createRoute({
  method: "post",
  path: "/accounting/vat-codes",
  tags: ["Accounting catalog"],
  summary: "Add a VAT code (its rate can never change afterwards)",
  security: [{ Bearer: [] }],
  request: { body: { required: true, content: { "application/json": { schema: AddVatCodeBodySchema } } } },
  responses: {
    201: json(VatCodeItemSchema, "The new, active code (AC-1.4)"),
    403: problemResponse("Caller lacks `settings:manage`"),
    409: problemResponse("`vat_code_duplicate`: the code exists, active or deactivated; reactivate it instead (AC-1.4)"),
    422: problemResponse("`invalid_vat_code`"),
  },
});

catalogRouter.openapi(addVatCodeRoute, async (c) => {
  const body = c.req.valid("json");
  const code = body.code.toUpperCase();
  const outcome = await createVatCode(
    { code, label: body.label, rateBasisPoints: percentToBasisPoints(body.ratePercent) },
    actorOf(c),
  );
  if (outcome.kind === "duplicate") {
    return c.json(problem(409, "Conflict", c.req.path, `VAT code ${code} already exists`, "vat_code_duplicate"), 409);
  }
  return c.json(outcome.item, 201);
});

for (const action of ["deactivate", "reactivate"] as const) {
  catalogRouter.openapi(statusRoute("vat-codes", action), async (c) => {
    const { id } = c.req.valid("param");
    const outcome = await setVatCodeActive(id, action === "reactivate", actorOf(c));
    if (outcome.kind === "not_found") {
      return c.json(problem(404, "Not Found", c.req.path, `VAT code ${id} not found`), 404);
    }
    if (outcome.kind === "unchanged") {
      const state = outcome.active ? "active" : "inactive";
      return c.json(
        problem(409, "Conflict", c.req.path, `VAT code ${outcome.item.code} is already ${state}`, `already_${state}`),
        409,
      );
    }
    return c.json(outcome.item, 200);
  });
}

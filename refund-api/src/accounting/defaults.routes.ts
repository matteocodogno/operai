/**
 * Default-classification endpoints (T7, specs/20261118-refund-accounting-export, plan § API contracts "Defaults";
 * reworked by T18, specs/20261119-accounting: natural keys, copies, live validation; AC-4.4, AC-4.5, AC-4.7, AC-6.9,
 * AC-3.7, AC-6.10).
 *
 *   GET /accounting/expense-type-defaults        settings:read
 *   PUT /accounting/expense-type-defaults/{type} settings:manage
 *   PUT /accounting/foreign-currency-vat-code    settings:manage
 *
 * The gates are Refund's own and unchanged: an Accounting capability opens none of them (AC-3.7), and a Refund admin
 * needs none to choose (AC-4.4). The designation of the foreign-currency VAT code is read inside the GET of the defaults
 * and written only here; it is deliberately not a generic setting.
 *
 * The GET never fails because Accounting does: it shows the recorded copies, each entry's state `unverified`, and
 * `accounting: "unavailable"` (AC-6.9). A PUT reads Accounting first (one operation, 10 s) and answers 503
 * `accounting_unavailable` with `Retry-After` when it cannot; a deactivated, unknown or non-WellD CH entry is 422.
 * The capability is checked in a middleware BEFORE the body is validated, and the actor always comes from the JWT.
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import {
  accountingPort,
  ACCOUNTING_RETRY_AFTER_SECONDS,
  accountingUnavailableProblem,
  tryReferenceSnapshot,
} from "./accountingClient";
import {
  isExpenseType,
  loadDefaultsView,
  setForeignCurrencyVatCode,
  setTypeDefault,
  type Actor,
} from "./defaults.repo";
import { UNVERIFIED_SNAPSHOT } from "./referenceSnapshot";
import {
  DefaultsProblemSchema,
  DefaultsResponseSchema,
  ExpenseTypeParamSchema,
  ForeignCurrencyVatCodeStateSchema,
  PutExpenseTypeDefaultBodySchema,
  PutForeignCurrencyVatCodeBodySchema,
  TypeDefaultRowSchema,
} from "./defaults.schemas";

const problem = <S extends number>(status: S, title: string, path: string, detail: string, code?: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance: path,
  ...(code !== undefined ? { code } : {}),
});

const BODY_SIZE_LIMIT = 4 * 1024;

export const defaultsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        problem(
          422,
          "Unprocessable Entity",
          c.req.path,
          result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          "invalid_default",
        ),
        422,
      );
    }
    return undefined;
  },
});

for (const path of ["/accounting/expense-type-defaults/*", "/accounting/foreign-currency-vat-code"]) {
  defaultsRouter.use(
    path,
    bodyLimit({
      maxSize: BODY_SIZE_LIMIT,
      onError: (c) => c.json(problem(413, "Payload Too Large", c.req.path, "Request body is too large."), 413),
    }),
    jwtMiddleware,
    authzMiddleware,
    createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
      const need = c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "manage";
      if (!hasCapability(c.get("authz").permissions, "settings", need)) {
        return c.json(
          problem(
            403,
            "Forbidden",
            c.req.path,
            need === "read"
              ? "You do not have permission to view the accounting defaults"
              : "You do not have permission to manage the accounting defaults",
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
const problemResponse = (description: string) => json(DefaultsProblemSchema, description);

/** 503 `accounting_unavailable` with `Retry-After`: nothing was written (D15). `instance` is the route pattern, with no ids (AC-6.10). */
const unavailable = (c: Context) => {
  c.header("Retry-After", String(ACCOUNTING_RETRY_AFTER_SECONDS));
  return c.json(accountingUnavailableProblem(c.req.routePath), 503);
};

const getDefaultsRoute = createRoute({
  method: "get",
  path: "/accounting/expense-type-defaults",
  tags: ["Accounting defaults"],
  summary: "The default account and VAT code of each expense type, and the foreign-currency VAT code",
  description:
    "Always the twelve expense types in enum order, `null` where unset (AC-2.2 of 20261118). Each default and the " +
    "designation show the copy Refund recorded (number and name, code, label and rate) with Accounting's present state of " +
    "the entry: `active`, `deactivated`, `not_found` (no longer there) or `unverified` (Accounting could not be read). A " +
    "default that is not `active` counts as no default for new classifications (AC-4.5). Each carries its history, oldest " +
    "first, as copied (AC-4.7). `foreignCurrencyVatCodeUsable` is `true` only for an `active` designation. `accounting: " +
    "\"unavailable\"` says Accounting could not be read: the page still opens, with the values as recorded (AC-6.9).",
  security: [{ Bearer: [] }],
  responses: {
    200: json(DefaultsResponseSchema, "The defaults"),
    403: problemResponse("Caller lacks `settings:read` (AC-2.8)"),
  },
});

defaultsRouter.openapi(getDefaultsRoute, async (c) => {
  const snapshot = (await tryReferenceSnapshot(accountingPort().begin("defaults_read"))) ?? UNVERIFIED_SNAPSHOT;
  return c.json(await loadDefaultsView(snapshot), 200);
});

const putTypeRoute = createRoute({
  method: "put",
  path: "/accounting/expense-type-defaults/{type}",
  tags: ["Accounting defaults"],
  summary: "Set the default account and VAT code of an expense type",
  description:
    "Both keys are required, by natural key (`accountNumber`, `vatCode`); `null` means no default for that half. Only an " +
    "active WellD CH entry of Accounting can be chosen, checked live (AC-4.4); the row records the entry as Accounting " +
    "holds it now. Saving what is already current is a 200 that writes no row.",
  security: [{ Bearer: [] }],
  request: {
    params: ExpenseTypeParamSchema,
    body: { required: true, content: { "application/json": { schema: PutExpenseTypeDefaultBodySchema } } },
  },
  responses: {
    200: json(TypeDefaultRowSchema, "The type's row"),
    403: problemResponse("Caller lacks `settings:manage`"),
    404: problemResponse("Not an expense type"),
    422: problemResponse("`ledger_account_inactive` | `vat_code_inactive` | `ledger_account_not_found` | `vat_code_not_found`"),
    503: problemResponse("`accounting_unavailable`: Accounting could not be read; nothing was saved (AC-6.1 style, D15)"),
  },
});

defaultsRouter.openapi(putTypeRoute, async (c) => {
  const { type } = c.req.valid("param");
  if (!isExpenseType(type)) {
    return c.json(problem(404, "Not Found", c.req.path, `${type} is not an expense type`), 404);
  }
  const snapshot = await tryReferenceSnapshot(accountingPort().begin("defaults_write"));
  if (snapshot === null) return unavailable(c);
  const outcome = await setTypeDefault(type, c.req.valid("json"), actorOf(c), snapshot);
  if (outcome.kind === "refused") {
    return c.json(problem(422, "Unprocessable Entity", c.req.routePath, outcome.detail, outcome.code), 422);
  }
  return c.json(outcome.value, 200);
});

const putDesignationRoute = createRoute({
  method: "put",
  path: "/accounting/foreign-currency-vat-code",
  tags: ["Accounting defaults"],
  summary: "Designate (or clear) the VAT code applied to every non-CHF WellD CH line",
  description:
    "Only an active WellD CH VAT code of Accounting can be designated, checked live (AC-4.4). `null` clears the " +
    "designation. Saving what is already current is a 200 that writes no row. A change never touches a line already " +
    "approved (AC-2.3 of 20261118).",
  security: [{ Bearer: [] }],
  request: { body: { required: true, content: { "application/json": { schema: PutForeignCurrencyVatCodeBodySchema } } } },
  responses: {
    200: json(ForeignCurrencyVatCodeStateSchema, "The designation, whether it is usable, and its history"),
    403: problemResponse("Caller lacks `settings:manage` (AC-2.8 of 20261118)"),
    422: problemResponse("`vat_code_inactive` | `vat_code_not_found`"),
    503: problemResponse("`accounting_unavailable`: Accounting could not be read; nothing was saved"),
  },
});

defaultsRouter.openapi(putDesignationRoute, async (c) => {
  const snapshot = await tryReferenceSnapshot(accountingPort().begin("defaults_write"));
  if (snapshot === null) return unavailable(c);
  const outcome = await setForeignCurrencyVatCode(c.req.valid("json").vatCode, actorOf(c), snapshot);
  if (outcome.kind === "refused") {
    return c.json(problem(422, "Unprocessable Entity", c.req.routePath, outcome.detail, outcome.code), 422);
  }
  return c.json(outcome.value, 200);
});

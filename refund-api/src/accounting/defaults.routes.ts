/**
 * Default-classification endpoints (T7, specs/20261118-refund-accounting-export,
 * plan § API contracts "Defaults"; AC-1.9, AC-1.10, AC-2.1, AC-2.2, AC-2.4 to AC-2.8).
 *
 *   GET /accounting/expense-type-defaults        settings:read
 *   PUT /accounting/expense-type-defaults/{type} settings:manage
 *   PUT /accounting/foreign-currency-vat-code    settings:manage
 *
 * The designation of the foreign-currency VAT code is read inside the GET of the
 * defaults and written only here; it is deliberately not a generic setting.
 * The capability is checked in a middleware BEFORE the body is validated, as in
 * the catalog routes, and the actor always comes from the verified JWT.
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import type { Actor } from "./catalog.repo";
import {
  isExpenseType,
  loadDefaultsView,
  setForeignCurrencyVatCode,
  setTypeDefault,
} from "./defaults.repo";
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

const getDefaultsRoute = createRoute({
  method: "get",
  path: "/accounting/expense-type-defaults",
  tags: ["Accounting defaults"],
  summary: "The default account and VAT code of each expense type, and the foreign-currency VAT code",
  description:
    "Always the twelve expense types in enum order, `null` where unset (AC-2.2). Each carries its history, oldest first " +
    "(AC-2.1). `foreignCurrencyVatCode` is the designation even when its code is inactive; `foreignCurrencyVatCodeUsable` " +
    "is `false` then, and when none is designated (AC-2.7).",
  security: [{ Bearer: [] }],
  responses: {
    200: json(DefaultsResponseSchema, "The defaults"),
    403: problemResponse("Caller lacks `settings:read` (AC-2.8)"),
  },
});

defaultsRouter.openapi(getDefaultsRoute, async (c) => c.json(await loadDefaultsView(), 200));

const putTypeRoute = createRoute({
  method: "put",
  path: "/accounting/expense-type-defaults/{type}",
  tags: ["Accounting defaults"],
  summary: "Set the default account and VAT code of an expense type",
  description:
    "Both keys are required; `null` means no default for that half. Only active entries can be chosen (AC-2.4). " +
    "Saving what is already current is a 200 that writes no row.",
  security: [{ Bearer: [] }],
  request: {
    params: ExpenseTypeParamSchema,
    body: { required: true, content: { "application/json": { schema: PutExpenseTypeDefaultBodySchema } } },
  },
  responses: {
    200: json(TypeDefaultRowSchema, "The type's row"),
    403: problemResponse("Caller lacks `settings:manage`"),
    404: problemResponse("Not an expense type"),
    422: problemResponse("`ledger_account_inactive` | `vat_code_inactive` | `unknown_ledger_account` | `unknown_vat_code`"),
  },
});

defaultsRouter.openapi(putTypeRoute, async (c) => {
  const { type } = c.req.valid("param");
  if (!isExpenseType(type)) {
    return c.json(problem(404, "Not Found", c.req.path, `${type} is not an expense type`), 404);
  }
  const outcome = await setTypeDefault(type, c.req.valid("json"), actorOf(c));
  if (outcome.kind === "refused") {
    return c.json(problem(422, "Unprocessable Entity", c.req.path, outcome.detail, outcome.code), 422);
  }
  return c.json(outcome.value, 200);
});

const putDesignationRoute = createRoute({
  method: "put",
  path: "/accounting/foreign-currency-vat-code",
  tags: ["Accounting defaults"],
  summary: "Designate (or clear) the VAT code applied to every non-CHF WellD CH line",
  description:
    "Only an active code can be designated (AC-2.6). `null` clears the designation. Saving what is already current " +
    "is a 200 that writes no row. A change never touches a line already approved (AC-2.3).",
  security: [{ Bearer: [] }],
  request: { body: { required: true, content: { "application/json": { schema: PutForeignCurrencyVatCodeBodySchema } } } },
  responses: {
    200: json(ForeignCurrencyVatCodeStateSchema, "The designation, whether it is usable, and its history"),
    403: problemResponse("Caller lacks `settings:manage` (AC-2.8)"),
    422: problemResponse("`vat_code_inactive` | `unknown_vat_code`"),
  },
});

defaultsRouter.openapi(putDesignationRoute, async (c) => {
  const outcome = await setForeignCurrencyVatCode(c.req.valid("json").vatCodeId, actorOf(c));
  if (outcome.kind === "refused") {
    return c.json(problem(422, "Unprocessable Entity", c.req.path, outcome.detail, outcome.code), 422);
  }
  return c.json(outcome.value, 200);
});

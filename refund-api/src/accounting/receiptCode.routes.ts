/**
 * Receipt-code endpoints (T5, specs/20261124-receipt-numbers-from-the-register, plan § API contracts and D8; AC-4.1, AC-4.2,
 * AC-4.3, AC-4.6, AC-4.7, AC-4.9, AC-4.10, AC-4.11; design sync DS-2, DS-8):
 *
 *   GET /accounting/receipt-codes                     receipt-code:manage
 *   PUT /accounting/receipt-codes/{userId}            receipt-code:manage
 *   GET /accounting/receipt-codes/{userId}/history    receipt-code:manage
 *
 * Reading is gated too (AC-4.9): the capability is checked for EVERY method, in a middleware BEFORE the body is validated, after
 * the JWT and the authorization are known. The order is `noStoreHeaders`, `bodyLimit(1 KiB)`, `jwtMiddleware`, `authzMiddleware`,
 * the gate. Errors are RFC 7807 with `instance` = the route pattern (no ids); a 409 names nobody. The actor of a change is the
 * JWT's, never the body's.
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { noStoreHeaders } from "./noStore";
import { listReceiptCodes, receiptCodeHistory, setReceiptCode } from "./receiptCode.repo";
import {
  PutReceiptCodeBodySchema,
  ReceiptCodeHistoryResponseSchema,
  ReceiptCodeProblemSchema,
  ReceiptCodeRowSchema,
  ReceiptCodesResponseSchema,
  UserIdParamSchema,
} from "./receiptCode.schemas";
import { nulRefusal } from "../lib/inputText";

const LIST_PATTERN = "/accounting/receipt-codes";
const ONE_PATTERN = "/accounting/receipt-codes/{userId}";
const HISTORY_PATTERN = "/accounting/receipt-codes/{userId}/history";

const INVALID_DETAIL = "A receipt code is two or three letters A–Z";
const IN_USE_DETAIL = "This code is already in use";

const problem = <S extends number>(status: S, title: string, instance: string, detail: string, code?: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance,
  ...(code !== undefined ? { code } : {}),
});

/** The route pattern of a request path, for `instance` (never the ids). */
const patternOf = (path: string): string =>
  path === LIST_PATTERN || path === `${LIST_PATTERN}/` ? LIST_PATTERN : path.endsWith("/history") ? HISTORY_PATTERN : ONE_PATTERN;

const BODY_SIZE_LIMIT = 1024;

export const receiptCodeRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    const nul = nulRefusal(result, c);
    if (nul) return nul;
    if (!result.success) return c.json(problem(422, "Unprocessable Entity", patternOf(c.req.path), INVALID_DETAIL, "receipt_code_invalid"), 422);
    return undefined;
  },
});

receiptCodeRouter.use(
  "/accounting/receipt-codes/*",
  noStoreHeaders,
  bodyLimit({
    maxSize: BODY_SIZE_LIMIT,
    onError: (c) => c.json(problem(413, "Payload Too Large", patternOf(c.req.path), "Request body is too large."), 413),
  }),
  jwtMiddleware,
  authzMiddleware,
  createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
    if (!hasCapability(c.get("authz").permissions, "receipt-code", "manage")) {
      return c.json(problem(403, "Forbidden", patternOf(c.req.path), "You do not have permission to manage receipt codes", "forbidden"), 403);
    }
    await next();
    return undefined;
  }),
);

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });
const problemResponse = (description: string) => json(ReceiptCodeProblemSchema, description);

const listRoute = createRoute({
  method: "get",
  path: LIST_PATTERN,
  tags: ["Receipt codes"],
  summary: "The employees known to Refund, with their receipt code",
  description:
    "Employees with at least one request, in any status, ordered by name then user id. `prefix` is the code, else the derived " +
    "initials. `changedAt` and `changedByEmail` come from the newest change, a clear included. `sharesPrefix` is true when the " +
    "prefix equals another employee's code or derived initials (when that one has no code), or the prefix of a number issued or " +
    "imported to another employee.",
  security: [{ Bearer: [] }],
  responses: {
    200: json(ReceiptCodesResponseSchema, "The employees"),
    403: problemResponse("Caller lacks `receipt-code:manage` (AC-4.9: reading is gated too)"),
  },
});

receiptCodeRouter.openapi(listRoute, async (c) => c.json({ employees: await listReceiptCodes() }, 200));

const putRoute = createRoute({
  method: "put",
  path: ONE_PATTERN,
  tags: ["Receipt codes"],
  summary: "Set, change or clear an employee's receipt code",
  description:
    "`{ code: \"lcx\" }` sets or changes (stored as `LCX`); `{ code: \"\" }` or `{ code: null }` clears. A code replaces the " +
    "initials in NEW numbers only. Saving the current value is a 200 that writes no history row.",
  security: [{ Bearer: [] }],
  request: {
    params: UserIdParamSchema,
    body: { required: true, content: { "application/json": { schema: PutReceiptCodeBodySchema } } },
  },
  responses: {
    200: json(ReceiptCodeRowSchema, "The employee's row, as in the list"),
    403: problemResponse("Caller lacks `receipt-code:manage`"),
    404: problemResponse("`employee_not_found`: no request has that owner"),
    409: problemResponse("`receipt_code_in_use`: another employee holds the code or has numbers with that prefix; names nobody"),
    422: problemResponse("`receipt_code_invalid`: not two or three letters A-Z, or a body with another key"),
  },
});

receiptCodeRouter.openapi(putRoute, async (c) => {
  const { userId } = c.req.valid("param");
  const { code } = c.req.valid("json");
  const outcome = await setReceiptCode(userId, code, { userId: c.get("userId"), email: c.get("email") });
  switch (outcome.kind) {
    case "ok":
      return c.json(outcome.row, 200);
    case "invalid":
      return c.json(problem(422, "Unprocessable Entity", ONE_PATTERN, INVALID_DETAIL, "receipt_code_invalid"), 422);
    case "in_use":
      return c.json(problem(409, "Conflict", ONE_PATTERN, IN_USE_DETAIL, "receipt_code_in_use"), 409);
    case "employee_not_found":
      return c.json(problem(404, "Not Found", ONE_PATTERN, "No such employee", "employee_not_found"), 404);
  }
});

const historyRoute = createRoute({
  method: "get",
  path: HISTORY_PATTERN,
  tags: ["Receipt codes"],
  summary: "The changes of an employee's receipt code, newest first",
  security: [{ Bearer: [] }],
  request: { params: UserIdParamSchema },
  responses: {
    200: json(ReceiptCodeHistoryResponseSchema, "The entries, with who and when"),
    403: problemResponse("Caller lacks `receipt-code:manage`"),
    404: problemResponse("`employee_not_found`"),
  },
});

receiptCodeRouter.openapi(historyRoute, async (c) => {
  const { userId } = c.req.valid("param");
  const entries = await receiptCodeHistory(userId);
  if (entries === null) return c.json(problem(404, "Not Found", HISTORY_PATTERN, "No such employee", "employee_not_found"), 404);
  return c.json({ entries }, 200);
});

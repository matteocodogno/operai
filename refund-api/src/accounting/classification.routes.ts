/**
 * Line classification endpoints (T13, specs/20261118-refund-accounting-export,
 * plan § API contracts "Accounting (classification)"; AC-1.3, AC-1.6, AC-2.7,
 * AC-3.1, AC-3.2, AC-3.8, AC-3.9, AC-3.10, AC-4.6).
 *
 *   GET /review/requests/{id}/accounting   request:review + entity scope
 *   GET /accounting/options                request:review (any scope)
 *   PUT /review/requests/{id}/lines/{lineId}/classification
 *                                          set-approved-total while submitted, reclassify once approved (T14)
 *
 * Accounting data reaches a browser ONLY through the first route. It answers
 * 404 to everyone who is not an in-scope reviewer of the request, the owner
 * included (AC-3.10, the plan's "Visibility"): `GET /requests/{id}`, which the
 * owner reads, never carries an account, a VAT code or a CHF amount, and this
 * route does not exist for the owner. A caller with no `request:review` grant at
 * all gets the same 404 as a stranger, exactly as `GET /requests/{id}` answers
 * them, so the route does not reveal which requests exist.
 */

import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { authzMiddleware, type AuthzContext, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { entityScopeForPermission, findPermission, hasCapability, requestInScope } from "../authz/conditions";
import { LineIdParamSchema, RequestIdParamSchema } from "../requests/requests.schemas";
import { scopeForReviewAction } from "../review/review.service";
import {
  buildAccountingView,
  classifyLine,
  loadAccountingOptions,
  readAccountingRequest,
  type ActionScope,
} from "./classification.repo";
import {
  AccountingLineSchema,
  AccountingOptionsSchema,
  ClassificationProblemSchema,
  ClassifyBodySchema,
  RequestAccountingSchema,
} from "./classification.schemas";

const problem = <S extends number>(status: S, title: string, path: string, detail: string, code?: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance: path,
  ...(code !== undefined ? { code } : {}),
});

export const classificationRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        problem(
          422,
          "Unprocessable Entity",
          c.req.path,
          result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          "invalid_classification",
        ),
        422,
      );
    }
    return undefined;
  },
});

const CLASSIFY_BODY_SIZE_LIMIT = 4 * 1024; // two ids

classificationRouter.use(
  "/review/requests/:id/lines/:lineId/classification",
  bodyLimit({
    maxSize: CLASSIFY_BODY_SIZE_LIMIT,
    onError: (c) => c.json(problem(413, "Payload Too Large", c.req.path, "Request body is too large."), 413),
  }),
);

for (const path of [
  "/review/requests/:id/accounting",
  "/accounting/options",
  "/review/requests/:id/lines/:lineId/classification",
]) {
  classificationRouter.use(path, jwtMiddleware);
  classificationRouter.use(path, authzMiddleware);
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const problemResponse = (description: string) => json(ClassificationProblemSchema, description);

// ─── GET /accounting/options ─────────────────────────────────────────────────

const optionsRoute = createRoute({
  method: "get",
  path: "/accounting/options",
  tags: ["Accounting"],
  summary: "The accounts and VAT codes a line can be classified with",
  description:
    "Active entries only (AC-1.3, AC-1.6, AC-2.4). A deactivated entry is absent here, and a line that already " +
    "carries one keeps it and shows it with `active: false` in its accounting view. Any `request:review` scope.",
  security: [{ Bearer: [] }],
  responses: {
    200: json(AccountingOptionsSchema, "Active accounts by number, active VAT codes by code"),
    403: problemResponse("Caller lacks `request:review`"),
  },
});

classificationRouter.openapi(optionsRoute, async (c) => {
  if (!hasCapability(c.get("authz").permissions, "request", "review")) {
    return c.json(problem(403, "Forbidden", c.req.path, "You do not have permission to review refund requests"), 403);
  }
  return c.json(await loadAccountingOptions(), 200);
});

// ─── GET /review/requests/{id}/accounting ────────────────────────────────────

const viewRoute = createRoute({
  method: "get",
  path: "/review/requests/{id}/accounting",
  tags: ["Accounting"],
  summary: "A request's lines with their account, VAT code, CHF amount and VAT amount",
  description:
    "While the request is `submitted`, a line with nothing stored shows the live default of its expense type " +
    "(the foreign-currency VAT code for a line not in CHF) marked as a default (AC-3.1, AC-3.2). Once approved, " +
    "only what is stored on the line is shown. WellD Italia and rejected lines carry `classification: null` " +
    "(AC-3.9). `amountCents` is `approvedTotalCents ?? requestedAmountCents`. `chf` and `vatAmountCents` are " +
    "derived on read; a month with no rate is `rateMissing: true` and a `null` CHF and VAT amount, never 0 " +
    "(AC-3.8). 404 for anyone who is not an in-scope reviewer of the request, its owner included (AC-3.10).",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    200: json(RequestAccountingSchema, "The accounting view"),
    404: problemResponse("No such request, or the caller is not an in-scope reviewer of it"),
  },
});

classificationRouter.openapi(viewRoute, async (c) => {
  const { id } = c.req.valid("param");
  const notFound = () => c.json(problem(404, "Not Found", c.req.path, `Refund request ${id} not found`), 404);

  const scope = scopeForReviewAction(c.get("authz"), "review");
  if (scope === undefined || scope === null) return notFound();
  const row = await readAccountingRequest(id);
  if (!row || !requestInScope(row.lines, scope)) return notFound();

  return c.json(await buildAccountingView(row), 200);
});

// ─── PUT /review/requests/{id}/lines/{lineId}/classification ─────────────────

/** The caller's scope for one `request` action: no grant, a grant with no entity, or the entity scope. */
function scopeOf(authz: AuthzContext, action: string): ActionScope {
  if (!hasCapability(authz.permissions, "request", action)) return undefined;
  const grant = findPermission(authz.permissions, "request", action);
  return entityScopeForPermission(grant?.conditions ?? null, authz.entity);
}

const classifyRoute = createRoute({
  method: "put",
  path: "/review/requests/{id}/lines/{lineId}/classification",
  tags: ["Accounting"],
  summary: "Set the account and/or the VAT code of one WellD CH line",
  description:
    "Body: `ledgerAccountId`, `vatCodeId`, or both; ids only, never null (there is no \"back to the default\"). " +
    "While the request is `submitted` it needs `request:set-approved-total`; once `approved` (not paid) it needs " +
    "`request:reclassify`; a `paid` request is refused (AC-3.7), and so is a database trigger. The status is " +
    "decided on the locked request row, so a change racing the approval or the payment is either before it or " +
    "refused. Only the named value changes: the approved total, the status and the decision are never touched " +
    "(AC-3.6). An inactive or unknown entry is a 422 (AC-1.3, AC-1.6); a value the line already stores is a no-op. " +
    "Every change writes one `line_classified` audit row (cause `review` or `post_approval`). " +
    "Answers with the line, as in the accounting view.",
  security: [{ Bearer: [] }],
  request: {
    params: LineIdParamSchema,
    body: { required: true, content: { "application/json": { schema: ClassifyBodySchema } } },
  },
  responses: {
    200: json(AccountingLineSchema, "The line after the change"),
    403: problemResponse("The grant the request's current status needs is missing"),
    404: problemResponse("No such request or line, or out of the caller's entity scope"),
    409: problemResponse("`classification_locked` (paid), `not_classifiable_status` (draft, rejected), `line_rejected`"),
    422: problemResponse(
      "`line_not_welld_ch`, `ledger_account_inactive`, `vat_code_inactive`, `unknown_ledger_account`, `unknown_vat_code`, `invalid_classification`",
    ),
  },
});

classificationRouter.openapi(classifyRoute, async (c) => {
  const { id, lineId } = c.req.valid("param");
  const body = c.req.valid("json");
  const authz = c.get("authz");

  const outcome = await classifyLine(id, lineId, body, {
    userId: c.get("userId"),
    email: c.get("email"),
    setApprovedTotal: scopeOf(authz, "set-approved-total"),
    reclassify: scopeOf(authz, "reclassify"),
  });

  switch (outcome.kind) {
    case "ok":
      return c.json(outcome.line, 200);
    case "not_found":
      return c.json(problem(404, "Not Found", c.req.path, "Refund request or line not found"), 404);
    case "forbidden":
      return c.json(
        problem(403, "Forbidden", c.req.path, `You do not have permission to change this line's classification (${outcome.needs})`),
        403,
      );
    case "locked":
      return c.json(problem(409, "Conflict", c.req.path, "The request is paid: its classification is locked", "classification_locked"), 409);
    case "not_classifiable":
      return c.json(
        problem(409, "Conflict", c.req.path, "Only a submitted or approved request can be classified", "not_classifiable_status"),
        409,
      );
    case "line_rejected":
      return c.json(problem(409, "Conflict", c.req.path, "This line is rejected: restore it before classifying it", "line_rejected"), 409);
    case "not_welld_ch":
      return c.json(problem(422, "Unprocessable Entity", c.req.path, "Only a WellD CH line has an account and a VAT code", "line_not_welld_ch"), 422);
    case "refused": {
      const detail: Record<typeof outcome.code, string> = {
        ledger_account_inactive: "That ledger account is deactivated and cannot be chosen",
        vat_code_inactive: "That VAT code is deactivated and cannot be chosen",
        unknown_ledger_account: "No such ledger account",
        unknown_vat_code: "No such VAT code",
      };
      return c.json(problem(422, "Unprocessable Entity", c.req.path, detail[outcome.code], outcome.code), 422);
    }
  }
});

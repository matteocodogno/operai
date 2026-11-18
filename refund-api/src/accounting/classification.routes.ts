/**
 * Line classification endpoints (T13, specs/20261118-refund-accounting-export,
 * plan § API contracts "Accounting (classification)"; AC-1.3, AC-1.6, AC-2.7,
 * AC-3.1, AC-3.2, AC-3.8, AC-3.9, AC-3.10, AC-4.6).
 *
 *   GET /review/requests/{id}/accounting   request:review + entity scope
 *   GET /accounting/options                request:review (any scope)
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
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability, requestInScope } from "../authz/conditions";
import { RequestIdParamSchema } from "../requests/requests.schemas";
import { scopeForReviewAction } from "../review/review.service";
import { buildAccountingView, loadAccountingOptions, readAccountingRequest } from "./classification.repo";
import {
  AccountingOptionsSchema,
  ClassificationProblemSchema,
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

for (const path of ["/review/requests/:id/accounting", "/accounting/options"]) {
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

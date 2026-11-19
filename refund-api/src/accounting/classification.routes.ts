/**
 * Line classification endpoints (T13, specs/20261118-refund-accounting-export,
 * plan § API contracts "Accounting (classification)"; reworked by T19, specs/20261119-accounting; AC-4.1, AC-4.2,
 * AC-4.3, AC-4.9, AC-5.2, AC-5.7, AC-6.5, AC-6.10, AC-7.3, AC-1.4, AC-1.8, AC-3.9).
 *
 *   GET /review/requests/{id}/accounting   request:review + entity scope (request level, then line level: SR-1)
 *   GET /accounting/options                request:review with a scope that covers welld_ch (SR-1) OR settings:manage (D16)
 *   PUT /review/requests/{id}/lines/{lineId}/classification
 *                                          set-approved-total while submitted, reclassify once approved (T14)
 *
 * Reference data comes from Accounting, live, read through the `AccountingPort` (one operation per request, no cache).
 * Accounting unreachable: the view is still 200 (`accounting: "unavailable"`), the options and the PUT are 503
 * `accounting_unavailable` with `Retry-After`, and nothing is written (AC-6.5).
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
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { noStoreHeaders } from "./noStore";
import { authzMiddleware, type AuthzContext, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import {
  approveSelfRestricted,
  entityScopeForPermission,
  findPermission,
  GLOBAL_ENTITY_SCOPE,
  hasCapability,
  requestInScope,
} from "../authz/conditions";
import { canOpenAccountingRates } from "../authz/accountingViewer";
import { LineIdParamSchema, RequestIdParamSchema } from "../requests/requests.schemas";
import { scopeForReviewAction } from "../review/review.service";
import {
  accountingPort,
  ACCOUNTING_RETRY_AFTER_SECONDS,
  accountingUnavailableProblem,
} from "./accountingClient";
import {
  buildAccountingView,
  classificationSelfRestricted,
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

// F-07: no-store + nosniff on every answer of these routes, before the body limit and the auth so that 413 and 401 carry them.
for (const path of [
  "/review/requests/:id/accounting",
  "/accounting/options",
  "/review/requests/:id/lines/:lineId/classification",
]) {
  classificationRouter.use(path, noStoreHeaders);
}

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

/** 503 `accounting_unavailable` with `Retry-After`: nothing was written (D15). `instance` is the route pattern, with no ids (AC-6.10). */
const unavailable = (c: Context) => {
  c.header("Retry-After", String(ACCOUNTING_RETRY_AFTER_SECONDS));
  return c.json(accountingUnavailableProblem(c.req.routePath), 503);
};

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
  summary: "The accounts and VAT codes a line, a default or the foreign-currency designation can use",
  description:
    "Accounting's active WellD CH entries only, by natural key, read live (AC-4.1, AC-4.4): no deactivated entry, no " +
    "history, no who-added, no rates, and no Accounting capability needed. Needs `request:review` with a scope that " +
    "covers WellD CH (global, or entity `welld_ch`: these are WellD CH's books, SR-1, AC-4.2), or `settings:manage` " +
    "(a Refund admin choosing a default, D16). 503 `accounting_unavailable` (with `Retry-After`) when Accounting cannot be read.",
  security: [{ Bearer: [] }],
  responses: {
    200: json(AccountingOptionsSchema, "Active accounts by number, active VAT codes by code"),
    403: problemResponse("Caller lacks both `request:review` and `settings:manage`, or `accounting_out_of_scope`"),
    503: problemResponse("`accounting_unavailable`: Accounting could not be read"),
  },
});

classificationRouter.openapi(optionsRoute, async (c) => {
  const authz = c.get("authz");
  const scope = scopeForReviewAction(authz, "review");
  // D16: a Refund admin who chooses defaults needs the options too, with no review grant and no Accounting grant. They
  // see only what a reviewer of WellD CH sees: the active WellD CH entries.
  const mayChooseDefaults = hasCapability(authz.permissions, "settings", "manage");
  // `null` is a conditioned grant with no entity on the caller: it covers nothing (SR-1, as the export).
  const reviewsWelldCh = scope === GLOBAL_ENTITY_SCOPE || scope === "welld_ch";
  if (!reviewsWelldCh && !mayChooseDefaults) {
    if (scope === undefined) {
      return c.json(problem(403, "Forbidden", c.req.path, "You do not have permission to review refund requests"), 403);
    }
    return c.json(
      problem(
        403,
        "Forbidden",
        c.req.path,
        "The accounts and VAT codes are WellD CH's books: your review scope does not cover WellD CH",
        "accounting_out_of_scope",
      ),
      403,
    );
  }
  const options = await loadAccountingOptions(accountingPort().begin("options"));
  if (options === null) return unavailable(c);
  return c.json(options, 200);
});

// ─── GET /review/requests/{id}/accounting ────────────────────────────────────

const viewRoute = createRoute({
  method: "get",
  path: "/review/requests/{id}/accounting",
  tags: ["Accounting"],
  summary: "A request's lines with their account, VAT code, CHF amount and VAT amount",
  description:
    "While the request is `submitted`, a line with nothing stored shows the live default of its expense type " +
    "(the foreign-currency VAT code for a line not in CHF) marked as a default (AC-3.1, AC-3.2 of 20261118), with " +
    "Accounting's present state of the entry (`active`, `deactivated`, `not_found`, `unverified`); an unusable default " +
    "is returned WITH its state and `isDefault: true`, never as `null` (G8a). Once approved, only what is stored on the " +
    "line is shown, as copied. WellD Italia and rejected lines carry `classification: null` (AC-4.9). `amountCents` is " +
    "`approvedTotalCents ?? requestedAmountCents`. `chf` and `vatAmountCents` are derived on read from the line's copied " +
    "rate (`rateStatus: copied`), or under review from the rate in effect (`in_effect`, `missing`, `unavailable`); an " +
    "approved foreign-currency line with no rate is `pending` with a `null` CHF and VAT amount, never 0 (AC-5.6). " +
    "Accounting unreachable is still a 200: `accounting: \"unavailable\"`, each line shows what it holds (AC-6.5). " +
    "`viewer.canOpenAccountingRates` says whether the caller may open Accounting's rates (AC-7.3). 404 for anyone who is " +
    "not an in-scope reviewer of the request, its owner included (AC-3.10 of 20261118). The scope also applies per line " +
    "(SR-1): a line whose entity the caller's scope does not cover has `inScope: false` and no classification, CHF or VAT " +
    "figure. `selfRestricted` says the caller owns the request and may not classify it (SR-2).",
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

  const authz = c.get("authz");
  const selfRestricted = classificationSelfRestricted(row, selfRestrictionOf(authz, c.get("userId")));
  return c.json(
    await buildAccountingView(row, {
      scope,
      selfRestricted,
      operation: accountingPort().begin("view"),
      canOpenAccountingRates: canOpenAccountingRates(authz.permissions, authz),
    }),
    200,
  );
});

// ─── PUT /review/requests/{id}/lines/{lineId}/classification ─────────────────

/** The caller's scope for one `request` action: no grant, a grant with no entity, or the entity scope. */
function scopeOf(authz: AuthzContext, action: string): ActionScope {
  if (!hasCapability(authz.permissions, "request", action)) return undefined;
  const grant = findPermission(authz.permissions, "request", action);
  return entityScopeForPermission(grant?.conditions ?? null, authz.entity);
}

/** SR-2: which of the caller's grants carry `self-approval: deny`. */
function selfRestrictionOf(authz: AuthzContext, userId: string) {
  return {
    userId,
    approveSelfRestricted: approveSelfRestricted(findPermission(authz.permissions, "request", "approve")?.conditions ?? null),
    reclassifySelfRestricted: approveSelfRestricted(findPermission(authz.permissions, "request", "reclassify")?.conditions ?? null),
  };
}

/** specs/20261118 SR-2: an info-level, parseable event per refusal; ids only, no personal data (as `refund.self_approval_denied`). */
function logClassificationSelfApprovalDenied(actorUserId: string, requestId: string): void {
  console.info(
    JSON.stringify({
      event: "refund.classification_self_approval_denied",
      actorUserId,
      requestId,
      timestamp: new Date().toISOString(),
    }),
  );
}

const classifyRoute = createRoute({
  method: "put",
  path: "/review/requests/{id}/lines/{lineId}/classification",
  tags: ["Accounting"],
  summary: "Set the account and/or the VAT code of one WellD CH line",
  description:
    "Body: `accountNumber`, `vatCode`, or both; Accounting's natural keys only, never null (there is no \"back to the default\"). " +
    "While the request is `submitted` it needs `request:set-approved-total`; once `approved` (not paid) it needs " +
    "`request:reclassify`; a `paid` request is refused (AC-3.7), and so is a database trigger. The status is " +
    "decided on the locked request row, so a change racing the approval or the payment is either before it or " +
    "refused. Only the named value changes: the approved total, the status and the decision are never touched " +
    "(AC-5.7). A deactivated, unknown or non-WellD CH entry is a 422, checked live (AC-4.3, AC-1.4, AC-1.8); " +
    "Accounting unreachable is a 503 with the line unchanged (AC-6.5); a value the line already stores is a no-op. " +
    "The line keeps its own copy of the entry: its number and name, or its code and rate, as Accounting holds them at " +
    "this moment (AC-5.2); the exchange rate copy is never touched. " +
    "Every change writes one `line_classified` audit row (detail v2; cause `review` or `post_approval`). " +
    "Answers with the line, as in the accounting view. Two rules from the security review: the line's entity must be " +
    "covered by the scope of the grant the status needs, else 404 as for a stranger (SR-1); and the owner of a request " +
    "who may not approve it (`self-approval: deny` on `approve`, or on `reclassify` once approved) may not change its " +
    "classification, 403 `self_approval_forbidden`, answered before the scope 404s (SR-2).",
  security: [{ Bearer: [] }],
  request: {
    params: LineIdParamSchema,
    body: { required: true, content: { "application/json": { schema: ClassifyBodySchema } } },
  },
  responses: {
    200: json(AccountingLineSchema, "The line after the change"),
    403: problemResponse("The grant the request's current status needs is missing, or `self_approval_forbidden` (SR-2)"),
    404: problemResponse("No such request or line, or the request or the line is out of the caller's entity scope (SR-1)"),
    409: problemResponse("`classification_locked` (paid), `not_classifiable_status` (draft, rejected), `line_rejected`, `classification_conflict`"),
    422: problemResponse(
      "`line_not_welld_ch`, `ledger_account_inactive`, `vat_code_inactive`, `ledger_account_not_found`, `vat_code_not_found`, `invalid_classification`",
    ),
    503: problemResponse("`accounting_unavailable`: Accounting could not be read; the line is unchanged (AC-6.5)"),
  },
});

classificationRouter.openapi(classifyRoute, async (c) => {
  const { id, lineId } = c.req.valid("param");
  const body = c.req.valid("json");
  const authz = c.get("authz");
  const restriction = selfRestrictionOf(authz, c.get("userId"));

  const outcome = await classifyLine(id, lineId, body, {
    userId: c.get("userId"),
    email: c.get("email"),
    setApprovedTotal: scopeOf(authz, "set-approved-total"),
    reclassify: scopeOf(authz, "reclassify"),
    approveSelfRestricted: restriction.approveSelfRestricted,
    reclassifySelfRestricted: restriction.reclassifySelfRestricted,
    canOpenAccountingRates: canOpenAccountingRates(authz.permissions, authz),
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
    case "self_restricted":
      logClassificationSelfApprovalDenied(c.get("userId"), id);
      return c.json(
        problem(
          403,
          "Forbidden",
          c.req.path,
          "You cannot change the classification of a refund request you submitted yourself.",
          "self_approval_forbidden",
        ),
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
      // Generic: no number, code, name or id is echoed back (AC-6.10).
      const detail: Record<typeof outcome.code, string> = {
        ledger_account_inactive: "That ledger account is deactivated in Accounting and cannot be chosen",
        vat_code_inactive: "That VAT code is deactivated in Accounting and cannot be chosen",
        ledger_account_not_found: "That ledger account was not found in Accounting for WellD CH",
        vat_code_not_found: "That VAT code was not found in Accounting for WellD CH",
      };
      return c.json(problem(422, "Unprocessable Entity", c.req.routePath, detail[outcome.code], outcome.code), 422);
    }
    case "unavailable":
      return unavailable(c);
    case "conflict":
      return c.json(
        problem(409, "Conflict", c.req.path, "The line changed while it was being classified: try again", "classification_conflict"),
        409,
      );
  }
});

// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { healthRouter } from "./health/health.routes";
import { whoamiRouter } from "./auth/whoami.routes";
import { requestsRouter } from "./requests/requests.routes";
import { linesRouter } from "./requests/lines.routes";
import { requestExportRouter } from "./requests/export.routes";
import { attachmentsRouter } from "./attachments/attachments.routes";
import { lifecycleRouter } from "./requests/lifecycle.routes";
import { suggestionsRouter } from "./requests/suggestions.routes";
import { reviewRouter } from "./review/review.routes";
import { decideRouter } from "./review/decide.routes";
import { batchesRouter } from "./batches/batches.routes";
import { batchDecideRouter } from "./batches/decide.routes";
import { ratesRouter } from "./rates/routes";
import { rateEffectiveRouter } from "./rates/effective.routes";
import { settingsRouter } from "./settings/routes";
import { defaultsRouter } from "./accounting/defaults.routes";
import { classificationRouter } from "./accounting/classification.routes";
import { exportRouter } from "./accounting/export.routes";
import { receiptCodeRouter } from "./accounting/receiptCode.routes";
import { requestLogger } from "./lib/logger";
import { setupOpenAPI } from "./openapi/registry";
import { problemErrorHandler } from "./lib/errorHandler";

export const app = new OpenAPIHono();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    // The accounting export's download headers (specs/20261118-refund-accounting-export, G9): a browser on the UI's
    // origin can only read these when the server exposes them. The UI builds its own filename and does not depend on them.
    exposeHeaders: ["Content-Disposition", "X-Export-Row-Count", "X-Export-Excluded-Line-Count"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log
// bodies (data-residency constraint: this service handles financial data and
// PII inside expense line motivations/receipts — nothing about a request or
// response body may appear in application logs, see src/lib/logger.ts).
app.use("*", requestLogger());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);
// whoamiRouter is the bootstrap's identity probe (jwtMiddleware only, no
// authorization) — kept as a lightweight diagnostic route alongside the real
// domain routers below.
app.route("/", whoamiRouter);
// requestsRouter: employee request-level endpoints (T7, specs/20260716-refund-service).
app.route("/", requestsRouter);
// requestExportRouter: the per-request archive PDF (ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes). Registered
// before linesRouter purely for readability — its path (/requests/:id/export)
// cannot collide with any line route.
app.route("/", requestExportRouter);
// linesRouter: expense-line endpoints (T8, specs/20260716-refund-service).
app.route("/", linesRouter);
// suggestionsRouter: GET /line-suggestions — the caller's own past travel_km
// trip signatures, for the composer's motivo autocomplete (T5,
// specs/20260811-motivo-autocomplete).
//
// MOUNTED AT TOP LEVEL, DELIBERATELY NOT UNDER `/requests/…`: requestsRouter
// above owns `GET /requests/{id}`, and it is registered FIRST, so a path like
// `/requests/line-suggestions` would be matched by that route with
// `id = "line-suggestions"` and answered with its ownership 404 — a silent,
// total feature outage. See suggestions.routes.ts's header and its
// registration-order regression test.
app.route("/", suggestionsRouter);
// attachmentsRouter: receipt attachments + EU object storage (T9, specs/20260716-refund-service).
app.route("/", attachmentsRouter);
// lifecycleRouter: submit/withdraw + audit (T10, specs/20260716-refund-service).
app.route("/", lifecycleRouter);
// reviewRouter: accounting review queue (T11, specs/20260716-refund-service).
app.route("/", reviewRouter);
// decideRouter: accounting decisions (set-approved-total/approve/reject),
// specs/20260716-refund-service (T12; T13 adds the post-decision notify trigger).
app.route("/", decideRouter);
// batchesRouter: compiled-batch candidate preview + compile (the atomic
// claim) + reads + compilation email, specs/20260719-refund-monthly-processing
// (T3/T4/T5).
app.route("/", batchesRouter);
// batchDecideRouter: batch terminal transitions — mark-paid + discard,
// specs/20260719-refund-monthly-processing (T6/T8).
app.route("/", batchDecideRouter);
// ratesRouter: mileage-rate management (GET/POST /rates), gated by the new
// rate:read/rate:manage capability — specs/20260720-mileage-rate (T4).
app.route("/", ratesRouter);
// rateEffectiveRouter: GET /rates/effective, the employee-facing live-recompute
// read gated by refund:access only — specs/20260720-mileage-rate (T4).
app.route("/", rateEffectiveRouter);
// settingsRouter: refund-settings management (GET/PUT /settings/:key), gated
// by the new settings:read/settings:manage capability — specs/20260722-refund-settings (T3).
app.route("/", settingsRouter);
// defaultsRouter: the default account / VAT code per expense type and the foreign-currency
// VAT code, specs/20261118-refund-accounting-export (T7), on copies of Accounting's entries since T18 of 20261119.
app.route("/", defaultsRouter);
// NOT MOUNTED any more (specs/20261119-accounting T23, AC-3.7, AC-4.6): the ledger accounts, the VAT codes and the monthly exchange
// rates are Accounting's (accounting-api, `/v1/entities/{entity}/...`). `/accounting/ledger-accounts*`, `/accounting/vat-codes*` and
// `/exchange-rates*` answer 404 here for everyone, a `settings:manage` holder included (`removed-routes.test.ts`). Refund reads
// Accounting, as itself, through `accounting/accountingClient.ts`.
// classificationRouter: a request's accounting view and the active classification options, gated by
// request:review + entity scope — specs/20261118-refund-accounting-export (T13; T14 adds the PUT).
app.route("/", classificationRouter);
// exportRouter: the accounting export of a batch, summary + XLSX file (`/accounting-export/file`; `/csv` is retired and answers 404), gated by request:review + a review scope covering
// welld_ch — specs/20261118-refund-accounting-export (T18). Its paths (/batches/{id}/accounting-export…) collide with
// no batch route, so the registration order does not matter.
app.route("/", exportRouter);
// receiptCodeRouter: the receipt code per employee (list, set/change/clear, history), gated by the new receipt-code:manage
// capability on every method — specs/20261124-receipt-numbers-from-the-register (T5).
app.route("/", receiptCodeRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError(problemErrorHandler);

app.notFound((c) =>
  c.json(
    {
      type: "https://httpstatuses.com/404",
      title: "Not Found",
      status: 404,
      detail: `${c.req.method} ${c.req.path} does not exist`,
      instance: c.req.path,
    },
    404,
  ),
);

// ─── Start ───────────────────────────────────────────────────────────────────

console.log(`Refund API → http://localhost:${env.PORT}`);
console.log(`API docs   → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

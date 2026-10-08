// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { scopeRouter } from "./scope/scope.routes";
import { meRouter } from "./me/me.routes";
import { assetReadRouter } from "./assets/read.routes";
import { assetRegisterRouter } from "./assets/register.routes";
import { assetEditRouter } from "./assets/edit.routes";
import { assetTransitionsRouter } from "./assets/transitions.routes";
import { assignmentsRouter } from "./assignments/assignments.routes";
import { disposeRouter } from "./ledger/dispose.routes";
import { rulesRouter } from "./depreciation/rules.routes";
import { fiscalYearReadRouter } from "./fiscal-years/read.routes";
import { fiscalYearCloseRouter } from "./fiscal-years/close.routes";
import { invoicesRouter } from "./invoices/invoices.routes";
import { historyRouter } from "./history/history.routes";
import { requestLogger } from "./lib/logger";
import { handleProblemError } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";

// Exported so the capability matrix (src/matrix.test.ts, T44) can read the
// ASSEMBLED app's own route table; Bun serves only the default export below.
export const app = new OpenAPIHono();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log
// bodies (data-residency constraint: financial figures and who holds which
// device — see src/lib/logger.ts).
app.use("*", requestLogger());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);
// One router per route group, each an empty stub in T1 and filled by its own
// later task — so no later task edits this file (specs/015 tasks.md header).
app.route("/", scopeRouter);
app.route("/", meRouter);
app.route("/", assetReadRouter);
app.route("/", assetRegisterRouter);
app.route("/", assetEditRouter);
app.route("/", assetTransitionsRouter);
app.route("/", assignmentsRouter);
app.route("/", disposeRouter);
app.route("/", rulesRouter);
app.route("/", fiscalYearReadRouter);
app.route("/", fiscalYearCloseRouter);
app.route("/", invoicesRouter);
app.route("/", historyRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
  // A ProblemError is a deliberate, typed answer (409 fiscal_year_closed, …),
  // not a fault: render it with its top-level `code`/extension members and do
  // not log it as uncaught.
  const problem = handleProblemError(err, c.req.path);
  if (problem) return problem;

  console.error("[uncaught]", err);

  const status =
    "status" in err && typeof (err as { status: number }).status === "number"
      ? (err as { status: number }).status
      : 500;

  return c.json(
    {
      type: `https://httpstatuses.com/${status}`,
      title: status === 500 ? "Internal Server Error" : err.message,
      status,
      detail:
        env.NODE_ENV === "development"
          ? err.message
          : "An unexpected error occurred",
      instance: c.req.path,
    },
    status as 500,
  );
});

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

console.log(`Inventory API → http://localhost:${env.PORT}`);
console.log(`API docs      → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

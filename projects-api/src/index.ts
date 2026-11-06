// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { scopeRouter } from "./scope/scope.routes";
import { projectsRouter } from "./projects/projects.routes";
import { transitionsRouter } from "./projects/transitions.routes";
import { teamRouter } from "./projects/team.routes";
import { contractsRouter } from "./contracts/contracts.routes";
import { bexioRouter } from "./contracts/bexio.routes";
import { companiesRouter } from "./companies/companies.routes";
import { requestLogger } from "./lib/logger";
import { handleProblemError, problem, validationHook } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";

// Exported so the authorization matrix (src/matrix.test.ts) can read the
// ASSEMBLED app's own route table; Bun serves only the default export below.
export const app = new OpenAPIHono({ defaultHook: validationHook });

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    // If-Match / ETag carry the optimistic-concurrency version (AC-1.7, ADR-0038).
    allowHeaders: ["Content-Type", "Authorization", "If-Match"],
    exposeHeaders: ["ETag"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log
// bodies (contract terms, who is on which project — see src/lib/logger.ts).
// The query string carries search terms, which is why it is dropped too.
app.use("*", requestLogger());

// A global cap on request bodies: the largest legitimate body is a contract with its
// terms (a handful of positions), so 64 KiB is generous. Refused as a 413 Problem
// before anything is parsed.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c: Context) => problem({ status: 413, detail: "Request body is too large" }, c.req.path),
  }),
);

// ─── Routes ──────────────────────────────────────────────────────────────────
// Every area router is mounted here, once. T5–T9 fill the stubs in; none edits this file.

app.route("/", healthRouter);
app.route("/", scopeRouter);
app.route("/", projectsRouter);
app.route("/", transitionsRouter);
app.route("/", teamRouter);
app.route("/", contractsRouter);
app.route("/", bexioRouter);
app.route("/", companiesRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
  // A ProblemError is a deliberate, typed answer (409 version_conflict, …),
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
      detail: env.NODE_ENV === "development" ? err.message : "An unexpected error occurred",
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

console.log(`Projects API  → http://localhost:${env.PORT}`);
console.log(`API docs      → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

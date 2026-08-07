// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { estimatesRouter, importEstimatesRouter } from "./estimates/estimates.routes";
import { registerCollaboratorRoutes } from "./estimates/collaborators.routes";
import { requestLogger } from "./lib/logger";
import { setupOpenAPI } from "./openapi/registry";
import { registerCollaboratorOpenApiDocs } from "./openapi/collaborators.docs";

const app = new OpenAPIHono();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log
// bodies (data-residency constraint: estimate content must not appear in
// logs). Query strings are dropped too — shared src/lib/logger.ts posture
// with notify-api, whose GET /notifications/stream?ticket=<t> (ADR-0008)
// carries a live single-use credential in the query string that hono/logger's
// stock implementation would otherwise write to application logs.
app.use("*", requestLogger());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────
//
// T11 (specs/013-estimate-sharing) — MUST be registered on `app` BEFORE
// `importEstimatesRouter`/`estimatesRouter` are mounted below. Both of those
// routers apply a wildcard `.use("*", jwtMiddleware)` to themselves (T5/T8);
// `OpenAPIHono.route()` merges a mounted sub-router's routes (middleware
// included) into the PARENT's own route table at call time, and Hono runs
// every route entry that matches a given request path IN REGISTRATION
// ORDER, stopping at the first one that returns a response instead of
// calling `next()`. Registering `/openapi.json`/`/docs` AFTER that merge
// (the previous order) meant the wildcard jwtMiddleware — merged in
// earlier — always ran FIRST for those paths too and returned 401 before
// `app.doc()`'s own handler ever got a turn, even though neither route
// needs auth. Registering the doc routes here, BEFORE any jwt-gated router
// is mounted, fixes that without touching estimates.routes.ts's/
// collaborators.routes.ts's own middleware at all — `/estimates/*` still
// requires a Bearer JWT exactly as before (verified by a supertest-style
// check: GET /openapi.json → 200 unauthenticated, GET /estimates → 401
// unauthenticated). `getOpenAPIDocument` is computed lazily PER REQUEST
// (@hono/zod-openapi's `.doc()` internals), so this reordering does not
// affect document COMPLETENESS — every route merged in by the `app.route()`
// calls below is still present by the time any request actually arrives.
setupOpenAPI(app);

// importEstimatesRouter is mounted BEFORE estimatesRouter. The import route has
// a larger bodyLimit (IMPORT_BODY_SIZE_LIMIT) and a completely separate middleware
// chain — it is never subject to estimatesRouter's 2 MiB cap (OWASP A04 fix).
app.route("/", importEstimatesRouter);
// GET/POST/PATCH/DELETE /estimates/{id}/collaborators[...] (T8/T9,
// specs/013-estimate-sharing) attach directly onto estimatesRouter — called
// AFTER estimates.routes.ts's own module-load-time bodyLimit/jwtMiddleware
// `.use("*", …)` calls have already run (guaranteed: the import above fully
// evaluates that module first), so these routes inherit the same
// middleware chain. See collaborators.routes.ts's file header for why this
// is a registration call rather than a side-effect import mutating the
// singleton. `registerCollaboratorOpenApiDocs` (T11) documents those same
// five routes for `/openapi.json`/`/docs` WITHOUT wiring a second handler
// — see that module's file header — and, like `registerCollaboratorRoutes`,
// MUST run before `estimatesRouter` is mounted below for the merge to pick
// it up.
registerCollaboratorRoutes(estimatesRouter);
registerCollaboratorOpenApiDocs(estimatesRouter);
app.route("/", estimatesRouter);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
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

console.log(`EstimAI API → http://localhost:${env.PORT}`);
console.log(`API docs    → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

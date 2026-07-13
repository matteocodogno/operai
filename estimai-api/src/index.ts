// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { estimatesRouter, importEstimatesRouter } from "./estimates/estimates.routes";
import { requestLogger } from "./lib/logger";
import { setupOpenAPI } from "./openapi/registry";

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
// importEstimatesRouter is mounted BEFORE estimatesRouter. The import route has
// a larger bodyLimit (IMPORT_BODY_SIZE_LIMIT) and a completely separate middleware
// chain — it is never subject to estimatesRouter's 2 MiB cap (OWASP A04 fix).
app.route("/", importEstimatesRouter);
app.route("/", estimatesRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

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
  fetch: app.fetch,
};

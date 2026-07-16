// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { whoamiRouter } from "./auth/whoami.routes";
import { requestsRouter } from "./requests/requests.routes";
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
// requestsRouter: employee request-level endpoints (T7, specs/007-refund-service).
app.route("/", requestsRouter);

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

console.log(`Refund API → http://localhost:${env.PORT}`);
console.log(`API docs   → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};

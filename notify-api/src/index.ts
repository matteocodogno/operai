// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { requestLogger } from "./lib/logger";
import { listRouter } from "./notifications/list.routes";
import { markReadRouter } from "./notifications/markRead.routes";
import { raiseRouter } from "./notifications/raise.routes";
import { streamRouter } from "./notifications/stream.routes";
import { setupOpenAPI } from "./openapi/registry";
import { systemEmailsRouter } from "./system/emails.routes";
import { systemNotificationsRouter } from "./system/notifications.routes";

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
// bodies (data-residency constraint: notification title/body may name clients/
// estimates and must not appear in logs) and never log query strings either:
// GET /notifications/stream?ticket=<t> carries the single-use SSE ticket
// (ADR-0008) in its query string, and hono/logger's stock implementation logs
// the full path INCLUDING the query string — see src/lib/logger.ts.
app.use("*", requestLogger());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);
app.route("/", raiseRouter);
app.route("/", listRouter);
app.route("/", markReadRouter);
app.route("/", streamRouter);
// System routes — internal-token-authed only (ADR-0011, and ADR-0017 for
// the second internal caller/route). NEVER register either router with
// jwtMiddleware applied anywhere above it in the chain; both must stay
// reachable exclusively via internalTokenMiddleware.
app.route("/", systemEmailsRouter);
app.route("/", systemNotificationsRouter);

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

console.log(`Notify API → http://localhost:${env.PORT}`);
console.log(`API docs   → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

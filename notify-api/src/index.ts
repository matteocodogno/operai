// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { listRouter } from "./notifications/list.routes";
import { markReadRouter } from "./notifications/markRead.routes";
import { raiseRouter } from "./notifications/raise.routes";
import { streamRouter } from "./notifications/stream.routes";
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

// Log method / path / status only — NEVER log bodies (data-residency constraint:
// notification title/body may name clients/estimates and must not appear in logs).
app.use("*", logger());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);
app.route("/", raiseRouter);
app.route("/", listRouter);
app.route("/", markReadRouter);
app.route("/", streamRouter);

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
  fetch: app.fetch,
};

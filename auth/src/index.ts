// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Context } from "hono";
import { authRouter } from "./auth/auth.routes";
import { auditRouter } from "./authz/audit.routes";
import { authzRouter } from "./authz/authz.routes";
import { catalogRouter } from "./authz/catalog.routes";
import { departmentsRouter } from "./admin/departments.routes";
import { usersRouter } from "./admin/users.routes";
import { healthRouter } from "./health/health.routes";
import { jwksRouter } from "./jwks/jwks.routes";
import { signinRouter } from "./signin/signin.routes";
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

app.use("*", logger());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/auth", authRouter);
app.route("/", healthRouter);
app.route("/", jwksRouter);
app.route("/", signinRouter);
app.route("/", auditRouter);
app.route("/", authzRouter);
app.route("/", catalogRouter);
app.route("/", departmentsRouter);
app.route("/", usersRouter);

// ── Test-auth router (structural defence-in-depth) ──────────────────────────
// Only import + register when BOTH conditions are true at startup:
//   1. NODE_ENV !== 'production'
//   2. ENABLE_TEST_AUTH === true
// The dynamic import keeps the module out of the production bundle entirely
// (not loaded, not visible in OpenAPI, no route registered).
// The handler inside the module still performs its own request-time gate check
// as a second layer of defence — do NOT remove that check.
if (env.NODE_ENV !== "production" && env.ENABLE_TEST_AUTH) {
  const { testAuthRouter } = await import("./test-auth/test-auth.routes");
  app.route("/", testAuthRouter);
}

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

console.log(`Auth service → http://localhost:${env.PORT}`);
console.log(`API docs     → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};

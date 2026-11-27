// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { activitiesRouter } from "./activities/activities.routes";
import { healthRouter } from "./health/health.routes";
import { requestLogger } from "./lib/logger";
import { maintenanceGate } from "./lib/maintenance";
import { handleProblemError, problem, validationHook } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";
import { systemRouter } from "./system/system.routes";
import { tasksRouter } from "./tasks/tasks.routes";
import { filesRouter } from "./files/files.routes";
import { startDueReminderScheduler } from "./tasks/dueReminders";
import { NUL_DATABASE_DETAIL, isNulDatabaseError, logNulRefusal } from "./lib/nul";

// Exported so the authorization matrix (src/matrix.test.ts, T11) can read the ASSEMBLED
// app's own route table; Bun serves only the default export below.
export const app = new OpenAPIHono({ defaultHook: validationHook });

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log bodies
// (activity subjects and notes are free text about clients, see src/lib/logger.ts).
app.use("*", requestLogger());

// The maintenance switch (AC-2.5, ADR 20261110-activities-migration-write-pause): before authentication and before any route,
// so nothing reads or writes while the CRM activities are being copied.
app.use("*", maintenanceGate());

// A global cap on request bodies: an activity body is at most 10 000 characters, so 64 KiB
// is generous. Refused as a 413 Problem before anything is parsed. Creating or editing an
// activity may carry a task's description (≤ 128 KiB of JSON, ADR 20261113-task-description-files-in-activities-api-bucket), so those two writes
// get a larger cap; nothing else does (a file's bytes never pass through here).
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_ACTIVITY_WRITE_BYTES = 192 * 1024;
const isActivityWrite = (method: string, path: string) =>
  (method === "POST" && path === "/activities") || (method === "PATCH" && /^\/activities\/[^/]+$/.test(path));
const tooLarge = (c: Context) => problem({ status: 413, detail: "Request body is too large" }, c.req.path);
const defaultLimit = bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES, onError: tooLarge });
const activityWriteLimit = bodyLimit({ maxSize: MAX_ACTIVITY_WRITE_BYTES, onError: tooLarge });
app.use("*", (c, next) => (isActivityWrite(c.req.method, c.req.path) ? activityWriteLimit(c, next) : defaultLimit(c, next)));

// ─── Routes ──────────────────────────────────────────────────────────────────
// Every area router is mounted here, once. T7–T10 add theirs.

app.route("/", healthRouter);
app.route("/", activitiesRouter);
app.route("/", tasksRouter);
app.route("/", systemRouter);
app.route("/", filesRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
  // A ProblemError is a deliberate, typed answer (409 task_blocked, …), not a fault.
  const typed = handleProblemError(err, c.req.path);
  if (typed) return typed;

  // Safety net for a NUL that no schema refused: the request was wrong, not the server (QE D2). Names no value.
  if (isNulDatabaseError(err)) {
    logNulRefusal(err); // the code only (A09): a server-built bad value must not be blamed on the client with no trace
    return problem({ status: 400, code: "validation_failed", detail: NUL_DATABASE_DETAIL }, c.req.path);
  }

  // Name and code only: a database error's message and stack can carry the statement and its
  // parameters, which are free text about clients (OWASP review L2).
  const code = (err as { code?: unknown }).code;
  console.error("[uncaught]", { name: err.name, ...(typeof code === "string" ? { code } : {}) });

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

console.log(`Activities API → http://localhost:${env.PORT}`);
console.log(`API docs       → http://localhost:${env.PORT}/docs`);
if (env.ACTIVITIES_MAINTENANCE) console.warn("Activities API is in MAINTENANCE: every route but /health answers 503");

// Due-date reminders (the day before, 08:00 Europe/Zurich): off in tests and with TASK_DUE_REMINDERS=off.
startDueReminderScheduler();

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer services can reach us
  // over *.railway.internal. Off Railway (local dev), keep Bun's default (IPv4 0.0.0.0).
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

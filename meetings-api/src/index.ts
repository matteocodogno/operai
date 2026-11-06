// env is validated at import time: process.exit(1) on a missing or unsafe variable
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { hostsRouter } from "./hosts/hosts.routes";
import { meetingsRouter } from "./meetings/meetings.routes";
import { captureRouter } from "./capture/capture.routes";
import { processingRouter } from "./processing/processing.routes";
import { transcriptRouter } from "./transcript/transcript.routes";
import { audioRouter } from "./audio/audio.routes";
import { summariesRouter } from "./summaries/summaries.routes";
import { templatesRouter } from "./templates/templates.routes";
import { conversationRouter } from "./conversation/conversation.routes";
import { eraseRouter } from "./erase/erase.routes";
import { requestLogger } from "./lib/logger";
import { handleProblemError, problem, validationHook } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";
import { createS3Client } from "./lib/storage";
import { runStartupChecks } from "./lib/startupChecks";
import { startWorker } from "./jobs/handlers";

// Exported so the assembled-app tests (specs/021 T42) can read the real route
// table; Bun serves only the default export below.
export const app = new OpenAPIHono({ defaultHook: validationHook });

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization", "If-Match", "Accept-Language"],
    exposeHeaders: ["ETag", "Retry-After"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Method / PATH ONLY (no query string) / status / duration: never a body or a
// search term (AC-4.10, src/lib/logger.ts).
app.use("*", requestLogger());

// Body limit 64 KiB, except PUT /meetings/:id/text (1 MiB, plan.md § Conventions).
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_TEXT_BODY_BYTES = 1024 * 1024;
const tooLarge = (c: Context) => problem({ status: 413, detail: "Request body is too large" }, c.req.path);
const smallBody = bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES, onError: tooLarge });
const textBody = bodyLimit({ maxSize: MAX_TEXT_BODY_BYTES, onError: tooLarge });
const isTextWrite = (c: Context) => c.req.method === "PUT" && /^\/meetings\/[^/]+\/text$/.test(c.req.path);
app.use("*", (c, next) => (isTextWrite(c) ? textBody(c, next) : smallBody(c, next)));

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);
app.route("/", hostsRouter);
app.route("/", meetingsRouter);
app.route("/", captureRouter);
app.route("/", processingRouter);
app.route("/", transcriptRouter);
app.route("/", audioRouter);
app.route("/", summariesRouter);
app.route("/", templatesRouter);
app.route("/", conversationRouter);
app.route("/", eraseRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
  // A ProblemError is a deliberate, typed answer (409 version_conflict, …), not a fault.
  const typed = handleProblemError(err, c.req.path);
  if (typed) return typed;

  // Name only: an error message can carry a title or a file name (AC-4.10).
  console.error("[uncaught]", err.name);

  const status =
    "status" in err && typeof (err as { status: number }).status === "number" ? (err as { status: number }).status : 500;

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

// The 30-day audio deletion is the bucket's own lifecycle rule (AC-4.4, ADR-0063):
// refuse to start (exit 1) unless it is there and versioning is not enabled.
// Skipped under test, where storage is faked.
if (env.NODE_ENV !== "test") await runStartupChecks(createS3Client(), env.MEETINGS_S3_BUCKET);

// The durable job runner lives in this process (ADR-0062; MEETINGS_WORKER=off disables it).
if (env.NODE_ENV !== "test") await startWorker();

console.log(`Meetings API → http://localhost:${env.PORT}`);
console.log(`API docs     → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only: bind to :: there so peer services
  // can reach us over *.railway.internal. Local dev keeps Bun's default.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

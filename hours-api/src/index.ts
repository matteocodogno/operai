// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { jwtMiddleware } from "./auth/jwt.middleware";
import { healthRouter } from "./health/health.routes";
import { handleError, handleNotFound, invalidRequestHook } from "./lib/errors";
import { listsRouter } from "./lists/lists.routes";
import { requestLogger } from "./lib/logger";
import { problem } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";

// Exported so the authorization matrix (src/matrix.test.ts, T20) can read the ASSEMBLED
// app's own route table; Bun serves only the default export below.
export const app = new OpenAPIHono({ defaultHook: invalidRequestHook });

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

// Log method / PATH ONLY (no query string) / status / duration — NEVER log bodies or queries
// (a note is free text about what someone worked on; the filters name people, projects and
// deals), see src/lib/logger.ts.
app.use("*", requestLogger());

// A global cap on request bodies: an entry is a handful of members and a note of at most 1000
// characters, so 64 KiB is generous. Refused as a 413 Problem before anything is parsed, and
// before the session is checked, so nothing large is read for anyone.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c: Context) => problem({ status: 413, detail: "Request body is too large" }, c.req.path),
  }),
);

// ─── Public routes ───────────────────────────────────────────────────────────
// Answer anyone: liveness and the API documents. Nothing else may be mounted above the session
// guard below, and the authorization matrix (T20) fails on a route it was not told is public.

app.route("/", healthRouter);
setupOpenAPI(app);

// ─── The session guard ───────────────────────────────────────────────────────
// Default-deny (AC-5.3): every path below this line, including one nothing serves, needs a valid
// session (RS256, issuer, `aud=AUTH_AUDIENCE`), so a route added later without its own check is
// still refused, and a probe learns nothing about which paths exist. A session is all a person
// needs to record and read their own hours (AC-5.1); what else a route needs (`time-entry:read-all`,
// `time-list:manage`, bookability) it asks for itself.

app.use("*", jwtMiddleware);

// ─── Routes ──────────────────────────────────────────────────────────────────
// Every area router is mounted here, once, in this order (src/index.ts is shared by T12, T14, T17
// and T18): lists, entries, list, totals. T10 mounted none; T12 mounts the lists.

app.route("/", listsRouter);

// ─── Error answers (RFC 7807 Problem JSON) ───────────────────────────────────

app.onError(handleError);
app.notFound(handleNotFound);

// ─── Start ───────────────────────────────────────────────────────────────────

console.log(`Hours API → http://localhost:${env.PORT}`);
console.log(`API docs  → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer services can reach us
  // over *.railway.internal. Off Railway (local dev), keep Bun's default (IPv4 0.0.0.0).
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

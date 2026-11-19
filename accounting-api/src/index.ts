// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { catalogRouter } from "./catalog/catalog.routes";
import { healthRouter } from "./health/health.routes";
import { requestLogger } from "./lib/logger";
import { meRouter } from "./me/me.routes";
import { handleProblemError, problem, validationHook } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";
import { createRatesRouter } from "./rates/rates.routes";
import { createRatesService } from "./rates/rates.service";

// Exported so tests (and the route matrix of the later tasks) can read the ASSEMBLED app;
// Bun serves only the default export below.
export const app = new OpenAPIHono({ defaultHook: validationHook });

// ─── Middleware ───────────────────────────────────────────────────────────────

// CORS to the shell's origin only (ALLOWED_ORIGINS, never a wildcard: env.ts refuses it).
// PUT is the exchange-rate correction (T12); entries themselves have no PUT, PATCH or DELETE (AC-1.12).
app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log bodies or query strings
// (src/lib/logger.ts).
app.use("*", requestLogger());

// A global cap on request bodies: the largest legitimate body is a ledger account or a VAT code
// (a few short fields), so 4 KiB is generous. Refused as a 413 Problem before anything is parsed.
export const MAX_REQUEST_BODY_BYTES = 4 * 1024;
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c: Context) => problem({ status: 413, detail: "Request body is too large" }, c.req.path),
  }),
);

// ─── Routes ──────────────────────────────────────────────────────────────────
// Each area router is mounted here, once, by the task that owns it (tasks.md § Shared registries:
// T4 → T6 → T8 → T12 → T13).

// The one rates service of the process: the user routes (manager) and the system routes (consumer) share it, because
// single flight and the throttle's in-process half are per service instance. ACCOUNTING_FX_SOURCE=off makes every attempt a
// `disabled` row with no outbound call.
const ratesService = createRatesService({ mode: env.ACCOUNTING_FX_SOURCE });

app.route("/", healthRouter);
app.route("/", meRouter);
app.route("/", catalogRouter);
app.route("/", createRatesRouter(ratesService));

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
  // A ProblemError is a deliberate, typed answer (409 ledger_account_duplicate, …), not a fault:
  // render it with its top-level `code`/extension members and do not log it as uncaught.
  const handled = handleProblemError(err, c.req.path);
  if (handled) return handled;

  // A framework error that carries a client status (malformed JSON body: 400) keeps it; anything
  // else is a 500 whose detail never leaves the process outside development (AC-6.10).
  const carried = "status" in err ? (err as { status: unknown }).status : undefined;
  const status = typeof carried === "number" && carried >= 400 && carried <= 599 ? carried : 500;
  if (status >= 500) console.error("[uncaught]", err);

  return problem(
    {
      status,
      detail: status < 500 || env.NODE_ENV === "development" ? err.message : "An unexpected error occurred",
    },
    c.req.path,
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

console.log(`Accounting API → http://localhost:${env.PORT}`);
console.log(`API docs       → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { healthRouter } from "./health/health.routes";
import { scopeRouter } from "./scope/scope.routes";
import { companiesRouter } from "./companies/companies.routes";
import { contactsRouter } from "./contacts/contacts.routes";
import { dealsRouter } from "./deals/deals.routes";
import { estimateRouter } from "./estimates/estimate.routes";
import { estimateNoticesRouter } from "./estimates/estimateNotices.routes";
import { offerTemplatesRouter } from "./offer-templates/offerTemplates.routes";
import { offersRouter } from "./offers/offers.routes";
import { attachmentsRouter } from "./attachments/attachments.routes";
import { entityProfilesRouter } from "./entity-profiles/entityProfiles.routes";
import { offerSequencesRouter } from "./offer-sequences/offerSequences.routes";
import { activitiesRouter } from "./activities/activities.routes";
import { meetingHostResolveRouter } from "./meeting-host/resolve.routes";
import { requestLogger } from "./lib/logger";
import { handleProblemError, problem } from "./lib/problem";
import { setupOpenAPI } from "./openapi/registry";

// Exported so the authorization matrix (src/matrix.test.ts) can read the
// ASSEMBLED app's own route table; Bun serves only the default export below.
export const app = new OpenAPIHono();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    // If-Match / ETag carry the optimistic-concurrency version (D-7).
    allowHeaders: ["Content-Type", "Authorization", "If-Match"],
    exposeHeaders: ["ETag"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Log method / PATH ONLY (no query string) / status / duration — NEVER log
// bodies (data-residency constraint: deal values and clients' contacts'
// personal data — see src/lib/logger.ts). The query string carries search
// terms (names, emails), which is why it is dropped too.
app.use("*", requestLogger());

// A global cap on request bodies: the largest legitimate body is a note or an
// activity of at most 10 000 characters, so 64 KiB is generous. Refused as a
// 413 Problem before anything is parsed.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
// An offer or a template carries up to 15 sections of 20 000 characters
// (specs/020 AC-3.3), so those bodies get a larger, still bounded, cap.
export const MAX_DOCUMENT_BODY_BYTES = 1024 * 1024;
const tooLarge = (c: Context) => problem({ status: 413, detail: "Request body is too large" }, c.req.path);
const smallBody = bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES, onError: tooLarge });
const documentBody = bodyLimit({ maxSize: MAX_DOCUMENT_BODY_BYTES, onError: tooLarge });
const isDocumentWrite = (c: Context) =>
  c.req.path.startsWith("/offer-templates") || (c.req.method === "POST" && /^\/deals\/[^/]+\/offers$/.test(c.req.path));
app.use("*", (c, next) => (isDocumentWrite(c) ? documentBody(c, next) : smallBody(c, next)));

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/", healthRouter);
app.route("/", scopeRouter);
app.route("/", companiesRouter);
app.route("/", contactsRouter);
app.route("/", dealsRouter);
app.route("/", estimateRouter);
app.route("/", estimateNoticesRouter);
app.route("/", offersRouter);
app.route("/", offerTemplatesRouter);
app.route("/", attachmentsRouter);
app.route("/", entityProfilesRouter);
app.route("/", offerSequencesRouter);
app.route("/", activitiesRouter);
app.route("/", meetingHostResolveRouter);

// ─── OpenAPI + Scalar UI ─────────────────────────────────────────────────────

setupOpenAPI(app);

// ─── Global error handler (RFC 7807 Problem JSON) ───────────────────────────

app.onError((err: Error, c: Context) => {
  // A ProblemError is a deliberate, typed answer (409 version_conflict, …),
  // not a fault: render it with its top-level `code`/extension members and do
  // not log it as uncaught.
  const problem = handleProblemError(err, c.req.path);
  if (problem) return problem;

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

console.log(`CRM API  → http://localhost:${env.PORT}`);
console.log(`API docs → http://localhost:${env.PORT}/docs`);

export default {
  port: env.PORT,
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

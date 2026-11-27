// env is validated at import time — process.exit(1) on missing vars
import { env } from "./lib/env";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { requestLogger } from "./lib/logger";
import { auth } from "./auth/auth.config";
import { authRouter } from "./auth/auth.routes";
import { auditRouter } from "./authz/audit.routes";
import { authzRouter } from "./authz/authz.routes";
import { resolveRouter } from "./authz/resolve.routes";
import { catalogRouter } from "./authz/catalog.routes";
import { appAccessCheckRouter } from "./authz/appAccessCheck.routes";
import { directoryRouter } from "./authz/directory.routes";
import { holdersRouter } from "./authz/holders.routes";
import { identitiesRouter } from "./authz/identities.routes";
import { departmentsRouter } from "./admin/departments.routes";
import { rolesRouter } from "./admin/roles.routes";
import { teamsRouter } from "./teams/admin.routes";
import { usersRouter } from "./admin/users.routes";
import { userAddressRouter } from "./admin/userAddress.routes";
import { addressRouter } from "./profile/address.routes";
import { legalEntityReadRouter } from "./legalEntities/read.routes";
import { legalEntityHistoryRouter } from "./legalEntities/history.routes";
import { legalEntityCheckRouter } from "./legalEntities/check.routes";
import { legalEntityWriteRouter } from "./legalEntities/write.routes";
import { createSystemLegalEntitiesRouter } from "./legalEntities/system.routes";
import { healthRouter } from "./health/health.routes";
import { inviteRouter } from "./invite/invite.routes";
import { invitationsRouter } from "./invitations/invitations.routes";
import { accessRequestsRouter } from "./signup/accessRequests.routes";
import { jwksRouter } from "./jwks/jwks.routes";
import { signinRouter } from "./signin/signin.routes";
import { createServiceTokenRouter, signWithAuth } from "./system/serviceToken.routes";
import { createUserContactRouter, jwksFromAuth } from "./system/userContact.routes";
import { createSelfServiceTokenProvider } from "./system/selfServiceToken";
import {
  createSystemRateLimits,
  LEGAL_ENTITIES_SERVICE_LIMIT,
  TEAMS_OPTIONS_SERVICE_LIMIT,
  TEAMS_SERVICE_LIMIT,
} from "./system/systemRateLimits";
import { createSystemTeamsRouter } from "./teams/system.routes";
import { setNotifyTokenProvider } from "./lib/notify";
import { startNoticeDispatcher } from "./legalEntities/notices/dispatcher";
import { setupOpenAPI } from "./openapi/registry";
import { isNulDatabaseError, nulProblem, rejectNul, logNulRefusal } from "./lib/nul";
import { requestBodyLimit } from "./lib/bodyLimit";

// Exported so `legalEntities/routerTable.test.ts` can read the real route table (AC-2.7).
export const app = new OpenAPIHono();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // `Retry-After` is not CORS-safelisted: without this a cross-origin page cannot read the wait of a 429 (T74).
    exposeHeaders: ["Retry-After"],
    credentials: true,
  }),
);

// Redacted request logger (security-review fix #1, specs/20260713-user-invitations):
// hono/logger() logs the full path INCLUDING the query string, which would
// write the live `GET /invite?id&token=<raw>` invitation token into every log
// line for that request — see src/lib/logger.ts.
app.use("*", requestLogger());

// A ceiling on the body BEFORE anything reads it: the NUL scan below decodes a whole JSON body on every request, signed in or not
// (security review A04/A05). 413 `request_too_large`; the figure and why are in lib/bodyLimit.ts.
app.use("*", requestBodyLimit);

// A NUL in the path, the query or a JSON body is a 400 before any route runs: Postgres text cannot hold it, and every string
// the admin, invitation, legal-entity and authz routes take would otherwise need its own refusal (QE D2).
app.use("*", rejectNul);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.route("/auth", authRouter);
app.route("/", healthRouter);
app.route("/", jwksRouter);
app.route("/", signinRouter);
app.route("/", auditRouter);
app.route("/", authzRouter);
app.route("/", resolveRouter);
app.route("/", catalogRouter);
app.route("/", appAccessCheckRouter);
app.route("/", identitiesRouter);
app.route("/", directoryRouter);
app.route("/", holdersRouter);
app.route("/", departmentsRouter);
app.route("/", rolesRouter);
// Teams (specs/20261126-teams, T2): admin-only named groups of users; they grant nothing and bump no epoch.
app.route("/", teamsRouter);
app.route("/", usersRouter);
app.route("/", userAddressRouter);
app.route("/", addressRouter);
// The legal-entity registry, person read API (specs/20261117-legal-entities, T5). `/legal-entities/manageable` is
// registered inside this router before `/legal-entities/{entity}` (E2).
app.route("/", legalEntityReadRouter);
// The history and the read-only version view (T7): GET only, each path with its own authentication and `no-store`.
app.route("/", legalEntityHistoryRouter);
// Save and restore (T8): POST only, per exact path, each with its own session, grant check and `no-store`. The registry
// is append-only: there is no PUT, PATCH or DELETE under `/legal-entities` (`routerTable.test.ts` reads this table).
app.route("/", legalEntityWriteRouter);
// The dry run of a save (T55): POST only, its own exact path, read-only; shares the write router's limiter pair.
app.route("/", legalEntityCheckRouter);
app.route("/", invitationsRouter);
app.route("/", accessRequestsRouter);
app.route("/", inviteRouter);
const signServiceJwt = signWithAuth(auth);
// One set of limits for the /system endpoints: the invalid-credential count is shared (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service).
const systemLimits = createSystemRateLimits();
console.log(
  `[system] limits per ${env.SYSTEM_RATE_WINDOW_MS} ms: service-token ${env.SERVICE_TOKEN_SERVICE_LIMIT} per service, ` +
    `users/contact ${env.USERS_CONTACT_SERVICE_LIMIT} per service, legal-entities ${LEGAL_ENTITIES_SERVICE_LIMIT} per service, ` +
    `teams ${TEAMS_SERVICE_LIMIT} per service (ids) and ${TEAMS_OPTIONS_SERVICE_LIMIT} (options), ` +
    `invalid credentials ${env.SYSTEM_INVALID_CREDENTIAL_LIMIT} per source`,
);
console.log(
  `[legal-entities] limits per ${env.LEGAL_ENTITY_RATE_WINDOW_MS} ms: save+restore ${env.LEGAL_ENTITY_WRITE_RATE_LIMIT} per person, ` +
    `check ${env.LEGAL_ENTITY_CHECK_RATE_LIMIT} per person`,
);
app.route("/", createServiceTokenRouter({ signJwt: signServiceJwt, limits: systemLimits }));
app.route("/", createUserContactRouter({ getJwks: jwksFromAuth(auth), limits: systemLimits }));
// The service read API of the legal-entity registry (specs/20261117-legal-entities, T6): the same limits object (one
// shared invalid-credential count); its own key-set cache, so a re-read here never spends the contact route's cooldown.
app.route("/", createSystemLegalEntitiesRouter({ getJwks: jwksFromAuth(auth), limits: systemLimits }));
// The service read of teams (specs/20261126-teams, T9): the same limits object again (one shared invalid-credential
// count, its own two allowances), its own key-set cache. A team grants nothing; projects-api is the one bound reader.
app.route("/", createSystemTeamsRouter({ getJwks: jwksFromAuth(auth), limits: systemLimits }));
// `auth`'s own notify credential (specs/20261013-notify-service-credentials T7, ADR 20261013-auth-mints-own-service-credential-in-process): invitation emails
// authenticate with it. Injected here, not imported by lib/notify.ts, so that
// module never depends on auth.config (see serviceToken.routes.ts).
export const selfServiceTokenProvider = createSelfServiceTokenProvider({ signJwt: signServiceJwt });
setNotifyTokenProvider(selfServiceTokenProvider);
// The notice dispatcher of a protected legal-entity change (specs/20261117-legal-entities, T59; plan G6): sends the rows
// the save wrote down, right after the save commits (`kickNotices`) and from a sweep every 15 s on every replica,
// including once now. It needs the credential above, so it starts after it; never under `bun test`, where the routes'
// kick does nothing and a test builds its own dispatcher.
if (env.NODE_ENV !== "test") startNoticeDispatcher();

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
  // Safety net for a NUL that got past the guard to the database (a 22021 / 22P05): the request was wrong, not the server.
  if (isNulDatabaseError(err)) {
    logNulRefusal(err); // the code only (A09): a server-built bad value must not be blamed on the client with no trace
    return nulProblem(c.req.path);
  }

  // Name and code only (D9-3): a message or the object can carry a database call's arguments, an address among them.
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    "[uncaught]",
    err instanceof Error ? err.name : "UnknownError",
    typeof code === "string" || typeof code === "number" ? code : "",
  );

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
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

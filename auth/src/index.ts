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
import { usersRouter } from "./admin/users.routes";
import { userAddressRouter } from "./admin/userAddress.routes";
import { addressRouter } from "./profile/address.routes";
import { legalEntityReadRouter } from "./legalEntities/read.routes";
import { legalEntityHistoryRouter } from "./legalEntities/history.routes";
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
import { createSystemRateLimits, LEGAL_ENTITIES_SERVICE_LIMIT } from "./system/systemRateLimits";
import { setNotifyTokenProvider } from "./lib/notify";
import { setupOpenAPI } from "./openapi/registry";

const app = new OpenAPIHono();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: env.ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// Redacted request logger (security-review fix #1, specs/20260713-user-invitations):
// hono/logger() logs the full path INCLUDING the query string, which would
// write the live `GET /invite?id&token=<raw>` invitation token into every log
// line for that request — see src/lib/logger.ts.
app.use("*", requestLogger());

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
app.route("/", usersRouter);
app.route("/", userAddressRouter);
app.route("/", addressRouter);
// The legal-entity registry, person read API (specs/20261117-legal-entities, T5). `/legal-entities/manageable` is
// registered inside this router before `/legal-entities/{entity}` (E2).
app.route("/", legalEntityReadRouter);
// The history and the read-only version view (T7): GET only, each path with its own authentication and `no-store`.
app.route("/", legalEntityHistoryRouter);
app.route("/", invitationsRouter);
app.route("/", accessRequestsRouter);
app.route("/", inviteRouter);
const signServiceJwt = signWithAuth(auth);
// One set of limits for the /system endpoints: the invalid-credential count is shared (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service).
const systemLimits = createSystemRateLimits();
console.log(
  `[system] limits per ${env.SYSTEM_RATE_WINDOW_MS} ms: service-token ${env.SERVICE_TOKEN_SERVICE_LIMIT} per service, ` +
    `users/contact ${env.USERS_CONTACT_SERVICE_LIMIT} per service, legal-entities ${LEGAL_ENTITIES_SERVICE_LIMIT} per service, ` +
    `invalid credentials ${env.SYSTEM_INVALID_CREDENTIAL_LIMIT} per source`,
);
app.route("/", createServiceTokenRouter({ signJwt: signServiceJwt, limits: systemLimits }));
app.route("/", createUserContactRouter({ getJwks: jwksFromAuth(auth), limits: systemLimits }));
// The service read API of the legal-entity registry (specs/20261117-legal-entities, T6): the same limits object (one
// shared invalid-credential count); its own key-set cache, so a re-read here never spends the contact route's cooldown.
app.route("/", createSystemLegalEntitiesRouter({ getJwks: jwksFromAuth(auth), limits: systemLimits }));
// `auth`'s own notify credential (specs/20261013-notify-service-credentials T7, ADR 20261013-auth-mints-own-service-credential-in-process): invitation emails
// authenticate with it. Injected here, not imported by lib/notify.ts, so that
// module never depends on auth.config (see serviceToken.routes.ts).
export const selfServiceTokenProvider = createSelfServiceTokenProvider({ signJwt: signServiceJwt });
setNotifyTokenProvider(selfServiceTokenProvider);

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
  // Railway private networking is IPv6-only — bind to :: there so peer
  // services can reach us over *.railway.internal. Off Railway (local dev),
  // keep Bun's default (IPv4 0.0.0.0) to avoid IPv4-localhost edge cases.
  ...(process.env["RAILWAY_PRIVATE_DOMAIN"] ? { hostname: "::" } : {}),
  fetch: app.fetch,
};

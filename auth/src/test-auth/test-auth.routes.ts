import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { env } from "../lib/env";
import { auth } from "../auth/auth.config";
import { getCookies } from "better-auth/cookies";

/**
 * Produces a Hono-compatible signed cookie value: "<token>.<HMAC-SHA256-base64>".
 *
 * This is the exact format that Hono's `parseSigned` / `getSignedCookie` expects
 * (see hono/dist/utils/cookie.js → `serializeSigned`, `makeSignature`).  Using the
 * same algorithm here means better-auth can accept the cookie through its normal
 * `ctx.getSignedCookie(...)` path without any changes to the production auth config.
 *
 * The signing algorithm matches Hono's `makeSignature`:
 *   key    = HMAC-SHA-256 import of the raw secret bytes
 *   sig    = HMAC-SHA-256 sign of TextEncoder(value)
 *   result = btoa(String.fromCharCode(...Uint8Array(sig)))  → 44 base64 chars
 */
const signCookieValue = async (value: string, secret: string): Promise<string> => {
  const keyMaterial = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(value),
  );
  const base64Sig = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  return `${value}.${base64Sig}`;
};

/**
 * Dev/test-only session-mint endpoint (T14, specs/002).
 *
 * POST /test-auth/session
 *
 * Mints a valid better-auth session for a seeded test user and returns the
 * session cookie(s) in Set-Cookie headers.  The resulting cookie works against
 * the existing `GET /auth/get-session` and `GET /auth/token` endpoints.
 *
 * PRODUCTION GATE (the whole point of this file):
 *   The endpoint only exists when BOTH of the following are true:
 *     1. NODE_ENV !== 'production'
 *     2. ENABLE_TEST_AUTH === true
 *
 *   When either condition is not met the router returns 404.  The gate is
 *   checked at REQUEST time (not at module load), so a misconfigured deploy
 *   that somehow imports this router still cannot mint sessions.
 *
 * This endpoint is a test seam — it does NOT enable emailAndPassword sign-in
 * and does NOT add any production-visible authentication path.  It uses the
 * better-auth internalAdapter directly to create the user and session.
 */

// Only emails ending with this suffix may be minted by this endpoint.
// Anything else (e.g. admin@welld.ch) is rejected with 403 to prevent
// impersonation of real users in staging/dev environments.
const TEST_EMAIL_SUFFIX = "@operai.test";

const RequestBodySchema = z.object({
  email: z.string().email().optional().default("test@operai.test"),
  name: z.string().optional().default("Test User"),
});

export const testAuthRouter = new OpenAPIHono();

testAuthRouter.post("/test-auth/session", async (c) => {
  // ── Production gate ────────────────────────────────────────────────────────
  // Check both conditions at request time so a misconfigured server cannot
  // accidentally expose this endpoint even if the router was registered.
  if (env.NODE_ENV === "production" || !env.ENABLE_TEST_AUTH) {
    return c.json(
      {
        type: "https://httpstatuses.com/404",
        title: "Not Found",
        status: 404,
        detail: "POST /test-auth/session does not exist",
        instance: c.req.path,
      },
      404,
    );
  }

  // ── Parse request body (optional — defaults applied by schema) ─────────────
  let body: z.infer<typeof RequestBodySchema>;
  try {
    const raw = await c.req.json().catch(() => ({}));
    body = RequestBodySchema.parse(raw);
  } catch {
    return c.json(
      {
        type: "https://httpstatuses.com/400",
        title: "Bad Request",
        status: 400,
        detail: "Request body must be valid JSON with optional email and name",
        instance: c.req.path,
      },
      400,
    );
  }

  // ── Test-domain allowlist (OWASP: prevent impersonation of real accounts) ──
  // Reject any email that does not end with @operai.test.  This must run
  // BEFORE the user lookup/create so a real account is never touched.
  if (!body.email.endsWith(TEST_EMAIL_SUFFIX)) {
    return c.json(
      {
        type: "https://httpstatuses.com/403",
        title: "Forbidden",
        status: 403,
        detail: `Test sessions may only be minted for addresses ending with ${TEST_EMAIL_SUFFIX}`,
        instance: c.req.path,
      },
      403,
    );
  }

  // ── Resolve better-auth internal adapter ──────────────────────────────────
  // `auth.$context` is a Promise that resolves once better-auth has initialised
  // its DB connection.  We await it here; in practice this is near-instantaneous
  // after the first request because the DB adapter is lazily initialised.
  const ctx = await auth.$context;
  const adapter = ctx.internalAdapter;

  // ── Find-or-create the test user ──────────────────────────────────────────
  // We look up by email so repeated calls to this endpoint are idempotent —
  // the same user row is reused across test runs.
  //
  // On the existing-user path we also UPDATE the name (and any future provided
  // fields) to match the request body, so the minted session deterministically
  // reflects the caller's payload regardless of what the row was first created with.
  let userId: string;

  const existing = await adapter.findUserByEmail(body.email);
  if (existing) {
    userId = existing.user.id;
    // Upsert the name so callers get deterministic user data in their sessions.
    // This keeps e2e name-assertions from being DB-state-dependent.
    await adapter.updateUser(userId, { name: body.name });
  } else {
    const created = await adapter.createUser({
      email: body.email,
      name: body.name,
      emailVerified: true,
      // image is optional in the User model; omit it for the test user
    });
    userId = created.id;
  }

  // ── Mint a real better-auth session ───────────────────────────────────────
  // `createSession` persists a session row and returns the full Session object.
  // The second argument (dontRememberMe=false) ensures a long-lived session
  // matching the configured `expiresIn` (7 days) so e2e tests don't expire mid-run.
  const session = await adapter.createSession(userId, false);

  // ── Build Set-Cookie header ───────────────────────────────────────────────
  // We use better-auth's own `getCookies` to obtain the correct cookie name and
  // attributes (SameSite, Secure, Path, HttpOnly, MaxAge) for this configuration.
  // This keeps cookie attributes in sync with whatever better-auth uses for real
  // sessions — if the auth config changes the cookies, our test cookie changes too.
  const cookieConfig = getCookies(auth.options);
  const sessionCookieName = cookieConfig.sessionToken.name;
  const sessionCookieAttrs = cookieConfig.sessionToken.attributes;

  // Sign the session token with the same HMAC-SHA-256 algorithm that Hono uses
  // for signed cookies (`serializeSigned` / `makeSignature`).  The resulting value
  // is "<token>.<base64-sig>" — accepted verbatim by Hono's `parseSigned` (and
  // therefore by better-auth's `ctx.getSignedCookie`).
  //
  // We use `env.BETTER_AUTH_SECRET` directly because `ctx.context.secret` (used by
  // better-auth internally) is derived from `options.secret`, which is wired to the
  // same env var in `auth.config.ts`.
  const signedCookieValue = await signCookieValue(session.token, env.BETTER_AUTH_SECRET);

  // Build the attribute string from the config object
  const attrParts: string[] = [`${sessionCookieName}=${signedCookieValue}`];

  if (sessionCookieAttrs.path) attrParts.push(`Path=${sessionCookieAttrs.path}`);
  if (sessionCookieAttrs.httpOnly) attrParts.push("HttpOnly");
  if (sessionCookieAttrs.sameSite) attrParts.push(`SameSite=${sessionCookieAttrs.sameSite}`);
  if (sessionCookieAttrs.maxAge !== undefined) attrParts.push(`Max-Age=${sessionCookieAttrs.maxAge}`);
  // Secure is env-dependent in better-auth (only on https); honour that
  if (sessionCookieAttrs.secure) attrParts.push("Secure");

  const setCookieValue = attrParts.join("; ");

  // Return the session cookie in a Set-Cookie header so the calling test
  // (Playwright helper or bun test) can inject it into the browser context.
  // NOTE: sessionToken is intentionally absent from the body (OWASP: avoid
  // exposing raw bearer tokens as an exfiltration vector — the Set-Cookie
  // header is the only delivery mechanism the test helper needs).
  return c.json(
    {
      userId,
      email: body.email,
      name: body.name,
    },
    200,
    {
      "Set-Cookie": setCookieValue,
    },
  );
});

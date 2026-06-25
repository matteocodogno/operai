/**
 * QE regression test — T14 Defect D-1
 *
 * Verifies that the Set-Cookie value returned by POST /test-auth/session uses
 * the Hono signed-cookie format ("<token>.<HMAC-SHA256-base64>") so that
 * better-auth's `getSignedCookie` can accept it.
 *
 * better-auth calls `ctx.getSignedCookie(...)` (Hono's signed-cookie helper)
 * to read the session token.  Hono's `parseSigned` expects the cookie value
 * to be "<value>.<base64url-signature>" where:
 *   - the final "." separates the value from the signature
 *   - the signature is exactly 44 characters and ends with "="
 *   (see hono/dist/utils/cookie.js parseSigned, line 78-87)
 *
 * The current implementation writes the raw session token as the cookie value,
 * which Hono rejects (returns undefined), causing `GET /auth/get-session` to
 * return null.
 *
 * This test FAILS against the current implementation and PASSES once the
 * implementation uses Hono's `setSignedCookie` (or equivalent) to sign the
 * token with BETTER_AUTH_SECRET before setting the cookie.
 *
 * Evidence: live integration run on 2026-06-26 showed the endpoint emitting a
 * bare (unsigned) session-token cookie, after which GET /auth/get-session
 * returned null — the session existed in the DB but the cookie was rejected by
 * Hono's getSignedCookie because it lacked the `<token>.<signature>` form.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";

// ─── Mocks (same as the main test file) ───────────────────────────────────────

const FAKE_USER_ID = "usr_regression_test";
const FAKE_SESSION_TOKEN = "raw_token_without_hmac_signature";
const MOCK_COOKIE_NAME = "better-auth.session_token";

const mockInternalAdapter = {
  findUserByEmail: mock(async (_email: string) => null),
  createUser: mock(async (data: { email: string; name: string; emailVerified: boolean }) => ({
    id: FAKE_USER_ID,
    email: data.email,
    name: data.name,
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  createSession: mock(async (_userId: string, _dontRememberMe: boolean) => ({
    id: "ses_regression_test",
    token: FAKE_SESSION_TOKEN,
    userId: FAKE_USER_ID,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ipAddress: null,
    userAgent: null,
  })),
};

const mockAuthContext = {
  internalAdapter: mockInternalAdapter,
};

mock.module("../auth/auth.config", () => ({
  auth: {
    options: { baseURL: "http://localhost:3001", basePath: "/auth" },
    $context: Promise.resolve(mockAuthContext),
  },
}));

mock.module("better-auth/cookies", () => ({
  getCookies: mock((_opts: unknown) => ({
    sessionToken: {
      name: MOCK_COOKIE_NAME,
      attributes: {
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const,
        maxAge: 604800,
        secure: false,
      },
    },
  })),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /test-auth/session — signed cookie format (D-1 regression)", () => {
  beforeEach(() => {
    mockInternalAdapter.findUserByEmail.mockClear();
    mockInternalAdapter.createUser.mockClear();
    mockInternalAdapter.createSession.mockClear();
    mockInternalAdapter.findUserByEmail.mockImplementation(async () => null);
  });

  /**
   * Open the gate (same pattern as main test file).
   */
  async function openGate() {
    const envModule = await import("../lib/env");
    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = true;
    (envModule.env as Record<string, unknown>).NODE_ENV = "test";
    const { testAuthRouter } = await import("./test-auth.routes");
    return testAuthRouter;
  }

  /**
   * D-1: The cookie value MUST be signed (format "<token>.<HMAC-SHA256>").
   *
   * Hono's parseSigned rejects unsigned cookies — it looks for the last "."
   * separator and validates that the suffix is a 44-character base64 string
   * ending with "=".  Without this, better-auth's getSignedCookie returns
   * undefined and GET /auth/get-session returns null.
   *
   * This test FAILS on the current implementation.
   */
  test("(D-1) Set-Cookie value must be in Hono signed-cookie format <token>.<signature>", async () => {
    const router = await openGate();
    const res = await router.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);

    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    // Extract the cookie value (everything between the first "=" and the first ";")
    const cookieValueMatch = setCookieHeader.match(
      new RegExp(`${MOCK_COOKIE_NAME}=([^;]+)`),
    );
    expect(cookieValueMatch).not.toBeNull();

    const cookieValue: string = cookieValueMatch![1]!;

    // Hono signed-cookie format: "<value>.<base64-HMAC-SHA256>"
    // parseSigned looks for the LAST "." as the separator
    const lastDotIdx = cookieValue.lastIndexOf(".");
    expect(lastDotIdx).toBeGreaterThan(0); // there must be a "." separator

    const signature = cookieValue.substring(lastDotIdx + 1);
    // Hono signature: exactly 44 base64 characters ending with "="
    // (SHA-256 produces 32 bytes → 44 base64 chars with padding)
    expect(signature).toHaveLength(44);
    expect(signature.endsWith("=")).toBe(true);

    const rawToken = cookieValue.substring(0, lastDotIdx);
    expect(rawToken).toBe(FAKE_SESSION_TOKEN);
  });

  /**
   * D-1 corollary: the raw session token alone (no signature) must NOT appear
   * as the complete cookie value.  If it does, Hono's parseSigned will
   * return undefined and the cookie is unusable.
   */
  test("(D-1) cookie value is not the bare session token (bare token is not a valid signed cookie)", async () => {
    const router = await openGate();
    const res = await router.request("/test-auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    const cookieValueMatch = setCookieHeader.match(
      new RegExp(`${MOCK_COOKIE_NAME}=([^;]+)`),
    );
    expect(cookieValueMatch).not.toBeNull();

    const cookieValue: string = cookieValueMatch![1]!;
    // The cookie value must not be identical to the raw token —
    // it must contain the HMAC signature suffix
    expect(cookieValue).not.toBe(FAKE_SESSION_TOKEN);
  });
});

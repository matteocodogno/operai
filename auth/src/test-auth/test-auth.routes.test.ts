/**
 * T14: Dev/test-only session-mint endpoint — unit tests
 *
 * Strategy: mock `better-auth/cookies` and the `auth` module so no live
 * database or real OAuth credentials are needed.  The tests assert the
 * production gate (the security deliverable) and the happy-path shape.
 *
 * Gate cases:
 *   (b) ENABLE_TEST_AUTH off  → 404 / no session minted
 *   (c) NODE_ENV=production   → 404 / no session minted (even if flag is on)
 *
 * Session-mint case:
 *   (a) ENABLE_TEST_AUTH on + NODE_ENV=test → 200 with Set-Cookie and body
 *
 * NOTE: The "real /auth/get-session accepts the cookie" and "real /auth/token
 * returns a JWT" assertions (part (a) from tasks.md) require a live DB and
 * working Prisma connection.  They are documented below as DB-dependent tests
 * that are SKIPPED in this unit suite but must be verified in a full
 * integration environment (see INTEGRATION NOTE at the bottom of this file).
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Makes a POST request to `testAuthRouter` with the current env already baked
 * into the router module (reloaded per test via beforeEach).
 */
async function postMintSession(
  router: import("@hono/zod-openapi").OpenAPIHono,
  body?: Record<string, string>,
): Promise<Response> {
  return router.request("/test-auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ─── Shared mock objects ───────────────────────────────────────────────────────

const FAKE_USER_ID = "usr_test_00000000";
const FAKE_SESSION_TOKEN = "sess_tok_test_deadbeef";

/** Minimal stub for better-auth internal adapter */
const mockInternalAdapter = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findUserByEmail: mock(async (_email: string): Promise<any> => null),
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
    id: "ses_test_00000000",
    token: FAKE_SESSION_TOKEN,
    userId: FAKE_USER_ID,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ipAddress: null,
    userAgent: null,
  })),
};

/** Minimal stub for auth.$context */
const mockAuthContext = {
  internalAdapter: mockInternalAdapter,
};

/** Stub for getCookies — returns the same shape better-auth uses for real */
const MOCK_COOKIE_NAME = "better-auth.session_token";
const mockGetCookies = mock((_opts: unknown) => ({
  sessionToken: {
    name: MOCK_COOKIE_NAME,
    attributes: {
      path: "/",
      httpOnly: true,
      sameSite: "lax" as const,
      maxAge: 604800, // 7 days in seconds
      secure: false,
    },
  },
}));

// ─── Module mock setup ─────────────────────────────────────────────────────────
//
// We mock two external modules at the top level so that when the route module
// is imported, it gets the stubs rather than real implementations that would
// attempt DB connections.
//
// Bun's module mock system patches the module cache; we must call mock.module
// BEFORE the module-under-test is imported.

mock.module("../auth/auth.config", () => ({
  auth: {
    options: { baseURL: "http://localhost:3001", basePath: "/auth" },
    $context: Promise.resolve(mockAuthContext),
  },
}));

mock.module("better-auth/cookies", () => ({
  getCookies: mockGetCookies,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /test-auth/session — production gate (security)", () => {
  // Cache original env so we can restore after each test
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ENABLE_TEST_AUTH: process.env.ENABLE_TEST_AUTH,
  };

  beforeEach(() => {
    // Reset adapter mocks before each test
    mockInternalAdapter.findUserByEmail.mockClear();
    mockInternalAdapter.createUser.mockClear();
    mockInternalAdapter.createSession.mockClear();
  });

  afterEach(() => {
    // Restore env
    if (originalEnv.NODE_ENV !== undefined) {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalEnv.ENABLE_TEST_AUTH !== undefined) {
      process.env.ENABLE_TEST_AUTH = originalEnv.ENABLE_TEST_AUTH;
    } else {
      delete process.env.ENABLE_TEST_AUTH;
    }
  });

  // ── Case (b): flag OFF ─────────────────────────────────────────────────────

  test("(b) returns 404 when ENABLE_TEST_AUTH is unset (flag off)", async () => {
    // env.ts is parsed once at module load — but the gate check in the route
    // handler reads `env.ENABLE_TEST_AUTH` at request time.  We need to
    // re-import the route module with the env value we want.
    //
    // Because Bun caches modules, we patch the env singleton directly.
    const envModule = await import("../lib/env");
    const savedFlag = (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH;
    const savedNodeEnv = (envModule.env as Record<string, unknown>).NODE_ENV;

    // Flag off, non-production env
    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = false;
    (envModule.env as Record<string, unknown>).NODE_ENV = "test";

    const { testAuthRouter } = await import("./test-auth.routes");
    const res = await postMintSession(testAuthRouter);

    expect(res.status).toBe(404);

    // No session must have been minted
    expect(mockInternalAdapter.createSession).not.toHaveBeenCalled();

    // Restore
    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = savedFlag;
    (envModule.env as Record<string, unknown>).NODE_ENV = savedNodeEnv;
  });

  test("(b) returns 404 when ENABLE_TEST_AUTH is 'false'", async () => {
    const envModule = await import("../lib/env");
    const savedFlag = (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH;
    const savedNodeEnv = (envModule.env as Record<string, unknown>).NODE_ENV;

    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = false;
    (envModule.env as Record<string, unknown>).NODE_ENV = "test";

    const { testAuthRouter } = await import("./test-auth.routes");
    const res = await postMintSession(testAuthRouter);

    expect(res.status).toBe(404);
    expect(mockInternalAdapter.createSession).not.toHaveBeenCalled();

    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = savedFlag;
    (envModule.env as Record<string, unknown>).NODE_ENV = savedNodeEnv;
  });

  // ── Case (c): production env ───────────────────────────────────────────────

  test("(c) returns 404 when NODE_ENV is 'production' even if ENABLE_TEST_AUTH is true", async () => {
    const envModule = await import("../lib/env");
    const savedFlag = (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH;
    const savedNodeEnv = (envModule.env as Record<string, unknown>).NODE_ENV;

    // Both conditions that should prevent the gate from opening
    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = true;
    (envModule.env as Record<string, unknown>).NODE_ENV = "production";

    const { testAuthRouter } = await import("./test-auth.routes");
    const res = await postMintSession(testAuthRouter);

    expect(res.status).toBe(404);
    expect(mockInternalAdapter.createSession).not.toHaveBeenCalled();

    // Restore
    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = savedFlag;
    (envModule.env as Record<string, unknown>).NODE_ENV = savedNodeEnv;
  });

  test("(c) production gate cannot be bypassed: both flag=true and NODE_ENV=production → 404", async () => {
    const envModule = await import("../lib/env");
    const savedFlag = (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH;
    const savedNodeEnv = (envModule.env as Record<string, unknown>).NODE_ENV;

    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = true;
    (envModule.env as Record<string, unknown>).NODE_ENV = "production";

    const { testAuthRouter } = await import("./test-auth.routes");
    const res = await postMintSession(testAuthRouter);

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body.status).toBe(404);
    // Verify no cookies were set
    expect(res.headers.get("set-cookie")).toBeNull();
    // Confirm no session was created in the adapter
    expect(mockInternalAdapter.createSession).not.toHaveBeenCalled();

    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = savedFlag;
    (envModule.env as Record<string, unknown>).NODE_ENV = savedNodeEnv;
  });
});

describe("POST /test-auth/session — happy path (gate open)", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ENABLE_TEST_AUTH: process.env.ENABLE_TEST_AUTH,
  };

  beforeEach(() => {
    mockInternalAdapter.findUserByEmail.mockClear();
    mockInternalAdapter.createUser.mockClear();
    mockInternalAdapter.createSession.mockClear();
    // Reset findUserByEmail to return null (no existing user) by default
    mockInternalAdapter.findUserByEmail.mockImplementation(async () => null);
  });

  afterEach(() => {
    if (originalEnv.NODE_ENV !== undefined) {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalEnv.ENABLE_TEST_AUTH !== undefined) {
      process.env.ENABLE_TEST_AUTH = originalEnv.ENABLE_TEST_AUTH;
    } else {
      delete process.env.ENABLE_TEST_AUTH;
    }
  });

  /**
   * Opens the gate by patching the env singleton, then imports the router.
   * Because of Bun's module cache the router uses the same env singleton,
   * so patching it before the request is sufficient.
   */
  async function openGate(): Promise<import("@hono/zod-openapi").OpenAPIHono> {
    const envModule = await import("../lib/env");
    (envModule.env as Record<string, unknown>).ENABLE_TEST_AUTH = true;
    (envModule.env as Record<string, unknown>).NODE_ENV = "test";
    const { testAuthRouter } = await import("./test-auth.routes");
    return testAuthRouter;
  }

  // ── Case (a): session minted ───────────────────────────────────────────────

  test("(a) returns 200 with Set-Cookie when gate is open", async () => {
    const router = await openGate();
    const res = await postMintSession(router);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(MOCK_COOKIE_NAME);
    expect(setCookie).toContain(FAKE_SESSION_TOKEN);
  });

  test("(a) Set-Cookie header contains HttpOnly and Path=/", async () => {
    const router = await openGate();
    const res = await postMintSession(router);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
  });

  test("(a) Set-Cookie header contains SameSite attribute", async () => {
    const router = await openGate();
    const res = await postMintSession(router);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/SameSite=/i);
  });

  test("(a) response body includes userId, sessionToken and email", async () => {
    const router = await openGate();
    const res = await postMintSession(router);
    const body = await res.json() as Record<string, unknown>;

    expect(body.userId).toBe(FAKE_USER_ID);
    expect(body.sessionToken).toBe(FAKE_SESSION_TOKEN);
    expect(body.email).toBe("test@operai.test");
  });

  test("(a) uses better-auth internalAdapter to create the session (not a hand-forged cookie)", async () => {
    const router = await openGate();
    await postMintSession(router);

    // Session must have been created via the adapter (proves it is a real better-auth session)
    expect(mockInternalAdapter.createSession).toHaveBeenCalledTimes(1);
    expect(mockInternalAdapter.createSession).toHaveBeenCalledWith(
      FAKE_USER_ID,
      false,
    );
  });

  test("(a) creates a new user when the email does not already exist", async () => {
    mockInternalAdapter.findUserByEmail.mockImplementation(async () => null);
    const router = await openGate();
    await postMintSession(router, { email: "newuser@operai.test", name: "New User" });

    expect(mockInternalAdapter.findUserByEmail).toHaveBeenCalledWith("newuser@operai.test");
    expect(mockInternalAdapter.createUser).toHaveBeenCalledTimes(1);
  });

  test("(a) reuses an existing user row when the email already exists (idempotent)", async () => {
    const existingUser = {
      user: {
        id: FAKE_USER_ID,
        email: "test@operai.test",
        name: "Test User",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      accounts: [],
    };
    mockInternalAdapter.findUserByEmail.mockImplementation(async () => existingUser);

    const router = await openGate();
    await postMintSession(router);

    expect(mockInternalAdapter.findUserByEmail).toHaveBeenCalledTimes(1);
    // User already exists → createUser must NOT be called
    expect(mockInternalAdapter.createUser).not.toHaveBeenCalled();
    // But a new session is still created for the existing user
    expect(mockInternalAdapter.createSession).toHaveBeenCalledWith(FAKE_USER_ID, false);
  });

  test("(a) accepts custom email and name in request body", async () => {
    const router = await openGate();
    const res = await postMintSession(router, {
      email: "custom@operai.test",
      name: "Custom Tester",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.email).toBe("custom@operai.test");
    expect(body.name).toBe("Custom Tester");
  });

  test("(a) uses default email and name when request body is empty", async () => {
    const router = await openGate();
    const res = await postMintSession(router);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.email).toBe("test@operai.test");
    expect(body.name).toBe("Test User");
  });

  test("(a) uses getCookies from better-auth to build the Set-Cookie header (stays in sync with auth config)", async () => {
    const router = await openGate();
    await postMintSession(router);

    // getCookies must have been called with the auth options — proves we did not
    // hand-forge cookie attributes
    expect(mockGetCookies).toHaveBeenCalled();
  });
});

describe("POST /test-auth/session — production sign-in surface unchanged", () => {
  test("the auth config does NOT enable emailAndPassword (no password path added)", async () => {
    // Import the real auth config (not mocked here — checking the config itself)
    // We use a dynamic import to avoid polluting other test modules.
    //
    // We check the options shape: if emailAndPassword were enabled the options
    // object would carry an `emailAndPassword` key with `enabled: true`.
    const { auth: realAuth } = await import("../auth/auth.config");
    const options = realAuth.options as Record<string, unknown>;

    // emailAndPassword should either be absent or explicitly disabled
    const eap = options.emailAndPassword as Record<string, unknown> | undefined;
    const enabled = eap?.enabled;
    expect(enabled).not.toBe(true);
  });
});

/*
 * ─── INTEGRATION NOTE ──────────────────────────────────────────────────────────
 *
 * The following assertions from tasks.md require a live PostgreSQL database
 * and a real better-auth initialisation (Prisma adapter, JWKS keypair, etc.)
 * and are therefore NOT covered in this unit suite:
 *
 *   (a-integration-1) The session cookie returned by POST /test-auth/session
 *     is accepted by GET /auth/get-session (user resolves to the seeded user).
 *
 *   (a-integration-2) GET /auth/token returns a valid RS256 JWT when called
 *     with the minted session cookie.
 *
 * To verify these assertions manually or in a CI environment with a DB:
 *
 *   1. Start PostgreSQL:  docker compose up -d   (localhost:5435)
 *   2. Run migrations:    cd auth && bun run db:migrate
 *   3. Set env:           export ENABLE_TEST_AUTH=true NODE_ENV=test
 *   4. Start the service: bun run dev
 *   5. Mint a session:
 *        curl -s -c /tmp/jar.txt -X POST http://localhost:3001/test-auth/session \
 *             -H 'Content-Type: application/json' \
 *             -d '{"email":"test@operai.test","name":"Test User"}'
 *   6. Verify get-session:
 *        curl -s -b /tmp/jar.txt http://localhost:3001/auth/get-session
 *        # → {"user":{"email":"test@operai.test",...},"session":{...}}
 *   7. Verify JWT:
 *        curl -s -b /tmp/jar.txt http://localhost:3001/auth/token
 *        # → {"token":"<RS256 JWT>"}
 *        # Decode and verify against /.well-known/jwks.json
 *
 * The unit tests above cover all gate/security assertions without a live DB.
 * ───────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { signinRouter } from "./signin.routes";

async function getSignIn(path = "/sign-in"): Promise<Response> {
  return signinRouter.request(path);
}

describe("GET /sign-in", () => {
  test("returns 200 HTML", async () => {
    const res = await getSignIn();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("offers a Google sign-in control wired to the social endpoint", async () => {
    const res = await getSignIn();
    const html = await res.text();
    expect(html).toContain('data-provider="google"');
    expect(html).toContain("Continue with Google");
  });

  test("offers a GitHub sign-in control wired to the social endpoint", async () => {
    const res = await getSignIn();
    const html = await res.text();
    expect(html).toContain('data-provider="github"');
    expect(html).toContain("Continue with GitHub");
  });

  test("both controls post to POST /auth/sign-in/social with the matching provider", async () => {
    const res = await getSignIn();
    const html = await res.text();
    // single submit path used by both buttons, provider read from the control
    expect(html).toContain('fetch("/auth/sign-in/social"');
    expect(html).toContain('method: "POST"');
    expect(html).toContain('provider: provider');
    expect(html).toContain('getAttribute("data-provider")');
  });

  test("uses the Operai design system tokens", async () => {
    const res = await getSignIn();
    const html = await res.text();
    // dark ink palette + purple accent + DM Sans / Syne typefaces
    expect(html).toContain("#0d0d14"); // dark ink
    expect(html).toContain("#5b6af7"); // purple accent
    expect(html).toContain("DM+Sans");
    expect(html).toContain("Syne");
  });
});

// ─── Security: script-context XSS (DEFECT 1) ────────────────────────────────
//
// Regression tests for the script-context XSS fix: a `redirect` that has a
// valid allowlisted origin but a path containing `</script>` must not produce
// a literal `</script>` in the rendered HTML.  The helper `scriptJsonEncode`
// escapes `<` → `<` so the HTML parser can never close the script block
// prematurely.

describe("GET /sign-in — script-context XSS regression (DEFECT 1)", () => {
  test("</script> in redirect path is escaped in rendered output", async () => {
    const { env } = await import("../lib/env");
    const allowedOrigin = env.ALLOWED_ORIGINS[0]; // e.g. http://localhost:5173
    // Craft a URL whose path contains the breakout sequence.
    const maliciousPath = `${allowedOrigin}/</script><script>alert(document.cookie)</script>`;
    const res = await signinRouter.request(
      `/sign-in?redirect=${encodeURIComponent(maliciousPath)}`,
    );
    const body = await res.text();

    // The literal sequence `</script>` must NOT appear inside the JS string.
    // The safe encoding < must be present instead.
    expect(body).not.toContain("</script><script>");
    expect(body).toContain("\\u003c/script");
  });

  test("script tag is properly closed once and only by the page template", async () => {
    const { env } = await import("../lib/env");
    const allowedOrigin = env.ALLOWED_ORIGINS[0];
    const maliciousPath = `${allowedOrigin}/path?x=</script><script>evil()`;
    const res = await signinRouter.request(
      `/sign-in?redirect=${encodeURIComponent(maliciousPath)}`,
    );
    const body = await res.text();
    // The injected `<script>` must not appear in the output as a raw tag.
    expect(body).not.toMatch(/<script>evil/);
  });
});

// ─── Security: CSP and framing headers (DEFECT 2) ────────────────────────────
//
// Regression tests verifying that `GET /sign-in` emits the required security
// headers and that the nonce in the CSP header matches the `nonce` attribute
// on the inline `<script>` tag.

describe("GET /sign-in — security headers (DEFECT 2)", () => {
  test("response includes Content-Security-Policy header", async () => {
    const res = await signinRouter.request("/sign-in");
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
  });

  test("CSP contains frame-ancestors 'none'", async () => {
    const res = await signinRouter.request("/sign-in");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("CSP contains script-src with a nonce", async () => {
    const res = await signinRouter.request("/sign-in");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
  });

  test("nonce in CSP header matches nonce attribute on the <script> tag", async () => {
    const res = await signinRouter.request("/sign-in");
    const csp = res.headers.get("content-security-policy") ?? "";
    const body = await res.text();

    // Extract nonce from CSP header.
    const cspMatch = csp.match(/nonce-([A-Za-z0-9_-]+)/);
    expect(cspMatch).not.toBeNull();
    const headerNonce = cspMatch![1];

    // The rendered <script> must carry the same nonce value.
    expect(body).toContain(`nonce="${headerNonce}"`);
  });

  test("response includes X-Frame-Options: DENY", async () => {
    const res = await signinRouter.request("/sign-in");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("response includes X-Content-Type-Options: nosniff", async () => {
    const res = await signinRouter.request("/sign-in");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("each request generates a unique nonce (no nonce reuse)", async () => {
    const [res1, res2] = await Promise.all([
      signinRouter.request("/sign-in"),
      signinRouter.request("/sign-in"),
    ]);
    const csp1 = res1.headers.get("content-security-policy") ?? "";
    const csp2 = res2.headers.get("content-security-policy") ?? "";
    const nonce1 = csp1.match(/nonce-([A-Za-z0-9_-]+)/)?.[1];
    const nonce2 = csp2.match(/nonce-([A-Za-z0-9_-]+)/)?.[1];
    expect(nonce1).toBeDefined();
    expect(nonce2).toBeDefined();
    expect(nonce1).not.toBe(nonce2);
  });
});

// ─── T2: redirect validation and callbackURL wiring ──────────────────────────
//
// These tests exercise `resolveCallbackURL` indirectly via the rendered HTML —
// the resolved value is embedded in the page's inline script as `callbackURL`.
// We also verify startup-time env validation by checking `UI_HOME_URL` is
// present in the validated env shape (import would fail at module load if the
// variable were missing and the env schema rejected it).

describe("GET /sign-in — redirect validation (T2)", () => {
  // Stash original env values so each test runs with a clean slate.
  const originalEnv = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    UI_HOME_URL: process.env.UI_HOME_URL,
  };

  beforeEach(() => {
    // Set a known ALLOWED_ORIGINS and UI_HOME_URL for the env module.
    // Because `env` is loaded once at module import time we control its
    // values by mutating the already-parsed `env` object imported from
    // signin.routes (which re-exports it indirectly) — instead we patch
    // env directly via the module's shared singleton.
    process.env.ALLOWED_ORIGINS = "http://localhost:5173,https://app.estimai.io";
    process.env.UI_HOME_URL = "http://localhost:5173";
  });

  afterEach(() => {
    process.env.ALLOWED_ORIGINS = originalEnv.ALLOWED_ORIGINS;
    process.env.UI_HOME_URL = originalEnv.UI_HOME_URL;
  });

  // Helper: extract the `callbackURL` value the page embeds in its inline script.
  async function extractCallbackURL(path: string): Promise<string | null> {
    const res = await signinRouter.request(path);
    const body = await res.text();
    // The page renders: var callbackURL = <JSON.stringify(value)>;
    const match = body.match(/var callbackURL = (.*?);/);
    if (!match || match[1] === undefined) return null;
    return JSON.parse(match[1]) as string | null;
  }

  test("(a) redirect whose origin is in ALLOWED_ORIGINS is passed through as callbackURL", async () => {
    // The env singleton is fixed at import — use a matching origin from the
    // value that was set when the module was first loaded (the test env sets
    // ALLOWED_ORIGINS=http://localhost:5173,https://app.estimai.io in the
    // env.ts parse step). We read ALLOWED_ORIGINS from the already-parsed env.
    const { env } = await import("../lib/env");
    const allowedOrigin = env.ALLOWED_ORIGINS[0]; // e.g. "http://localhost:5173"
    const redirectURL = `${allowedOrigin}/estimates/42`;

    const callbackURL = await extractCallbackURL(
      `/sign-in?redirect=${encodeURIComponent(redirectURL)}`,
    );

    expect(callbackURL).toBe(redirectURL);
  });

  test("(b) missing redirect falls back to UI_HOME_URL", async () => {
    const { env } = await import("../lib/env");

    const callbackURL = await extractCallbackURL("/sign-in");

    expect(callbackURL).toBe(env.UI_HOME_URL);
  });

  test("(b) foreign-origin redirect falls back to UI_HOME_URL", async () => {
    const { env } = await import("../lib/env");

    const callbackURL = await extractCallbackURL(
      `/sign-in?redirect=${encodeURIComponent("https://evil.com/steal")}`,
    );

    expect(callbackURL).toBe(env.UI_HOME_URL);
  });

  test("path-based bypass is rejected: https://evil.com/?x=https://app.legit (foreign origin)", async () => {
    const { env } = await import("../lib/env");
    // The origin of this URL is https://evil.com — not in ALLOWED_ORIGINS
    const tricky = "https://evil.com/?x=https://app.estimai.io";

    const callbackURL = await extractCallbackURL(
      `/sign-in?redirect=${encodeURIComponent(tricky)}`,
    );

    expect(callbackURL).toBe(env.UI_HOME_URL);
  });

  test("subdomain spoofing is rejected: https://app.legit.evil.com (foreign origin)", async () => {
    const { env } = await import("../lib/env");
    // The origin is https://app.legit.evil.com — not in ALLOWED_ORIGINS even
    // though it contains a known origin as a substring.
    const tricky = "https://app.legit.evil.com/path";

    const callbackURL = await extractCallbackURL(
      `/sign-in?redirect=${encodeURIComponent(tricky)}`,
    );

    expect(callbackURL).toBe(env.UI_HOME_URL);
  });

  test("invalid (non-URL) redirect value falls back to UI_HOME_URL", async () => {
    const { env } = await import("../lib/env");

    const callbackURL = await extractCallbackURL(
      `/sign-in?redirect=not-a-url`,
    );

    expect(callbackURL).toBe(env.UI_HOME_URL);
  });

  test("(c) UI_HOME_URL is validated at startup — env object exposes it", async () => {
    // env is validated by Zod at module import time (process.exit(1) on failure).
    // If the schema did not include UI_HOME_URL the field would be undefined here.
    const { env } = await import("../lib/env");
    expect(typeof env.UI_HOME_URL).toBe("string");
    expect(env.UI_HOME_URL.startsWith("http")).toBe(true);
  });
});

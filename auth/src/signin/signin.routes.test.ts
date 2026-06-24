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

import { describe, expect, test } from "bun:test";
import { checkSuite, hasErrors, type Finding, type SuiteEnv } from "./check";

const TOKEN = "x".repeat(40);
const AUD = "operai-suite";
const AUTH_URL = "https://auth.operai.welld.io";
const SHELL = "https://operai.welld.io";
const ADMIN = "https://admin.operai.welld.io";

/** A fully-correct production suite — the baseline every mutation test starts from. */
function validSuite(): SuiteEnv {
  return {
    auth: {
      DATABASE_URL: "postgres://…/auth",
      BETTER_AUTH_SECRET: TOKEN,
      BETTER_AUTH_URL: AUTH_URL,
      AUTH_AUDIENCE: AUD,
      ALLOWED_ORIGINS: SHELL,
      UI_HOME_URL: `${SHELL}/`,
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      NOTIFY_INTERNAL_TOKEN: TOKEN,
      PORT: "3001",
    },
    "estimai-api": {
      DATABASE_URL: "postgres://…/estimai",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_AUDIENCE: AUD,
      PORT: "8080",
    },
    "notify-api": {
      DATABASE_URL: "postgres://…/notify",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_AUDIENCE: AUD,
      NOTIFY_INTERNAL_TOKEN: TOKEN,
      PORT: "8080",
    },
    "refund-api": {
      DATABASE_URL: "postgres://…/refund",
      ALLOWED_ORIGINS: `${SHELL},${ADMIN}`,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      NOTIFY_INTERNAL_TOKEN: TOKEN,
      REFUND_APP_BASE_URL: SHELL,
      PORT: "8082",
    },
  };
}

const PROD = { env: "production", isProdLike: true };
const errs = (f: Finding[]) => f.filter((x) => x.level === "error");
const warns = (f: Finding[]) => f.filter((x) => x.level === "warn");
const errText = (f: Finding[]) => errs(f).map((x) => x.message).join(" | ");

describe("env-doctor checker", () => {
  test("a fully-correct production suite passes with no errors or warnings", () => {
    const f = checkSuite(validSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
    expect(hasErrors(f)).toBe(false);
  });

  test("AUTH_AUDIENCE drift across services → error", () => {
    const s = validSuite();
    s["refund-api"]!.AUTH_AUDIENCE = "different";
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("AUTH_AUDIENCE is not identical");
  });

  test("NOTIFY_INTERNAL_TOKEN drift → error", () => {
    const s = validSuite();
    s["notify-api"]!.NOTIFY_INTERNAL_TOKEN = "y".repeat(40);
    expect(errText(checkSuite(s, PROD))).toContain("NOTIFY_INTERNAL_TOKEN is not identical");
  });

  test("AUTH_ISSUER not equal to auth's BETTER_AUTH_URL → error", () => {
    const s = validSuite();
    s["refund-api"]!.AUTH_ISSUER = "https://wrong.example.com";
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_ISSUER");
  });

  test("AUTH_BASE_URL as a public https URL (should be internal) → error", () => {
    const s = validSuite();
    s["refund-api"]!.AUTH_BASE_URL = AUTH_URL; // public — a CALL must be internal
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_BASE_URL");
  });

  test("AUTH_BASE_URL = localhost in prod → error (the 503 bug)", () => {
    const s = validSuite();
    s["refund-api"]!.AUTH_BASE_URL = "http://localhost:3001";
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_BASE_URL");
  });

  test("AUTH_ISSUER pointed at internal DNS → error (the iss-claim trap)", () => {
    const s = validSuite();
    const internal = "http://auth.railway.internal:3001";
    s["estimai-api"]!.AUTH_ISSUER = internal;
    s["notify-api"]!.AUTH_ISSUER = internal;
    s["refund-api"]!.AUTH_ISSUER = internal;
    // Also update auth's BETTER_AUTH_URL to isolate the public-URL check from the issuer-equality check.
    s.auth!.BETTER_AUTH_URL = internal;
    const f = checkSuite(s, PROD);
    // AUTH_ISSUER + BETTER_AUTH_URL are public-url vars → flagged as non-public in prod.
    expect(errText(f)).toContain("AUTH_ISSUER");
    expect(errText(f)).toContain("BETTER_AUTH_URL");
  });

  test("ALLOWED_ORIGINS missing admin-ui on refund-api → error (the CORS bug)", () => {
    const s = validSuite();
    s["refund-api"]!.ALLOWED_ORIGINS = SHELL; // dropped admin-ui
    expect(errText(checkSuite(s, PROD))).toContain("missing admin-ui");
  });

  test("internal URL port != target service PORT → error (notify 8081 vs 8080)", () => {
    const s = validSuite();
    s["refund-api"]!.NOTIFY_INTERNAL_URL = "http://notify-api.railway.internal:8081"; // notify PORT is 8080
    expect(errText(checkSuite(s, PROD))).toContain("targets port 8081");
  });

  test("Railway ${{svc.PORT}} reference form is accepted (no port/shape error)", () => {
    const s = validSuite();
    s["refund-api"]!.AUTH_JWKS_URL = "http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks";
    s["refund-api"]!.AUTH_BASE_URL = "http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}";
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("a missing required key → error", () => {
    const s = validSuite();
    delete s["refund-api"]!.AUTH_BASE_URL;
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_BASE_URL is missing");
  });

  test("an unresolved op:// reference → warning (not error)", () => {
    const s = validSuite();
    // Assembled so the literal `op://…` doesn't appear in source (gitleaks' 1password-reference rule).
    s.auth!.NOTIFY_INTERNAL_TOKEN = "op:" + "//Operai-Prod/notify-token/password";
    const f = checkSuite(s, PROD);
    expect(warns(f).some((w) => w.message.includes("1Password reference"))).toBe(true);
  });

  test("local env relaxes the prod-only shape checks (localhost is fine)", () => {
    const s = validSuite();
    // A realistic local shape: everything on localhost, no railway.internal.
    s.auth!.BETTER_AUTH_URL = "http://localhost:3001";
    s.auth!.UI_HOME_URL = "http://localhost:5173/";
    s.auth!.ALLOWED_ORIGINS = "http://localhost:5173";
    s.auth!.NOTIFY_INTERNAL_URL = "http://localhost:8081";
    for (const svc of ["estimai-api", "notify-api", "refund-api"] as const) {
      s[svc]!.AUTH_ISSUER = "http://localhost:3001";
      s[svc]!.AUTH_JWKS_URL = "http://localhost:3001/auth/jwks";
      s[svc]!.ALLOWED_ORIGINS = "http://localhost:5173";
    }
    s["refund-api"]!.AUTH_BASE_URL = "http://localhost:3001";
    s["refund-api"]!.REFUND_APP_BASE_URL = "http://localhost:5173";
    // refund-api serves admin-ui's direct calls, so it must allow admin-ui's local origin too (5177).
    s["refund-api"]!.ALLOWED_ORIGINS = "http://localhost:5173,http://localhost:5177";
    // notify-api PORT stays 8080 but the local NOTIFY_INTERNAL_URL uses 8081 → keep them consistent for this test
    s.auth!.NOTIFY_INTERNAL_URL = "http://localhost:8080";
    s["refund-api"]!.NOTIFY_INTERNAL_URL = "http://localhost:8080";
    const f = checkSuite(s, { env: "local", isProdLike: false });
    expect(errs(f)).toEqual([]);
  });
});

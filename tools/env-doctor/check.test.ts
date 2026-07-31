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

  test("internal URL host != target's actual RAILWAY_PRIVATE_DOMAIN → error (the 2026-07-31 prod outage)", () => {
    const s = validSuite();
    // Railway pins the private domain at service CREATION; a later rename does
    // not move it. In production notify-api answers to `operai.railway.internal`
    // while both callers hardcoded `notify-api.railway.internal` — a hostname
    // that resolves to nothing, yet passes the `.railway.internal` suffix test.
    s["notify-api"]!.RAILWAY_PRIVATE_DOMAIN = "operai.railway.internal";
    s["refund-api"]!.NOTIFY_INTERNAL_URL = "http://notify-api.railway.internal:8080";
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain("notify-api.railway.internal");
    expect(text).toContain("operai.railway.internal");
  });

  test("internal URL host matching the target's real private domain → no error", () => {
    const s = validSuite();
    s["notify-api"]!.RAILWAY_PRIVATE_DOMAIN = "operai.railway.internal";
    s["refund-api"]!.NOTIFY_INTERNAL_URL = "http://operai.railway.internal:8080";
    s.auth!.NOTIFY_INTERNAL_URL = "http://operai.railway.internal:8080";
    expect(errs(checkSuite(s, PROD))).toEqual([]);
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

  test("a lingering secret reference in a supposedly-resolved suite → warning (not error)", () => {
    const s = validSuite();
    // Assembled so the literal `op://…` doesn't appear in source (gitleaks' 1password-reference rule).
    s.auth!.NOTIFY_INTERNAL_TOKEN = "op:" + "//Operai-Prod/notify-token/password";
    const f = checkSuite(s, PROD); // PROD ⇒ resolved defaults true
    expect(warns(f).some((w) => w.message.includes("unresolved secret reference"))).toBe(true);
    expect(errs(f)).toEqual([]);
  });

  test("offline template mode (resolved:false): a ${OP:…} secret is accepted, no warning", () => {
    const s = validSuite();
    s.auth!.NOTIFY_INTERNAL_TOKEN = "${OP:AIScream/OperAI - NOTIFY_INTERNAL_TOKEN/password}";
    s["notify-api"]!.NOTIFY_INTERNAL_TOKEN = "${OP:AIScream/OperAI - NOTIFY_INTERNAL_TOKEN/password}";
    s["refund-api"]!.NOTIFY_INTERNAL_TOKEN = "${OP:AIScream/OperAI - NOTIFY_INTERNAL_TOKEN/password}";
    const f = checkSuite(s, { env: "production", isProdLike: true, resolved: false });
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("shared vars as ${{shared.X}} refs across all services → no drift error (ref form is drift-proof)", () => {
    const s = validSuite();
    for (const svc of ["auth", "estimai-api", "notify-api", "refund-api"] as const) {
      s[svc]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    }
    for (const svc of ["auth", "notify-api", "refund-api"] as const) {
      s[svc]!.NOTIFY_INTERNAL_TOKEN = "${{shared.NOTIFY_INTERNAL_TOKEN}}";
    }
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("AUTH_ISSUER as a ${{shared.AUTH_ISSUER}} ref → issuer-consistency check defers (no false error)", () => {
    const s = validSuite();
    s["refund-api"]!.AUTH_ISSUER = "${{shared.AUTH_ISSUER}}"; // auth.BETTER_AUTH_URL stays a literal
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
  });

  test("a shared var mixing a literal and a ref → warning (can't verify offline), not a hard error", () => {
    const s = validSuite();
    s.auth!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}"; // ref …
    // estimai/notify/refund keep the literal AUD → mixed shapes
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f).some((w) => w.message.includes("mixes a literal and a reference"))).toBe(true);
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

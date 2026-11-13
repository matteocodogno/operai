import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkSuite, hasErrors, showValue, type Finding, type SuiteEnv } from "./check";
import {
  BACKENDS,
  LEGAL_ENTITY_NOTICE_EMAIL,
  LEGAL_ENTITY_RATE_VARS,
  LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX,
  ORIGINS,
  REQUIRED_KEYS,
  SECRET_VARS,
  SERVICES,
  isSecretVar,
  legalEntityConfigProblems,
} from "./manifest";
import { parseEnvFile } from "./parse";
// specs/029: the hours-api block at the end of this file pins the contract entries themselves too.
import { CORS_REQUIREMENTS, INTERNAL_URL_VARS, ISSUER, PRODUCTION_REQUIRED_KEYS, SERVICE_CLIENT_LINKS } from "./manifest";

const TOKEN = "x".repeat(40);
const AUD = "operai-suite";
const AUTH_URL = "https://auth.operai.welld.io";
const SHELL = "https://operai.welld.io";
const ADMIN = "https://admin.operai.welld.io";
const SVC_AUD = "operai-service";
// Synthetic, never a real credential: 40 chars, only used inside this test file.
const CLIENT_SECRET = "c".repeat(40);
const CLIENT_SECRET_EST = "e".repeat(40);
const CLIENT_SECRET_REF = "r".repeat(40);
/** The three-client registry after Manual A. Scopes of inventory-api are overridable (its tests predate the rest). */
const registry = (secret: string, scope = "notifications.push emails.send") =>
  JSON.stringify({
    "inventory-api": { secret, scope },
    "estimai-api": { secret: CLIENT_SECRET_EST, scope: "notifications.push estimate-notices.send" },
    "refund-api": { secret: CLIENT_SECRET_REF, scope: "notifications.push emails.send accounting.reference.read" },
  });

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
      SERVICE_AUDIENCE: SVC_AUD,
      SERVICE_CLIENTS: registry(CLIENT_SECRET),
      ALLOWED_SIGNUP_DOMAINS: "welld.ch,welld.it",
      PORT: "3001",
    },
    "estimai-api": {
      DATABASE_URL: "postgres://…/estimai",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_AUDIENCE: AUD,
      SERVICE_CLIENT_ID: "estimai-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_EST,
      CRM_INTERNAL_URL: "http://crm-api.railway.internal:8084",
      SERVICE_AUDIENCE: SVC_AUD,
      PORT: "8080",
    },
    "notify-api": {
      DATABASE_URL: "postgres://…/notify",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_AUDIENCE: AUD,
      SERVICE_AUDIENCE: SVC_AUD,
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
      REFUND_APP_BASE_URL: SHELL,
      SERVICE_CLIENT_ID: "refund-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_REF,
      ACCOUNTING_INTERNAL_URL: "http://accounting-api.railway.internal:8089", // specs/20261119-accounting, required
      PORT: "8082",
    },
    "inventory-api": {
      DATABASE_URL: "postgres://…/inventory",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "inventory-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET,
      INVENTORY_S3_ENDPOINT: "https://t3.storageapi.dev",
      INVENTORY_S3_REGION: "ams",
      INVENTORY_S3_EU_ENDPOINT_HOSTS: "t3.storageapi.dev",
      PORT: "8083",
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

  test("SERVICE_AUDIENCE drift between auth and notify-api → error", () => {
    const s = validSuite();
    s["notify-api"]!.SERVICE_AUDIENCE = "a-different-service-audience";
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
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
    s["inventory-api"]!.NOTIFY_INTERNAL_URL = "http://operai.railway.internal:8080";
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
    // Assembled so the literal `op://…` doesn't appear in source (the secret scanner's 1password-reference rule).
    s.auth!.BETTER_AUTH_SECRET = "op:" + "//Operai-Prod/auth-secret/password";
    const f = checkSuite(s, PROD); // PROD ⇒ resolved defaults true
    expect(warns(f).some((w) => w.message.includes("unresolved secret reference"))).toBe(true);
    expect(errs(f)).toEqual([]);
  });

  test("offline template mode (resolved:false): a ${OP:…} secret is accepted, no warning", () => {
    const s = validSuite();
    s.auth!.BETTER_AUTH_SECRET = "${OP:Employee/Paperclip - BETTER_AUTH_SECRET/password}";
    const f = checkSuite(s, { env: "production", isProdLike: true, resolved: false });
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("shared vars as ${{shared.X}} refs across all services → no drift error (ref form is drift-proof)", () => {
    const s = validSuite();
    for (const svc of ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api"] as const) {
      s[svc]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    }
    for (const svc of ["auth", "notify-api", "estimai-api"] as const) {
      s[svc]!.SERVICE_AUDIENCE = "${{shared.SERVICE_AUDIENCE}}";
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
    s["inventory-api"]!.AUTH_ISSUER = "http://localhost:3001";
    s["inventory-api"]!.AUTH_JWKS_URL = "http://localhost:3001/auth/jwks";
    s["inventory-api"]!.AUTH_BASE_URL = "http://localhost:3001";
    s["inventory-api"]!.ALLOWED_ORIGINS = "http://localhost:5173";
    s["inventory-api"]!.NOTIFY_INTERNAL_URL = "http://localhost:8080";
    s["refund-api"]!.REFUND_APP_BASE_URL = "http://localhost:5173";
    // refund-api serves admin-ui's direct calls, so it must allow admin-ui's local origin too (5177).
    s["refund-api"]!.ALLOWED_ORIGINS = "http://localhost:5173,http://localhost:5177";
    // notify-api PORT stays 8080 but the local NOTIFY_INTERNAL_URL uses 8081 → keep them consistent for this test
    s.auth!.NOTIFY_INTERNAL_URL = "http://localhost:8080";
    s["refund-api"]!.NOTIFY_INTERNAL_URL = "http://localhost:8080";
    const f = checkSuite(s, { env: "local", isProdLike: false });
    expect(errs(f)).toEqual([]);
  });

  // ── specs/20261006-hardware-inventory (T43): service tokens, inventory-api ──────
  test("SERVICE_AUDIENCE differing between auth and notify-api → error", () => {
    const s = validSuite();
    s["notify-api"]!.SERVICE_AUDIENCE = "another-audience";
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
  });

  test("SERVICE_AUDIENCE equal to AUTH_AUDIENCE on the same service → error (auth and notify-api both exit at startup)", () => {
    for (const svc of ["auth", "notify-api"] as const) {
      const s = validSuite();
      s[svc]!.SERVICE_AUDIENCE = AUD;
      s[svc === "auth" ? "notify-api" : "auth"]!.SERVICE_AUDIENCE = AUD; // keep the shared check quiet
      expect(errText(checkSuite(s, PROD))).toContain(`${svc}.SERVICE_AUDIENCE must differ from ${svc}.AUTH_AUDIENCE`);
    }
  });

  test("SERVICE_AUDIENCE written as the same reference as AUTH_AUDIENCE → error (same shared var = same value)", () => {
    const s = validSuite();
    s.auth!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    s.auth!.SERVICE_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    expect(errText(checkSuite(s, PROD))).toContain("auth.SERVICE_AUDIENCE must differ");
  });

  test("SERVICE_AUDIENCE and AUTH_AUDIENCE as two different shared references → no error (cannot be compared offline)", () => {
    const s = validSuite();
    for (const svc of ["auth", "notify-api", "estimai-api"] as const) {
      s[svc]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
      s[svc]!.SERVICE_AUDIENCE = "${{shared.SERVICE_AUDIENCE}}";
    }
    s["estimai-api"]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    s["refund-api"]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    s["inventory-api"]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("a missing ALLOWED_SIGNUP_DOMAINS on auth is an error (auth exits at startup, specs/20261105-signup-gate)", () => {
    const s = validSuite();
    delete s.auth!.ALLOWED_SIGNUP_DOMAINS;
    expect(errText(checkSuite(s, PROD))).toContain("ALLOWED_SIGNUP_DOMAINS is missing");
  });

  test("a reserved test domain in auth's ALLOWED_SIGNUP_DOMAINS is an error in production (specs/20261105-signup-gate)", () => {
    for (const bad of ["welld.ch,welld.it,operai.test", "welld.ch,mail.example", "x.invalid", "a.localhost"]) {
      const s = validSuite();
      s.auth!.ALLOWED_SIGNUP_DOMAINS = bad;
      const text = errText(checkSuite(s, PROD));
      expect(text).toContain("ALLOWED_SIGNUP_DOMAINS");
      expect(text).toContain("reserved test domain");
    }
  });

  test("a reserved test domain is fine outside production-like environments", () => {
    const s = validSuite();
    s.auth!.ALLOWED_SIGNUP_DOMAINS = "welld.ch,welld.it,operai.test";
    const f = checkSuite(s, { env: "local", isProdLike: false });
    expect(errText(f)).not.toContain("reserved test domain");
  });

  test("a missing SERVICE_AUDIENCE / SERVICE_CLIENTS is an error (the push would silently 401)", () => {
    const s = validSuite();
    delete s["notify-api"]!.SERVICE_AUDIENCE;
    delete s.auth!.SERVICE_CLIENTS;
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain("SERVICE_AUDIENCE is missing");
    expect(text).toContain("SERVICE_CLIENTS is missing");
  });

  test("inventory-api AUTH_AUDIENCE drift → error", () => {
    const s = validSuite();
    s["inventory-api"]!.AUTH_AUDIENCE = "different";
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_AUDIENCE is not identical");
  });

  test("inventory-api calls auth over a public URL → error; its AUTH_ISSUER must be auth's", () => {
    const s = validSuite();
    s["inventory-api"]!.AUTH_BASE_URL = AUTH_URL;
    s["inventory-api"]!.AUTH_ISSUER = "https://wrong.example.com";
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain("AUTH_BASE_URL");
    expect(text).toContain("inventory-api.AUTH_ISSUER");
  });

  test("inventory-api ALLOWED_ORIGINS without the shell origin → error", () => {
    const s = validSuite();
    s["inventory-api"]!.ALLOWED_ORIGINS = ADMIN;
    expect(errText(checkSuite(s, PROD))).toContain("inventory-api.ALLOWED_ORIGINS is missing shell");
  });

  test("inventory-api NOTIFY_INTERNAL_URL on the wrong port → error", () => {
    const s = validSuite();
    s["inventory-api"]!.NOTIFY_INTERNAL_URL = "http://notify-api.railway.internal:8081";
    expect(errText(checkSuite(s, PROD))).toContain("targets port 8081");
  });

  // specs/20261013-notify-service-credentials AC-5.3: the retired shared token is forbidden on every service, flagged by name only.
  for (const svc of ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api"] as const) {
    test(`${svc} holding the retired shared token → error, value never printed`, () => {
      const s = validSuite();
      s[svc]!.NOTIFY_INTERNAL_TOKEN = TOKEN;
      const f = checkSuite(s, PROD);
      expect(errText(f)).toContain(`${svc} must not hold NOTIFY_INTERNAL_TOKEN`);
      expect(JSON.stringify(f)).not.toContain(TOKEN);
      expect(errs(f).filter((x) => x.message.includes("NOTIFY_INTERNAL_TOKEN")).map((x) => x.scope)).toEqual([svc]);
    });
  }

  test("the retired shared token is flagged even when its value is empty or a reference", () => {
    for (const value of ["", "${{shared.NOTIFY_INTERNAL_TOKEN}}", "${OP:AIScream/anything/password}"]) {
      const s = validSuite();
      s.auth!.NOTIFY_INTERNAL_TOKEN = value;
      expect(errText(checkSuite(s, PROD))).toContain("auth must not hold NOTIFY_INTERNAL_TOKEN");
    }
  });

  test("a suite without the retired shared token has no finding about it, and does not require it", () => {
    const f = checkSuite(validSuite(), PROD);
    expect(f.some((x) => x.message.includes("NOTIFY_INTERNAL_TOKEN"))).toBe(false);
  });

  // specs/20261111-push-notifications US-7 (ADR 20261112-system-endpoints-limited-per-verified-service): the address-keyed pair is retired on auth; an override sized for the old
  // rule (20, or the runbook's 60) would be ignored, so the leftover is flagged by name only.
  for (const name of ["SERVICE_TOKEN_RATE_LIMIT", "SERVICE_TOKEN_RATE_WINDOW_MS"]) {
    test(`auth holding the retired ${name} → error naming it, value never printed; other services are not flagged`, () => {
      const s = validSuite();
      s.auth![name] = "4242";
      const f = checkSuite(s, PROD);
      expect(errText(f)).toContain(`auth must not hold ${name}`);
      expect(JSON.stringify(f)).not.toContain("4242");
      expect(errs(f).filter((x) => x.message.includes(name)).map((x) => x.scope)).toEqual(["auth"]);
      const other = validSuite();
      other["refund-api"]![name] = "4242";
      expect(errText(checkSuite(other, PROD))).not.toContain(name);
    });
  }

  test("auth without the retired rate variables has no finding about them", () => {
    expect(checkSuite(validSuite(), PROD).some((x) => x.message.includes("SERVICE_TOKEN_RATE"))).toBe(false);
  });

  test("service client: id not registered in auth's SERVICE_CLIENTS → error", () => {
    const s = validSuite();
    s["inventory-api"]!.SERVICE_CLIENT_ID = "inventory-api-2";
    expect(errText(checkSuite(s, PROD))).toContain('has no entry for client id "inventory-api-2"');
  });

  test("service client: secret differs from the registered one → error, and no secret value is printed", () => {
    const s = validSuite();
    const other = "d".repeat(40);
    s["inventory-api"]!.SERVICE_CLIENT_SECRET = other;
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("does not match the secret");
    const all = JSON.stringify(f);
    expect(all).not.toContain(other);
    expect(all).not.toContain(CLIENT_SECRET);
  });

  test("service client: secret shorter than 32 chars → error without the value", () => {
    const s = validSuite();
    s["inventory-api"]!.SERVICE_CLIENT_SECRET = "short";
    s.auth!.SERVICE_CLIENTS = registry("short");
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("shorter than 32 characters (length 5)");
    expect(JSON.stringify(f)).not.toContain('"short"');
  });

  test("service client: registry entry without the notifications.push scope → error", () => {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = registry(CLIENT_SECRET, "something.else");
    expect(errText(checkSuite(s, PROD))).toContain('lacks the "notifications.push" scope');
  });

  test("service client: an extra scope on a client → error (estimai-api must not send email)", () => {
    const s = validSuite();
    const reg = JSON.parse(s.auth!.SERVICE_CLIENTS!);
    reg["estimai-api"].scope = "notifications.push emails.send";
    s.auth!.SERVICE_CLIENTS = JSON.stringify(reg);
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain('entry "estimai-api" holds the "emails.send" scope, which estimai-api does not need');
    expect(JSON.stringify(checkSuite(s, PROD))).not.toContain(CLIENT_SECRET_EST);
  });

  test("service client: refund-api missing emails.send → error naming the scope", () => {
    const s = validSuite();
    const reg = JSON.parse(s.auth!.SERVICE_CLIENTS!);
    reg["refund-api"].scope = "notifications.push";
    s.auth!.SERVICE_CLIENTS = JSON.stringify(reg);
    expect(errText(checkSuite(s, PROD))).toContain('entry "refund-api" lacks the "emails.send" scope');
  });

  test("service client: refund-api / estimai-api id or secret mismatch → error", () => {
    const s = validSuite();
    s["refund-api"]!.SERVICE_CLIENT_ID = "refund";
    s["estimai-api"]!.SERVICE_CLIENT_SECRET = "z".repeat(40);
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain('has no entry for client id "refund"');
    expect(text).toContain("estimai-api.SERVICE_CLIENT_SECRET does not match the secret");
  });

  test("service client: a scope-less entry is flagged for every required scope", () => {
    const s = validSuite();
    const reg = JSON.parse(s.auth!.SERVICE_CLIENTS!);
    delete reg["refund-api"].scope;
    s.auth!.SERVICE_CLIENTS = JSON.stringify(reg);
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain('lacks the "notifications.push" scope');
    expect(text).toContain('lacks the "emails.send" scope');
  });

  test("service client: refund-api / estimai-api must set their client id and secret", () => {
    const s = validSuite();
    delete s["refund-api"]!.SERVICE_CLIENT_SECRET;
    delete s["estimai-api"]!.SERVICE_CLIENT_ID;
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain("SERVICE_CLIENT_SECRET is missing");
    expect(text).toContain("SERVICE_CLIENT_ID is missing");
  });

  test("service client: malformed SERVICE_CLIENTS JSON → error", () => {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = "{not json";
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_CLIENTS is not valid JSON");
  });

  test("service client: the same shared reference inside the JSON and on inventory-api → ok (drift-proof)", () => {
    const s = validSuite();
    const ref = "${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}";
    s.auth!.SERVICE_CLIENTS = registry(ref);
    s["inventory-api"]!.SERVICE_CLIENT_SECRET = ref;
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("service client: a reference on one side and a different value on the other → warning, not error", () => {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = registry("${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}");
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f).some((w) => w.message.includes("can't verify they match offline"))).toBe(true);
  });

  test("service client: a whole-value reference for SERVICE_CLIENTS defers the match check", () => {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = "${OP:Vault/Item/field}";
    expect(errs(checkSuite(s, { ...PROD, resolved: false }))).toEqual([]);
  });

  test("S3 residency: a non-AWS endpoint outside the EU host list → error; empty list → error", () => {
    const s = validSuite();
    s["inventory-api"]!.INVENTORY_S3_ENDPOINT = "https://objects.example.com";
    expect(errText(checkSuite(s, PROD))).toContain("matches no entry of INVENTORY_S3_EU_ENDPOINT_HOSTS");
    s["inventory-api"]!.INVENTORY_S3_EU_ENDPOINT_HOSTS = "";
    expect(errText(checkSuite(s, PROD))).toContain("INVENTORY_S3_EU_ENDPOINT_HOSTS is empty");
  });

  test("S3 residency: an AWS endpoint in a non-EU region → error; in an EU region → ok", () => {
    const s = validSuite();
    s["inventory-api"]!.INVENTORY_S3_ENDPOINT = "https://s3.us-east-1.amazonaws.com";
    s["inventory-api"]!.INVENTORY_S3_REGION = "us-east-1";
    expect(errText(checkSuite(s, PROD))).toContain("not an EU AWS region");
    s["inventory-api"]!.INVENTORY_S3_ENDPOINT = "https://s3.eu-central-1.amazonaws.com";
    s["inventory-api"]!.INVENTORY_S3_REGION = "eu-central-1";
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("the SERVICE_CLIENT / S3 credential vars are redacted when surfaced", () => {
    const f = showValue("SERVICE_CLIENT_SECRET", CLIENT_SECRET);
    expect(f).toStartWith("<redacted sha256:");
    expect(showValue("SERVICE_CLIENTS", registry(CLIENT_SECRET))).toStartWith("<redacted");
    expect(showValue("INVENTORY_S3_SECRET_ACCESS_KEY", "x")).toStartWith("<redacted");
    expect(showValue("INVENTORY_S3_ACCESS_KEY_ID", "x")).toStartWith("<redacted");
  });
});

// specs/20261104-meetings, T81 — meetings-api joins the contract: a resource server, a notify caller, a
// crm-api host-notice caller (crm-api now verifies service tokens), and an audio-bucket owner.
describe("env-doctor checker — meetings (specs/20261104-meetings)", () => {
  const CLIENT_SECRET_MEET = "m".repeat(40);
  // A synthetic stand-in for the base64 service-account key; the tests assert it is never printed.
  const GCP_KEY = "eyJzeW50aGV0aWMta2V5LW5ldmVyLXByaW50ZWQi" + "Z".repeat(24);
  const meetingsRegistry = (scope = "notifications.push host-notices.send", secret = CLIENT_SECRET_MEET) =>
    JSON.stringify({
      "inventory-api": { secret: CLIENT_SECRET, scope: "notifications.push emails.send" },
      "estimai-api": { secret: CLIENT_SECRET_EST, scope: "notifications.push estimate-notices.send" },
      "refund-api": { secret: CLIENT_SECRET_REF, scope: "notifications.push emails.send accounting.reference.read" },
      // crm-api holds a client of its own since specs/20261103-projects-handoff (it reads projects-api), required in production.
      "crm-api": { secret: "k".repeat(40), scope: "notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read letterhead:render legal-entities:read" },
      "meetings-api": { secret, scope },
    });

  /** validSuite + crm-api (now a service-token verifier) + meetings-api, with the matching registry. */
  function meetingsSuite(): SuiteEnv {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = meetingsRegistry();
    s["crm-api"] = {
      DATABASE_URL: "postgres://…/crm",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      SERVICE_AUDIENCE: SVC_AUD,
      ACTIVITIES_API_URL: "http://activities-api.railway.internal:8087", // specs/20261110-activities, production-required
      LETTERHEAD_API_URL: "http://letterhead-api.railway.internal:8088", // specs/20261116-letterhead-service (T44), production-required
      LETTERHEAD_SERVICE_ENABLED: "false", // the switch, production-required
      PROJECTS_INTERNAL_URL: "http://projects-api.railway.internal:8086",
      SERVICE_CLIENT_ID: "crm-api",
      SERVICE_CLIENT_SECRET: "k".repeat(40),
      PORT: "8084",
    };
    s["meetings-api"] = {
      DATABASE_URL: "postgres://…/meetings",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      CRM_API_URL: "http://crm-api.railway.internal:8084",
      SERVICE_CLIENT_ID: "meetings-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_MEET,
      SERVICE_AUDIENCE: SVC_AUD, // specs/029: /system/meetings/hosts, production-required
      MEETINGS_S3_ENDPOINT: "https://t3.storageapi.dev",
      MEETINGS_S3_REGION: "ams",
      MEETINGS_S3_EU_ENDPOINT_HOSTS: "t3.storageapi.dev",
      MEETINGS_SPEECH_LOCATION: "eu",
      MEETINGS_VERTEX_LOCATION: "eu",
      MEETINGS_VERTEX_MODEL_ID: "claude-synthetic-model",
      MEETINGS_GCP_PROJECT_ID: "synthetic-project",
      MEETINGS_GCP_SERVICE_ACCOUNT_KEY: GCP_KEY,
      MEETINGS_GCS_TRANSIENT_BUCKET: "synthetic-transient-bucket",
      MEETINGS_AI_PROVIDER: "real",
      PORT: "8085",
    };
    return s;
  }

  test("a fully-correct suite including meetings-api and crm-api passes with no errors or warnings", () => {
    const f = checkSuite(meetingsSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  describe("MEETINGS_VERTEX_MODEL_ID is a bare Claude model id", () => {
    const withModel = (v: string) => {
      const s = meetingsSuite();
      s["meetings-api"]!.MEETINGS_VERTEX_MODEL_ID = v;
      return s;
    };
    test("a resource path (contains /) → error naming the variable, value never printed", () => {
      const f = checkSuite(withModel("publishers/anthropic/models/claude-leaky-0"), PROD);
      expect(errText(f)).toContain("MEETINGS_VERTEX_MODEL_ID must be a bare model id");
      expect(JSON.stringify(f)).not.toContain("leaky");
      expect(JSON.stringify(f)).not.toContain("anthropic/models");
    });
    test("not a claude- id, or odd characters → error, value not printed", () => {
      for (const v of ["gemini-secretname", "Claude-3", "claude-x y", " claude-x"]) {
        const f = checkSuite(withModel(v), PROD);
        expect(errText(f)).toContain("MEETINGS_VERTEX_MODEL_ID must be a Claude model id");
        expect(JSON.stringify(f)).not.toContain("secretname");
      }
    });
    test("fable / mythos models → error, value not printed", () => {
      for (const v of ["claude-fable-1", "claude-mythos-2"]) {
        const f = checkSuite(withModel(v), PROD);
        expect(errText(f)).toContain("MEETINGS_VERTEX_MODEL_ID names a model Google retains");
        expect(JSON.stringify(f).toLowerCase()).not.toContain("mythos-2");
      }
    });
    test("a versioned id with @ and . passes", () => {
      expect(errs(checkSuite(withModel("claude-sonnet-4-5@20250929"), PROD))).toEqual([]);
    });
    test("a SET-ME placeholder: silent offline (template), a warning once values should be real", () => {
      const s = withModel("SET-ME-pinned-model-id");
      expect(checkSuite(s, { ...PROD, resolved: false })).toEqual([]);
      const f = checkSuite(s, { ...PROD, resolved: true });
      expect(errs(f)).toEqual([]);
      expect(warns(f).map((w) => w.message).join("\n")).toContain("MEETINGS_VERTEX_MODEL_ID is still a SET-ME placeholder");
    });
    test("a Railway reference is not judged", () => {
      expect(checkSuite(withModel("${{shared.MODEL}}"), PROD)).toEqual([]);
    });
  });

  test("a missing MEETINGS_S3_REGION → error naming it", () => {
    const s = meetingsSuite();
    delete s["meetings-api"]!.MEETINGS_S3_REGION;
    expect(errText(checkSuite(s, PROD))).toContain("MEETINGS_S3_REGION is missing");
  });

  test("each required storage, provider and link variable is required", () => {
    for (const key of [
      "MEETINGS_S3_ENDPOINT", "MEETINGS_S3_EU_ENDPOINT_HOSTS",
      "MEETINGS_SPEECH_LOCATION", "MEETINGS_VERTEX_LOCATION", "MEETINGS_VERTEX_MODEL_ID",
      "MEETINGS_GCP_PROJECT_ID", "MEETINGS_GCP_SERVICE_ACCOUNT_KEY", "MEETINGS_GCS_TRANSIENT_BUCKET",
      "MEETINGS_AI_PROVIDER", "CRM_API_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET",
    ]) {
      const s = meetingsSuite();
      delete s["meetings-api"]![key];
      expect(errText(checkSuite(s, PROD))).toContain(`${key} is missing`);
    }
  });

  test("meetings-api's client without the host-notices.send scope → error naming the scope", () => {
    const s = meetingsSuite();
    s.auth!.SERVICE_CLIENTS = meetingsRegistry("notifications.push");
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain('entry "meetings-api" lacks the "host-notices.send" scope');
    expect(text).not.toContain('lacks the "notifications.push" scope');
  });

  test("meetings-api's client without notifications.push → error; an extra emails.send → error (least privilege)", () => {
    const s = meetingsSuite();
    s.auth!.SERVICE_CLIENTS = meetingsRegistry("host-notices.send");
    expect(errText(checkSuite(s, PROD))).toContain('entry "meetings-api" lacks the "notifications.push" scope');
    s.auth!.SERVICE_CLIENTS = meetingsRegistry("notifications.push host-notices.send emails.send");
    expect(errText(checkSuite(s, PROD))).toContain('holds the "emails.send" scope, which meetings-api does not need');
  });

  test("meetings-api's client id missing from auth's registry, or a different secret → error, no secret printed", () => {
    const s = meetingsSuite();
    s["meetings-api"]!.SERVICE_CLIENT_ID = "meetings-api-2";
    expect(errText(checkSuite(s, PROD))).toContain('has no entry for client id "meetings-api-2"');
    const t = meetingsSuite();
    t.auth!.SERVICE_CLIENTS = meetingsRegistry(undefined, "z".repeat(40));
    const f = checkSuite(t, PROD);
    expect(errText(f)).toContain("meetings-api.SERVICE_CLIENT_SECRET does not match");
    expect(JSON.stringify(f)).not.toContain(CLIENT_SECRET_MEET);
  });

  test("crm-api without SERVICE_AUDIENCE → error (every host notice would be a silent 401)", () => {
    const s = meetingsSuite();
    delete s["crm-api"]!.SERVICE_AUDIENCE;
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("SERVICE_AUDIENCE is missing");
    expect(errs(f).some((x) => x.scope === "crm-api" && x.message.includes("SERVICE_AUDIENCE is missing"))).toBe(true);
  });

  test("crm-api's SERVICE_AUDIENCE drifting from auth's → error; equal to its AUTH_AUDIENCE → error", () => {
    const s = meetingsSuite();
    s["crm-api"]!.SERVICE_AUDIENCE = "operai-service-2";
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
    const t = meetingsSuite();
    t["crm-api"]!.SERVICE_AUDIENCE = AUD;
    expect(errText(checkSuite(t, PROD))).toContain("crm-api.SERVICE_AUDIENCE must differ from crm-api.AUTH_AUDIENCE");
  });

  test("meetings-api: AUTH_AUDIENCE drift, wrong issuer, and a missing shell origin are errors", () => {
    const s = meetingsSuite();
    s["meetings-api"]!.AUTH_AUDIENCE = "other";
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_AUDIENCE is not identical");
    const t = meetingsSuite();
    t["meetings-api"]!.AUTH_ISSUER = "https://evil.example.com";
    expect(errText(checkSuite(t, PROD))).toContain("meetings-api.AUTH_ISSUER");
    const u = meetingsSuite();
    u["meetings-api"]!.ALLOWED_ORIGINS = "https://admin.operai.welld.io";
    expect(errText(checkSuite(u, PROD))).toContain("meetings-api.ALLOWED_ORIGINS is missing shell's origin");
  });

  test("meetings-api's CRM_API_URL must be internal and on crm-api's port", () => {
    const s = meetingsSuite();
    s["meetings-api"]!.CRM_API_URL = "https://crm-api.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("CRM_API_URL");
    const t = meetingsSuite();
    t["meetings-api"]!.CRM_API_URL = "http://crm-api.railway.internal:8085";
    expect(errText(checkSuite(t, PROD))).toContain("targets port 8085");
    const u = meetingsSuite();
    u["meetings-api"]!.CRM_API_URL = "http://${{crm-api.RAILWAY_PRIVATE_DOMAIN}}:${{crm-api.PORT}}";
    expect(errs(checkSuite(u, PROD)).filter((x) => x.message.includes("CRM_API_URL"))).toEqual([]);
  });

  test("meetings-api holding the retired shared token → error, value never printed", () => {
    const s = meetingsSuite();
    s["meetings-api"]!.NOTIFY_INTERNAL_TOKEN = TOKEN;
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("meetings-api must not hold NOTIFY_INTERNAL_TOKEN");
    expect(JSON.stringify(f)).not.toContain(TOKEN);
  });

  // specs/20261104-meetings plan § Amendment 2026-11-05 (G-7, T105): the provider change to Google Cloud.
  test("a missing MEETINGS_GCP_SERVICE_ACCOUNT_KEY is reported by name, and no value is printed", () => {
    const s = meetingsSuite();
    delete s["meetings-api"]!.MEETINGS_GCP_SERVICE_ACCOUNT_KEY;
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("MEETINGS_GCP_SERVICE_ACCOUNT_KEY is missing");
    expect(errs(f).some((x) => x.scope === "meetings-api")).toBe(true);
    expect(JSON.stringify(f)).not.toContain(GCP_KEY);
  });

  test("the service-account key is a secret: redacted when it appears in a finding, never shown", () => {
    expect(isSecretVar("MEETINGS_GCP_SERVICE_ACCOUNT_KEY")).toBe(true);
    expect(SECRET_VARS.has("MEETINGS_GCP_SERVICE_ACCOUNT_KEY")).toBe(true);
    const shown = showValue("MEETINGS_GCP_SERVICE_ACCOUNT_KEY", GCP_KEY);
    expect(shown).not.toContain(GCP_KEY);
    expect(shown).not.toContain("Z".repeat(10));
    // the non-secret companions stay readable, so drift is still diagnosable
    expect(showValue("MEETINGS_VERTEX_LOCATION", "eu")).toContain("eu");
  });

  test("the key never reaches any finding, even when other things are wrong", () => {
    const s = meetingsSuite();
    delete s["meetings-api"]!.MEETINGS_GCS_TRANSIENT_BUCKET;
    s["meetings-api"]!.AZURE_SPEECH_KEY = GCP_KEY; // a secret value in a retired name: still flagged by name only
    expect(JSON.stringify(checkSuite(s, PROD))).not.toContain(GCP_KEY);
  });

  // The seven names the provider change removed are flagged as retired, by name, never by value.
  for (const name of [
    "AZURE_SPEECH_REGION", "AZURE_SPEECH_KEY", "AZURE_SPEECH_ENDPOINT",
    "BEDROCK_REGION", "BEDROCK_MODEL_ID", "MEETINGS_AWS_ACCESS_KEY_ID", "MEETINGS_AWS_SECRET_ACCESS_KEY",
  ]) {
    test(`meetings-api holding the retired ${name} → error naming it as retired, value never printed`, () => {
      const s = meetingsSuite();
      s["meetings-api"]![name] = "retired-secret-value-0123456789";
      const f = checkSuite(s, PROD);
      expect(errText(f)).toContain(`meetings-api must not hold ${name} — retired by the provider change to Google Cloud`);
      expect(JSON.stringify(f)).not.toContain("retired-secret-value-0123456789");
      expect(errs(f).filter((x) => x.message.includes(name)).map((x) => x.scope)).toEqual(["meetings-api"]);
    });
  }

  test("a retired name is flagged even when empty or a reference; another service is not affected", () => {
    for (const value of ["", "${{shared.AZURE_SPEECH_KEY}}", "${OP:AIScream/anything/credential}"]) {
      const s = meetingsSuite();
      s["meetings-api"]!.AZURE_SPEECH_KEY = value;
      expect(errText(checkSuite(s, PROD))).toContain("meetings-api must not hold AZURE_SPEECH_KEY");
    }
    const t = meetingsSuite();
    t["crm-api"]!.BEDROCK_REGION = "eu-central-2"; // not a meetings-api variable on crm-api: out of this rule
    expect(errText(checkSuite(t, PROD))).not.toContain("must not hold BEDROCK_REGION");
  });

  test("a suite without the retired names has no finding about them, and does not require them", () => {
    const f = checkSuite(meetingsSuite(), PROD);
    expect(f.some((x) => /AZURE_|BEDROCK_|MEETINGS_AWS_/.test(x.message))).toBe(false);
  });

  test("audio bucket residency: a non-AWS host outside the EU list, an empty list, a non-EU AWS region → error", () => {
    const s = meetingsSuite();
    s["meetings-api"]!.MEETINGS_S3_ENDPOINT = "https://objects.example.com";
    expect(errText(checkSuite(s, PROD))).toContain("matches no entry of MEETINGS_S3_EU_ENDPOINT_HOSTS");
    s["meetings-api"]!.MEETINGS_S3_EU_ENDPOINT_HOSTS = "";
    expect(errText(checkSuite(s, PROD))).toContain("MEETINGS_S3_EU_ENDPOINT_HOSTS is empty");
    const t = meetingsSuite();
    t["meetings-api"]!.MEETINGS_S3_ENDPOINT = "https://s3.us-east-1.amazonaws.com";
    t["meetings-api"]!.MEETINGS_S3_REGION = "us-east-1";
    expect(errText(checkSuite(t, PROD))).toContain('MEETINGS_S3_REGION "us-east-1" is not an EU AWS region');
  });

  test("provider and bucket credentials are redacted when surfaced", () => {
    for (const name of [
      "AZURE_SPEECH_KEY", "MEETINGS_AWS_ACCESS_KEY_ID", "MEETINGS_AWS_SECRET_ACCESS_KEY",
      "MEETINGS_S3_ACCESS_KEY_ID", "MEETINGS_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(showValue(name, "v")).toStartWith("<redacted sha256:");
    }
  });

  test("meetings-ui is a known frontend with a production and a local origin", () => {
    expect(SERVICES["meetings-ui"]).toEqual({ platform: "vercel", kind: "frontend" });
    expect(ORIGINS.production!["meetings-ui"]).toBe("https://meetings.operai.welld.io");
    expect(ORIGINS.local!["meetings-ui"]).toBe("http://localhost:5180");
    expect(BACKENDS).toContain("meetings-api");
    expect(BACKENDS).not.toContain("meetings-ui");
  });
});

// The suite with crm-api and projects-api added, in its current (specs/20261103-projects-handoff) shape: both hold a service
// client, projects-api reads crm-api and estimai-api and notifies through notify-api, crm-api reads
// projects-api, and all of auth, notify-api, estimai-api, crm-api and projects-api share one SERVICE_AUDIENCE. Used by the specs/20261103-projects
// and specs/20261103-projects-handoff blocks below.
const CLIENT_SECRET_PROJECTS = "p".repeat(40);
const CLIENT_SECRET_CRM = "m".repeat(40);
const PROJECTS_SCOPES = "crm.companies.read crm.deals.read crm.contacts.read estimai.estimates.read notifications.push";
const CRM_SCOPES = "notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read letterhead:render legal-entities:read";
const projectsRegistry = (scope = PROJECTS_SCOPES, crmScope = CRM_SCOPES) =>
  JSON.stringify({
    ...JSON.parse(registry(CLIENT_SECRET)),
    "crm-api": { secret: CLIENT_SECRET_CRM, scope: crmScope },
    "projects-api": { secret: CLIENT_SECRET_PROJECTS, scope },
  });

function projectsSuite(): SuiteEnv {
  const s = validSuite();
  s.auth!.SERVICE_CLIENTS = projectsRegistry();
  s["crm-api"] = {
    DATABASE_URL: "postgres://…/crm",
    ALLOWED_ORIGINS: SHELL,
    AUTH_ISSUER: AUTH_URL,
    AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
    AUTH_BASE_URL: "http://auth.railway.internal:3001",
    AUTH_AUDIENCE: AUD,
    SERVICE_AUDIENCE: SVC_AUD,
    PROJECTS_INTERNAL_URL: "http://projects-api.railway.internal:8086",
    ACTIVITIES_API_URL: "http://activities-api.railway.internal:8087", // specs/20261110-activities, production-required
    LETTERHEAD_API_URL: "http://letterhead-api.railway.internal:8088", // specs/20261116-letterhead-service (T44), production-required
    LETTERHEAD_SERVICE_ENABLED: "false", // the switch, production-required
    SERVICE_CLIENT_ID: "crm-api",
    SERVICE_CLIENT_SECRET: CLIENT_SECRET_CRM,
    PORT: "8084",
  };
  s["projects-api"] = {
    DATABASE_URL: "postgres://…/projects",
    ALLOWED_ORIGINS: SHELL,
    AUTH_ISSUER: AUTH_URL,
    AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
    AUTH_BASE_URL: "http://auth.railway.internal:3001",
    AUTH_AUDIENCE: AUD,
    SERVICE_AUDIENCE: SVC_AUD,
    CRM_INTERNAL_URL: "http://crm-api.railway.internal:8084",
    ESTIMAI_INTERNAL_URL: "http://estimai-api.railway.internal:8080",
    NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
    SERVICE_CLIENT_ID: "projects-api",
    SERVICE_CLIENT_SECRET: CLIENT_SECRET_PROJECTS,
    PORT: "8086",
  };
  return s;
}
const LOCAL = { env: "local", isProdLike: false };

// specs/20261103-projects: projects-api (a new resource server) reads CRM companies from crm-api with a scoped
// service credential; crm-api gains SERVICE_AUDIENCE. The baseline is the suite above plus the two services.
describe("env-doctor checker — projects-api and the crm-api service audience (specs/20261103-projects)", () => {
  test("a fully-correct suite with projects-api and crm-api passes with no errors or warnings", () => {
    const f = checkSuite(projectsSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("the CRM service-credential group is required in production, not locally", () => {
    for (const key of ["CRM_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"]) {
      const s = projectsSuite();
      delete s["projects-api"]![key];
      expect(errText(checkSuite(s, PROD))).toContain(`${key} is missing`);
      // local: the same setup is not flagged for the missing optional group
      expect(errText(checkSuite(s, LOCAL))).not.toContain(`${key} is missing`);
    }
  });

  test("crm-api SERVICE_AUDIENCE is required in production and locally (ADR 20261105-estimai-closes-the-estimate-crm-follows; /system/companies relies on it too)", () => {
    const s = projectsSuite();
    delete s["crm-api"]!.SERVICE_AUDIENCE;
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is missing");
    expect(errText(checkSuite(s, LOCAL))).toContain("SERVICE_AUDIENCE is missing");
  });

  test("crm-api SERVICE_AUDIENCE equal to its AUTH_AUDIENCE → error", () => {
    const s = projectsSuite();
    s["crm-api"]!.SERVICE_AUDIENCE = AUD;
    expect(errText(checkSuite(s, PROD))).toContain("crm-api.SERVICE_AUDIENCE must differ from crm-api.AUTH_AUDIENCE");
  });

  test("SERVICE_AUDIENCE drift between auth and crm-api → error", () => {
    const s = projectsSuite();
    s["crm-api"]!.SERVICE_AUDIENCE = "a-different-service-audience";
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
  });

  test("projects-api AUTH_AUDIENCE drift → error", () => {
    const s = projectsSuite();
    s["projects-api"]!.AUTH_AUDIENCE = "different";
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_AUDIENCE is not identical");
  });

  test("projects-api AUTH_ISSUER not equal to auth's BETTER_AUTH_URL → error", () => {
    const s = projectsSuite();
    s["projects-api"]!.AUTH_ISSUER = "https://wrong.example.com";
    expect(errText(checkSuite(s, PROD))).toContain("projects-api.AUTH_ISSUER");
  });

  test("projects-api ALLOWED_ORIGINS without the shell origin → error", () => {
    const s = projectsSuite();
    s["projects-api"]!.ALLOWED_ORIGINS = "https://projects.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("projects-api.ALLOWED_ORIGINS is missing shell's origin");
  });

  test("CRM_INTERNAL_URL: a public https URL, or the wrong port → error", () => {
    const s = projectsSuite();
    s["projects-api"]!.CRM_INTERNAL_URL = "https://crm-api.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("CRM_INTERNAL_URL");
    s["projects-api"]!.CRM_INTERNAL_URL = "http://crm-api.railway.internal:9999";
    expect(errText(checkSuite(s, PROD))).toContain("CRM_INTERNAL_URL targets port 9999 but crm-api.PORT is 8084");
  });

  test("service client: projects-api's id missing from auth's registry → error", () => {
    const s = projectsSuite();
    s["projects-api"]!.SERVICE_CLIENT_ID = "someone-else";
    expect(errText(checkSuite(s, PROD))).toContain('no entry for client id "someone-else"');
  });

  test("service client: projects-api holds exactly its scopes — a missing or an extra scope → error", () => {
    const s = projectsSuite();
    s.auth!.SERVICE_CLIENTS = projectsRegistry("emails.send");
    const missing = errText(checkSuite(s, PROD));
    expect(missing).toContain('lacks the "crm.companies.read" scope');
    expect(missing).toContain('holds the "emails.send" scope, which projects-api does not need');
    s.auth!.SERVICE_CLIENTS = projectsRegistry(`${PROJECTS_SCOPES} emails.send`);
    expect(errText(checkSuite(s, PROD))).toContain('holds the "emails.send" scope, which projects-api does not need');
  });

  test("service client: projects-api's secret differing from the registry entry → error", () => {
    const s = projectsSuite();
    s["projects-api"]!.SERVICE_CLIENT_SECRET = "q".repeat(40);
    expect(errText(checkSuite(s, PROD))).toContain("projects-api.SERVICE_CLIENT_SECRET does not match");
  });

  test("the retired notify token on projects-api → error", () => {
    const s = projectsSuite();
    s["projects-api"]![["NOTIFY", "INTERNAL", "TOKEN"].join("_")] = "x";
    expect(errText(checkSuite(s, PROD))).toContain("projects-api must not hold");
  });
});

// specs/20261103-projects-handoff: the CRM and projects-api read each other over service credentials, and
// projects-api reads estimai-api for a deal's man-days (ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential). New keys: SERVICE_AUDIENCE on
// estimai-api and projects-api, ESTIMAI_INTERNAL_URL and NOTIFY_INTERNAL_URL on projects-api, PROJECTS_INTERNAL_URL
// on crm-api; new scopes on the projects-api and crm-api clients (`crm.contacts.read` is projects-api's only);
// crm-api's client is no longer notify-only.
describe("env-doctor checker — the projects hand-off keys (specs/20261103-projects-handoff)", () => {
  test("a fully-correct suite with the hand-off keys passes with no errors or warnings", () => {
    const f = checkSuite(projectsSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("SERVICE_AUDIENCE is required in production on estimai-api and projects-api; locally only on estimai-api", () => {
    for (const svc of ["estimai-api", "projects-api"] as const) {
      const s = projectsSuite();
      delete s[svc]!.SERVICE_AUDIENCE;
      expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is missing");
      expect(checkSuite(s, PROD).some((x) => x.scope === svc && x.message === "SERVICE_AUDIENCE is missing")).toBe(true);
      // local: projects-api starts without it (every /system/* request is a 401), so it is not flagged;
      // estimai-api's is a required key everywhere since main's deal-link notices.
      const flaggedLocally = checkSuite(s, LOCAL).some((x) => x.scope === svc && x.message === "SERVICE_AUDIENCE is missing");
      expect(flaggedLocally).toBe(svc === "estimai-api");
    }
  });

  test("SERVICE_AUDIENCE drift on estimai-api or projects-api → error", () => {
    for (const svc of ["estimai-api", "projects-api"] as const) {
      const s = projectsSuite();
      s[svc]!.SERVICE_AUDIENCE = "a-different-service-audience";
      expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
    }
  });

  test("SERVICE_AUDIENCE equal to AUTH_AUDIENCE on estimai-api or projects-api → error", () => {
    for (const svc of ["estimai-api", "projects-api"] as const) {
      const s = projectsSuite();
      s[svc]!.SERVICE_AUDIENCE = AUD;
      // the shared-audience drift error fires too; what matters is the distinct-from-AUTH_AUDIENCE one
      expect(errText(checkSuite(s, PROD))).toContain(`${svc}.SERVICE_AUDIENCE must differ from ${svc}.AUTH_AUDIENCE`);
    }
  });

  test("SERVICE_AUDIENCE as the same ${{shared.X}} reference on all five services → no error", () => {
    const s = projectsSuite();
    for (const svc of ["auth", "notify-api", "crm-api", "estimai-api", "projects-api"] as const) {
      s[svc]!.SERVICE_AUDIENCE = "${{shared.SERVICE_AUDIENCE}}";
    }
    for (const svc of ["auth", "estimai-api", "notify-api", "refund-api", "inventory-api", "crm-api", "projects-api"] as const) {
      s[svc]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    }
    const f = checkSuite(s, PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("ESTIMAI_INTERNAL_URL is required on projects-api in production, not locally", () => {
    const s = projectsSuite();
    delete s["projects-api"]!.ESTIMAI_INTERNAL_URL;
    expect(errText(checkSuite(s, PROD))).toContain("ESTIMAI_INTERNAL_URL is missing");
    expect(errText(checkSuite(s, LOCAL))).not.toContain("ESTIMAI_INTERNAL_URL is missing");
  });

  test("ESTIMAI_INTERNAL_URL: a public https URL, the wrong port, or a Railway reference → error / error / ok", () => {
    const s = projectsSuite();
    s["projects-api"]!.ESTIMAI_INTERNAL_URL = "https://estimai.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("ESTIMAI_INTERNAL_URL");
    s["projects-api"]!.ESTIMAI_INTERNAL_URL = "http://estimai-api.railway.internal:9999";
    expect(errText(checkSuite(s, PROD))).toContain("ESTIMAI_INTERNAL_URL targets port 9999 but estimai-api.PORT is 8080");
    s["projects-api"]!.ESTIMAI_INTERNAL_URL = "http://${{estimai-api.RAILWAY_PRIVATE_DOMAIN}}:${{estimai-api.PORT}}";
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("NOTIFY_INTERNAL_URL is required on projects-api in production, not locally", () => {
    const s = projectsSuite();
    delete s["projects-api"]!.NOTIFY_INTERNAL_URL;
    expect(errText(checkSuite(s, PROD))).toContain("NOTIFY_INTERNAL_URL is missing");
    expect(checkSuite(s, PROD).some((x) => x.scope === "projects-api" && x.message === "NOTIFY_INTERNAL_URL is missing")).toBe(true);
    expect(errText(checkSuite(s, LOCAL))).not.toContain("NOTIFY_INTERNAL_URL is missing");
  });

  test("projects-api NOTIFY_INTERNAL_URL: a public https URL, the wrong port, or a Railway reference → error / error / ok", () => {
    const s = projectsSuite();
    s["projects-api"]!.NOTIFY_INTERNAL_URL = "https://notify.operai.welld.io";
    expect(checkSuite(s, PROD).some((x) => x.scope === "projects-api" && x.level === "error" && x.message.includes("NOTIFY_INTERNAL_URL"))).toBe(true);
    s["projects-api"]!.NOTIFY_INTERNAL_URL = "http://notify-api.railway.internal:9999";
    expect(errText(checkSuite(s, PROD))).toContain("NOTIFY_INTERNAL_URL targets port 9999 but notify-api.PORT is 8080");
    s["projects-api"]!.NOTIFY_INTERNAL_URL = "http://${{notify-api.RAILWAY_PRIVATE_DOMAIN}}:${{notify-api.PORT}}";
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("PROJECTS_INTERNAL_URL is required on crm-api in production, not locally", () => {
    const s = projectsSuite();
    delete s["crm-api"]!.PROJECTS_INTERNAL_URL;
    expect(errText(checkSuite(s, PROD))).toContain("PROJECTS_INTERNAL_URL is missing");
    expect(errText(checkSuite(s, LOCAL))).not.toContain("PROJECTS_INTERNAL_URL is missing");
  });

  test("PROJECTS_INTERNAL_URL: a public https URL, or the wrong port → error", () => {
    const s = projectsSuite();
    s["crm-api"]!.PROJECTS_INTERNAL_URL = "https://projects.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("PROJECTS_INTERNAL_URL");
    s["crm-api"]!.PROJECTS_INTERNAL_URL = "http://projects-api.railway.internal:9999";
    expect(errText(checkSuite(s, PROD))).toContain("PROJECTS_INTERNAL_URL targets port 9999 but projects-api.PORT is 8086");
  });

  test("locally, an internal URL on localhost is accepted for the new calls", () => {
    const s = projectsSuite();
    s["projects-api"]!.ESTIMAI_INTERNAL_URL = "http://localhost:8080";
    s["projects-api"]!.NOTIFY_INTERNAL_URL = "http://localhost:8080";
    s["crm-api"]!.PROJECTS_INTERNAL_URL = "http://localhost:8086";
    // the CORS origins in this fixture are the production ones, so look only at the URL findings
    expect(checkSuite(s, LOCAL).filter((x) => x.message.includes("INTERNAL_URL"))).toEqual([]);
  });

  test("crm-api's client needs the SERVICE_CLIENT_* pair in production once PROJECTS_INTERNAL_URL is required — not only for notify", () => {
    for (const key of ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"]) {
      const s = projectsSuite();
      delete s["crm-api"]![key];
      delete s["crm-api"]!.NOTIFY_INTERNAL_URL; // a crm-api with no notify URL at all still needs the client for projects-api
      expect(errText(checkSuite(s, PROD))).toContain(`${key} is missing`);
      expect(errText(checkSuite(s, LOCAL))).not.toContain(`${key} is missing`);
    }
  });

  test("service client: projects-api needs the specs/20261103-projects-handoff scopes besides crm.companies.read", () => {
    const s = projectsSuite();
    s.auth!.SERVICE_CLIENTS = projectsRegistry("crm.companies.read"); // the specs/20261103-projects entry
    const text = errText(checkSuite(s, PROD));
    for (const scope of ["crm.deals.read", "crm.contacts.read", "estimai.estimates.read", "notifications.push"]) {
      expect(text).toContain(`entry "projects-api" lacks the "${scope}" scope`);
    }
    expect(text).not.toContain('entry "projects-api" lacks the "crm.companies.read" scope');
  });

  test("service client: projects-api a single scope of the five is not enough", () => {
    for (const scope of PROJECTS_SCOPES.split(" ")) {
      const s = projectsSuite();
      s.auth!.SERVICE_CLIENTS = projectsRegistry(scope);
      expect(hasErrors(checkSuite(s, PROD))).toBe(true);
    }
  });

  test("service client: projects-api drops no scope — each of the five is required", () => {
    for (const scope of PROJECTS_SCOPES.split(" ")) {
      const s = projectsSuite();
      const kept = PROJECTS_SCOPES.split(" ").filter((x) => x !== scope).join(" ");
      s.auth!.SERVICE_CLIENTS = projectsRegistry(kept);
      expect(errText(checkSuite(s, PROD))).toContain(`entry "projects-api" lacks the "${scope}" scope`);
    }
  });

  test("service client: crm.contacts.read belongs to projects-api only (M2) — crm-api holding it → error", () => {
    const s = projectsSuite();
    s.auth!.SERVICE_CLIENTS = projectsRegistry(PROJECTS_SCOPES, `${CRM_SCOPES} crm.contacts.read`);
    expect(errText(checkSuite(s, PROD))).toContain('entry "crm-api" holds the "crm.contacts.read" scope, which crm-api does not need');
  });

  test("service client: the retired contracts scope is not accepted in place of projects.purchase-orders.read", () => {
    const s = projectsSuite();
    const retired = ["projects", "contracts", "read"].join(".");
    s.auth!.SERVICE_CLIENTS = projectsRegistry(PROJECTS_SCOPES, `notifications.push emails.send ${retired}`);
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain('entry "crm-api" lacks the "projects.purchase-orders.read" scope');
    expect(text).toContain(`entry "crm-api" holds the "${retired}" scope, which crm-api does not need`);
  });

  test("service client: crm-api needs projects.purchase-orders.read besides its notify scopes", () => {
    const s = projectsSuite();
    s.auth!.SERVICE_CLIENTS = projectsRegistry(PROJECTS_SCOPES, "notifications.push emails.send"); // the specs/20261101-crm-notifications entry
    expect(errText(checkSuite(s, PROD))).toContain('entry "crm-api" lacks the "projects.purchase-orders.read" scope');
  });

  test("service client: crm-api keeps its notify scopes — dropping one → error", () => {
    for (const scope of ["notifications.push", "emails.send"]) {
      const s = projectsSuite();
      const kept = CRM_SCOPES.split(" ").filter((x) => x !== scope).join(" ");
      s.auth!.SERVICE_CLIENTS = projectsRegistry(PROJECTS_SCOPES, kept);
      expect(errText(checkSuite(s, PROD))).toContain(`entry "crm-api" lacks the "${scope}" scope`);
    }
  });

  test("service client: crm-api holds no scope beyond those three (least privilege)", () => {
    const s = projectsSuite();
    s.auth!.SERVICE_CLIENTS = projectsRegistry(PROJECTS_SCOPES, `${CRM_SCOPES} crm.deals.read`);
    expect(errText(checkSuite(s, PROD))).toContain('entry "crm-api" holds the "crm.deals.read" scope, which crm-api does not need');
  });

  test("service client: crm-api's id missing from auth's registry, or a secret mismatch → error without the value", () => {
    const s = projectsSuite();
    s["crm-api"]!.SERVICE_CLIENT_SECRET = "q".repeat(40);
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("crm-api.SERVICE_CLIENT_SECRET does not match");
    expect(JSON.stringify(f)).not.toContain(CLIENT_SECRET_CRM);
    s["crm-api"]!.SERVICE_CLIENT_ID = "someone-else";
    expect(errText(checkSuite(s, PROD))).toContain('no entry for client id "someone-else"');
  });
});

// specs/20261110-activities: activities-api (a new resource server that asks the hosts, ADR 20261110-activities-service-access-delegated-to-host) is called by
// crm-api with a scoped service credential (ADR 20261110-caller-chosen-ids-replace-cross-service-transactions) and notifies as itself (ADR 20261101-notify-api-resolves-email-notice-address-from-auth). The baseline is the
// suite above plus crm-api, projects-api and activities-api.
describe("env-doctor checker — activities-api (specs/20261110-activities)", () => {
  const CLIENT_SECRET_CRM = "m".repeat(40);
  const CLIENT_SECRET_ACT = "a".repeat(40);
  const CLIENT_SECRET_PRJ = "p".repeat(40);
  /** Only the findings about one service (the baseline has several services sharing key names). */
  const errsAbout = (f: Finding[], svc: string) => errs(f).filter((x) => x.scope === svc).map((x) => x.message).join(" | ");
  const CRM_SCOPES = "notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read letterhead:render legal-entities:read";
  const activitiesRegistry = (crmScope = CRM_SCOPES, actScope = "notifications.push emails.send") =>
    JSON.stringify({
      ...JSON.parse(registry(CLIENT_SECRET)),
      "crm-api": { secret: CLIENT_SECRET_CRM, scope: crmScope },
      "projects-api": { secret: CLIENT_SECRET_PRJ, scope: PROJECTS_SCOPES },
      "activities-api": { secret: CLIENT_SECRET_ACT, scope: actScope },
    });

  function activitiesSuite(): SuiteEnv {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = activitiesRegistry();
    s["crm-api"] = {
      DATABASE_URL: "postgres://…/crm",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "crm-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_CRM,
      SERVICE_AUDIENCE: SVC_AUD,
      ACTIVITIES_API_URL: "http://activities-api.railway.internal:8087",
      LETTERHEAD_API_URL: "http://letterhead-api.railway.internal:8088", // specs/20261116-letterhead-service (T44), production-required
      LETTERHEAD_SERVICE_ENABLED: "false", // the switch, production-required
      PROJECTS_INTERNAL_URL: "http://projects-api.railway.internal:8086", // specs/20261103-projects-handoff, production-required
      PORT: "8084",
    };
    s["projects-api"] = {
      DATABASE_URL: "postgres://…/projects",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      SERVICE_AUDIENCE: SVC_AUD,
      CRM_INTERNAL_URL: "http://crm-api.railway.internal:8084",
      ESTIMAI_INTERNAL_URL: "http://estimai-api.railway.internal:8080",
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080", // specs/20261103-projects-handoff, production-required
      SERVICE_CLIENT_ID: "projects-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_PRJ,
      PORT: "8086",
    };
    s["activities-api"] = {
      DATABASE_URL: "postgres://…/activities",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      CRM_API_URL: "http://crm-api.railway.internal:8084",
      PROJECTS_API_URL: "http://projects-api.railway.internal:8086",
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "activities-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_ACT,
      SERVICE_AUDIENCE: SVC_AUD,
      PORT: "8087",
    };
    return s;
  }
  const LOCAL = { env: "local", isProdLike: false };

  test("a fully-correct suite with activities-api, crm-api and projects-api passes with no errors or warnings", () => {
    const f = checkSuite(activitiesSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("activities-api is a Railway backend with no UI of its own", () => {
    expect(BACKENDS).toContain("activities-api");
    expect(SERVICES["activities-api"].platform).toBe("railway");
    expect(Object.keys(SERVICES)).not.toContain("activities-ui");
  });

  test("required keys: the hosts, notify, the service credential and the service audience", () => {
    for (const key of [
      "CRM_API_URL", "PROJECTS_API_URL", "NOTIFY_INTERNAL_URL", "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET",
      "SERVICE_AUDIENCE", "AUTH_BASE_URL", "AUTH_AUDIENCE", "ALLOWED_ORIGINS",
    ]) {
      const s = activitiesSuite();
      delete s["activities-api"]![key];
      expect(errsAbout(checkSuite(s, PROD), "activities-api")).toContain(`${key} is missing`);
    }
  });

  test("ACTIVITIES_MAINTENANCE is a runbook switch, not a required key", () => {
    const s = activitiesSuite();
    expect(s["activities-api"]!.ACTIVITIES_MAINTENANCE).toBeUndefined();
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("crm-api ACTIVITIES_API_URL is required in production, not locally", () => {
    const s = activitiesSuite();
    delete s["crm-api"]!.ACTIVITIES_API_URL;
    expect(errsAbout(checkSuite(s, PROD), "crm-api")).toContain("ACTIVITIES_API_URL is missing");
    expect(errText(checkSuite(s, LOCAL))).not.toContain("ACTIVITIES_API_URL is missing");
  });

  test("ACTIVITIES_API_URL: a public https URL, or the wrong port → error", () => {
    const s = activitiesSuite();
    s["crm-api"]!.ACTIVITIES_API_URL = "https://activities-api.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("ACTIVITIES_API_URL");
    s["crm-api"]!.ACTIVITIES_API_URL = "http://activities-api.railway.internal:9999";
    expect(errText(checkSuite(s, PROD))).toContain("ACTIVITIES_API_URL targets port 9999 but activities-api.PORT is 8087");
  });

  test("host URLs: CRM_API_URL / PROJECTS_API_URL must be private, on the target's port", () => {
    const s = activitiesSuite();
    s["activities-api"]!.CRM_API_URL = "https://crm-api.operai.welld.io";
    s["activities-api"]!.PROJECTS_API_URL = "http://projects-api.railway.internal:9999";
    const t = errText(checkSuite(s, PROD));
    expect(t).toContain("CRM_API_URL");
    expect(t).toContain("PROJECTS_API_URL targets port 9999 but projects-api.PORT is 8086");
  });

  test("activities-api SERVICE_AUDIENCE: drift from auth, or equal to its AUTH_AUDIENCE → error", () => {
    const s = activitiesSuite();
    s["activities-api"]!.SERVICE_AUDIENCE = "a-different-service-audience";
    expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
    s["activities-api"]!.SERVICE_AUDIENCE = AUD;
    expect(errText(checkSuite(s, PROD))).toContain("activities-api.SERVICE_AUDIENCE must differ from activities-api.AUTH_AUDIENCE");
  });

  test("activities-api AUTH_AUDIENCE drift, AUTH_ISSUER mismatch, CORS without the shell → error", () => {
    const s = activitiesSuite();
    s["activities-api"]!.AUTH_AUDIENCE = "different";
    s["activities-api"]!.AUTH_ISSUER = "https://wrong.example.com";
    s["activities-api"]!.ALLOWED_ORIGINS = "https://crm.operai.welld.io";
    const t = errText(checkSuite(s, PROD));
    expect(t).toContain("AUTH_AUDIENCE is not identical");
    expect(t).toContain("activities-api.AUTH_ISSUER");
    expect(t).toContain("activities-api.ALLOWED_ORIGINS is missing shell's origin");
  });

  test("service client: activities-api holds exactly notifications.push + emails.send (AC-6.1/6.3) — a missing or an extra scope → error", () => {
    const s = activitiesSuite();
    s.auth!.SERVICE_CLIENTS = activitiesRegistry(CRM_SCOPES, "notifications.push");
    expect(errText(checkSuite(s, PROD))).toContain('lacks the "emails.send" scope');
    s.auth!.SERVICE_CLIENTS = activitiesRegistry(CRM_SCOPES, "notifications.push emails.send crm.companies.read");
    expect(errText(checkSuite(s, PROD))).toContain('holds the "crm.companies.read" scope, which activities-api does not need');
  });

  test("service client: crm-api needs activities.write, and no scope beyond its five", () => {
    const s = activitiesSuite();
    s.auth!.SERVICE_CLIENTS = activitiesRegistry("notifications.push emails.send deal-link-notices.send");
    expect(errText(checkSuite(s, PROD))).toContain('lacks the "activities.write" scope');
    s.auth!.SERVICE_CLIENTS = activitiesRegistry(`${CRM_SCOPES} host-notices.send`);
    expect(errText(checkSuite(s, PROD))).toContain('holds the "host-notices.send" scope, which crm-api does not need');
  });

  // specs/20261116-letterhead-service (T44, AC-9.3, AC-10.12).
  test("crm-api LETTERHEAD_API_URL and LETTERHEAD_SERVICE_ENABLED are required in production, not locally", () => {
    for (const key of ["LETTERHEAD_API_URL", "LETTERHEAD_SERVICE_ENABLED"]) {
      const s = activitiesSuite();
      delete s["crm-api"]![key];
      expect(errsAbout(checkSuite(s, PROD), "crm-api")).toContain(`${key} is missing`);
      expect(errText(checkSuite(s, LOCAL))).not.toContain(`${key} is missing`);
    }
  });

  test("service client: crm-api needs letterhead:render, and a registry without it → error", () => {
    const s = activitiesSuite();
    s.auth!.SERVICE_CLIENTS = activitiesRegistry("notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read");
    expect(errText(checkSuite(s, PROD))).toContain('entry "crm-api" lacks the "letterhead:render" scope');
  });

  test("service client: letterhead:render is crm-api's alone — held by another client → error", () => {
    const s = activitiesSuite();
    s.auth!.SERVICE_CLIENTS = activitiesRegistry(CRM_SCOPES, "notifications.push emails.send letterhead:render");
    expect(errText(checkSuite(s, PROD))).toContain('entry "activities-api" holds the "letterhead:render" scope, which activities-api does not need');
  });

  test("service client: activities-api's id or secret differing from the registry → error", () => {
    const s = activitiesSuite();
    s["activities-api"]!.SERVICE_CLIENT_SECRET = "q".repeat(40);
    expect(errText(checkSuite(s, PROD))).toContain("activities-api.SERVICE_CLIENT_SECRET does not match");
    s["activities-api"]!.SERVICE_CLIENT_ID = "someone-else";
    expect(errText(checkSuite(s, PROD))).toContain('no entry for client id "someone-else"');
  });

  test("the retired notify token on activities-api → error", () => {
    const s = activitiesSuite();
    s["activities-api"]![["NOTIFY", "INTERNAL", "TOKEN"].join("_")] = "x";
    expect(errText(checkSuite(s, PROD))).toContain("activities-api must not hold");
  });

  test("the service-client secret is redacted", () => {
    expect(isSecretVar("SERVICE_CLIENT_SECRET")).toBe(true);
  });
});

// specs/20261117-legal-entities (T12, AC-3.2): the registry's service read takes the scope `legal-entities:read`. crm-api holds it
// besides its other scopes; letterhead-api is a NEW service client holding exactly it. A scope listed on one side only fails.
describe("env-doctor checker — legal-entities:read (specs/20261117-legal-entities)", () => {
  const CLIENT_SECRET_CRM = "m".repeat(40);
  const CLIENT_SECRET_ACT = "a".repeat(40);
  const CLIENT_SECRET_PRJ = "p".repeat(40);
  const CLIENT_SECRET_LH = "l".repeat(40);
  const CRM_SCOPES = "notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read letterhead:render legal-entities:read";
  const LH_SCOPES = "legal-entities:read";
  /** Findings about one service only (the baseline has several services sharing key names). */
  const errsAbout = (f: Finding[], svc: string) => errs(f).filter((x) => x.scope === svc).map((x) => x.message).join(" | ");
  const fullRegistry = (crmScope = CRM_SCOPES, lhScope: string | null = LH_SCOPES, lhSecret = CLIENT_SECRET_LH) => {
    const r: Record<string, unknown> = {
      ...JSON.parse(registry(CLIENT_SECRET)),
      "crm-api": { secret: CLIENT_SECRET_CRM, scope: crmScope },
      "projects-api": { secret: CLIENT_SECRET_PRJ, scope: PROJECTS_SCOPES },
      "activities-api": { secret: CLIENT_SECRET_ACT, scope: "notifications.push emails.send" },
    };
    if (lhScope !== null) r["letterhead-api"] = { secret: lhSecret, scope: lhScope };
    return JSON.stringify(r);
  };

  function legalSuite(): SuiteEnv {
    const s = validSuite();
    s.auth!.SERVICE_CLIENTS = fullRegistry();
    const rs = {
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      SERVICE_AUDIENCE: SVC_AUD,
    };
    s["crm-api"] = {
      ...rs,
      DATABASE_URL: "postgres://…/crm",
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "crm-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_CRM,
      ACTIVITIES_API_URL: "http://activities-api.railway.internal:8087",
      LETTERHEAD_API_URL: "http://letterhead-api.railway.internal:8088",
      LETTERHEAD_SERVICE_ENABLED: "false",
      PROJECTS_INTERNAL_URL: "http://projects-api.railway.internal:8086",
      PORT: "8084",
    };
    s["projects-api"] = {
      ...rs,
      DATABASE_URL: "postgres://…/projects",
      CRM_INTERNAL_URL: "http://crm-api.railway.internal:8084",
      ESTIMAI_INTERNAL_URL: "http://estimai-api.railway.internal:8080",
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "projects-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_PRJ,
      PORT: "8086",
    };
    s["activities-api"] = {
      ...rs,
      DATABASE_URL: "postgres://…/activities",
      CRM_API_URL: "http://crm-api.railway.internal:8084",
      PROJECTS_API_URL: "http://projects-api.railway.internal:8086",
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "activities-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_ACT,
      PORT: "8087",
    };
    s["letterhead-api"] = {
      ...rs,
      DATABASE_URL: "postgres://…/letterhead",
      SERVICE_CLIENT_ID: "letterhead-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_LH,
      LETTERHEAD_S3_ENDPOINT: "https://t3.storageapi.dev",
      LETTERHEAD_S3_REGION: "ams",
      LETTERHEAD_S3_EU_ENDPOINT_HOSTS: "t3.storageapi.dev",
      PORT: "8088",
    };
    return s;
  }
  const LOCAL = { env: "local", isProdLike: false };

  test("a fully-correct suite with the registry read on crm-api and letterhead-api passes with no errors or warnings", () => {
    const f = checkSuite(legalSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("a resolved production fixture whose registry lacks the scope fails naming letterhead-api and legal-entities:read", () => {
    const s = legalSuite();
    s.auth!.SERVICE_CLIENTS = fullRegistry(CRM_SCOPES, "letterhead:render");
    const text = errText(checkSuite(s, { ...PROD, resolved: true }));
    expect(text).toContain('auth.SERVICE_CLIENTS entry "letterhead-api" lacks the "legal-entities:read" scope');
    expect(text).toContain('entry "letterhead-api" holds the "letterhead:render" scope, which letterhead-api does not need');
  });

  test("crm-api needs legal-entities:read, and a registry without it → error naming crm-api and the scope", () => {
    const s = legalSuite();
    s.auth!.SERVICE_CLIENTS = fullRegistry("notifications.push emails.send deal-link-notices.send activities.write projects.purchase-orders.read letterhead:render");
    expect(errText(checkSuite(s, PROD))).toContain('entry "crm-api" lacks the "legal-entities:read" scope');
  });

  test("no letterhead-api entry in the registry → error: the token endpoint would answer 401 to it", () => {
    const s = legalSuite();
    s.auth!.SERVICE_CLIENTS = fullRegistry(CRM_SCOPES, null);
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain('no entry for client id "letterhead-api"');
    expect(text).toContain("letterhead-api");
  });

  test("letterhead-api holds exactly legal-entities:read: an extra scope on its entry → error", () => {
    const s = legalSuite();
    s.auth!.SERVICE_CLIENTS = fullRegistry(CRM_SCOPES, `${LH_SCOPES} crm.companies.read`);
    expect(errText(checkSuite(s, PROD))).toContain('entry "letterhead-api" holds the "crm.companies.read" scope, which letterhead-api does not need');
  });

  test("legal-entities:read is held by crm-api and letterhead-api only — another client holding it → error", () => {
    const s = legalSuite();
    s.auth!.SERVICE_CLIENTS = JSON.stringify({
      ...JSON.parse(fullRegistry()),
      "activities-api": { secret: CLIENT_SECRET_ACT, scope: "notifications.push emails.send legal-entities:read" },
    });
    expect(errText(checkSuite(s, PROD))).toContain('entry "activities-api" holds the "legal-entities:read" scope, which activities-api does not need');
  });

  test("letterhead-api's secret differing from the registry entry's → error; a wrong id → error", () => {
    const s = legalSuite();
    s["letterhead-api"]!.SERVICE_CLIENT_SECRET = "z".repeat(40);
    expect(errText(checkSuite(s, PROD))).toContain("letterhead-api.SERVICE_CLIENT_SECRET does not match");
    s["letterhead-api"]!.SERVICE_CLIENT_ID = "someone-else";
    expect(errText(checkSuite(s, PROD))).toContain('no entry for client id "someone-else"');
  });

  test("letterhead-api's secret must be 32 characters at least", () => {
    const s = legalSuite();
    s.auth!.SERVICE_CLIENTS = fullRegistry(CRM_SCOPES, LH_SCOPES, "s".repeat(31));
    s["letterhead-api"]!.SERVICE_CLIENT_SECRET = "s".repeat(31);
    expect(errsAbout(checkSuite(s, PROD), "letterhead-api")).toContain("SERVICE_CLIENT_SECRET is shorter than 32 characters");
  });

  test("letterhead-api SERVICE_CLIENT_ID and SERVICE_CLIENT_SECRET are required in production, not locally", () => {
    for (const key of ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"]) {
      const s = legalSuite();
      delete s["letterhead-api"]![key];
      expect(errsAbout(checkSuite(s, PROD), "letterhead-api")).toContain(`${key} is missing`);
      expect(errText(checkSuite(s, LOCAL))).not.toContain(`${key} is missing`);
    }
  });

  test("the same Railway reference on both sides is drift-proof (no warning), different references warn", () => {
    const s = legalSuite();
    const ref = "${{shared.LETTERHEAD_SERVICE_CLIENT_SECRET}}";
    s.auth!.SERVICE_CLIENTS = fullRegistry(CRM_SCOPES, LH_SCOPES, ref);
    s["letterhead-api"]!.SERVICE_CLIENT_SECRET = ref;
    const same = checkSuite(s, PROD);
    expect(errs(same)).toEqual([]);
    expect(warns(same)).toEqual([]);
    s["letterhead-api"]!.SERVICE_CLIENT_SECRET = "${{shared.OTHER}}";
    expect(warns(checkSuite(s, PROD)).map((x) => x.message).join(" | ")).toContain("letterhead-api.SERVICE_CLIENT_SECRET and the secret in auth.SERVICE_CLIENTS entry");
  });

  test("letterhead-api's client secret is redacted when surfaced", () => {
    expect(showValue("SERVICE_CLIENT_SECRET", CLIENT_SECRET_LH)).toStartWith("<redacted sha256:");
  });
});

describe("env-doctor — legal-entity registry configuration (specs/20261117-legal-entities, T67)", () => {
  const PROD_LIKE = { prodLike: true };
  const LOCAL_LIKE = { prodLike: false };
  const AUTH_TEMPLATE = readFileSync(resolve(import.meta.dir, "templates/production/auth.env"), "utf8");
  /** The shipped template with one more line appended, parsed the way the doctor loads it. */
  const templateWith = (...lines: string[]) => parseEnvFile(`${AUTH_TEMPLATE}\n${lines.join("\n")}\n`);

  test("the shipped auth template sets none of them (optional, defaults apply) and carries no address", () => {
    const t = parseEnvFile(AUTH_TEMPLATE);
    for (const name of [LEGAL_ENTITY_NOTICE_EMAIL, ...Object.keys(LEGAL_ENTITY_RATE_VARS)]) expect(name in t).toBe(false);
    expect(legalEntityConfigProblems(t, PROD_LIKE)).toEqual([]);
    // documented by name in comments, so the runbook and the template cannot drift apart unnoticed
    for (const name of [LEGAL_ENTITY_NOTICE_EMAIL, ...Object.keys(LEGAL_ENTITY_RATE_VARS)]) expect(AUTH_TEMPLATE).toContain(name);
    // a template holds references, never values: no address-shaped text after the variable's name
    expect(AUTH_TEMPLATE).not.toMatch(/LEGAL_ENTITY_NOTICE_EMAIL\s*=?\s*[^\s@=]+@/);
  });

  test("none of them is required: a suite without them passes, and the contract does not list them", () => {
    for (const keys of Object.values(REQUIRED_KEYS)) {
      for (const name of [LEGAL_ENTITY_NOTICE_EMAIL, ...Object.keys(LEGAL_ENTITY_RATE_VARS)]) expect(keys).not.toContain(name);
    }
    const f = checkSuite(validSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("a production template that sets the write limit above 10 is refused, naming the variable and never the value", () => {
    expect(LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX).toBe(10);
    for (const bad of ["11", "1000", "99999999"]) {
      const problems = legalEntityConfigProblems(templateWith(`LEGAL_ENTITY_WRITE_RATE_LIMIT=${bad}`), PROD_LIKE);
      expect(problems.join(" | ")).toContain("LEGAL_ENTITY_WRITE_RATE_LIMIT must not exceed 10 in production");
      expect(problems.join(" | ")).not.toContain(bad);
    }
    // 10 (the default) and anything below is fine; the same raise is allowed outside production (the e2e stack)
    for (const ok of ["1", "5", "10"]) expect(legalEntityConfigProblems(templateWith(`LEGAL_ENTITY_WRITE_RATE_LIMIT=${ok}`), PROD_LIKE)).toEqual([]);
    expect(legalEntityConfigProblems(templateWith("LEGAL_ENTITY_WRITE_RATE_LIMIT=1000"), LOCAL_LIKE)).toEqual([]);
  });

  test("auth/.env.example raises the write limit for local and e2e use only, and says so", () => {
    const example = readFileSync(resolve(import.meta.dir, "../../auth/.env.example"), "utf8");
    const vars = parseEnvFile(example);
    expect(Number(vars.LEGAL_ENTITY_WRITE_RATE_LIMIT)).toBeGreaterThan(LEGAL_ENTITY_WRITE_RATE_LIMIT_PRODUCTION_MAX);
    expect(legalEntityConfigProblems(vars, LOCAL_LIKE)).toEqual([]);
    expect(legalEntityConfigProblems(vars, PROD_LIKE).join(" | ")).toContain("LEGAL_ENTITY_WRITE_RATE_LIMIT must not exceed 10");
    expect(example).toMatch(/LOCAL DEVELOPMENT AND THE E2E STACK ONLY/);
    expect(example).toContain("NEVER copy this value");
    expect(LEGAL_ENTITY_NOTICE_EMAIL in vars).toBe(false); // unset locally: no outside recipient
    for (const name of [LEGAL_ENTITY_NOTICE_EMAIL, "LEGAL_ENTITY_CHECK_RATE_LIMIT", "LEGAL_ENTITY_RATE_WINDOW_MS"]) expect(example).toContain(name);
  });

  test("LEGAL_ENTITY_NOTICE_EMAIL: one email address when set; unset, empty or a reference is fine", () => {
    const check = (v: string | undefined) => legalEntityConfigProblems({ [LEGAL_ENTITY_NOTICE_EMAIL]: v }, PROD_LIKE);
    for (const ok of ["notices@welld.example", "a.b+legal@sub.domain.io", undefined, "", "${{shared.LEGAL_ENTITY_NOTICE_EMAIL}}", "${OP:Employee/item/field}"]) {
      expect(check(ok)).toEqual([]);
    }
    for (const bad of ["not-an-email", "two@welld.example, other@welld.example", "a@b", "Name <a@welld.example>", "a b@welld.example", "@welld.example", "a@@welld.example", "mailto:a@welld.example;x"]) {
      const p = check(bad);
      expect(p.length).toBe(1);
      expect(p[0]).toContain("LEGAL_ENTITY_NOTICE_EMAIL must be one email address");
      expect(p[0]).not.toContain(bad); // the value is never echoed
    }
  });

  test("the three rate variables: integers at or above their floor, and the window at least 1000 ms", () => {
    const p = (name: string, v: string) => legalEntityConfigProblems({ [name]: v }, LOCAL_LIKE);
    for (const [name, rule] of Object.entries(LEGAL_ENTITY_RATE_VARS)) {
      expect(p(name, String(rule.default))).toEqual([]);
      for (const bad of ["abc", "1.5", "-3", String(rule.min - 1), "1e3", "0x10"]) {
        expect(p(name, bad).join(" | ")).toContain(`${name} must be an integer of at least ${rule.min}`);
      }
    }
    expect(p("LEGAL_ENTITY_RATE_WINDOW_MS", "999").length).toBe(1);
    expect(p("LEGAL_ENTITY_RATE_WINDOW_MS", "1000")).toEqual([]);
    expect(p("LEGAL_ENTITY_CHECK_RATE_LIMIT", "0").length).toBe(1);
  });

  test("the defaults the doctor knows are the ones the plan fixes (G9) and auth's env.ts declares", () => {
    expect(LEGAL_ENTITY_RATE_VARS.LEGAL_ENTITY_WRITE_RATE_LIMIT.default).toBe(10);
    expect(LEGAL_ENTITY_RATE_VARS.LEGAL_ENTITY_CHECK_RATE_LIMIT.default).toBe(60);
    expect(LEGAL_ENTITY_RATE_VARS.LEGAL_ENTITY_RATE_WINDOW_MS.default).toBe(600000);
    const envTs = readFileSync(resolve(import.meta.dir, "../../auth/src/lib/env.ts"), "utf8");
    expect(envTs).toMatch(/LEGAL_ENTITY_WRITE_RATE_LIMIT: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(10\)/);
    expect(envTs).toMatch(/LEGAL_ENTITY_CHECK_RATE_LIMIT: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(60\)/);
    expect(envTs).toMatch(/LEGAL_ENTITY_RATE_WINDOW_MS: z\.coerce\.number\(\)\.int\(\)\.min\(1000\)\.default\(600000\)/);
  });
});

// specs/20261119-accounting (T43): accounting-api is a new resource server (JWKS + authorization, one narrow service read on /system/v1/*),
// refund-api reads it live over private networking (ACCOUNTING_INTERNAL_URL, required) and no longer fetches rates (REFUND_FX_SOURCE retired).
// accounting-api holds no service client of its own. The scope `accounting.reference.read` on refund-api's SERVICE_CLIENTS entry joined the
// registry template and the manifest in one change, after the new auth was live (infra/README.md § Accounting release runbook, step 4, 2026-11-20).
describe("env-doctor checker — accounting-api (specs/20261119-accounting)", () => {
  const errsAbout = (f: Finding[], svc: string) => errs(f).filter((x) => x.scope === svc).map((x) => x.message).join(" | ");

  function accountingSuite(): SuiteEnv {
    const s = validSuite();
    s["notify-api"]!.SERVICE_AUDIENCE = SVC_AUD;
    s["accounting-api"] = {
      DATABASE_URL: "postgres://…/accounting",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      SERVICE_AUDIENCE: SVC_AUD,
      ACCOUNTING_FX_SOURCE: "bazg",
      PORT: "8089",
    };
    return s;
  }

  test("a fully-correct suite with accounting-api and refund-api's URL to it passes with no errors or warnings", () => {
    const f = checkSuite(accountingSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("accounting-api is a backend of the contract, its remote is the shell's, and ACCOUNTING_INTERNAL_URL is required on refund-api", () => {
    expect(SERVICES["accounting-api"]).toEqual({ platform: "railway", kind: "backend" });
    expect(SERVICES["accounting-ui"]).toEqual({ platform: "vercel", kind: "frontend" });
    expect(BACKENDS).toContain("accounting-api");
    expect(ORIGINS.production!["accounting-ui"]).toBe("https://accounting.operai.welld.io");
    expect(ORIGINS.local!["accounting-ui"]).toBe("http://localhost:5183");
    expect(REQUIRED_KEYS["refund-api"]).toContain("ACCOUNTING_INTERNAL_URL");
  });

  test("every variable accounting-api's own env.ts requires is required here; the ones with a default are not", () => {
    const required = REQUIRED_KEYS["accounting-api"]!;
    for (const key of ["DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE", "SERVICE_AUDIENCE", "PORT"]) {
      expect(required).toContain(key);
      const s = accountingSuite();
      delete s["accounting-api"]![key];
      expect(errsAbout(checkSuite(s, PROD), "accounting-api")).toContain(`${key} is missing`);
    }
    // no service client and no *_INTERNAL_URL of its own: nothing in the contract asks for one
    for (const key of ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", "NODE_ENV", "ACCOUNTING_FX_SOURCE"]) expect(required).not.toContain(key);
    const s = accountingSuite();
    delete s["accounting-api"]!.ACCOUNTING_FX_SOURCE;
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("ACCOUNTING_INTERNAL_URL missing on refund-api → error naming the variable", () => {
    const s = accountingSuite();
    delete s["refund-api"]!.ACCOUNTING_INTERNAL_URL;
    expect(errsAbout(checkSuite(s, PROD), "refund-api")).toContain("ACCOUNTING_INTERNAL_URL is missing");
  });

  test("ACCOUNTING_INTERNAL_URL: the public https URL, localhost or the wrong port → error (the service token must stay on private networking)", () => {
    const s = accountingSuite();
    s["refund-api"]!.ACCOUNTING_INTERNAL_URL = "https://accounting-api.operai.welld.io";
    expect(errText(checkSuite(s, PROD))).toContain("ACCOUNTING_INTERNAL_URL");
    s["refund-api"]!.ACCOUNTING_INTERNAL_URL = "http://localhost:8089";
    expect(errText(checkSuite(s, PROD))).toContain("ACCOUNTING_INTERNAL_URL");
    s["refund-api"]!.ACCOUNTING_INTERNAL_URL = "http://accounting-api.railway.internal:9999";
    expect(errText(checkSuite(s, PROD))).toContain("ACCOUNTING_INTERNAL_URL targets port 9999 but accounting-api.PORT is 8089");
  });

  test("the Railway reference form of ACCOUNTING_INTERNAL_URL is accepted", () => {
    const s = accountingSuite();
    s["refund-api"]!.ACCOUNTING_INTERNAL_URL = "http://${{accounting-api.RAILWAY_PRIVATE_DOMAIN}}:${{accounting-api.PORT}}";
    expect(errs(checkSuite(s, PROD))).toEqual([]);
  });

  test("AUTH_AUDIENCE and SERVICE_AUDIENCE drift on accounting-api → error; SERVICE_AUDIENCE equal to AUTH_AUDIENCE → error", () => {
    const a = accountingSuite();
    a["accounting-api"]!.AUTH_AUDIENCE = "different";
    expect(errText(checkSuite(a, PROD))).toContain("AUTH_AUDIENCE is not identical");
    const b = accountingSuite();
    b["accounting-api"]!.SERVICE_AUDIENCE = "a-different-service-audience";
    expect(errText(checkSuite(b, PROD))).toContain("SERVICE_AUDIENCE is not identical");
    const c = accountingSuite();
    c["accounting-api"]!.SERVICE_AUDIENCE = AUD;
    expect(errText(checkSuite(c, PROD))).toContain("accounting-api.SERVICE_AUDIENCE must differ from accounting-api.AUTH_AUDIENCE");
  });

  test("accounting-api's AUTH_ISSUER must equal auth's BETTER_AUTH_URL; its ALLOWED_ORIGINS must hold the shell; its JWKS URL must be private", () => {
    const a = accountingSuite();
    a["accounting-api"]!.AUTH_ISSUER = "https://wrong.example.com";
    expect(errText(checkSuite(a, PROD))).toContain("accounting-api.AUTH_ISSUER");
    const b = accountingSuite();
    b["accounting-api"]!.ALLOWED_ORIGINS = "https://accounting.operai.welld.io";
    expect(errText(checkSuite(b, PROD))).toContain("accounting-api.ALLOWED_ORIGINS is missing shell's origin");
    const c = accountingSuite();
    c["accounting-api"]!.AUTH_JWKS_URL = "https://auth.operai.welld.io/auth/jwks";
    expect(errText(checkSuite(c, PROD))).toContain("AUTH_JWKS_URL");
  });

  test("REFUND_FX_SOURCE is retired: flagged by name on refund-api only, naming where the switch went; the retired notify token stays forbidden on accounting-api", () => {
    const s = accountingSuite();
    s["refund-api"]!.REFUND_FX_SOURCE = "bazg";
    const text = errText(checkSuite(s, PROD));
    expect(text).toContain("refund-api must not hold REFUND_FX_SOURCE");
    expect(text).toContain("ACCOUNTING_FX_SOURCE");
    const t = accountingSuite();
    t["accounting-api"]!.REFUND_FX_SOURCE = "bazg";
    expect(errText(checkSuite(t, PROD))).not.toContain("REFUND_FX_SOURCE");
    const u = accountingSuite();
    u["accounting-api"]![["NOTIFY", "INTERNAL", "TOKEN"].join("_")] = "x";
    expect(errText(checkSuite(u, PROD))).toContain("accounting-api must not hold");
  });

  test("the retired variable's value is never echoed", () => {
    const s = accountingSuite();
    s["refund-api"]!.REFUND_FX_SOURCE = "a-distinctive-value-0451";
    expect(JSON.stringify(checkSuite(s, PROD))).not.toContain("a-distinctive-value-0451");
  });

  test("refund-api's entry holds its two notify scopes and accounting.reference.read (granted at release step 4, 2026-11-20)", () => {
    const s = accountingSuite();
    expect(errs(checkSuite(s, PROD))).toEqual([]);
    const reg = JSON.parse(s.auth!.SERVICE_CLIENTS!);
    expect(reg["refund-api"].scope).toBe("notifications.push emails.send accounting.reference.read");
  });

  describe("the committed templates", () => {
    const tpl = (name: string) => readFileSync(resolve(import.meta.dir, "templates/production", `${name}.env`), "utf8");
    const assigned = (name: string) => parseEnvFile(tpl(name));

    test("accounting-api's template sets exactly the service's variables: its own DB, the shell origin only, port 8089, the FX source on", () => {
      const vars = assigned("accounting-api");
      expect(Object.keys(vars).sort()).toEqual(
        ["ACCOUNTING_FX_SOURCE", "ALLOWED_ORIGINS", "AUTH_AUDIENCE", "AUTH_BASE_URL", "AUTH_ISSUER", "AUTH_JWKS_URL", "DATABASE_URL", "NODE_ENV", "PORT", "SERVICE_AUDIENCE"].sort(),
      );
      expect(vars.DATABASE_URL).toMatch(/:5432\/accounting$/);
      expect(vars.ALLOWED_ORIGINS).toBe("https://operai.welld.io");
      expect(vars.PORT).toBe("8089");
      expect(vars.NODE_ENV).toBe("production");
      expect(vars.ACCOUNTING_FX_SOURCE).toBe("bazg");
      expect(vars.AUTH_AUDIENCE).toBe("${{shared.AUTH_AUDIENCE}}");
      expect(vars.SERVICE_AUDIENCE).toBe("${{shared.SERVICE_AUDIENCE}}");
    });

    test("accounting-api's template holds no secret value: every credential-bearing value is a Railway reference", () => {
      const vars = assigned("accounting-api");
      for (const [k, v] of Object.entries(vars)) {
        if (isSecretVar(k)) expect(v).toMatch(/\$\{\{/);
        expect(v).not.toMatch(/^op:\/\//);
      }
    });

    test("refund-api's template points ACCOUNTING_INTERNAL_URL at accounting-api's private domain and port, and no longer sets REFUND_FX_SOURCE", () => {
      const vars = assigned("refund-api");
      expect(vars.ACCOUNTING_INTERNAL_URL).toBe("http://${{accounting-api.RAILWAY_PRIVATE_DOMAIN}}:${{accounting-api.PORT}}");
      expect("REFUND_FX_SOURCE" in vars).toBe(false);
      expect(vars.SERVICE_CLIENT_ID).toBe("refund-api");
    });
  });
});

// specs/029-time-tracking (ADR-0088/0089/0090): hours-api, a new resource server that asks four owners
// (projects-api, crm-api, activities-api, meetings-api) as the caller and reads one fact from meetings-api
// as itself (`GET /system/meetings/hosts`, scope `meetings.hosts.read`), so meetings-api now verifies service
// tokens and needs the service audience. The baseline is the suite with crm-api, projects-api, activities-api,
// meetings-api and hours-api.
describe("env-doctor checker — hours-api (specs/029)", () => {
  const CLIENT_SECRET_HOURS = "h".repeat(40);
  const CLIENT_SECRET_ACT = "a".repeat(40);
  const CLIENT_SECRET_MEET = "t".repeat(40);
  const HOURS_SCOPE = "meetings.hosts.read";
  const OWNER_URLS = {
    PROJECTS_API_URL: { target: "projects-api", port: "8086" },
    CRM_API_URL: { target: "crm-api", port: "8084" },
    ACTIVITIES_API_URL: { target: "activities-api", port: "8087" },
    MEETINGS_API_URL: { target: "meetings-api", port: "8085" },
  } as const;
  /** Only the findings about one service (the baseline has several services sharing key names). */
  const errsAbout = (f: Finding[], svc: string) => errs(f).filter((x) => x.scope === svc).map((x) => x.message).join(" | ");
  const hoursRegistry = (hoursScope = HOURS_SCOPE) =>
    JSON.stringify({
      ...JSON.parse(projectsRegistry()),
      "activities-api": { secret: CLIENT_SECRET_ACT, scope: "notifications.push emails.send" },
      "meetings-api": { secret: CLIENT_SECRET_MEET, scope: "notifications.push host-notices.send" },
      "hours-api": { secret: CLIENT_SECRET_HOURS, scope: hoursScope },
    });

  function hoursSuite(): SuiteEnv {
    const s = projectsSuite(); // validSuite + crm-api + projects-api, in their specs/026-028 shape
    s.auth!.SERVICE_CLIENTS = hoursRegistry();
    s["activities-api"] = {
      DATABASE_URL: "postgres://…/activities",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      CRM_API_URL: "http://crm-api.railway.internal:8084",
      PROJECTS_API_URL: "http://projects-api.railway.internal:8086",
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      SERVICE_CLIENT_ID: "activities-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_ACT,
      SERVICE_AUDIENCE: SVC_AUD,
      PORT: "8087",
    };
    s["meetings-api"] = {
      DATABASE_URL: "postgres://…/meetings",
      ALLOWED_ORIGINS: SHELL,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      NOTIFY_INTERNAL_URL: "http://notify-api.railway.internal:8080",
      CRM_API_URL: "http://crm-api.railway.internal:8084",
      SERVICE_CLIENT_ID: "meetings-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_MEET,
      SERVICE_AUDIENCE: SVC_AUD,
      MEETINGS_S3_ENDPOINT: "https://t3.storageapi.dev",
      MEETINGS_S3_REGION: "ams",
      MEETINGS_S3_EU_ENDPOINT_HOSTS: "t3.storageapi.dev",
      MEETINGS_SPEECH_LOCATION: "eu",
      MEETINGS_VERTEX_LOCATION: "eu",
      MEETINGS_VERTEX_MODEL_ID: "claude-synthetic-model",
      MEETINGS_GCP_PROJECT_ID: "synthetic-project",
      MEETINGS_GCP_SERVICE_ACCOUNT_KEY: "eyJzeW50aGV0aWMta2V5LW5ldmVyLXByaW50ZWQi" + "Z".repeat(24),
      MEETINGS_GCS_TRANSIENT_BUCKET: "synthetic-transient-bucket",
      MEETINGS_AI_PROVIDER: "real",
      PORT: "8085",
    };
    s["hours-api"] = {
      DATABASE_URL: "postgres://…/hours",
      ALLOWED_ORIGINS: `${SHELL},${ADMIN}`,
      AUTH_ISSUER: AUTH_URL,
      AUTH_JWKS_URL: "http://auth.railway.internal:3001/auth/jwks",
      AUTH_BASE_URL: "http://auth.railway.internal:3001",
      AUTH_AUDIENCE: AUD,
      PROJECTS_API_URL: "http://projects-api.railway.internal:8086",
      CRM_API_URL: "http://crm-api.railway.internal:8084",
      ACTIVITIES_API_URL: "http://activities-api.railway.internal:8087",
      MEETINGS_API_URL: "http://meetings-api.railway.internal:8085",
      SERVICE_CLIENT_ID: "hours-api",
      SERVICE_CLIENT_SECRET: CLIENT_SECRET_HOURS,
      SERVICE_AUDIENCE: SVC_AUD,
      PORT: "8088",
    };
    return s;
  }

  test("a fully-correct suite with hours-api and its owners passes with no errors or warnings", () => {
    const f = checkSuite(hoursSuite(), PROD);
    expect(errs(f)).toEqual([]);
    expect(warns(f)).toEqual([]);
  });

  test("hours-api is a Railway backend, hours-ui a Vercel frontend with a production and a local origin", () => {
    expect(BACKENDS).toContain("hours-api");
    expect(SERVICES["hours-api"]).toEqual({ platform: "railway", kind: "backend" });
    expect(SERVICES["hours-ui"]).toEqual({ platform: "vercel", kind: "frontend" });
    expect(BACKENDS).not.toContain("hours-ui");
    expect(ORIGINS.production!["hours-ui"]).toBe("https://hours.operai.welld.io");
    expect(ORIGINS.local!["hours-ui"]).toBe("http://localhost:5184");
  });

  test("the contract entries: issuer, links, internal URLs, CORS, required keys, the one scope", () => {
    expect(ISSUER.resourceServers).toContain("hours-api");
    expect(CORS_REQUIREMENTS).toContainEqual({ backend: "hours-api", mustAllow: ["shell", "admin-ui"] });
    expect(SERVICE_CLIENT_LINKS.find((l) => l.caller === "hours-api")?.requiredScopes).toEqual(["meetings.hosts.read"]);
    for (const [name, { target }] of Object.entries(OWNER_URLS)) {
      expect(INTERNAL_URL_VARS.some((u) => u.name === name && u.services.includes("hours-api") && u.target === target)).toBe(true);
    }
    for (const name of ["AUTH_JWKS_URL", "AUTH_BASE_URL"]) {
      expect(INTERNAL_URL_VARS.some((u) => u.name === name && u.services.includes("hours-api") && u.target === "auth")).toBe(true);
    }
    // Everything hours-api's env.ts requires at start is required by the contract; NODE_ENV has a default.
    expect([...REQUIRED_KEYS["hours-api"]!].sort()).toEqual(
      [
        "DATABASE_URL", "ALLOWED_ORIGINS", "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_BASE_URL", "AUTH_AUDIENCE",
        ...Object.keys(OWNER_URLS), "SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET", "SERVICE_AUDIENCE", "PORT",
      ].sort(),
    );
    expect(PRODUCTION_REQUIRED_KEYS["meetings-api"]).toEqual(["SERVICE_AUDIENCE"]);
  });

  test("required keys: every variable hours-api's own env.ts requires, in production and locally", () => {
    for (const key of REQUIRED_KEYS["hours-api"]!) {
      for (const opts of [PROD, LOCAL]) {
        const s = hoursSuite();
        delete s["hours-api"]![key];
        expect(errsAbout(checkSuite(s, opts), "hours-api")).toContain(`${key} is missing`);
      }
    }
  });

  test("SERVICE_AUDIENCE: missing on hours-api → error; missing on meetings-api → error in production only", () => {
    const s = hoursSuite();
    delete s["hours-api"]!.SERVICE_AUDIENCE;
    expect(errsAbout(checkSuite(s, PROD), "hours-api")).toBe("SERVICE_AUDIENCE is missing");
    const m = hoursSuite();
    delete m["meetings-api"]!.SERVICE_AUDIENCE;
    expect(errsAbout(checkSuite(m, PROD), "meetings-api")).toBe("SERVICE_AUDIENCE is missing");
    // meetings-api's own env.ts keeps it optional so a local setup starts: the contract asks for it in production.
    expect(errsAbout(checkSuite(m, LOCAL), "meetings-api")).not.toContain("SERVICE_AUDIENCE is missing");
  });

  test("SERVICE_AUDIENCE: hours-api or meetings-api drifting from auth's → error", () => {
    for (const svc of ["hours-api", "meetings-api"]) {
      const s = hoursSuite();
      s[svc as keyof SuiteEnv]!.SERVICE_AUDIENCE = "a-different-service-audience";
      expect(errText(checkSuite(s, PROD))).toContain("SERVICE_AUDIENCE is not identical");
    }
  });

  test("SERVICE_AUDIENCE equal to AUTH_AUDIENCE on hours-api or meetings-api → error (both refuse to start)", () => {
    for (const svc of ["hours-api", "meetings-api"]) {
      const s = hoursSuite();
      s[svc as keyof SuiteEnv]!.SERVICE_AUDIENCE = AUD;
      expect(errText(checkSuite(s, PROD))).toContain(`${svc}.SERVICE_AUDIENCE must differ from ${svc}.AUTH_AUDIENCE`);
    }
    // The same `${{shared.X}}` reference written for both is equal too.
    const s = hoursSuite();
    s["hours-api"]!.AUTH_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    s["hours-api"]!.SERVICE_AUDIENCE = "${{shared.AUTH_AUDIENCE}}";
    expect(errText(checkSuite(s, PROD))).toContain("hours-api.SERVICE_AUDIENCE must differ from hours-api.AUTH_AUDIENCE");
  });

  test("hours-api AUTH_AUDIENCE drift, AUTH_ISSUER mismatch, CORS without the shell → error", () => {
    const s = hoursSuite();
    s["hours-api"]!.AUTH_AUDIENCE = "different";
    s["hours-api"]!.AUTH_ISSUER = "https://wrong.example.com";
    s["hours-api"]!.ALLOWED_ORIGINS = ADMIN;
    const t = errText(checkSuite(s, PROD));
    expect(t).toContain("AUTH_AUDIENCE is not identical");
    expect(t).toContain("hours-api.AUTH_ISSUER");
    expect(t).toContain("hours-api.ALLOWED_ORIGINS is missing shell's origin");
  });

  test("hours-api CORS without admin-ui's origin → error (the Time lists page calls it directly)", () => {
    const s = hoursSuite();
    s["hours-api"]!.ALLOWED_ORIGINS = SHELL;
    expect(errText(checkSuite(s, PROD))).toContain(`hours-api.ALLOWED_ORIGINS is missing admin-ui's origin ${ADMIN}`);
    s["hours-api"]!.ALLOWED_ORIGINS = `${SHELL}/,${ADMIN}/`; // a trailing slash is normalised
    expect(errsAbout(checkSuite(s, PROD), "hours-api")).toBe("");
  });

  test("hours-api AUTH_ISSUER must be a public https URL", () => {
    const s = hoursSuite();
    s["hours-api"]!.AUTH_ISSUER = "http://localhost:3001";
    expect(errText(checkSuite(s, PROD))).toContain("AUTH_ISSUER must be a public https:// URL");
  });

  test("auth links: AUTH_JWKS_URL / AUTH_BASE_URL public, or on the wrong port → error", () => {
    const s = hoursSuite();
    s["hours-api"]!.AUTH_JWKS_URL = "https://auth.operai.welld.io/auth/jwks";
    s["hours-api"]!.AUTH_BASE_URL = "http://auth.railway.internal:9999";
    const t = errText(checkSuite(s, PROD));
    expect(t).toContain("AUTH_JWKS_URL");
    expect(t).toContain("AUTH_BASE_URL targets port 9999 but auth.PORT is 3001");
  });

  for (const [name, { target, port }] of Object.entries(OWNER_URLS)) {
    test(`${name}: a public https URL → error, the wrong port → error, a Railway reference passes`, () => {
      const s = hoursSuite();
      s["hours-api"]![name] = `https://${target}.operai.welld.io`;
      expect(errsAbout(checkSuite(s, PROD), "hours-api")).toContain(name);
      s["hours-api"]![name] = `http://${target}.railway.internal:9999`;
      expect(errsAbout(checkSuite(s, PROD), "hours-api")).toContain(`${name} targets port 9999 but ${target}.PORT is ${port}`);
      s["hours-api"]![name] = `http://\${{${target}.RAILWAY_PRIVATE_DOMAIN}}:\${{${target}.PORT}}`;
      expect(errsAbout(checkSuite(s, PROD), "hours-api")).toBe("");
    });
  }

  test("service client: hours-api holds exactly meetings.hosts.read — a missing or an extra scope → error", () => {
    const s = hoursSuite();
    s.auth!.SERVICE_CLIENTS = hoursRegistry("notifications.push");
    const missing = errText(checkSuite(s, PROD));
    expect(missing).toContain('entry "hours-api" lacks the "meetings.hosts.read" scope');
    expect(missing).toContain('entry "hours-api" holds the "notifications.push" scope, which hours-api does not need');
    s.auth!.SERVICE_CLIENTS = hoursRegistry(`${HOURS_SCOPE} crm.deals.read`);
    expect(errText(checkSuite(s, PROD))).toContain('holds the "crm.deals.read" scope, which hours-api does not need');
    s.auth!.SERVICE_CLIENTS = hoursRegistry("");
    expect(errText(checkSuite(s, PROD))).toContain('entry "hours-api" lacks the "meetings.hosts.read" scope');
  });

  test("service client: hours-api's id or secret differing from the registry, or no entry at all → error", () => {
    const s = hoursSuite();
    s["hours-api"]!.SERVICE_CLIENT_SECRET = "q".repeat(40);
    const f = checkSuite(s, PROD);
    expect(errText(f)).toContain("hours-api.SERVICE_CLIENT_SECRET does not match");
    expect(JSON.stringify(f)).not.toContain(CLIENT_SECRET_HOURS);
    expect(JSON.stringify(f)).not.toContain("q".repeat(40));
    s["hours-api"]!.SERVICE_CLIENT_SECRET = CLIENT_SECRET_HOURS;
    s["hours-api"]!.SERVICE_CLIENT_ID = "someone-else";
    expect(errText(checkSuite(s, PROD))).toContain('no entry for client id "someone-else"');
    const registryWithout = JSON.parse(hoursRegistry());
    delete registryWithout["hours-api"];
    s["hours-api"]!.SERVICE_CLIENT_ID = "hours-api";
    s.auth!.SERVICE_CLIENTS = JSON.stringify(registryWithout);
    expect(errText(checkSuite(s, PROD))).toContain('has no entry for client id "hours-api"');
  });

  test("service client: a secret shorter than 32 characters, on either side → error", () => {
    const s = hoursSuite();
    s["hours-api"]!.SERVICE_CLIENT_SECRET = "short";
    expect(errsAbout(checkSuite(s, PROD), "hours-api")).toContain("SERVICE_CLIENT_SECRET is shorter than 32 characters");
  });

  test("the retired notify token on hours-api → error", () => {
    const s = hoursSuite();
    s["hours-api"]![["NOTIFY", "INTERNAL", "TOKEN"].join("_")] = "x";
    expect(errText(checkSuite(s, PROD))).toContain("hours-api must not hold");
  });

  test("meetings-api's own service client is unchanged by the new audience (notifications.push + host-notices.send)", () => {
    const s = hoursSuite();
    expect(errs(checkSuite(s, PROD))).toEqual([]);
    const registry = JSON.parse(hoursRegistry());
    registry["meetings-api"].scope = "notifications.push host-notices.send meetings.hosts.read";
    s.auth!.SERVICE_CLIENTS = JSON.stringify(registry);
    expect(errText(checkSuite(s, PROD))).toContain('entry "meetings-api" holds the "meetings.hosts.read" scope, which meetings-api does not need');
  });

  test("hours-api's service-client secret is redacted", () => {
    expect(isSecretVar("SERVICE_CLIENT_SECRET")).toBe(true);
    expect(showValue("SERVICE_CLIENT_SECRET", CLIENT_SECRET_HOURS)).toStartWith("<redacted sha256:");
  });
});

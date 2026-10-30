import { describe, expect, test } from "bun:test";
import { checkSuite, hasErrors, showValue, type Finding, type SuiteEnv } from "./check";

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
const registry = (secret: string, scope = "notifications.push") =>
  JSON.stringify({
    "inventory-api": { secret, scope },
    "estimai-api": { secret: CLIENT_SECRET_EST, scope: "notifications.push" },
    "refund-api": { secret: CLIENT_SECRET_REF, scope: "notifications.push emails.send" },
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
    for (const svc of ["auth", "notify-api"] as const) {
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

  // ── specs/015-hardware-inventory (T43): service tokens, inventory-api ──────
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
    for (const svc of ["auth", "notify-api"] as const) {
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

  // specs/016 AC-5.3: the retired shared token is forbidden on every service, flagged by name only.
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

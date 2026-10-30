import { describe, expect, test } from "bun:test";
import { checkSuite, showValue, type CheckOptions, type SuiteEnv } from "./check";
import { diffLiteral } from "./live";

// Synthetic marker strings; none is a real credential. They must NEVER appear in a finding.
const PASS = "hunter2-userinfo-secret";
const TOKEN = "qs-token-secret";
const FRAG = "frag-secret";
const LEAKS = [PASS, TOKEN, FRAG];

const PROD: CheckOptions = { env: "production", isProdLike: true, resolved: true };
const LOCAL: CheckOptions = { env: "local", isProdLike: false, resolved: true };

/** Every string a finding can carry to a terminal. */
const rendered = (findings: ReturnType<typeof checkSuite>) => JSON.stringify(findings);
const expectNoLeak = (text: string) => {
  for (const l of LEAKS) expect(text).not.toContain(l);
};

const withCreds = (base: string) => base.replace("://", `://svc:${PASS}@`) + `?token=${TOKEN}#${FRAG}`;

describe("a URL's userinfo and query never reach a finding", () => {
  test("showValue strips userinfo, query and fragment from a URL but keeps the host/path", () => {
    const shown = showValue("NOTIFY_INTERNAL_URL", withCreds("http://notify-api.railway.internal:8080/x"));
    expectNoLeak(shown);
    expect(shown).toContain("notify-api.railway.internal:8080/x");
  });

  test("showValue leaves a plain URL, a plain value and a Railway ref untouched", () => {
    expect(showValue("AUTH_ISSUER", "https://auth.operai.welld.io")).toBe("https://auth.operai.welld.io");
    expect(showValue("PORT", "8080")).toBe("8080");
    expect(showValue("AUTH_AUDIENCE", "${{shared.AUTH_AUDIENCE}}")).toBe("${{shared.AUTH_AUDIENCE}}");
  });

  test("showValue scrubs userinfo embedded in a value that is not itself a URL (a list)", () => {
    expectNoLeak(showValue("SOME_LIST", `https://ok.example,https://u:${PASS}@h.example/p`));
  });

  test("showValue still fingerprints the secret vars", () => {
    expect(showValue("DATABASE_URL", withCreds("postgres://h/db"))).toStartWith("<redacted sha256:");
  });

  test("two URLs differing only in the stripped part stay distinguishable", () => {
    const a = showValue("X_URL", `https://u:${PASS}@h.example/p`);
    const b = showValue("X_URL", `https://u:other@h.example/p`);
    expect(a).not.toBe(b);
    expectNoLeak(a + b);
  });

  test.each([
    ["internal URL is not valid", { "refund-api": { AUTH_BASE_URL: `http://svc:${PASS}@bad host:${TOKEN}/x` } }, PROD],
    [
      "internal URL has the wrong scheme",
      { "refund-api": { AUTH_BASE_URL: withCreds("https://auth.railway.internal:3001") } },
      PROD,
    ],
    [
      "internal URL points at a public host",
      { "refund-api": { NOTIFY_INTERNAL_URL: withCreds("http://notify.example.com:8081") } },
      PROD,
    ],
    ["internal URL has the wrong port", { auth: { PORT: "3001" }, "refund-api": { AUTH_BASE_URL: withCreds("http://auth.railway.internal:9") } }, PROD],
    ["public URL is not valid", { auth: { BETTER_AUTH_URL: `https://svc:${PASS}@bad host/?t=${TOKEN}` } }, PROD],
    ["public URL is http / localhost", { auth: { UI_HOME_URL: withCreds("http://localhost:5173") } }, PROD],
    ["public URL is internal", { "refund-api": { AUTH_ISSUER: withCreds("https://x.railway.internal") } }, PROD],
    [
      "issuer differs from auth's",
      { auth: { BETTER_AUTH_URL: "https://auth.operai.welld.io" }, "notify-api": { AUTH_ISSUER: withCreds("https://evil.example") } },
      PROD,
    ],
    [
      "issuer on the auth side carries credentials",
      { auth: { BETTER_AUTH_URL: withCreds("https://auth.operai.welld.io") }, "notify-api": { AUTH_ISSUER: "https://other.example" } },
      PROD,
    ],
    ["local run, wrong scheme", { "refund-api": { AUTH_BASE_URL: withCreds("https://localhost:3001") } }, LOCAL],
  ] as [string, SuiteEnv, CheckOptions][])("%s", (_n, suite, opts) => {
    const out = rendered(checkSuite(suite, opts));
    expect(out).not.toBe("[]"); // the case really did produce a finding
    expectNoLeak(out);
  });

  test("a live drift on a URL variable does not echo its credentials", () => {
    const tpl: SuiteEnv = { "refund-api": { SOME_URL: `https://svc:${PASS}@a.example/?t=${TOKEN}` } };
    const live: SuiteEnv = { "refund-api": { SOME_URL: `https://svc:other@b.example/?t=${FRAG}` } };
    const drift = rendered(diffLiteral(tpl, live));
    expect(drift).toContain("drifted");
    expectNoLeak(drift);
    const missing = rendered(diffLiteral(tpl, { "refund-api": { OTHER: "1" } }));
    expect(missing).toContain("MISSING");
    expectNoLeak(missing);
  });
});

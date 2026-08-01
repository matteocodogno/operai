import { afterEach, describe, expect, test } from "bun:test";
import { diffLiteral, linkedProjectId, loadLiveSuite, parseRailwayJson, type RailwayRunner } from "./live";
import { checkSuite } from "./check";
import type { SuiteEnv } from "./check";

describe("parseRailwayJson (tolerant of Railway's JSON shapes)", () => {
  test("flat object {KEY: value}", () => {
    expect(parseRailwayJson('{"AUTH_ISSUER":"https://auth.x","PORT":"3001"}')).toEqual({
      AUTH_ISSUER: "https://auth.x",
      PORT: "3001",
    });
  });
  test("object of {KEY: {value}}", () => {
    expect(parseRailwayJson('{"PORT":{"value":"8080"}}')).toEqual({ PORT: "8080" });
  });
  test("array of {name,value}", () => {
    expect(parseRailwayJson('[{"name":"PORT","value":"8082"},{"name":"NODE_ENV","value":"production"}]')).toEqual({
      PORT: "8082",
      NODE_ENV: "production",
    });
  });
  test("garbage → empty (no throw)", () => {
    expect(parseRailwayJson("not json")).toEqual({});
  });
});

describe("loadLiveSuite (injectable runner — never hits Railway)", () => {
  const good: RailwayRunner = (svc) => ({
    code: 0,
    stdout: JSON.stringify({ SERVICE: svc, AUTH_AUDIENCE: "operai-suite" }),
    stderr: "",
  });

  test("loads every backend from the runner", () => {
    const r = loadLiveSuite("production", { run: good });
    expect(r.loaded).toEqual(["auth", "estimai-api", "notify-api", "refund-api"]);
    expect(r.errors).toEqual([]);
    expect(r.suite.auth!.SERVICE).toBe("auth");
  });

  const noSleep = () => {};

  test("a non-zero exit (after retries) → per-service error, service skipped", () => {
    const run: RailwayRunner = (svc) =>
      svc === "auth"
        ? { code: 1, stdout: "", stderr: "Unauthorized. Please login." }
        : { code: 0, stdout: '{"X":"y"}', stderr: "" };
    const r = loadLiveSuite("production", { run, services: ["auth", "notify-api"], sleep: noSleep });
    expect(r.loaded).toEqual(["notify-api"]);
    expect(r.errors[0]!.scope).toBe("auth");
    expect(r.errors[0]!.message).toContain("railway variable list failed");
  });

  test("a transient failure is retried, then succeeds (no error)", () => {
    let calls = 0;
    const run: RailwayRunner = () => {
      calls++;
      return calls < 2 ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: '{"AUTH_AUDIENCE":"operai-suite"}', stderr: "" };
    };
    const r = loadLiveSuite("production", { run, services: ["auth"], sleep: noSleep });
    expect(calls).toBe(2); // failed once, retried, succeeded
    expect(r.loaded).toEqual(["auth"]);
    expect(r.errors).toEqual([]);
  });

  test("the failure message includes stdout when stderr is empty (railway writes there)", () => {
    const run: RailwayRunner = () => ({ code: 1, stdout: "Too Many Requests (429)", stderr: "" });
    const r = loadLiveSuite("production", { run, services: ["auth"], retries: 1, sleep: noSleep });
    expect(r.errors[0]!.message).toContain("Too Many Requests (429)");
  });

  test("empty/garbage output → parse error, service skipped", () => {
    const run: RailwayRunner = () => ({ code: 0, stdout: "<<not json>>", stderr: "" });
    const r = loadLiveSuite("production", { run, services: ["auth"], sleep: noSleep });
    expect(r.loaded).toEqual([]);
    expect(r.errors[0]!.message).toContain("no variables parsed");
  });
});

describe("diffLiteral (deployed value vs committed template)", () => {
  const tpl: SuiteEnv = {
    auth: {
      BETTER_AUTH_URL: "https://auth.operai.welld.io", // literal → compared
      AUTH_AUDIENCE: "${{shared.AUTH_AUDIENCE}}", // ref → skipped
      BETTER_AUTH_SECRET: "${OP:Vault/Item/field}", // secret sentinel → skipped
      PORT: "3001",
    },
  };

  test("a drifted literal → error, with values", () => {
    const live: SuiteEnv = { auth: { BETTER_AUTH_URL: "https://auth.WRONG.io", PORT: "3001" } };
    const f = diffLiteral(tpl, live);
    expect(f.some((x) => x.message.includes("BETTER_AUTH_URL drifted"))).toBe(true);
    expect(f.every((x) => x.level === "error")).toBe(true);
  });

  test("a literal missing from the deployment → error", () => {
    const live: SuiteEnv = { auth: { BETTER_AUTH_URL: "https://auth.operai.welld.io" } }; // PORT missing
    const f = diffLiteral(tpl, live);
    expect(f.some((x) => x.message.includes("PORT is set in the template but MISSING"))).toBe(true);
  });

  test("refs and secret sentinels are never diffed (no false positives)", () => {
    // live differs on AUTH_AUDIENCE and BETTER_AUTH_SECRET, but those are ref/secret in the template.
    const live: SuiteEnv = {
      auth: { BETTER_AUTH_URL: "https://auth.operai.welld.io", PORT: "3001", AUTH_AUDIENCE: "anything", BETTER_AUTH_SECRET: "real-secret" },
    };
    expect(diffLiteral(tpl, live)).toEqual([]);
  });

  test("extra live-only keys are ignored (Railway injects many)", () => {
    const live: SuiteEnv = {
      auth: { BETTER_AUTH_URL: "https://auth.operai.welld.io", PORT: "3001", RAILWAY_PRIVATE_DOMAIN: "auth.railway.internal" },
    };
    expect(diffLiteral(tpl, live)).toEqual([]);
  });
});

describe("secret redaction (Phase 3 holds real deployed secrets in memory)", () => {
  test("a NOTIFY_INTERNAL_TOKEN drift is reported by fingerprint, never the value", () => {
    const suite: SuiteEnv = {
      auth: { NOTIFY_INTERNAL_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "notify-api": { NOTIFY_INTERNAL_TOKEN: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      "refund-api": { NOTIFY_INTERNAL_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    };
    const f = checkSuite(suite, { env: "production", isProdLike: true, resolved: true });
    const drift = f.find((x) => x.message.includes("NOTIFY_INTERNAL_TOKEN is not identical"));
    expect(drift).toBeDefined();
    expect(drift!.message).toContain("sha256:");
    expect(drift!.message).not.toContain("aaaaaaaa");
    expect(drift!.message).not.toContain("bbbbbbbb");
  });
});

describe("linkedProjectId (works around Railway CLI 5.30.1's broken link resolution)", () => {
  const ORIGINAL = process.env["RAILWAY_PROJECT_ID"];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["RAILWAY_PROJECT_ID"];
    else process.env["RAILWAY_PROJECT_ID"] = ORIGINAL;
  });

  test("RAILWAY_PROJECT_ID wins over any on-disk link (CI / manual override)", () => {
    process.env["RAILWAY_PROJECT_ID"] = "env-wins-1234";
    expect(linkedProjectId("/nowhere/at/all")).toBe("env-wins-1234");
  });

  test("an UNEXPANDED ${RAILWAY_PROJECT_ID} placeholder is ignored, not forwarded", () => {
    // The repo's own .envrc can cache this literal when `op read` doesn't
    // resolve; forwarding it gives `Project "${RAILWAY_PROJECT_ID}" not found`.
    process.env["RAILWAY_PROJECT_ID"] = "${RAILWAY_PROJECT_ID}";
    expect(linkedProjectId("/definitely/not/a/linked/repo/path")).toBeNull();
  });

  test("an unlinked path falls back to null (the CLI's own resolution)", () => {
    delete process.env["RAILWAY_PROJECT_ID"];
    // No ancestor of this path can plausibly appear in ~/.railway/config.json.
    expect(linkedProjectId("/definitely/not/a/linked/repo/path")).toBeNull();
  });
});

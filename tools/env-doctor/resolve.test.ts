import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasSecretSentinels, hasTemplates, loadTemplateSuite, toOpInjectTemplate, type OpRunner } from "./resolve";
import { checkSuite } from "./check";

/** Build a throwaway templates root with the given `<service>.env` contents for one env. */
function fixture(env: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "envdoctor-tpl-"));
  const dir = join(root, env);
  mkdirSync(dir, { recursive: true });
  for (const [svc, body] of Object.entries(files)) writeFileSync(join(dir, `${svc}.env`), body);
  return root;
}

// Assembled so a literal 1Password reference never appears in this source file
// (gitleaks' 1password-reference rule) — the resolver's whole job is to PRODUCE these.
const OP = "op:" + "//";

const AUTH_TPL = [
  "BETTER_AUTH_URL=https://auth.operai.welld.io",
  "BETTER_AUTH_SECRET=${OP:Employee/Paperclip - BETTER_AUTH_SECRET/password}",
  "AUTH_AUDIENCE=${{shared.AUTH_AUDIENCE}}",
].join("\n");

describe("env-doctor resolver", () => {
  test("toOpInjectTemplate rewrites ${OP:…} → op://… (and only that)", () => {
    const out = toOpInjectTemplate("A=${OP:Vault/Item/field}\nB=https://x\nC=${{shared.X}}");
    expect(out).toContain(OP + "Vault/Item/field");
    expect(out).toContain("B=https://x");
    expect(out).toContain("${{shared.X}}"); // Railway refs untouched
    expect(out).not.toContain("${OP:");
  });

  test("hasSecretSentinels detects ${OP:…} and is not confused by ${{railway.refs}}", () => {
    expect(hasSecretSentinels(AUTH_TPL)).toBe(true);
    expect(hasSecretSentinels("A=${{shared.X}}\nB=https://y")).toBe(false);
  });

  test("hasTemplates: true for an env dir with .env files, false otherwise", () => {
    const root = fixture("production", { auth: AUTH_TPL });
    expect(hasTemplates("production", root)).toBe(true);
    expect(hasTemplates("staging", root)).toBe(false);
  });

  test("offline (resolve:false): ${OP:…} is left verbatim; resolved=false", () => {
    const root = fixture("production", { auth: AUTH_TPL });
    const r = loadTemplateSuite("production", { dir: root });
    expect(r.loaded).toEqual(["auth"]);
    expect(r.resolved).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.suite.auth!.BETTER_AUTH_SECRET).toBe("${OP:Employee/Paperclip - BETTER_AUTH_SECRET/password}");
    expect(r.suite.auth!.BETTER_AUTH_URL).toBe("https://auth.operai.welld.io");
  });

  test("resolve:true pipes the op-inject template through the runner and parses its stdout", () => {
    const root = fixture("production", { auth: AUTH_TPL });
    const seen: string[] = [];
    const run: OpRunner = (tpl) => {
      seen.push(tpl);
      // Simulate `op inject` resolving the 1Password ref to a real secret.
      const stdout = tpl.replace(OP + "Employee/Paperclip - BETTER_AUTH_SECRET/password", "s3cr3t-value-x".padEnd(32, "x"));
      return { code: 0, stdout, stderr: "" };
    };
    const r = loadTemplateSuite("production", { dir: root, resolve: true, run });
    expect(seen[0]).toContain(OP + "Employee/Paperclip - BETTER_AUTH_SECRET/password");
    expect(r.resolved).toBe(true);
    expect(r.suite.auth!.BETTER_AUTH_SECRET).toBe("s3cr3t-value-x".padEnd(32, "x"));
  });

  test("resolve:true with a failing runner → error surfaced, non-secret values still parsed", () => {
    const root = fixture("production", { auth: AUTH_TPL });
    const run: OpRunner = () => ({ code: 1, stdout: "", stderr: "[ERROR] not signed in" });
    const r = loadTemplateSuite("production", { dir: root, resolve: true, run });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.scope).toBe("auth");
    expect(r.errors[0]!.message).toContain("op inject failed");
    // Falls back to the unresolved template so the URL/audience checks still run.
    expect(r.suite.auth!.BETTER_AUTH_URL).toBe("https://auth.operai.welld.io");
    expect(r.resolved).toBe(false);
  });

  test("a template with no ${OP:…} secrets does not invoke the runner even with resolve:true", () => {
    const root = fixture("production", { "estimai-api": "AUTH_AUDIENCE=${{shared.AUTH_AUDIENCE}}\nPORT=8080" });
    let called = false;
    const run: OpRunner = () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = loadTemplateSuite("production", { dir: root, resolve: true, run });
    expect(called).toBe(false);
    expect(r.resolved).toBe(true);
    expect(r.suite["estimai-api"]!.PORT).toBe("8080");
  });

  // Guards the SHIPPED templates against contract drift — if someone edits a real
  // template into an invalid shape, this fails offline, before any deploy.
  test("the committed production templates pass the doctor offline (no errors, no warnings)", () => {
    const r = loadTemplateSuite("production"); // real TEMPLATES_DIR, offline
    expect(r.errors).toEqual([]);
    expect(r.loaded).toEqual(["auth", "estimai-api", "notify-api", "refund-api"]);
    const findings = checkSuite(r.suite, { env: "production", isProdLike: true, resolved: r.resolved });
    const bad = findings.filter((f) => f.level !== "ok");
    expect(bad).toEqual([]);
  });
});

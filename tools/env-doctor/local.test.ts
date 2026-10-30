import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkSuite } from "./check";
import { loadLocalSuite, parseEnvNul, type CommandRunner, type RunResult } from "./local";

const SECRET = "s3cr3t-value-that-must-never-be-printed";

/** A throwaway repo root: each entry is `[dotenv body | null, hasEnvrc]` for that service. */
function repo(layout: Record<string, [string | null, boolean]>): string {
  const root = mkdtempSync(join(tmpdir(), "envdoctor-local-"));
  for (const [svc, [dotenv, envrc]] of Object.entries(layout)) {
    mkdirSync(join(root, svc), { recursive: true });
    if (dotenv !== null) writeFileSync(join(root, svc, ".env"), dotenv);
    if (envrc) writeFileSync(join(root, svc, ".envrc"), "# exports\n");
  }
  return root;
}

const nul = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\0") + "\0";
const ok = (vars: Record<string, string>): RunResult => ({ code: 0, stdout: nul(vars), stderr: "direnv: loading .envrc\n" });

describe("parseEnvNul", () => {
  test("keeps multi-line values and values containing '='", () => {
    const env = parseEnvNul(nul({ KEY: "-----BEGIN-----\nabc\n-----END-----", URL: "pg://u:p@h/db?a=b" }));
    expect(env.KEY).toBe("-----BEGIN-----\nabc\n-----END-----");
    expect(env.URL).toBe("pg://u:p@h/db?a=b");
  });

  test("ignores entries without a valid key", () => {
    expect(parseEnvNul("=x\0noequals\0 bad key=1\0OK=1\0")).toEqual({ OK: "1" });
  });
});

describe("loadLocalSuite", () => {
  test("a variable that only the direnv-resolved env holds is not reported missing", () => {
    const root = repo({ "notify-api": ["PORT=8081\n", true] });
    const run: CommandRunner = () => ok({ DATABASE_URL: "postgres://x", PORT: "8081" });
    const r = loadLocalSuite({ root, run });
    expect(r.suite["notify-api"]?.DATABASE_URL).toBe("postgres://x");
    expect(r.loaded).toContain("notify-api");
    expect(r.warnings).toEqual([]);
    const findings = checkSuite(r.suite, { env: "local", isProdLike: false, resolved: true });
    expect(findings.some((f) => f.message.includes("DATABASE_URL is missing"))).toBe(false);
  });

  test("direnv values win over the file; file-only keys survive", () => {
    const root = repo({ auth: ["PORT=1\nONLY_FILE=f\n", true] });
    const r = loadLocalSuite({ root, run: () => ok({ PORT: "3001" }) });
    expect(r.suite.auth).toEqual({ ONLY_FILE: "f", PORT: "3001" });
  });

  test("runs `direnv exec <service dir> env -0` with a timeout", () => {
    const root = repo({ auth: [null, true] });
    const seen: { cmd: readonly string[]; timeoutMs: number }[] = [];
    loadLocalSuite({
      root,
      timeoutMs: 1234,
      run: (cmd, o) => (seen.push({ cmd, timeoutMs: o.timeoutMs }), ok({ A: "1" })),
    });
    expect(seen).toEqual([{ cmd: ["direnv", "exec", join(root, "auth"), "env", "-0"], timeoutMs: 1234 }]);
  });

  test("the directory handed to direnv is absolute even for a relative root", () => {
    const prev = process.cwd();
    const root = repo({ auth: [null, true] });
    process.chdir(root);
    try {
      const dirs: string[] = [];
      loadLocalSuite({ run: (cmd) => (dirs.push(cmd[2]!), ok({ A: "1" })) });
      expect(dirs).toHaveLength(1);
      expect(isAbsolute(dirs[0]!)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  test.each([
    ["exit code", { code: 1, stdout: "", stderr: `boom ${SECRET}` } as RunResult, "exited with code 1"],
    ["blocked .envrc", { code: 1, stdout: "", stderr: `direnv: error .envrc is blocked ${SECRET}` } as RunResult, "direnv allow"],
    ["timeout", { code: null, stdout: "", stderr: SECRET, failure: "timeout" } as RunResult, "did not answer within"],
  ])("a direnv failure (%s) falls back to the file with one warning naming the service", (_n, result, reason) => {
    const root = repo({ "refund-api": [`FROM_FILE=${SECRET}\n`, true] });
    const r = loadLocalSuite({ root, run: () => result });
    expect(r.suite["refund-api"]).toEqual({ FROM_FILE: SECRET });
    expect(r.loaded).toContain("refund-api");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.level).toBe("warn");
    expect(r.warnings[0]!.scope).toBe("refund-api");
    expect(r.warnings[0]!.message).toContain("refund-api");
    expect(r.warnings[0]!.message + (r.warnings[0]!.fix ?? "")).toContain(reason);
    // no value, from stderr or from the file, reaches a finding
    expect(JSON.stringify(r.warnings)).not.toContain(SECRET);
  });

  test("direnv not installed, or no .envrc: quiet fallback to the file", () => {
    const root = repo({ auth: ["A=1\n", true], "estimai-api": ["B=2\n", false] });
    const calls: string[] = [];
    const run: CommandRunner = (cmd) => (calls.push(cmd[2]!), { code: null, stdout: "", stderr: "", failure: "missing" });
    const r = loadLocalSuite({ root, run });
    expect(r.suite.auth).toEqual({ A: "1" });
    expect(r.suite["estimai-api"]).toEqual({ B: "2" });
    expect(r.warnings).toEqual([]);
    expect(calls).toEqual([join(root, "auth")]); // never asked for a service without an .envrc
  });

  test("a service with neither a file nor a usable direnv is skipped", () => {
    const root = repo({ auth: [null, true] });
    const r = loadLocalSuite({ root, run: () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(r.skipped).toContain("auth");
    expect(r.loaded).not.toContain("auth");
    expect(r.warnings).toHaveLength(1);
  });

  test("an empty direnv environment counts as a failure, not as 'everything missing'", () => {
    const root = repo({ auth: ["A=1\n", true] });
    const r = loadLocalSuite({ root, run: () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(r.suite.auth).toEqual({ A: "1" });
    expect(r.warnings).toHaveLength(1);
  });

  test("nothing is written to the console while loading, and findings carry no value", () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    const root = repo({ auth: [`TOKEN=${SECRET}\n`, true], "notify-api": [null, true] });
    const run: CommandRunner = (cmd) =>
      cmd[2]!.endsWith("auth") ? ok({ TOKEN: SECRET, KEY: `a\n${SECRET}` }) : { code: 1, stdout: SECRET, stderr: SECRET };
    const r = loadLocalSuite({ root, run });
    const findings = [...r.warnings, ...checkSuite(r.suite, { env: "local", isProdLike: false, resolved: true })];
    expect(JSON.stringify(findings)).not.toContain(SECRET);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

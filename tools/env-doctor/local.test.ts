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

/**
 * A runner for the two commands the loader issues: the ambient baseline (`env -0`, no direnv) and
 * `direnv exec <dir> env -0`. `direnv` may be a result or a function of the service dir.
 */
function runner(opts: {
  ambient?: Record<string, string>;
  ambientResult?: RunResult;
  direnv: RunResult | ((dir: string) => RunResult);
  calls?: (readonly string[])[];
}): CommandRunner {
  return (cmd) => {
    opts.calls?.push(cmd);
    if (cmd[0] === "env") return opts.ambientResult ?? ok(opts.ambient ?? {});
    return typeof opts.direnv === "function" ? opts.direnv(cmd[2]!) : opts.direnv;
  };
}

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
    const run = runner({ direnv: ok({ DATABASE_URL: "postgres://x", PORT: "8081" }) });
    const r = loadLocalSuite({ root, run });
    expect(r.suite["notify-api"]?.DATABASE_URL).toBe("postgres://x");
    expect(r.loaded).toContain("notify-api");
    expect(r.warnings).toEqual([]);
    const findings = checkSuite(r.suite, { env: "local", isProdLike: false, resolved: true });
    expect(findings.some((f) => f.message.includes("DATABASE_URL is missing"))).toBe(false);
  });

  test("direnv values win over the file; file-only keys survive", () => {
    const root = repo({ auth: ["PORT=1\nONLY_FILE=f\n", true] });
    const r = loadLocalSuite({ root, run: runner({ direnv: ok({ PORT: "3001" }) }) });
    expect(r.suite.auth).toEqual({ ONLY_FILE: "f", PORT: "3001" });
  });

  test("runs the ambient baseline, then `direnv exec <service dir> env -0`, both with the timeout", () => {
    const root = repo({ auth: [null, true] });
    const seen: { cmd: readonly string[]; timeoutMs: number }[] = [];
    loadLocalSuite({
      root,
      timeoutMs: 1234,
      run: (cmd, o) => (seen.push({ cmd, timeoutMs: o.timeoutMs }), ok({ A: "1" })),
    });
    expect(seen).toEqual([
      { cmd: ["env", "-0"], timeoutMs: 1234 },
      { cmd: ["direnv", "exec", join(root, "auth"), "env", "-0"], timeoutMs: 1234 },
    ]);
  });

  test("the directory handed to direnv is absolute even for a relative root", () => {
    const prev = process.cwd();
    const root = repo({ auth: [null, true] });
    process.chdir(root);
    try {
      const dirs: string[] = [];
      loadLocalSuite({
        run: (cmd) => {
          if (cmd[0] === "direnv") dirs.push(cmd[2]!);
          return ok({ A: "1" });
        },
      });
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
    const r = loadLocalSuite({ root, run: runner({ direnv: result }) });
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
    const dirs: string[] = [];
    const run: CommandRunner = (cmd) => {
      if (cmd[0] === "direnv") dirs.push(cmd[2]!);
      return cmd[0] === "env" ? ok({}) : { code: null, stdout: "", stderr: "", failure: "missing" };
    };
    const r = loadLocalSuite({ root, run });
    expect(r.suite.auth).toEqual({ A: "1" });
    expect(r.suite["estimai-api"]).toEqual({ B: "2" });
    expect(r.warnings).toEqual([]);
    expect(dirs).toEqual([join(root, "auth")]); // never asked for a service without an .envrc
  });

  test("a service with neither a file nor a usable direnv is skipped", () => {
    const root = repo({ auth: [null, true] });
    const r = loadLocalSuite({ root, run: runner({ direnv: { code: 1, stdout: "", stderr: "" } }) });
    expect(r.skipped).toContain("auth");
    expect(r.loaded).not.toContain("auth");
    expect(r.warnings).toHaveLength(1);
  });

  test("an empty direnv environment counts as a failure, not as 'everything missing'", () => {
    const root = repo({ auth: ["A=1\n", true] });
    const r = loadLocalSuite({ root, run: runner({ direnv: { code: 0, stdout: "", stderr: "" } }) });
    expect(r.suite.auth).toEqual({ A: "1" });
    expect(r.warnings).toHaveLength(1);
  });

  test("nothing is written to the console while loading, and findings carry no value", () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    const root = repo({ auth: [`TOKEN=${SECRET}\n`, true], "notify-api": [null, true] });
    const run = runner({
      ambient: { AMBIENT: SECRET },
      direnv: (dir) => (dir.endsWith("auth") ? ok({ TOKEN: SECRET, KEY: `a\n${SECRET}` }) : { code: 1, stdout: SECRET, stderr: SECRET }),
    });
    const r = loadLocalSuite({ root, run });
    const findings = [...r.warnings, ...checkSuite(r.suite, { env: "local", isProdLike: false, resolved: true })];
    expect(JSON.stringify(findings)).not.toContain(SECRET);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });

  describe("ambient environment masking", () => {
    test("a variable that only the developer's shell holds is not credited to the service", () => {
      const root = repo({ "notify-api": ["PORT=8081\n", true] });
      // The shell exports NOTIFY_INTERNAL_URL; neither the file nor the .envrc does.
      const run = runner({
        ambient: { NOTIFY_INTERNAL_URL: "http://ambient:1", HOME: "/h" },
        direnv: ok({ NOTIFY_INTERNAL_URL: "http://ambient:1", HOME: "/h", DATABASE_URL: "postgres://x" }),
      });
      const r = loadLocalSuite({ root, run });
      expect(r.suite["notify-api"]?.NOTIFY_INTERNAL_URL).toBeUndefined();
      expect(r.suite["notify-api"]?.HOME).toBeUndefined();
      expect(r.suite["notify-api"]?.DATABASE_URL).toBe("postgres://x"); // what the .envrc really adds
      expect(r.suite["notify-api"]?.PORT).toBe("8081"); // the file still counts
    });

    test("a masked variable is reported missing by the checker, not hidden", () => {
      const root = repo({ "refund-api": ["PORT=8082\n", true] });
      const run = runner({
        ambient: { AUTH_AUDIENCE: "ambient-aud" },
        direnv: ok({ AUTH_AUDIENCE: "ambient-aud", DATABASE_URL: "postgres://x" }),
      });
      const r = loadLocalSuite({ root, run });
      const findings = checkSuite(r.suite, { env: "local", isProdLike: false, resolved: true });
      expect(findings.some((f) => f.scope === "refund-api" && f.message.includes("AUTH_AUDIENCE is missing"))).toBe(true);
    });

    test("a variable the .envrc sets or overrides still counts (its value differs from the shell's)", () => {
      const root = repo({ auth: [null, true] });
      const run = runner({ ambient: { PORT: "9999" }, direnv: ok({ PORT: "3001", ONLY_ENVRC: "x" }) });
      expect(loadLocalSuite({ root, run }).suite.auth).toEqual({ PORT: "3001", ONLY_ENVRC: "x" });
    });

    test("the file's own value is kept even when the shell holds the same variable", () => {
      const root = repo({ auth: ["PORT=3001\n", true] });
      const run = runner({ ambient: { PORT: "3001" }, direnv: ok({ PORT: "3001", DATABASE_URL: "postgres://x" }) });
      expect(loadLocalSuite({ root, run }).suite.auth).toEqual({ PORT: "3001", DATABASE_URL: "postgres://x" });
    });

    test("the ambient baseline is taken once for the whole suite, and only if some .envrc exists", () => {
      const calls: (readonly string[])[] = [];
      const root = repo({ auth: [null, true], "notify-api": [null, true], "estimai-api": ["A=1\n", false] });
      loadLocalSuite({ root, run: runner({ direnv: ok({ A: "1" }), calls }) });
      expect(calls.filter((c) => c[0] === "env")).toHaveLength(1);
      expect(calls.filter((c) => c[0] === "direnv")).toHaveLength(2);

      const none: (readonly string[])[] = [];
      loadLocalSuite({ root: repo({ auth: ["A=1\n", false] }), run: runner({ direnv: ok({}), calls: none }) });
      expect(none).toEqual([]);
    });

    test("no baseline means no safe comparison: fall back to the file with a warning, never trust the unfiltered env", () => {
      const root = repo({ auth: [`ONLY_FILE=${SECRET}\n`, true] });
      const run = runner({
        ambientResult: { code: 1, stdout: "", stderr: SECRET },
        direnv: ok({ LEAKY: SECRET }),
      });
      const r = loadLocalSuite({ root, run });
      expect(r.suite.auth).toEqual({ ONLY_FILE: SECRET });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]!.message).toContain("auth");
      expect(JSON.stringify(r.warnings)).not.toContain(SECRET);
    });

    test("an .envrc that adds nothing beyond the shell is not an error when the file has the keys", () => {
      const root = repo({ auth: ["A=1\n", true] });
      const r = loadLocalSuite({ root, run: runner({ ambient: { X: "1" }, direnv: ok({ X: "1" }) }) });
      expect(r.suite.auth).toEqual({ A: "1" });
      expect(r.warnings).toEqual([]);
    });
  });
});

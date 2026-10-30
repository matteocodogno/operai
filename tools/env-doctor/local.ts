/**
 * Local-env loader — what each service ACTUALLY sees on this machine.
 *
 * A service's `.envrc` exports variables its dotenv file does not hold (e.g.
 * `DATABASE_URL`, built from `POSTGRES_*`), so reading only the file reports them
 * missing although the service starts. When `direnv` is installed and the service
 * has an `.envrc`, load the environment as direnv resolves it and overlay it on the
 * file (Bun itself reads the dotenv file, and the process environment wins over it).
 *
 * Values live in memory only. Nothing here prints one, and a failure reason is
 * classified from the exit status — raw direnv/1Password stderr is never echoed.
 * CI never reaches this path: it checks templates (`resolve.ts`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVICES, type ServiceName } from "./manifest";
import type { Finding, SuiteEnv } from "./check";
import { parseEnvFile, type ServiceEnv } from "./parse";

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process could not run to completion: not installed, or killed on timeout. */
  readonly failure?: "missing" | "timeout";
}

/** Runs `cmd` in `cwd`. Injectable so tests never need direnv. */
export type CommandRunner = (cmd: readonly string[], opts: { cwd: string; timeoutMs: number }) => RunResult;

/** A hung 1Password prompt must not block the tool. */
export const DIRENV_TIMEOUT_MS = 20_000;

export const spawnRunner: CommandRunner = (cmd, { cwd, timeoutMs }) => {
  const [bin, ...args] = cmd;
  const p = spawnSync(bin!, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const errCode = (p.error as NodeJS.ErrnoException | undefined)?.code;
  const failure = errCode === "ENOENT" ? "missing" : errCode === "ETIMEDOUT" || p.signal ? "timeout" : undefined;
  return { code: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? "", failure };
};

/** Parse `env -0` output (NUL-separated, so a multi-line PEM value survives). */
export function parseEnvNul(out: string): ServiceEnv {
  const env: ServiceEnv = {};
  for (const entry of out.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

type DirenvOutcome = { env: ServiceEnv } | { skip: true } | { reason: string };

/**
 * What the caller's own shell exports, taken with plain `env -0` (no direnv). `direnv exec` hands its
 * child the caller's WHOLE environment plus what the `.envrc` adds, so without this a variable exported
 * in the developer's shell would look provided by every service and could hide one that is really
 * missing. `null` = could not be established.
 */
function ambientEnv(run: CommandRunner, timeoutMs: number): ServiceEnv | null {
  const r = run(["env", "-0"], { cwd: tmpdir(), timeoutMs });
  if (r.failure || r.code !== 0) return null;
  return parseEnvNul(r.stdout); // an empty shell environment is legitimate: nothing to subtract
}

/** Only what the `.envrc` contributes: new keys, and keys whose value differs from the shell's. */
export function withoutAmbient(resolved: ServiceEnv, ambient: ServiceEnv): ServiceEnv {
  const out: ServiceEnv = {};
  for (const [k, v] of Object.entries(resolved)) if (ambient[k] !== v) out[k] = v;
  return out;
}

function direnvEnv(svcDir: string, run: CommandRunner, timeoutMs: number, ambient: () => ServiceEnv | null): DirenvOutcome {
  if (!existsSync(join(svcDir, ".envrc"))) return { skip: true };
  const base = ambient();
  // Without a baseline nothing separates the .envrc's variables from the shell's: do not guess.
  if (!base) return { reason: "could not read the shell's own environment to tell it apart from the .envrc's" };
  // Absolute dir: a relative one would be resolved against `cwd` a second time.
  const abs = resolve(svcDir);
  const r = run(["direnv", "exec", abs, "env", "-0"], { cwd: abs, timeoutMs });
  if (r.failure === "missing") return { skip: true }; // direnv not installed: quiet fallback
  if (r.failure === "timeout") {
    return { reason: `direnv did not answer within ${Math.round(timeoutMs / 1000)}s (1Password locked?)` };
  }
  if (r.code !== 0) {
    // Classify only — stderr may carry anything, so it is never quoted.
    return /blocked/i.test(r.stderr)
      ? { reason: `direnv has not allowed this .envrc (run \`direnv allow ${svcDir}\`)` }
      : { reason: `direnv exited with code ${r.code ?? "?"} (1Password locked?)` };
  }
  const env = parseEnvNul(r.stdout);
  return Object.keys(env).length ? { env: withoutAmbient(env, base) } : { reason: "direnv returned an empty environment" };
}

export interface LocalLoad {
  suite: SuiteEnv;
  loaded: ServiceName[];
  skipped: ServiceName[];
  warnings: Finding[];
}

/** Each service's dotenv file overlaid with what direnv resolves for it; falls back to the file with one warning. */
export function loadLocalSuite(opts: { root?: string; run?: CommandRunner; timeoutMs?: number } = {}): LocalLoad {
  const { root = ".", run = spawnRunner, timeoutMs = DIRENV_TIMEOUT_MS } = opts;
  const suite: SuiteEnv = {};
  const loaded: ServiceName[] = [];
  const skipped: ServiceName[] = [];
  const warnings: Finding[] = [];
  let baseline: ServiceEnv | null | undefined; // lazy: only worth a process when some service has an .envrc
  const ambient = () => (baseline === undefined ? (baseline = ambientEnv(run, timeoutMs)) : baseline);
  for (const svc of Object.keys(SERVICES) as ServiceName[]) {
    const svcDir = join(root, svc);
    const file = join(svcDir, ".env");
    const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : null;
    const d = direnvEnv(svcDir, run, timeoutMs, ambient);
    if ("env" in d) {
      suite[svc] = { ...fromFile, ...d.env };
      loaded.push(svc);
      continue;
    }
    if ("reason" in d) {
      warnings.push({
        scope: svc,
        level: "warn",
        message: `${svc}: ${d.reason}; ${fromFile ? "checked its dotenv file only" : "no dotenv file either"}`,
        fix: `run \`direnv exec ${svcDir} true\` to see why`,
      });
    }
    if (fromFile) {
      suite[svc] = fromFile;
      loaded.push(svc);
    } else {
      skipped.push(svc);
    }
  }
  return { suite, loaded, skipped, warnings };
}

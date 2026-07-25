/**
 * env-doctor live check (Phase 3) — validate the ACTUAL deployed config, not a
 * file that's assumed to mirror it. Templates (Phase 2) trust that what you
 * commit is what you deployed; this pulls the real variables from Railway and
 * (a) runs the same cross-service invariants on them, and (b) diffs the concrete
 * public literals against the committed template to surface dashboard drift.
 *
 *   mise run env:doctor -- --env production --live
 *
 * SECURITY: `railway variable list --json` prints RAW values, secrets included.
 * We hold them only in memory, never write them to disk, and never echo the raw
 * output — every value that reaches a finding goes through `showValue()` (secrets
 * → sha256 fingerprint). Requires the `railway` CLI logged in (or `RAILWAY_TOKEN`
 * in CI) and the project linked / passed via `--project`.
 */

import { BACKENDS, isRailwayRef, isSecretRef, isSecretVar, type ServiceName } from "./manifest";
import { parseEnvFile, type ServiceEnv } from "./parse";
import { showValue, type Finding, type SuiteEnv } from "./check";

/** How live variables are fetched for one service+environment. Injectable so tests never hit Railway. */
export type RailwayRunner = (service: ServiceName, env: string) => { code: number; stdout: string; stderr: string };

/** Default runner: `railway variable list --service <svc> --environment <env> --json`. */
export const railwayRunner: RailwayRunner = (service, env) => {
  const proc = Bun.spawnSync(
    ["railway", "variable", "list", "--service", service, "--environment", env, "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

/**
 * Parse `railway variable list --json` output into a flat KEY→value map. Tolerant
 * of the shapes Railway has shipped: a flat object `{KEY: "v"}`, an object of
 * `{KEY: {value: "v"}}`, or an array of `{name/key, value}`.
 */
export function parseRailwayJson(stdout: string): ServiceEnv {
  const out: ServiceEnv = {};
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return out;
  }
  const put = (k: unknown, v: unknown) => {
    if (typeof k !== "string") return;
    if (typeof v === "string") out[k] = v;
    else if (v && typeof v === "object" && "value" in v && typeof (v as { value: unknown }).value === "string") {
      out[k] = (v as { value: string }).value;
    }
  };
  if (Array.isArray(data)) {
    for (const row of data) {
      if (row && typeof row === "object") {
        const r = row as Record<string, unknown>;
        put(r["name"] ?? r["key"], "value" in r ? r["value"] : undefined);
      }
    }
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) put(k, v);
  }
  return out;
}

export interface LiveResult {
  readonly suite: SuiteEnv;
  readonly loaded: ServiceName[];
  readonly skipped: ServiceName[];
  readonly errors: Array<{ scope: ServiceName; message: string }>;
}

export interface LoadLiveOptions {
  readonly run?: RailwayRunner;
  /** Restrict to a subset of backends (default: all). */
  readonly services?: ServiceName[];
}

/** Fetch live variables for every backend (frontends have no cross-service invariants yet). */
export function loadLiveSuite(env: string, opts: LoadLiveOptions = {}): LiveResult {
  const run = opts.run ?? railwayRunner;
  const services = opts.services ?? BACKENDS;
  const suite: SuiteEnv = {};
  const loaded: ServiceName[] = [];
  const skipped: ServiceName[] = [];
  const errors: Array<{ scope: ServiceName; message: string }> = [];

  for (const svc of services) {
    const { code, stdout, stderr } = run(svc, env);
    if (code !== 0) {
      errors.push({
        scope: svc,
        message: `railway variable list failed (exit ${code}) — is the CLI logged in and the project linked? ${stderr.trim()}`.trim(),
      });
      skipped.push(svc);
      continue;
    }
    const parsed = parseRailwayJson(stdout);
    if (Object.keys(parsed).length === 0) {
      errors.push({ scope: svc, message: `no variables parsed from railway output for ${svc} (unexpected JSON shape?)` });
      skipped.push(svc);
      continue;
    }
    suite[svc] = parsed;
    loaded.push(svc);
  }
  return { suite, loaded, skipped, errors };
}

/**
 * Drift diff: for every concrete PUBLIC literal the template declares (skipping
 * Railway refs and secret sentinels, which don't have a comparable literal), the
 * live value must match. Catches a dashboard edit that diverged from the
 * committed contract. Never reports "extra" live keys (Railway injects many).
 */
export function diffLiteral(templateSuite: SuiteEnv, liveSuite: SuiteEnv): Finding[] {
  const out: Finding[] = [];
  for (const svc of Object.keys(templateSuite) as ServiceName[]) {
    const tpl = templateSuite[svc];
    const live = liveSuite[svc];
    if (!tpl || !live) continue; // only diff services present on both sides
    for (const [key, tplVal] of Object.entries(tpl)) {
      if (isRailwayRef(tplVal) || isSecretRef(tplVal)) continue; // no comparable literal
      const liveVal = live[key];
      if (liveVal === undefined || liveVal === "") {
        out.push({
          scope: svc,
          level: "error",
          message: `${key} is set in the template but MISSING from the deployed ${svc}`,
          fix: `Set ${key}=${showValue(key, tplVal)} on the ${svc} Railway service (or remove it from the template).`,
        });
      } else if (liveVal !== tplVal) {
        out.push({
          scope: svc,
          level: "error",
          message: `${key} drifted: template=${showValue(key, tplVal)} but deployed=${showValue(key, liveVal)}`,
          fix: `Reconcile ${svc}.${key} — update the Railway dashboard, or the template if the deployed value is intentional.`,
        });
      }
    }
  }
  return out;
}

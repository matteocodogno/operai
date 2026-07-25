#!/usr/bin/env bun
/**
 * env-doctor CLI — validate the suite's cross-service env contract BEFORE deploy.
 *
 *   mise run env:doctor -- --env production            # Phase 2: read committed templates
 *   mise run env:doctor -- --env production --resolve  # + resolve ${OP:…} via `op inject`
 *   mise run env:doctor -- --env production --dir ./x  # Phase 1: pre-resolved <service>.env files
 *
 * Source precedence:
 *   1. `--dir <path>`  — one pre-resolved `<service>.env` per service (Phase 1).
 *   2. `templates/<env>/` — committed per-env templates (Phase 2, the default);
 *      `--resolve` expands `${OP:…}` secrets through `op inject` in memory.
 *   3. `<service>/.env` — each service's own local file (quick local sanity check).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICES, type ServiceName } from "./manifest";
import { checkSuite, hasErrors, type Finding, type SuiteEnv } from "./check";
import { parseEnvFile } from "./parse";
import { hasTemplates, loadTemplateSuite } from "./resolve";

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function parseArgs(argv: string[]): { env: string; dir: string | null; resolve: boolean } {
  let env = "production";
  let dir: string | null = null;
  let resolve = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") env = argv[++i] ?? env;
    else if (argv[i] === "--dir") dir = argv[++i] ?? null;
    else if (argv[i] === "--resolve") resolve = true;
  }
  return { env, dir, resolve };
}

/** Load pre-resolved `<service>.env` files from `dir` (or each service's own `<svc>/.env` when dir is null). */
function loadFromFiles(dir: string | null): { suite: SuiteEnv; loaded: ServiceName[]; skipped: ServiceName[] } {
  const suite: SuiteEnv = {};
  const loaded: ServiceName[] = [];
  const skipped: ServiceName[] = [];
  for (const svc of Object.keys(SERVICES) as ServiceName[]) {
    const path = dir ? join(dir, `${svc}.env`) : join(svc, ".env");
    if (existsSync(path)) {
      suite[svc] = parseEnvFile(readFileSync(path, "utf8"));
      loaded.push(svc);
    } else {
      skipped.push(svc);
    }
  }
  return { suite, loaded, skipped };
}

function print(findings: Finding[], env: string, loaded: ServiceName[], skipped: ServiceName[], source: string): void {
  console.log(C.bold(`\nenv:doctor — ${env}`) + C.dim(`  (source: ${source})`));
  if (loaded.length) console.log(C.dim(`  checked: ${loaded.join(", ")}`));
  if (skipped.length) console.log(C.dim(`  skipped (no env file): ${skipped.join(", ")}`));
  console.log("");

  const byScope = new Map<string, Finding[]>();
  for (const f of findings) (byScope.get(f.scope) ?? byScope.set(f.scope, []).get(f.scope)!).push(f);

  const scopes = [...loaded, "cross-service"].filter((s) => byScope.has(s) || loaded.includes(s as ServiceName));
  for (const scope of scopes) {
    const fs = byScope.get(scope) ?? [];
    const errs = fs.filter((f) => f.level === "error");
    const warns = fs.filter((f) => f.level === "warn");
    const badge = errs.length ? C.red("✗") : warns.length ? C.yellow("!") : C.green("✓");
    console.log(`  ${badge} ${C.bold(scope)}`);
    for (const f of [...errs, ...warns]) {
      const mark = f.level === "error" ? C.red("✗") : C.yellow("!");
      console.log(`      ${mark} ${f.message}`);
      if (f.fix) console.log(`        ${C.dim("→ " + f.fix)}`);
    }
  }

  const errCount = findings.filter((f) => f.level === "error").length;
  const warnCount = findings.filter((f) => f.level === "warn").length;
  console.log("");
  if (errCount) console.log(C.red(`${errCount} error${errCount === 1 ? "" : "s"}`) + `, ${warnCount} warning(s) — fix before deploy.`);
  else if (warnCount) console.log(C.yellow(`0 errors, ${warnCount} warning(s)`) + " — review, then good to deploy.");
  else console.log(C.green("all checks passed."));
}

function main(): void {
  const { env, dir, resolve } = parseArgs(process.argv.slice(2));
  const isProdLike = env === "production" || env === "preview";

  let suite: SuiteEnv;
  let loaded: ServiceName[];
  let skipped: ServiceName[];
  let resolved = true;
  let source: string;
  const extra: Finding[] = [];

  if (dir) {
    // Phase 1: caller-provided, already-resolved <service>.env files.
    ({ suite, loaded, skipped } = loadFromFiles(dir));
    source = `--dir ${dir}`;
  } else if (hasTemplates(env)) {
    // Phase 2: committed per-env templates, optionally op-resolved.
    const r = loadTemplateSuite(env, { resolve });
    suite = r.suite;
    loaded = r.loaded;
    skipped = r.skipped;
    resolved = r.resolved;
    source = resolve ? `templates/${env} (op-resolved)` : `templates/${env}`;
    for (const e of r.errors) extra.push({ scope: e.scope, level: "error", message: e.message });
  } else {
    // Fallback: each service's own local .env (quick local sanity check).
    ({ suite, loaded, skipped } = loadFromFiles(null));
    source = "<service>/.env";
  }

  if (loaded.length === 0) {
    console.error(
      C.red(`\nenv:doctor: no env source found for "${env}".`) +
        `\n  Expected one of:` +
        `\n    • templates/${env}/<service>.env  (committed per-env templates — the default)` +
        `\n    • --dir <path> with <service>.env files (pre-resolved)` +
        `\n    • <service>/.env at the repo root (local sanity check)\n`,
    );
    process.exit(2);
  }

  const findings = [...extra, ...checkSuite(suite, { env, isProdLike, resolved })];
  print(findings, env, loaded, skipped, source);
  if (!resolved && !dir) {
    console.log(
      C.dim(
        `  note: secrets shown as \${OP:…} were not resolved — non-secret checks ran fully; add --resolve to verify them via 1Password.`,
      ),
    );
  }
  process.exit(hasErrors(findings) ? 1 : 0);
}

main();

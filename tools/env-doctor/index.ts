#!/usr/bin/env bun
/**
 * env-doctor CLI (Phase 1) — resolve the suite's config for a target
 * environment and validate the cross-service env contract BEFORE deploy.
 *
 *   mise run env:doctor -- --env production --dir ./resolved
 *
 * `--dir <path>` holds one `<service>.env` per service (plain KEY=VALUE). How
 * you produce them is up to you; the intended prod flow (Phase 2 automates it)
 * is to `op inject` each service's reference template into that dir so the
 * doctor sees resolved values. With no `--dir`, it falls back to each service's
 * own local `.env` (a quick local sanity check; unresolved `op://` refs WARN).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICES, type ServiceName } from "./manifest";
import { checkSuite, hasErrors, type Finding, type ServiceEnv, type SuiteEnv } from "./check";

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function parseEnvFile(text: string): ServiceEnv {
  const out: ServiceEnv = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]!] = val;
  }
  return out;
}

function parseArgs(argv: string[]): { env: string; dir: string | null } {
  let env = "production";
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") env = argv[++i] ?? env;
    else if (argv[i] === "--dir") dir = argv[++i] ?? null;
  }
  return { env, dir };
}

function loadSuite(dir: string | null): { suite: SuiteEnv; loaded: ServiceName[]; skipped: ServiceName[] } {
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

function print(findings: Finding[], env: string, loaded: ServiceName[], skipped: ServiceName[]): void {
  console.log(C.bold(`\nenv:doctor — ${env}`));
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
  const { env, dir } = parseArgs(process.argv.slice(2));
  const isProdLike = env === "production" || env === "preview";
  const { suite, loaded, skipped } = loadSuite(dir);

  if (loaded.length === 0) {
    console.error(
      C.red(`\nenv:doctor: no env files found.`) +
        `\n  Provide --dir <path> with <service>.env files (e.g. op inject each service's template there),` +
        `\n  or run from the repo root where <service>/.env exist for a local check.\n`,
    );
    process.exit(2);
  }

  const findings = checkSuite(suite, { env, isProdLike });
  print(findings, env, loaded, skipped);
  process.exit(hasErrors(findings) ? 1 : 0);
}

main();

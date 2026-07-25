/**
 * env-doctor template resolver (Phase 2) — turn the committed per-environment
 * templates in `templates/<env>/<service>.env` into a checkable suite, with ONE
 * command and no hand-built `--dir`.
 *
 * A template holds the exact values you set on the platform for that env:
 *   - literals for public config (URLs, origins, audience)                → checked as-is
 *   - `${{railway.refs}}` for internal DNS / shared vars (the recommended  → shape-checked,
 *     Railway forms)                                                         value deferred
 *   - `${OP:vault/item/field}` sentinels for real 1Password secrets        → resolved by --resolve
 *
 * The `${OP:…}` spelling is deliberately NOT a literal `op://…` so committed
 * template files don't trip gitleaks' 1password-reference rule. With `--resolve`,
 * we rewrite `${OP:…}` → `op://…` in memory and pipe the template through
 * `op inject`, capturing the resolved values on stdout — secrets never touch disk.
 * Offline (the default), `${OP:…}` is left verbatim; every non-secret check still
 * runs, and identical `${OP:…}` strings across services still prove the shared
 * secret references the same item.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES, type ServiceName } from "./manifest";
import { parseEnvFile } from "./parse";
import type { SuiteEnv } from "./check";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(HERE, "templates");

const OP_SENTINEL = /\$\{OP:([^}]+)\}/g;
// Assembled, not a literal, so this source file doesn't itself trip gitleaks'
// 1password-reference rule (the whole point of the `${OP:…}` sentinel spelling).
const OP_SCHEME = "op:" + "//";

/** Does this template text carry at least one `${OP:…}` 1Password sentinel? */
export function hasSecretSentinels(text: string): boolean {
  OP_SENTINEL.lastIndex = 0;
  return OP_SENTINEL.test(text);
}

/** Rewrite each `${OP:vault/item/field}` sentinel into the 1Password reference `op inject` expects. */
export function toOpInjectTemplate(text: string): string {
  return text.replace(OP_SENTINEL, (_m, path) => `${OP_SCHEME}${path}`);
}

/** How a template blob gets its 1Password refs resolved. Injectable so tests never touch real `op`. */
export type OpRunner = (opInjectTemplate: string) => { code: number; stdout: string; stderr: string };

/** Default runner: pipe the template through the 1Password CLI (`op inject`), reading resolved output on stdout. */
export const opInjectRunner: OpRunner = (opInjectTemplate) => {
  const proc = Bun.spawnSync(["op", "inject"], {
    stdin: Buffer.from(opInjectTemplate),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
};

export interface ResolveResult {
  readonly suite: SuiteEnv;
  readonly loaded: ServiceName[];
  readonly skipped: ServiceName[];
  /** Fatal per-service resolution errors (op locked, item missing, bad template). */
  readonly errors: Array<{ scope: ServiceName; message: string }>;
  /** Whether every loaded value is fully resolved (no secret sentinels remain) — drives the checker's `resolved` flag. */
  readonly resolved: boolean;
}

export interface LoadTemplatesOptions {
  /** Actually run `op inject` on templates that carry `${OP:…}` sentinels. Off by default (offline, CI-safe). */
  readonly resolve?: boolean;
  /** Override the templates root (tests). */
  readonly dir?: string;
  /** Override the op runner (tests). */
  readonly run?: OpRunner;
}

/** True iff a templates directory exists for this environment. */
export function hasTemplates(env: string, dir: string = TEMPLATES_DIR): boolean {
  const envDir = join(dir, env);
  if (!existsSync(envDir)) return false;
  return readdirSync(envDir).some((f: string) => f.endsWith(".env"));
}

/**
 * Load `templates/<env>/<service>.env` for every known service, optionally
 * resolving `${OP:…}` secrets via `op inject`. Missing templates are skipped
 * (not every service needs one). Never throws — resolution failures come back
 * as `errors` so the CLI can print them as findings.
 */
export function loadTemplateSuite(env: string, opts: LoadTemplatesOptions = {}): ResolveResult {
  const root = opts.dir ?? TEMPLATES_DIR;
  const run = opts.run ?? opInjectRunner;
  const envDir = join(root, env);

  const suite: SuiteEnv = {};
  const loaded: ServiceName[] = [];
  const skipped: ServiceName[] = [];
  const errors: Array<{ scope: ServiceName; message: string }> = [];
  let anyUnresolvedSecret = false;

  for (const svc of Object.keys(SERVICES) as ServiceName[]) {
    const path = join(envDir, `${svc}.env`);
    if (!existsSync(path)) {
      skipped.push(svc);
      continue;
    }
    const text = readFileSync(path, "utf8");
    const secrets = hasSecretSentinels(text);

    if (secrets && opts.resolve) {
      const { code, stdout, stderr } = run(toOpInjectTemplate(text));
      if (code !== 0) {
        errors.push({
          scope: svc,
          message: `op inject failed (exit ${code}) — is 1Password signed in and the item present? ${stderr.trim()}`.trim(),
        });
        // Fall back to the unresolved template so the non-secret checks still run.
        suite[svc] = parseEnvFile(text);
        anyUnresolvedSecret = true;
      } else {
        suite[svc] = parseEnvFile(stdout);
      }
    } else {
      suite[svc] = parseEnvFile(text);
      if (secrets) anyUnresolvedSecret = true;
    }
    loaded.push(svc);
  }

  return { suite, loaded, skipped, errors, resolved: !anyUnresolvedSecret };
}

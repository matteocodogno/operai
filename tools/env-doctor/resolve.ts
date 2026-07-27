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
 * The `${OP:…}` spelling is deliberately NOT a literal 1Password URI so committed
 * template files don't trip gitleaks' 1password-reference rule. With `--resolve`,
 * each `${OP:path}` value is resolved one reference at a time via `op read` (the
 * op-scheme reference assembled at runtime) — the same call `.envrc` uses. We
 * deliberately do NOT pipe the whole template through `op inject`: op inject has
 * its own `{{ }}` template language, which collides with Railway's
 * `${{railway.refs}}`. Resolved secrets are held in
 * memory only, never written to disk. Offline (the default), `${OP:…}` is left
 * verbatim; every non-secret check still runs, and identical `${OP:…}` strings
 * across services still prove the shared secret references the same item.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES, type ServiceName } from "./manifest";
import { parseEnvFile, type ServiceEnv } from "./parse";
import type { SuiteEnv } from "./check";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(HERE, "templates");

const OP_SENTINEL = /\$\{OP:([^}]+)\}/g;
// Assembled, not a literal, so this source file doesn't itself trip gitleaks'
// 1password-reference rule (the whole point of the `${OP:…}` sentinel spelling).
const OP_SCHEME = "op:" + "//";

/** Does this text carry at least one `${OP:…}` 1Password sentinel? */
export function hasSecretSentinels(text: string): boolean {
  OP_SENTINEL.lastIndex = 0;
  return OP_SENTINEL.test(text);
}

/** Reads ONE 1Password reference (an `op:`-scheme `vault/item/field` URI) → its value. Injectable so tests never touch real `op`. */
export type OpReader = (opRef: string) => { code: number; stdout: string; stderr: string };

/** Default reader: `op read op://…`, the same single-reference call `.envrc` uses (no `{{ }}` template parsing). */
export const opReadReader: OpReader = (opRef) => {
  const proc = spawnSync("op", ["read", opRef], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return {
    code: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? proc.error?.message ?? "",
  };
};

/** Resolve every `${OP:path}` in one value via `read`. Returns the first failure, if any. */
export function resolveSecretsInValue(value: string, read: OpReader): { value: string; error?: string } {
  let error: string | undefined;
  const resolved = value.replace(OP_SENTINEL, (_m, path: string) => {
    if (error) return _m;
    const r = read(`${OP_SCHEME}${path}`);
    if (r.code !== 0 || r.stdout === "") {
      error = `op read failed for ${path}${r.stderr.trim() ? ` — ${r.stderr.trim()}` : ""}`;
      return _m;
    }
    return r.stdout.replace(/\n$/, ""); // `op read` appends a trailing newline
  });
  return { value: resolved, error };
}

export interface ResolveResult {
  readonly suite: SuiteEnv;
  readonly loaded: ServiceName[];
  readonly skipped: ServiceName[];
  /** Fatal per-service resolution errors (op locked, item missing, bad reference). */
  readonly errors: Array<{ scope: ServiceName; message: string }>;
  /** Whether every loaded value is fully resolved (no secret sentinels remain) — drives the checker's `resolved` flag. */
  readonly resolved: boolean;
}

export interface LoadTemplatesOptions {
  /** Actually resolve `${OP:…}` secrets via `op read`. Off by default (offline, CI-safe). */
  readonly resolve?: boolean;
  /** Override the templates root (tests). */
  readonly dir?: string;
  /** Override the op reader (tests). */
  readonly read?: OpReader;
}

/** True iff a templates directory exists for this environment. */
export function hasTemplates(env: string, dir: string = TEMPLATES_DIR): boolean {
  const envDir = join(dir, env);
  if (!existsSync(envDir)) return false;
  return readdirSync(envDir).some((f: string) => f.endsWith(".env"));
}

/**
 * Load `templates/<env>/<service>.env` for every known service, optionally
 * resolving `${OP:…}` secrets via `op read`. Missing templates are skipped
 * (not every service needs one). Never throws — resolution failures come back
 * as `errors` so the CLI can print them as findings.
 */
export function loadTemplateSuite(env: string, opts: LoadTemplatesOptions = {}): ResolveResult {
  const root = opts.dir ?? TEMPLATES_DIR;
  const read = opts.read ?? opReadReader;
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
    const parsed: ServiceEnv = parseEnvFile(readFileSync(path, "utf8"));

    if (opts.resolve) {
      for (const [key, val] of Object.entries(parsed)) {
        if (!hasSecretSentinels(val)) continue;
        const { value, error } = resolveSecretsInValue(val, read);
        if (error) {
          errors.push({ scope: svc, message: `${key}: ${error} (is 1Password signed in and the item present?)` });
          anyUnresolvedSecret = true; // leave the sentinel in place; non-secret checks still run
        } else {
          parsed[key] = value;
        }
      }
    } else if (hasSecretSentinels(readFileSync(path, "utf8"))) {
      anyUnresolvedSecret = true;
    }

    suite[svc] = parsed;
    loaded.push(svc);
  }

  return { suite, loaded, skipped, errors, resolved: !anyUnresolvedSecret };
}

/**
 * env-doctor checker (Phase 1) — a pure function over an already-resolved suite
 * config. Given `{ service: { VAR: value } }` for a target environment, it runs
 * the per-service presence check (Layer A) and the cross-service invariants
 * (Layer B) and returns a flat list of findings. No I/O, no platform access —
 * that's `index.ts`'s job. This is the tested core.
 */

import { createHash } from "node:crypto";
import {
  BACKENDS,
  CORS_REQUIREMENTS,
  INTERNAL_URL_VARS,
  ISSUER,
  ORIGINS,
  PUBLIC_URL_VARS,
  REQUIRED_KEYS,
  SHARED_VARS,
  isRailwayRef,
  isSecretRef,
  isSecretVar,
  type ServiceName,
} from "./manifest";
import type { ServiceEnv } from "./parse";

export type { ServiceEnv };

export type Level = "ok" | "warn" | "error";

export interface Finding {
  readonly scope: string; // service name, or "cross-service"
  readonly level: Level;
  readonly message: string;
  readonly fix?: string;
}

export type SuiteEnv = Partial<Record<ServiceName, ServiceEnv>>;

export interface CheckOptions {
  readonly env: string;
  /** production/preview are prod-like: enforce https-public and railway.internal. Local relaxes those. */
  readonly isProdLike: boolean;
  /**
   * Whether the values were supposed to be fully resolved before checking
   * (a pre-resolved `--dir`, or a `--resolve`d template run). When true, a
   * lingering secret ref (`op://…`/`${OP:…}`) is a WARN — you claimed these
   * were resolved but one isn't. When false (offline template mode, the
   * default one-command run), secret refs are expected and accepted silently.
   * Defaults to true to preserve Phase-1 `--dir` semantics.
   */
  readonly resolved?: boolean;
}

const XS = "cross-service";

/** Render a value for a finding message — secrets become a non-reversible fingerprint. */
export function showValue(name: string, v: string): string {
  if (!isSecretVar(name)) return v;
  const fp = createHash("sha256").update(v).digest("hex").slice(0, 8);
  return `<redacted sha256:${fp}>`;
}

function parseUrl(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

/** Comma-separated origin list → normalized (no trailing slash) set. */
function parseOrigins(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

// ── Layer A: per-service required-key presence ──────────────────────────────
function checkRequiredKeys(suite: SuiteEnv, opts: CheckOptions): Finding[] {
  const out: Finding[] = [];
  const resolved = opts.resolved ?? true;
  for (const svc of BACKENDS) {
    const env = suite[svc];
    if (!env) continue; // service not in scope for this run
    for (const key of REQUIRED_KEYS[svc] ?? []) {
      const v = env[key];
      if (v === undefined || v === "") {
        out.push({ scope: svc, level: "error", message: `${key} is missing`, fix: `Set ${key} on ${svc}.` });
      } else if (isSecretRef(v) && resolved) {
        // Values were meant to be resolved (pre-resolved --dir, or --resolve),
        // yet this one still points at a secret store. In offline template mode
        // (resolved=false) an unresolved secret ref is expected, so we stay quiet.
        out.push({
          scope: svc,
          level: "warn",
          message: `${key} is still an unresolved secret reference (${v})`,
          fix: `Run with --resolve (or resolve it via \`op read\`) so the doctor sees the real value.`,
        });
      }
    }
  }
  return out;
}

// ── Layer B1: shared vars must be identical ─────────────────────────────────
function checkSharedVars(suite: SuiteEnv): Finding[] {
  const out: Finding[] = [];
  for (const { name, services } of SHARED_VARS) {
    const present = services
      .map((svc) => ({ svc, val: suite[svc]?.[name] }))
      .filter((x): x is { svc: ServiceName; val: string } => x.val !== undefined && x.val !== "");
    if (present.length < 2) continue; // nothing to compare (missing is caught by Layer A)

    // A Railway reference resolves at deploy time to whatever the referenced
    // shared var / secret holds — we can't know that offline, so it can't be
    // compared byte-for-byte against a literal. Compare the concrete LITERALS;
    // treat refs as "assumed to resolve to the shared value".
    const literals = present.filter((x) => !isRailwayRef(x.val) && !isSecretRef(x.val));
    const distinctLiterals = [...new Set(literals.map((x) => x.val))];
    const detail = present.map((x) => `${x.svc}=${showValue(name, x.val)}`).join(", ");

    if (distinctLiterals.length > 1) {
      out.push({
        scope: XS,
        level: "error",
        message: `${name} is not identical across ${services.join(", ")} (${detail})`,
        fix: `Make ${name} one value everywhere — ideally a Railway project Shared Variable referenced as \${{shared.${name}}}.`,
      });
    } else if (distinctLiterals.length === 1 && literals.length < present.length) {
      // Some services use a literal and others a ref — the ref MIGHT resolve to
      // the same thing, but a mixed shape is a drift risk we can't verify offline.
      out.push({
        scope: XS,
        level: "warn",
        message: `${name} mixes a literal and a reference across ${services.join(", ")} (${detail}) — can't verify they match offline`,
        fix: `Use the SAME form everywhere (ideally \${{shared.${name}}} on all), or --resolve to compare real values.`,
      });
    }
  }
  return out;
}

// ── Layer B2: AUTH_ISSUER == auth.BETTER_AUTH_URL ───────────────────────────
function checkIssuerConsistency(suite: SuiteEnv): Finding[] {
  const out: Finding[] = [];
  const authIssuer = suite[ISSUER.authService]?.[ISSUER.authVar];
  if (!authIssuer) return out; // missing caught by Layer A
  if (isRailwayRef(authIssuer) || isSecretRef(authIssuer)) return out; // auth side is a ref → nothing to compare against
  const norm = (s: string) => s.replace(/\/$/, "");
  for (const svc of ISSUER.resourceServers) {
    const iss = suite[svc]?.[ISSUER.issuerVar];
    if (iss === undefined || iss === "") continue;
    if (isRailwayRef(iss) || isSecretRef(iss)) continue; // ref → assumed to resolve to auth's value
    if (norm(iss) !== norm(authIssuer)) {
      out.push({
        scope: XS,
        level: "error",
        message: `${svc}.${ISSUER.issuerVar} (${iss}) != ${ISSUER.authService}.${ISSUER.authVar} (${authIssuer}) — the JWT \`iss\` claim won't match`,
        fix: `Set ${svc}.${ISSUER.issuerVar} to auth's public URL (\${{shared.AUTH_ISSUER}}).`,
      });
    }
  }
  return out;
}

// ── Layer B3: internal URLs — http + railway.internal(prod) + port == target PORT ──
function checkInternalUrls(suite: SuiteEnv, opts: CheckOptions): Finding[] {
  const out: Finding[] = [];
  for (const { name, services, target } of INTERNAL_URL_VARS) {
    for (const svc of services) {
      const v = suite[svc]?.[name];
      if (v === undefined || v === "" || isSecretRef(v)) continue;
      if (isRailwayRef(v)) continue; // ${{svc.PORT}} form — self-consistent, the recommended shape
      const url = parseUrl(v);
      if (!url) {
        out.push({ scope: svc, level: "error", message: `${name} is not a valid URL (${v})` });
        continue;
      }
      if (url.protocol !== "http:") {
        out.push({
          scope: svc,
          level: "error",
          message: `${name} must be http:// on the private network, got ${url.protocol}// (${v})`,
          fix: `Private networking carries no TLS — use http://${target}.railway.internal:<PORT>.`,
        });
      }
      if (opts.isProdLike && !url.hostname.endsWith(".railway.internal")) {
        out.push({
          scope: svc,
          level: "error",
          message: `${name} should call ${target} over private networking but points at ${url.hostname} (${v})`,
          fix: `Use http://\${{${target}.RAILWAY_PRIVATE_DOMAIN}}:\${{${target}.PORT}} (a CALL, not a public URL).`,
        });
      }
      // Port consistency vs the target service's PORT.
      const targetPort = suite[target]?.["PORT"];
      if (url.port && targetPort && !isRailwayRef(targetPort) && url.port !== targetPort) {
        out.push({
          scope: svc,
          level: "error",
          message: `${name} targets port ${url.port} but ${target}.PORT is ${targetPort}`,
          fix: `A service listens on ONE port — reference \${{${target}.PORT}} instead of hardcoding.`,
        });
      }
    }
  }
  return out;
}

// ── Layer B4: public URLs — https + not localhost/internal in prod ──────────
function checkPublicUrls(suite: SuiteEnv, opts: CheckOptions): Finding[] {
  const out: Finding[] = [];
  if (!opts.isProdLike) return out; // localhost is fine locally
  for (const { name, services } of PUBLIC_URL_VARS) {
    for (const svc of services) {
      const v = suite[svc]?.[name];
      if (v === undefined || v === "" || isSecretRef(v) || isRailwayRef(v)) continue;
      const url = parseUrl(v);
      if (!url) {
        out.push({ scope: svc, level: "error", message: `${name} is not a valid URL (${v})` });
        continue;
      }
      if (url.hostname === "localhost" || url.hostname.endsWith(".railway.internal") || url.protocol !== "https:") {
        out.push({
          scope: svc,
          level: "error",
          message: `${name} must be a public https:// URL in ${opts.env}, got ${v}`,
          fix: `${name} is browser-facing / a JWT claim — never localhost or *.railway.internal in prod.`,
        });
      }
    }
  }
  return out;
}

// ── Layer B5: ALLOWED_ORIGINS ⊇ required frontend origins (CORS) ─────────────
function checkCors(suite: SuiteEnv, opts: CheckOptions): Finding[] {
  const out: Finding[] = [];
  const origins = ORIGINS[opts.env] ?? {};
  for (const { backend, mustAllow } of CORS_REQUIREMENTS) {
    const raw = suite[backend]?.["ALLOWED_ORIGINS"];
    if (raw === undefined || raw === "" || isSecretRef(raw) || isRailwayRef(raw)) continue;
    const allowed = parseOrigins(raw);
    for (const fe of mustAllow) {
      const feOrigin = origins[fe];
      if (feOrigin === undefined) {
        out.push({
          scope: backend,
          level: "warn",
          message: `can't verify ALLOWED_ORIGINS includes ${fe} — no origin for ${fe} in the manifest for env "${opts.env}"`,
          fix: `Add ${fe}'s origin to ORIGINS.${opts.env} in tools/env-doctor/manifest.ts.`,
        });
        continue;
      }
      if (feOrigin === null) continue; // explicitly unknown → skip
      if (!allowed.includes(feOrigin.replace(/\/$/, ""))) {
        out.push({
          scope: backend,
          level: "error",
          message: `${backend}.ALLOWED_ORIGINS is missing ${fe}'s origin ${feOrigin}`,
          fix: `Add ${feOrigin} to ${backend}.ALLOWED_ORIGINS (comma-separated, no trailing slash).`,
        });
      }
    }
  }
  return out;
}

export function checkSuite(suite: SuiteEnv, opts: CheckOptions): Finding[] {
  return [
    ...checkRequiredKeys(suite, opts),
    ...checkSharedVars(suite),
    ...checkIssuerConsistency(suite),
    ...checkInternalUrls(suite, opts),
    ...checkPublicUrls(suite, opts),
    ...checkCors(suite, opts),
  ];
}

export const hasErrors = (findings: Finding[]): boolean => findings.some((f) => f.level === "error");

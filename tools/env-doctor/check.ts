/**
 * env-doctor checker (Phase 1) — a pure function over an already-resolved suite
 * config. Given `{ service: { VAR: value } }` for a target environment, it runs
 * the per-service presence check (Layer A) and the cross-service invariants
 * (Layer B) and returns a flat list of findings. No I/O, no platform access —
 * that's `index.ts`'s job. This is the tested core.
 */

import {
  BACKENDS,
  CORS_REQUIREMENTS,
  INTERNAL_URL_VARS,
  ISSUER,
  ORIGINS,
  PUBLIC_URL_VARS,
  REQUIRED_KEYS,
  SHARED_VARS,
  isOpRef,
  isRailwayRef,
  type ServiceName,
} from "./manifest";

export type Level = "ok" | "warn" | "error";

export interface Finding {
  readonly scope: string; // service name, or "cross-service"
  readonly level: Level;
  readonly message: string;
  readonly fix?: string;
}

export type ServiceEnv = Record<string, string>;
export type SuiteEnv = Partial<Record<ServiceName, ServiceEnv>>;

export interface CheckOptions {
  readonly env: string;
  /** production/preview are prod-like: enforce https-public and railway.internal. Local relaxes those. */
  readonly isProdLike: boolean;
}

const XS = "cross-service";

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
function checkRequiredKeys(suite: SuiteEnv): Finding[] {
  const out: Finding[] = [];
  for (const svc of BACKENDS) {
    const env = suite[svc];
    if (!env) continue; // service not in scope for this run
    for (const key of REQUIRED_KEYS[svc] ?? []) {
      const v = env[key];
      if (v === undefined || v === "") {
        out.push({ scope: svc, level: "error", message: `${key} is missing`, fix: `Set ${key} on ${svc}.` });
      } else if (isOpRef(v)) {
        out.push({
          scope: svc,
          level: "warn",
          message: `${key} is an unresolved 1Password reference (${v})`,
          fix: `Resolve it first (\`op inject\`) so the doctor can validate the real value.`,
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
      .filter((x) => x.val !== undefined && x.val !== "");
    if (present.length < 2) continue; // nothing to compare (missing is caught by Layer A)
    const distinct = [...new Set(present.map((x) => x.val))];
    if (distinct.length > 1) {
      const detail = present.map((x) => `${x.svc}=${x.val}`).join(", ");
      out.push({
        scope: XS,
        level: "error",
        message: `${name} is not identical across ${services.join(", ")} (${detail})`,
        fix: `Make ${name} one value everywhere — ideally a Railway project Shared Variable referenced as \${{shared.${name}}}.`,
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
  const norm = (s: string) => s.replace(/\/$/, "");
  for (const svc of ISSUER.resourceServers) {
    const iss = suite[svc]?.[ISSUER.issuerVar];
    if (iss === undefined || iss === "") continue;
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
      if (v === undefined || v === "" || isOpRef(v)) continue;
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
      if (v === undefined || v === "" || isOpRef(v) || isRailwayRef(v)) continue;
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
    if (raw === undefined || raw === "" || isOpRef(raw)) continue;
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
    ...checkRequiredKeys(suite),
    ...checkSharedVars(suite),
    ...checkIssuerConsistency(suite),
    ...checkInternalUrls(suite, opts),
    ...checkPublicUrls(suite, opts),
    ...checkCors(suite, opts),
  ];
}

export const hasErrors = (findings: Finding[]): boolean => findings.some((f) => f.level === "error");

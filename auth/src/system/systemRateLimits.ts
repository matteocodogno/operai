/**
 * The limits of the internal endpoints every backend calls —
 * `POST /system/service-token` (ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049) and `POST /system/users/contact`
 * (ADR 20261101-notify-api-resolves-email-notice-address-from-auth) — as decided by specs/20261111-push-notifications US-7 and ADR 20261112-system-endpoints-limited-per-verified-service.
 *
 * THE RULE: a rate limit is keyed by the identity it is meant to bound, and a
 * credential is verified before any count is consulted. The routes verify
 * first, then consult exactly ONE of:
 *
 *   serviceToken     a VALID service-token credential, keyed by the verified
 *                    `system:<clientId>`           (300 per window by default)
 *   usersContact     a VALID contact-lookup credential, keyed by the verified
 *                    JWT `sub`                      (600 per window)
 *   legalEntities    a VALID legal-entity read credential (`legal-entities:read`), keyed by the verified `sub`
 *                    (300 per window; a fixed default, no env variable: specs/20261117-legal-entities, T6, AC-3.2)
 *   teams            a VALID teams-read credential (`teams:read`, bound to its reader by `TEAM_READERS`) asking by
 *                    `ids`, keyed by the verified `sub` (3 000 per window: members and access bits that decisions
 *                    and the project view read; specs/20261126-teams D11)
 *   teamsOptions     the same credential asking the options mode (`state=active`, with or without `q`), keyed by the
 *                    verified `sub` (1 500 per window): its own count, so a search driven by what a person types
 *                    cannot spend the budget the decisions depend on (D11, D13)
 *   invalidCredentials  an INVALID credential of any of these endpoints, keyed by
 *                    the source address — the only key available before there
 *                    is an identity. ONE counter shared by all routes (20 per
 *                    window), capped at `INVALID_MAX_KEYS` keys.
 *
 * Why not one address bucket (the old shape): on Railway's private network no
 * forwarded address reaches `auth`, so every service is the same "direct"
 * caller and the suite shared one bucket of 20 (D-1). Why not key the
 * pre-verification count by the claimed client id: anyone could then lock a
 * service out by its guessable name (ADR 20261112-system-endpoints-limited-per-verified-service option E).
 *
 * Both refusals are the SAME response, built only by `tooManyRequests`: its
 * status, body and headers are a function of the request path and the window,
 * never of which limiter refused or how full it is, and `Retry-After` is the
 * fixed window length (a bucket's remainder would tell a sender whether its
 * credential was valid). A refused attempt is never recorded (the limiter's
 * `consume` semantics), so retrying during a refusal does not extend it.
 *
 * Per process, like the suite's other limiters (ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt): a second `auth`
 * instance would double every allowance (R17). `RateLimiter` is the seam for a
 * shared store.
 */

import type { Context } from "hono";
import { env } from "../lib/env";
import { createSlidingWindowRateLimiter, type RateLimiter } from "../lib/rateLimiter";

/** Distinct source addresses held for the invalid-credential count; past this, new ones share one overflow key. */
export const INVALID_MAX_KEYS = 50_000;

/** Legal-entity reads per calling service per window: a consumer caches 30 s, so ~20 per 10 min is the steady rate. */
export const LEGAL_ENTITIES_SERVICE_LIMIT = 300;

/**
 * Team reads by id per calling service per window (specs/20261126-teams D11): the cached host path is ~20 per
 * window and every project page view or write costs one fresh call, so 3 000 leaves ten times the headroom.
 */
export const TEAMS_SERVICE_LIMIT = 3000;

/** Options-mode (attach search) reads per calling service per window (D11): a handful per attach session. */
export const TEAMS_OPTIONS_SERVICE_LIMIT = 1500;

export interface SystemRateLimitConfig {
  /** Service tokens per calling service per window (AC-7.1). */
  serviceTokenLimit: number;
  /** Contact lookups per calling service per window (AC-7.2). */
  usersContactLimit: number;
  /** Legal-entity reads per calling service per window (specs/20261117-legal-entities AC-3.2). */
  legalEntitiesLimit: number;
  /** Team reads by id per calling service per window (specs/20261126-teams D11). */
  teamsLimit: number;
  /** Team options-mode reads per calling service per window (specs/20261126-teams D11). */
  teamsOptionsLimit: number;
  /** Invalid-credential requests per source address per window, all routes together (AC-7.5). */
  invalidLimit: number;
  /** The one window of all four limiters, and the source of `Retry-After`. */
  windowMs: number;
}

export type SystemRoute = "service-token" | "users/contact" | "legal-entities" | "teams";

export interface SystemRateLimits {
  invalidCredentials: RateLimiter;
  serviceToken: RateLimiter;
  usersContact: RateLimiter;
  legalEntities: RateLimiter;
  teams: RateLimiter;
  teamsOptions: RateLimiter;
  windowMs: number;
  /** The ONLY 429 of the /system routes. */
  tooManyRequests(c: Context): Response;
  /**
   * Bounded log line for a refusal, at most one per key per window. `invalid`
   * logs no key (an address); `allowance` logs the verified `system:<id>`.
   */
  logRefusal(kind: "invalid" | "allowance", route: SystemRoute, key: string): void;
}

export function createSystemRateLimits(
  options: { now?: () => number; config?: Partial<SystemRateLimitConfig> } = {},
): SystemRateLimits {
  const now = options.now ?? Date.now;
  const config: SystemRateLimitConfig = {
    serviceTokenLimit: env.SERVICE_TOKEN_SERVICE_LIMIT,
    usersContactLimit: env.USERS_CONTACT_SERVICE_LIMIT,
    legalEntitiesLimit: LEGAL_ENTITIES_SERVICE_LIMIT,
    teamsLimit: TEAMS_SERVICE_LIMIT,
    teamsOptionsLimit: TEAMS_OPTIONS_SERVICE_LIMIT,
    invalidLimit: env.SYSTEM_INVALID_CREDENTIAL_LIMIT,
    windowMs: env.SYSTEM_RATE_WINDOW_MS,
    ...options.config,
  };
  const { windowMs } = config;

  // The limiter reads the clock from the injected function unless the caller passes one.
  const create = (limit: number, maxKeys?: number): RateLimiter => {
    const inner = createSlidingWindowRateLimiter({
      limit,
      windowMs,
      ...(maxKeys === undefined ? {} : { maxKeys }),
    });
    return { consume: (key, at) => inner.consume(key, at ?? now()) };
  };

  const retryAfter = String(Math.max(1, Math.ceil(windowMs / 1000)));

  const lastLogged = new Map<string, number>();

  return {
    invalidCredentials: create(config.invalidLimit, INVALID_MAX_KEYS),
    serviceToken: create(config.serviceTokenLimit),
    usersContact: create(config.usersContactLimit),
    legalEntities: create(config.legalEntitiesLimit),
    teams: create(config.teamsLimit),
    teamsOptions: create(config.teamsOptionsLimit),
    windowMs,

    tooManyRequests(c) {
      return c.json(
        {
          type: "https://httpstatuses.com/429",
          title: "Too Many Requests",
          status: 429,
          detail: "Too many requests. Try again later.",
          instance: c.req.path,
          code: "rate_limited",
        },
        429,
        { "Retry-After": retryAfter, "Cache-Control": "no-store" },
      );
    },

    logRefusal(kind, route, key) {
      const at = now();
      const id = `${kind}|${route}|${key}`;
      const last = lastLogged.get(id);
      if (last !== undefined && at - last < windowMs) return;
      if (lastLogged.size >= INVALID_MAX_KEYS) {
        for (const [k, t] of lastLogged) if (at - t >= windowMs) lastLogged.delete(k);
        // Still full: stay silent rather than grow (the refusals themselves are already bounded).
        if (lastLogged.size >= INVALID_MAX_KEYS) return;
      }
      lastLogged.set(id, at);
      console.warn(
        kind === "invalid"
          ? `[system/${route}] invalid-credential limit reached`
          : `[system/${route}] allowance exhausted caller=${key}`,
      );
    },
  };
}

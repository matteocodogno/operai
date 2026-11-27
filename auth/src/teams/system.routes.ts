/**
 * The service read of teams (specs/20261126-teams, T9; AC-1.5, AC-1.6, AC-4.1, AC-4.7; plan D1, D11, D13):
 *
 *   GET /system/teams?ids=<id>,<id>,…           ids mode: 1..50 distinct team ids, with their members and each
 *                                               member's access to the reader's app
 *   GET /system/teams?state=active[&q=<text>]   options mode: the active teams' names, optionally searched
 *
 * A team grants nothing; this route only reports what an admin put in it. It is a narrow, purpose-scoped channel for
 * one consumer (projects-api), not a user route: the consumers that need it are mostly called AS an ordinary user,
 * and a user route would spend that person's own budget and need a caller gate that names a Projects permission.
 *
 * AUTH: a service JWT, and nothing else (a person's session cookie or user JWT opens nothing here). Verified in
 * process exactly as `legalEntities/system.routes.ts` does it: RS256 pinned, issuer = BETTER_AUTH_URL, `aud` =
 * SERVICE_AUDIENCE (a user JWT carries AUTH_AUDIENCE and fails), required exp/sub/aud/iss, `sub` of the form
 * `system:<client>`, `teams:read` in the space-delimited `scope`, over the same cached key set (`jwksFromAuth`). Then
 * the `sub` is looked up in `TEAM_READERS`, a binding in CODE: a client that holds the scope but is not bound is
 * refused like any other. EVERY failure answers the same frozen 401, byte for byte, whichever form of the route and
 * whatever the query: the body carries no request path or text.
 *
 * THE APP IS DERIVED, NEVER ASKED: `appAccess` means "holds `(<app>, "access")`", and `<app>` is the one
 * `TEAM_READERS` binds to the verified `sub` (`system:projects-api` -> `projects`). No parameter, header or body field
 * names an app, so no caller can ask what another app's access looks like (ADR 20261119-on-demand-outbound-work-…:
 * what a call is about is decided by the provider from the verified principal, never claimed by the caller).
 *
 * ORDER (the rule of `systemRateLimits.ts`: a credential is verified before any count is consulted, and exactly one
 * count is consulted):
 *   1. verify the credential (no I/O, no count);
 *   2. invalid -> the source address's shared invalid-credential count, then the 401 (or the one 429);
 *      valid  -> the verified service's allowance, CHOSEN ONLY BY WHETHER `ids` IS PRESENT (`teams`, 3 000, for the
 *                ids mode; `teamsOptions`, 1 500, for everything else), then the one 429 or on. Nothing else of the
 *                request is read here, so a malformed request spends the allowance of the mode it names (D11);
 *   3. only then the query is validated (400, a fixed body that never repeats a character of the request) and the
 *      database read.
 * So an unauthenticated caller learns nothing, a refused request reads no row, and a search driven by what a person
 * types cannot spend the budget the decisions depend on.
 *
 * `q` matches TEAM NAMES ONLY (never members, descriptions or archived teams) and returns `{id, name}`, which the
 * unfiltered options mode already lists, so it reveals nothing new. It is bounded (at most 80 characters after the
 * JS trim, at most 200 raw, no NUL) and used only as a bound parameter of `strpos(lower(name), lower($q))`: the same
 * `lower()` as the unique name index, not LIKE/ILIKE, so `%`, `_` and `\` are literal characters.
 *
 * Every answer, errors included, carries `Cache-Control: no-store` (a decision must see the next change).
 *
 * LOGGING: one line per accepted call, `[system] teams.read caller=<sub> mode=<ids|options> search=<yes|no>
 * count=<n>`: never an id, a name or the `q` text. A refusal after an allowance is spent goes through
 * `logRefusal("allowance", "teams", sub)` for either mode.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Effect } from "effect";
import { errors as joseErrors, jwtVerify } from "jose";
import { holdersOfAppAccess } from "../authz/resolver";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { SERVICE_SUB_PREFIX } from "../system/serviceClients";
import { callerAddress } from "../system/serviceToken.routes";
import type { SystemRateLimits } from "../system/systemRateLimits";
import { type GetServiceJwks, MAX_TOKEN_CHARS } from "../system/userContact.routes";

export const TEAMS_READ_SCOPE = "teams:read";

/**
 * Which service may read teams, and for which app it asks `appAccess`. In code, not in configuration: granting the
 * scope in `SERVICE_CLIENTS` alone opens nothing, and a second reader is a reviewed change of this table.
 */
export const TEAM_READERS: Readonly<Record<string, string>> = Object.freeze({
  "system:projects-api": "projects",
});

/** Team ids per ids-mode call (AC-1.5's picker and the project page read at most this many). */
export const IDS_LIMIT = 50;
/** Teams per options-mode answer; one more row is read to say `truncated`. */
export const OPTIONS_LIMIT = 50;
const MAX_NAME_CHARS = 80; // the team name maximum (the table's CHECK counts characters)
const MAX_RAW_Q_CHARS = 200;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** 50 ids of 64 characters and 49 commas: anything longer cannot be a valid `ids` value. */
const MAX_IDS_RAW_CHARS = IDS_LIMIT * 64 + (IDS_LIMIT - 1);

const NO_STORE = "no-store";

/**
 * The one 401 of this module: a constant, so it cannot depend on the request (no path, no query) nor on which check
 * failed.
 */
export const FROZEN_UNAUTHORIZED_BODY = Object.freeze({
  type: "https://httpstatuses.com/401",
  title: "Unauthorized",
  status: 401,
  detail: "Valid credentials are required",
  instance: "/system/teams",
});

/** The one 400 of this module: a constant too, so it can never echo the request. */
export const FROZEN_VALIDATION_BODY = Object.freeze({
  type: "https://httpstatuses.com/400",
  title: "Bad Request",
  status: 400,
  detail: "The query is not valid",
  instance: "/system/teams",
  code: "validation_failed",
});

// ─── API document (the handler below owns the order, so this is registered for the document only) ────────────────

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string().optional(),
});

const IdsAnswer = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        archived: z.boolean(),
        members: z.array(
          z.object({ id: z.string(), name: z.string().nullable(), active: z.boolean(), appAccess: z.boolean() }),
        ),
      }),
    ),
  })
  .openapi("TeamsByIdsServiceAnswer");
const OptionsAnswer = z
  .object({ items: z.array(z.object({ id: z.string(), name: z.string() })), truncated: z.boolean() })
  .openapi("TeamOptionsServiceAnswer");

const readRoute = createRoute({
  method: "get",
  path: "/system/teams",
  tags: ["System"],
  summary: "Teams, their members and each member's app access, or the active teams' names (service principals only)",
  description:
    "Service-to-service only: needs a service JWT (aud SERVICE_AUDIENCE) with scope `teams:read`, from a service bound " +
    "in `TEAM_READERS`. Exactly one of `ids` (1..50 distinct team ids) or `state=active` (with an optional `q`, a name " +
    "search of at most 80 characters). `appAccess` is derived from the verified caller, never asked for.",
  request: {
    query: z.object({ ids: z.string().optional(), state: z.literal("active").optional(), q: z.string().optional() }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.union([IdsAnswer, OptionsAnswer]) } }, description: "The teams" },
    400: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "`validation_failed`: a fixed body, nothing of the request is echoed" },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid service credential (identical for every failure)",
    },
    429: { content: { "application/json": { schema: ProblemSchema } }, description: "Per-service allowance exceeded (one per mode)" },
  },
});

// ─── query ───────────────────────────────────────────────────────────────────

type Query = { mode: "ids"; ids: string[] } | { mode: "options"; q: string | null };

const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
};

/** The parsed query, or `null` for anything outside the contract. Reads the raw URL: nothing here is first-wins. */
function parseQuery(params: URLSearchParams): Query | null {
  const keys = new Set<string>();
  for (const key of params.keys()) {
    if (key !== "ids" && key !== "state" && key !== "q") return null;
    keys.add(key);
  }
  for (const key of keys) if (params.getAll(key).length !== 1) return null;

  if (keys.has("ids")) {
    if (keys.has("state") || keys.has("q")) return null;
    const raw = params.get("ids")!;
    if (raw.length === 0 || raw.length > MAX_IDS_RAW_CHARS) return null;
    const ids = raw.split(",");
    if (ids.length > IDS_LIMIT || !ids.every((id) => ID_SHAPE.test(id)) || new Set(ids).size !== ids.length) return null;
    return { mode: "ids", ids };
  }

  if (params.get("state") !== "active") return null;
  if (!keys.has("q")) return { mode: "options", q: null };
  const raw = params.get("q")!;
  if (raw.includes("\u0000") || !raw.isWellFormed() || codePoints(raw) > MAX_RAW_Q_CHARS) return null;
  const q = raw.trim();
  const length = codePoints(q);
  if (length < 1 || length > MAX_NAME_CHARS) return null;
  return { mode: "options", q };
}

// ─── Router ──────────────────────────────────────────────────────────────────

const nameCollator = new Intl.Collator("it", { sensitivity: "base" });
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param deps.getJwks the key source (`jwksFromAuth(auth)` in production; a local key set in tests, so this module
 *   never imports `auth.config`)
 * @param deps.limits the one set of `/system` limits `index.ts` shares between its routers
 * @param deps.client the client the teams are read through; `db` unless a test reads through another
 */
export function createSystemTeamsRouter(deps: { getJwks: GetServiceJwks; limits: SystemRateLimits; client?: typeof db }) {
  const { limits } = deps;
  const client = deps.client ?? db;

  /** The verified calling service and the app it asks about, or `failure` (the jose error code, for the log line). */
  type Verdict = { valid: true; sub: string; appId: string } | { valid: false; failure: string | null };

  async function verify(authorization: string | undefined): Promise<Verdict> {
    const audience = env.SERVICE_AUDIENCE;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!audience || !token || token.length > MAX_TOKEN_CHARS) return { valid: false, failure: null };
    try {
      const { payload } = await jwtVerify(token, await deps.getJwks(), {
        issuer: env.BETTER_AUTH_URL,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "aud", "iss"],
      });
      const sub = payload.sub;
      const scope = payload["scope"];
      if (
        typeof sub !== "string" ||
        !sub.startsWith(SERVICE_SUB_PREFIX) ||
        sub.length === SERVICE_SUB_PREFIX.length ||
        typeof scope !== "string" ||
        !scope.split(" ").includes(TEAMS_READ_SCOPE) ||
        !Object.hasOwn(TEAM_READERS, sub)
      ) {
        return { valid: false, failure: null };
      }
      return { valid: true, sub, appId: TEAM_READERS[sub]! };
    } catch (err) {
      // The jose error code only: nothing about the presented credential.
      const code = err instanceof joseErrors.JOSEError ? (err.code ?? err.constructor.name) : "JWT_VERIFY_FAILED";
      return { valid: false, failure: code };
    }
  }

  const frozen401 = (c: Context): Response =>
    c.body(JSON.stringify(FROZEN_UNAUTHORIZED_BODY), 401, {
      "Content-Type": "application/json",
      "Cache-Control": NO_STORE,
    });

  const frozen400 = (c: Context): Response =>
    c.body(JSON.stringify(FROZEN_VALIDATION_BODY), 400, {
      "Content-Type": "application/problem+json",
      "Cache-Control": NO_STORE,
    });

  /** Steps 1 and 2: the verified caller, or the response that ends the request. */
  async function admit(c: Context): Promise<{ sub: string; appId: string } | Response> {
    const verdict = await verify(c.req.header("Authorization"));
    if (!verdict.valid) {
      const source = callerAddress(c.req.header("X-Forwarded-For"));
      if (!limits.invalidCredentials.consume(source).allowed) {
        limits.logRefusal("invalid", "teams", source);
        return limits.tooManyRequests(c);
      }
      if (verdict.failure !== null) console.warn("[system-jwt] verification failed:", verdict.failure);
      return frozen401(c);
    }
    // The allowance is chosen by the PRESENCE of `ids` and by nothing else in the request.
    const byIds = new URL(c.req.url).searchParams.has("ids");
    const allowance = byIds ? limits.teams : limits.teamsOptions;
    if (!allowance.consume(verdict.sub).allowed) {
      limits.logRefusal("allowance", "teams", verdict.sub);
      return limits.tooManyRequests(c);
    }
    return { sub: verdict.sub, appId: verdict.appId };
  }

  // ─── the reads ───

  async function readByIds(ids: string[], appId: string) {
    const teams = await client.team.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, archivedAt: true },
    });
    if (teams.length === 0) return [];
    const rows = await client.teamMember.findMany({
      where: { teamId: { in: teams.map((t) => t.id) } },
      select: { teamId: true, user: { select: { id: true, name: true, deletedAt: true } } },
    });
    // ONE batch for every (team, member) row, whatever the number of teams or people (AC-4.7). A deactivated person
    // is never asked about: they read as inactive with no access, whatever roles they still hold.
    const activeIds = rows.filter((r) => r.user.deletedAt === null).map((r) => r.user.id);
    const holders = await Effect.runPromise(holdersOfAppAccess(appId, activeIds, client));

    const membersOf = new Map<string, { id: string; name: string | null; active: boolean; appAccess: boolean; sortName: string }[]>();
    for (const row of rows) {
      const active = row.user.deletedAt === null;
      const list = membersOf.get(row.teamId) ?? [];
      list.push({
        id: row.user.id,
        name: active ? row.user.name : null,
        active,
        appAccess: active && holders.has(row.user.id),
        sortName: row.user.name,
      });
      membersOf.set(row.teamId, list);
    }

    const byId = new Map(teams.map((t) => [t.id, t]));
    return ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const team = byId.get(id)!;
        const members = (membersOf.get(id) ?? []).sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          // Inactive people are ordered by id only: their names are hidden, and an order by name would leak it.
          if (!a.active) return compareText(a.id, b.id);
          return nameCollator.compare(a.sortName, b.sortName) || compareText(a.sortName, b.sortName) || compareText(a.id, b.id);
        });
        return {
          id: team.id,
          name: team.name,
          archived: team.archivedAt !== null,
          members: members.map(({ id: memberId, name, active, appAccess }) => ({ id: memberId, name, active, appAccess })),
        };
      });
  }

  async function readOptions(q: string | null) {
    const rows =
      q === null
        ? await client.team.findMany({
            where: { archivedAt: null },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: OPTIONS_LIMIT + 1,
            select: { id: true, name: true },
          })
        : await client.$queryRaw<{ id: string; name: string }[]>`
            SELECT "id", "name" FROM "team"
            WHERE "archivedAt" IS NULL AND strpos(lower("name"), lower(${q}::text)) > 0
            ORDER BY
              CASE
                WHEN lower("name") = lower(${q}::text) THEN 0
                WHEN strpos(lower("name"), lower(${q}::text)) = 1 THEN 1
                ELSE 2
              END,
              "name", "id"
            LIMIT ${OPTIONS_LIMIT + 1}`;
    return {
      items: rows.slice(0, OPTIONS_LIMIT).map(({ id, name }) => ({ id, name })),
      truncated: rows.length > OPTIONS_LIMIT,
    };
  }

  // Not `.openapi()`: its query validation would run before any credential check or count. The route is registered
  // for the API document only.
  const router = new OpenAPIHono();
  router.openAPIRegistry.registerPath(readRoute);

  router.get("/system/teams", async (c) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;

    const query = parseQuery(new URL(c.req.url).searchParams);
    if (query === null) return frozen400(c);

    c.header("Cache-Control", NO_STORE);
    if (query.mode === "ids") {
      const items = await readByIds(query.ids, admitted.appId);
      console.log(`[system] teams.read caller=${admitted.sub} mode=ids search=no count=${items.length}`);
      return c.json({ items }, 200);
    }
    const answer = await readOptions(query.q);
    console.log(
      `[system] teams.read caller=${admitted.sub} mode=options search=${query.q === null ? "no" : "yes"} count=${answer.items.length}`,
    );
    return c.json(answer, 200);
  });

  return router;
}

/**
 * The history of the legal-entity registry (specs/20261117-legal-entities, T7; AC-2.2, AC-2.3, AC-2.4, AC-4.3,
 * AC-7.2; amendment E1):
 *
 *   GET /legal-entities/{entity}/versions       a page of versions (`limit`, `before`, `nextBefore`; G5), newest first, each with `restorable`
 *   GET /legal-entities/{entity}/versions/{n}   all the details of version n plus how it came to be
 *
 * WHO: a signed-in person who may manage AT LEAST ONE entity (`legal-entity:manage`, through the same coverage
 * function as `/legal-entities/manageable`, fail closed). Either history may be read once one entity is covered: a
 * `welld_ch`-only manager reads `welld_it`'s history too (AC-4.3: the other entity is read-only to them; writing is
 * T8's `must cover {entity}`). Otherwise 403 `forbidden`. A soft-deleted person is refused whatever grants remain (F2).
 *
 * ORDER of refusals: 401 (no session) -> 403 (no covering grant) -> 404 (`unknown_legal_entity`, then
 * `version_not_found`) -> 422 `invalid_request` (the history's query only). A person without a grant therefore learns nothing about which entities or versions exist.
 * Every body is a constant: none carries the requested entity, version or path.
 *
 * `restorable` (E1) is computed on every read from `rules.ts` over the stored details: the very check the restore
 * route applies (D4). It is a hint for the page; the guard stays the 422 of the restore route.
 *
 * Authentication is attached per exact path and GET only, with its own `no-store` (T5's note): the POST routes of
 * T8 on these same paths are not touched by anything declared here. Reads only: `repo.ts` SELECTs, nothing here
 * writes `legal_entity_version`.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { User } from "better-auth";
import { Effect } from "effect";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { resolveEffectivePermissions } from "../authz/resolver";
import { db } from "../lib/db";
import { activeUserProfile, coveredEntities } from "./coverage";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";
import { isLegalEntity, NO_STORE, unknownLegalEntity } from "./read.routes";
import { type HistoryRow, type Reader, versionOf, versionsOf } from "./repo";
import { restorable } from "./rules";
import { detailsOf, serializeEntity } from "./serialize";

/** The 403 of a person with no covering grant (AC-4.2/4.3): constant, nothing of the request in it. */
export const FORBIDDEN_BODY = Object.freeze({
  type: "https://httpstatuses.com/403",
  title: "Forbidden",
  status: 403,
  code: "forbidden",
  detail: "You do not hold a permission that allows managing a legal entity",
});

/** The 404 of a version that does not exist (whatever the text of `n`): constant, `n` is never echoed. */
export const VERSION_NOT_FOUND_BODY = Object.freeze({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404,
  code: "version_not_found",
  detail: "There is no such version",
});

const INT4_MAX = 2_147_483_647;

/** Versions per page of the history unless `limit` says otherwise (G5, F3). */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

/** The 422 of a query the history does not accept: constant, nothing of the request in it (not even a member name). */
export const INVALID_QUERY_BODY = Object.freeze({
  type: "https://httpstatuses.com/422",
  title: "Unprocessable Entity",
  status: 422,
  code: "invalid_request",
  detail: "The query is not in the expected shape",
});

/**
 * `limit` (1-100, default 50) and `before` (a version number) of the history, or null when anything else is in the
 * query: another member, a repeated member, an empty or non-canonical number. Only canonical decimal integers pass.
 */
export function parseHistoryQuery(url: string): { limit: number; before?: number } | null {
  const params = new URL(url).searchParams;
  const keys = new Set<string>();
  for (const key of params.keys()) {
    if (key !== "limit" && key !== "before") return null;
    if (keys.has(key)) return null;
    keys.add(key);
  }
  let limit = DEFAULT_HISTORY_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit > MAX_HISTORY_LIMIT) return null;
  }
  const rawBefore = params.get("before");
  if (rawBefore === null) return { limit };
  const before = parseVersion(rawBefore);
  return before === null ? null : { limit, before };
}

/**
 * The version a path segment names, or null. Only a canonical whole number >= 1 that fits the column (an int4)
 * can be a version: "0", "-1", "1.5", "1e2", "01", " 1", "0x1" and "99999999999999999999" are all "not found",
 * and none reaches the database (which would answer a 500 to an out-of-range parameter).
 */
export function parseVersion(segment: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(segment)) return null;
  const n = Number(segment);
  return n <= INT4_MAX ? n : null;
}

/** `createdBy` of a version: null for the system, else the person as recorded at the save. */
function createdByOf(row: HistoryRow): { id: string; name: string } | null {
  return row.createdByUserId === null ? null : { id: row.createdByUserId, name: row.createdByName ?? "" };
}

/** One item of the history, in the key order of plan E1. */
export function serializeHistoryItem(row: HistoryRow) {
  return {
    version: row.version,
    action: row.action,
    restoredFrom: row.restoredFrom,
    createdBy: createdByOf(row),
    createdAt: row.createdAt.toISOString(),
    changedFields: [...row.changedFields],
    restorable: restorable(detailsOf(row)),
  };
}

/** The version view: the one `LegalEntity` serializer over version n, then how it came to be (AC-2.3, AC-7.2). */
export function serializeVersionView(entity: LegalEntity, row: HistoryRow) {
  return {
    ...serializeEntity(entity, row),
    action: row.action,
    restoredFrom: row.restoredFrom,
    createdBy: createdByOf(row),
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const EntityNameSchema = z.enum(LEGAL_ENTITIES);
const FieldSchema = z.enum(["legalName", "address.it", "address.en", "vatNumber", "iban", "contacts.it", "contacts.en"]);
const CreatedBySchema = z.object({ id: z.string(), name: z.string() }).nullable();
const ActionSchema = z.enum(["import", "save", "restore"]);

const HistoryItemSchema = z
  .object({
    version: z.number().int(),
    action: ActionSchema,
    restoredFrom: z.number().int().nullable(),
    createdBy: CreatedBySchema.describe("null: the system (the import)"),
    createdAt: z.string(),
    changedFields: z.array(FieldSchema),
    restorable: z.boolean().describe("Passes today's rules: what a restore of it would be allowed to do (E1)"),
  })
  .openapi("LegalEntityHistoryItem");

const VersionViewSchema = z
  .object({
    entity: EntityNameSchema,
    version: z.number().int(),
    updatedAt: z.string().nullable(),
    legalName: z.string(),
    address: z.object({ it: z.array(z.string()), en: z.array(z.string()) }),
    vatNumber: z.string(),
    iban: z.string(),
    ibanPrint: z.string(),
    contacts: z.object({ it: z.string(), en: z.string() }),
    complete: z.boolean(),
    missing: z.array(z.enum(["legalName", "address.it", "address.en", "vatNumber"])),
    invalid: z.array(
      z.object({
        field: FieldSchema,
        line: z.number().int().optional(),
        reason: z.enum(["required", "too_long", "too_many_lines", "line_break", "control_character", "iban_format", "iban_check_digits"]),
        limit: z.number().int().optional(),
      }),
    ),
    action: ActionSchema,
    restoredFrom: z.number().int().nullable(),
    createdBy: CreatedBySchema,
    createdAt: z.string(),
  })
  .openapi("LegalEntityVersion");

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  code: z.string().optional(),
});

const refusals = {
  401: { content: { "application/json": { schema: ProblemSchema } }, description: "No valid session" },
  403: {
    content: { "application/json": { schema: ProblemSchema } },
    description: "`forbidden`: no `legal-entity:manage` covering at least one entity",
  },
};

const historyRoute = createRoute({
  method: "get",
  path: "/legal-entities/{entity}/versions",
  tags: ["Legal entities"],
  summary: "Every version of an entity, newest first (any manager reads either entity)",
  request: {
    params: z.object({ entity: z.string() }),
    // Documented only: the handler reads the raw query itself (any other member or value is 422, never a 400 echo).
    query: z.object({
      // string | string[]: a repeated member must reach the handler's 422, not the validator's 400.
      limit: z.union([z.string(), z.array(z.string())]).optional().describe("1-100, default 50"),
      before: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("A version number: only versions below it (the previous page's `nextBefore`)"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(HistoryItemSchema),
            nextBefore: z.number().int().nullable().describe("Pass as `before` for the next page; null on the last page"),
          }),
        },
      },
      description: "One page of versions, newest first",
    },
    ...refusals,
    404: {
      content: { "application/problem+json": { schema: ProblemSchema } },
      description: "`unknown_legal_entity`",
    },
    422: {
      content: { "application/problem+json": { schema: ProblemSchema } },
      description: "`invalid_request`: a `limit` or `before` out of range, or another query member",
    },
  },
});

const versionRoute = createRoute({
  method: "get",
  path: "/legal-entities/{entity}/versions/{n}",
  tags: ["Legal entities"],
  summary: "One version, read-only (any manager reads either entity)",
  request: { params: z.object({ entity: z.string(), n: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: VersionViewSchema } }, description: "All details of version n" },
    ...refusals,
    404: {
      content: { "application/problem+json": { schema: ProblemSchema } },
      description: "`unknown_legal_entity` or `version_not_found`",
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────────────────

type Env = { Variables: { user: User | null } };

/** 403 `forbidden` unless the caller's grants cover at least one entity (the coverage of `/manageable`). */
const requireCoveredEntity: MiddlewareHandler<Env> = async (c, next) => {
  const userId = c.get("user")!.id;
  const [profile, permissions] = await Promise.all([
    activeUserProfile(userId),
    Effect.runPromise(resolveEffectivePermissions(userId)),
  ]);
  // A missing or soft-deleted person is refused whatever grants remain (F2); the session may outlive the delete.
  if (profile === null || coveredEntities(permissions, { entity: profile.entity }).length === 0) {
    return c.body(JSON.stringify(FORBIDDEN_BODY), 403, {
      "Content-Type": "application/problem+json",
      "Cache-Control": NO_STORE,
    });
  }
  return next();
};

/**
 * @param client the client the versions are read through; `db` unless a test reads through its rolled-back
 *   transaction (grants and users are always read through `db`, as in `read.routes.ts`).
 */
export function createLegalEntityHistoryRouter(client: Reader = db) {
  const router = new OpenAPIHono<Env>();

  // GET only, per exact path (never `/legal-entities/*`): T8's POSTs on these paths are not ours to authenticate.
  // `no-store` first, so the 401, 403 and 404 carry it too.
  for (const path of ["/legal-entities/:entity/versions", "/legal-entities/:entity/versions/:n"]) {
    router.on("GET", path, async (c, next) => {
      c.header("Cache-Control", NO_STORE);
      await next();
    });
    router.on("GET", path, sessionMiddleware, requireAuth, requireCoveredEntity);
  }

  router.openapi(historyRoute, async (c) => {
    const { entity } = c.req.valid("param");
    if (!isLegalEntity(entity)) return unknownLegalEntity(c) as never;
    const page = parseHistoryQuery(c.req.url);
    if (page === null) {
      return c.body(JSON.stringify(INVALID_QUERY_BODY), 422, {
        "Content-Type": "application/problem+json",
        "Cache-Control": NO_STORE,
      }) as never;
    }
    const rows = await versionsOf(entity, client, page);
    // One row more than the page was read: its presence is "another page exists" (and is not part of this one).
    const items = rows.slice(0, page.limit);
    const nextBefore = rows.length > page.limit ? items[items.length - 1]!.version : null;
    return c.json({ items: items.map(serializeHistoryItem), nextBefore }, 200);
  });

  router.openapi(versionRoute, async (c) => {
    const { entity, n } = c.req.valid("param");
    if (!isLegalEntity(entity)) return unknownLegalEntity(c) as never;
    const version = parseVersion(n);
    const row = version === null ? null : await versionOf(entity, version, client);
    if (row === null) {
      return c.body(JSON.stringify(VERSION_NOT_FOUND_BODY), 404, {
        "Content-Type": "application/problem+json",
        "Cache-Control": NO_STORE,
      }) as never;
    }
    return c.json(serializeVersionView(entity, row), 200);
  });

  return router;
}

export const legalEntityHistoryRouter = createLegalEntityHistoryRouter();

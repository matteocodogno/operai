/**
 * The person read API of the legal-entity registry (specs/20261117-legal-entities, T5; AC-1.1, AC-3.1, AC-3.4,
 * AC-4.3; amendments E2, E6):
 *
 *   GET /legal-entities              the two entities, in `LEGAL_ENTITIES` order
 *   GET /legal-entities/manageable   the entities the caller may manage (`[]` for none)
 *   GET /legal-entities/{entity}     one entity; 404 `unknown_legal_entity` for any other name
 *
 * Any signed-in person reads (cookie or Bearer, `sessionMiddleware` + `requireAuth` as `/authz/me`): no role
 * needed, the IBAN included (AC-3.1). Every answer, errors too, carries `Cache-Control: no-store` so no cache keeps
 * a registry value past a save (AC-3.3).
 *
 * Routing (E2): `manageable` is a reserved path segment registered BEFORE `/legal-entities/{entity}`; it is not an
 * entity name. Authentication is attached per exact path (not `/legal-entities/*`), so this module never
 * authenticates or no-stores the history/write routes of T7/T8, which declare their own.
 *
 * The 404 body is one constant: it carries neither the requested name nor the request path (AC-3.4), so
 * `/legal-entities/welld_de`, `%00` and a 300-character name answer identical bytes - and the service route of T6,
 * which reuses `unknownLegalEntity`, answers the same ones.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { User } from "better-auth";
import { Effect } from "effect";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { resolveEffectivePermissions } from "../authz/resolver";
import { db } from "../lib/db";
import { coveredEntities } from "./coverage";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";
import { currentVersions, type Reader } from "./repo";
import { serializeAll, serializeEntity } from "./serialize";

export const NO_STORE = "no-store";

/** The fixed 404 of an unknown entity name (AC-3.4): no member depends on the request. */
export const UNKNOWN_LEGAL_ENTITY_BODY = Object.freeze({
  type: "https://httpstatuses.com/404",
  title: "Not Found",
  status: 404,
  code: "unknown_legal_entity",
  detail: "There is no such legal entity",
});

export function isLegalEntity(name: string): name is LegalEntity {
  return (LEGAL_ENTITIES as readonly string[]).includes(name);
}

/** The 404 of an unknown entity, as the same bytes on every route that answers it. */
export function unknownLegalEntity(c: Context): Response {
  return c.body(JSON.stringify(UNKNOWN_LEGAL_ENTITY_BODY), 404, {
    "Content-Type": "application/problem+json",
    "Cache-Control": NO_STORE,
  });
}

/** The list answer, shared with the service route (T6): same rows, same bytes. */
export async function readAll(client: Reader = db) {
  return serializeAll(await currentVersions(client));
}

/** One entity's answer (`name` already known to be an entity), shared with the service route (T6). */
export async function readOne(entity: LegalEntity, client: Reader = db) {
  const rows = await currentVersions(client);
  return serializeEntity(entity, rows.find((row) => row.entity === entity) ?? null);
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const FieldSchema = z.enum(["legalName", "address.it", "address.en", "vatNumber", "iban", "contacts.it", "contacts.en"]);
const InvalidItemSchema = z.object({
  field: FieldSchema,
  line: z.number().int().optional(),
  reason: z.enum(["required", "too_long", "too_many_lines", "line_break", "control_character", "iban_format", "iban_check_digits"]),
  limit: z.number().int().optional(),
});
const EntityNameSchema = z.enum(LEGAL_ENTITIES);

const LegalEntitySchema = z
  .object({
    entity: EntityNameSchema,
    version: z.number().int().describe("0: not moved yet (empty values)"),
    updatedAt: z.string().nullable(),
    legalName: z.string(),
    address: z.object({ it: z.array(z.string()), en: z.array(z.string()) }),
    vatNumber: z.string(),
    iban: z.string().describe("Electronic form; empty when none"),
    ibanPrint: z.string().describe("Groups of four; empty when none"),
    contacts: z.object({ it: z.string(), en: z.string() }),
    complete: z.boolean(),
    missing: z.array(z.enum(["legalName", "address.it", "address.en", "vatNumber"])),
    invalid: z.array(InvalidItemSchema),
  })
  .openapi("LegalEntity");

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string().optional(),
});

const unauthorized = {
  content: { "application/json": { schema: ProblemSchema } },
  description: "No valid session",
};

// ─── Routes ───────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/legal-entities",
  tags: ["Legal entities"],
  summary: "The group's legal entities (any signed-in person)",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ items: z.array(LegalEntitySchema) }) } },
      description: "Both entities, welld_it then welld_ch",
    },
    401: unauthorized,
  },
});

const manageableRoute = createRoute({
  method: "get",
  path: "/legal-entities/manageable",
  tags: ["Legal entities"],
  summary: "The entities the caller may manage",
  description:
    "Computed from the caller's `legal-entity:manage` grants through the same coverage function the management " +
    "routes use. About the caller only. `manageable` is not an entity name.",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ entities: z.array(EntityNameSchema) }) } },
      description: "The covered entities (empty for none)",
    },
    401: unauthorized,
  },
});

const oneRoute = createRoute({
  method: "get",
  path: "/legal-entities/{entity}",
  tags: ["Legal entities"],
  summary: "One legal entity (any signed-in person)",
  request: { params: z.object({ entity: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: LegalEntitySchema } }, description: "The entity's current details" },
    401: unauthorized,
    404: {
      content: { "application/problem+json": { schema: ProblemSchema } },
      description: "`unknown_legal_entity`: a fixed body, the requested name is never echoed",
    },
  },
});

/**
 * @param client the client the registry is read through; `db` unless a test reads through its rolled-back
 *   transaction.
 */
export function createLegalEntityReadRouter(client: Reader = db) {
  const router = new OpenAPIHono<{ Variables: { user: User | null } }>();

  // GET only, per exact path, never `/legal-entities/*` (see the module header). `:entity` also matches
  // `manageable`, so it is listed once. `no-store` first, so the 401 carries it too.
  for (const path of ["/legal-entities", "/legal-entities/:entity"]) {
    router.on("GET", path, async (c, next) => {
      c.header("Cache-Control", NO_STORE);
      await next();
    });
    router.on("GET", path, sessionMiddleware, requireAuth);
  }

  router.openapi(listRoute, async (c) => c.json(await readAll(client), 200));

  // E2: registered before `/legal-entities/{entity}`.
  router.openapi(manageableRoute, async (c) => {
    const userId = c.get("user")!.id;
    const [profile, permissions] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: userId }, select: { entity: true } }),
      Effect.runPromise(resolveEffectivePermissions(userId)),
    ]);
    return c.json({ entities: coveredEntities(permissions, { entity: profile.entity }) }, 200);
  });

  router.openapi(oneRoute, async (c) => {
    const { entity } = c.req.valid("param");
    if (!isLegalEntity(entity)) return unknownLegalEntity(c) as never;
    return c.json(await readOne(entity, client), 200);
  });

  return router;
}

export const legalEntityReadRouter = createLegalEntityReadRouter();

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { db } from "../lib/db";
import { createSlidingWindowRateLimiter } from "../lib/rateLimiter";
import { PROJECTS_APP_ID } from "./catalogs/projects";
import { entityGrantFor, resolveEffectivePermissions } from "./resolver";
import { bearerJwtMiddleware, type ResolveAuthVariables } from "./resolveAuth.middleware";

/**
 * The permissions that open the holders listing: `handoff:take` (the `projects`
 * catalog's), under ANY entity scope - the people who take a won deal are the
 * ones who pick its ops-manager. Deliberately NOT the directory's gate
 * (`DIRECTORY_GATE_PERMISSIONS`): that one admits asset and deal managers, who
 * have no business reading who may receive purchase orders (T18 M4). The
 * resolver keys grants by (resource, action) without the app id, so no other
 * catalog may declare a `handoff` resource with a `take` action.
 */
export const HOLDERS_GATE_PERMISSIONS: readonly { resource: string; action: string }[] = [
  { resource: "handoff", action: "take" },
];

/**
 * This route's OWN limiter (not the directory's: separate counters), keyed by
 * caller `sub` and counted on every attempt past authentication - a 403 or a
 * malformed query counts too. Module constants, not env: a picker asks once per
 * form opening, so 60 / 10 min is generous, and `lib/env.ts` is not this task's.
 */
export const HOLDERS_RATE_LIMIT = 60;
export const HOLDERS_RATE_WINDOW_MS = 600_000;

// Module-scope singleton: every request in this process shares one window map.
const holdersLimiter = createSlidingWindowRateLimiter({
  limit: HOLDERS_RATE_LIMIT,
  windowMs: HOLDERS_RATE_WINDOW_MS,
});

/** The one pair this route answers, pinned server-side (T18 L4): never read from the query. */
const RECEIVE = { resource: "purchase-order", action: "receive" } as const;

const HoldersQuerySchema = z
  .object({
    resource: z.string(),
    action: z.string(),
    entity: z.enum(["welld_ch", "welld_it"]),
  })
  .strict();

const HoldersResponseSchema = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string(), unconditioned: z.boolean() })),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

const ProblemJsonWithCodeSchema = ProblemJsonSchema.extend({ code: z.string() });

const getHoldersRoute = createRoute({
  method: "get",
  path: "/authz/users/holders",
  tags: ["Authorization"],
  summary: "List the holders of purchase-order:receive for an entity (for the project hand-off's ops-manager picker)",
  description:
    `Returns the active users whose effective permissions grant purchase-order:receive for the asked ` +
    `entity and who hold projects:access, as { id, name, unconditioned }, name-sorted - no email, no ` +
    `entity. unconditioned is true for an unrestricted grant (the admins), false for an own-entity one. ` +
    `Only the pair purchase-order:receive is answerable (400 unsupported_permission otherwise); the ` +
    `query is strict (unknown parameters and entities other than welld_ch / welld_it are 400). The ` +
    `caller must hold handoff:take under any entity scope (403 otherwise; T18 M4). Rate-limited per ` +
    `caller, every attempt counted (429 + Retry-After). Never cached.`,
  request: { query: HoldersQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: HoldersResponseSchema } },
      description: "The holders",
    },
    400: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "Malformed query (invalid_query) or a pair other than purchase-order:receive (unsupported_permission)",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Missing, invalid, expired, or wrong-issuer/audience Bearer token",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "The caller does not hold handoff:take, or is soft-deleted",
    },
    429: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "Caller exceeded the rate limit",
    },
  },
});

// Same human name order as the directory's (directory.routes.ts): case- and
// accent-insensitive, Italian locale. Ties fall back to id: deterministic.
const nameCollator = new Intl.Collator("it", { sensitivity: "base" });

const badRequest = (path: string, detail: string, code: string) => ({
  type: "https://httpstatuses.com/400",
  title: "Bad Request",
  status: 400,
  detail,
  instance: path,
  code,
});

export const holdersRouter = new OpenAPIHono<{ Variables: ResolveAuthVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        badRequest(
          c.req.path,
          result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
          "invalid_query",
        ),
        400,
      );
    }
    return undefined;
  },
});

/**
 * Rate limit, then the capability gate. The gate is resolved live (ADR-0007):
 * the caller must hold an entry of {@link HOLDERS_GATE_PERMISSIONS} and not be
 * soft-deleted (a still-valid JWT outlives the deletion, ADR-0012). Both run
 * before the query is read, so a caller who may not ask learns nothing about
 * what can be asked, and every attempt is counted.
 */
const holdersGate = createMiddleware<{ Variables: ResolveAuthVariables }>(async (c, next) => {
  const callerId = c.get("callerId");

  // 429: counted on every attempt, including ones the gate then refuses.
  const rateLimitResult = holdersLimiter.consume(callerId);
  if (!rateLimitResult.allowed) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(rateLimitResult.retryAfterMs / 1000))));
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        type: "https://httpstatuses.com/429",
        title: "Too Many Requests",
        status: 429,
        detail: "Too many holders requests. Try again later.",
        instance: c.req.path,
        code: "rate_limited",
      },
      429,
    );
  }

  const [callerRow, callerPermissions] = await Promise.all([
    db.user.findUnique({ where: { id: callerId }, select: { deletedAt: true } }),
    Effect.runPromise(resolveEffectivePermissions(callerId)),
  ]);

  const holdsGate = callerPermissions.some((permission) =>
    HOLDERS_GATE_PERMISSIONS.some(
      (gate) => gate.resource === permission.resource && gate.action === permission.action,
    ),
  );

  if (!callerRow || callerRow.deletedAt !== null || !holdsGate) {
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        type: "https://httpstatuses.com/403",
        title: "Forbidden",
        status: 403,
        detail: "You do not hold a permission that allows listing the holders of a permission.",
        instance: c.req.path,
        code: "holders_forbidden",
      },
      403,
    );
  }

  await next();
  return undefined;
});

holdersRouter.use("/authz/users/holders", bearerJwtMiddleware, holdersGate);

holdersRouter.openapi(getHoldersRoute, async (c) => {
  const { resource, action, entity } = c.req.valid("query");
  if (resource !== RECEIVE.resource || action !== RECEIVE.action) {
    return c.json(
      badRequest(c.req.path, "Only purchase-order:receive can be asked for.", "unsupported_permission"),
      400,
    );
  }

  // Candidates: active users with at least one rule for the pair, through a
  // direct role or a department's. Only a narrowing - the verdict is the
  // resolver's (dedupe, widest wins) and `entityGrantFor`'s, per candidate.
  const rulesForPair = { rules: { some: { resource: RECEIVE.resource, action: RECEIVE.action } } };
  const candidates = await db.user.findMany({
    where: {
      deletedAt: null,
      OR: [
        { userRoles: { some: { role: rulesForPair } } },
        {
          userDepartments: {
            some: { department: { departmentRoles: { some: { role: rulesForPair } } } },
          },
        },
      ],
    },
    select: { id: true, name: true, entity: true },
  });
  const rows = await Promise.all(
    candidates.map(async (user) => {
      const permissions = await Effect.runPromise(resolveEffectivePermissions(user.id));
      const grant = entityGrantFor(permissions, RECEIVE.resource, RECEIVE.action, user, entity);
      const hasAccess = permissions.some((p) => p.resource === PROJECTS_APP_ID && p.action === "access");
      return grant && hasAccess ? { id: user.id, name: user.name, unconditioned: grant.unconditioned } : null;
    }),
  );
  const users = rows
    .filter((row) => row !== null)
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  c.header("Cache-Control", "no-store");
  return c.json({ users }, 200);
});

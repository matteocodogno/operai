/**
 * GET /authz/users/directory — the roster of active users, for the inventory
 * assign picker and holder filter (T5, specs/015-hardware-inventory — refs
 * AC-2.1, AC-3.7; plan.md "User directory for the assign picker"; ADR-0047).
 *
 * THIS IS A FACT ENDPOINT, AND THE GATE IS ITS WHOLE SAFETY ARGUMENT. It
 * returns a list of people, so it is acceptable only because it is gated on a
 * named capability whose holders have a business need to pick a person. It is
 * the deliberate, narrow exception to ADR-0039's "no email/search" stance —
 * `POST /authz/users/identities` stays id-keyed and untouched — and it must not
 * erode in either direction:
 *
 *   - GATE: the caller must hold an entry of {@link DIRECTORY_GATE_PERMISSIONS}
 *     (today only the `inventory` catalog's `asset:manage`, under ANY entity
 *     scope) — an explicit allowlist, resolved live through `auth`'s own
 *     resolver (revocation is immediate). A second consuming app is ADDED to
 *     that list deliberately; the gate is never relaxed to "any app-access
 *     holder" or "any signed-in user". `ledger:manage` alone does NOT open it.
 *     Otherwise 403. A soft-deleted caller with a still-valid JWT (ADR-0012's
 *     residual window) is refused 403 as well.
 *   - SHAPE: exactly `{id, name, email, entity}` per user. No address, job
 *     title, role, or any other attribute — adding a field is a change to
 *     ADR-0047, not a drive-by.
 *   - POPULATION: active users only (`deletedAt IS NULL`), BOTH entities, even
 *     to an entity-scoped manager: the entity scope on `asset:manage`
 *     constrains which ASSETS they see, not which PEOPLE they can pick
 *     (ADR-0047 point 4).
 *   - NO query parameters, no pagination, no search. The route reads none.
 *
 * Authentication is the forwarded-caller-JWT model (`bearerJwtMiddleware`, no
 * new secret), like `/authz/resolve` and `/authz/users/identities`.
 *
 * RATE LIMITING reuses `lib/rateLimiter.ts` with its own
 * `DIRECTORY_RATE_LIMIT`/`_WINDOW_MS` pair, keyed by caller `sub`, counted on
 * every attempt (a 403 probe counts), 429 + `Retry-After` in the same shape as
 * `identities.routes.ts`. No response-time floor: there is no negative to
 * equalise here (a holder is MEANT to learn the roster; the controls are who
 * may ask and how often).
 *
 * The response is `Cache-Control: no-store` — it is a roster of personal data
 * and must not sit in a shared cache or the browser's HTTP cache. The consumer
 * (`inventory-ui`) holds it in memory only and `inventory-api` keeps no copy.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import { z } from "zod";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { createSlidingWindowRateLimiter } from "../lib/rateLimiter";
import { INVENTORY_APP_ID } from "./catalogs/inventory";
import { resolveEffectivePermissions } from "./resolver";
import { bearerJwtMiddleware, type ResolveAuthVariables } from "./resolveAuth.middleware";

/**
 * The permissions that open the directory — an explicit allowlist (ADR-0047
 * point 2). Held under ANY entity condition: a conditioned grant is still a
 * grant. (`INVENTORY_APP_ID` is the catalog the resource belongs to; the
 * resolver keys permissions by `(resource, action)`.)
 */
export const DIRECTORY_GATE_PERMISSIONS: readonly { resource: string; action: string }[] = [
  { resource: "asset", action: "manage" }, // the `inventory` catalog's asset:manage
];

// ─── Schemas ──────────────────────────────────────────────────────────────────

const DirectoryUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  entity: z.string().nullable(),
});

const DirectoryResponseSchema = z.object({ users: z.array(DirectoryUserSchema) });

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

const ProblemJsonWithCodeSchema = ProblemJsonSchema.extend({ code: z.string() });

// ─── Route ────────────────────────────────────────────────────────────────────

const getDirectoryRoute = createRoute({
  method: "get",
  path: "/authz/users/directory",
  tags: ["Authorization"],
  summary: "List active users (capability-gated; for the inventory assign picker)",
  description:
    `Returns every active user as { id, name, email, entity }, name-sorted, both entities. ` +
    `The caller must hold the '${INVENTORY_APP_ID}' catalog's asset:manage permission under any ` +
    `entity scope (403 otherwise). Not paginated, takes no query parameters, never returns ` +
    `soft-deleted users or any other attribute (ADR-0047).`,
  responses: {
    200: {
      content: { "application/json": { schema: DirectoryResponseSchema } },
      description: "The roster of active users",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Missing, invalid, expired, or wrong-issuer/audience Bearer token",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "The caller does not hold asset:manage, or is soft-deleted",
    },
    429: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "Caller exceeded the rate limit",
    },
  },
});

export const directoryRouter = new OpenAPIHono<{ Variables: ResolveAuthVariables }>();

directoryRouter.use("/authz/users/directory", bearerJwtMiddleware);

// Module-scope singleton so every request in this process shares one
// sliding-window map, keyed by caller `sub`.
const directoryLimiter = createSlidingWindowRateLimiter({
  limit: env.DIRECTORY_RATE_LIMIT,
  windowMs: env.DIRECTORY_RATE_WINDOW_MS,
});

// Human name order: case- and accent-insensitive, Italian locale (wellD's
// people). Ties fall back to email then id so the order is deterministic.
const nameCollator = new Intl.Collator("it", { sensitivity: "base" });

directoryRouter.openapi(getDirectoryRoute, async (c) => {
  const callerId = c.get("callerId");

  // ── 429: counted on every attempt, including ones the gate then refuses.
  const rateLimitResult = directoryLimiter.consume(callerId);
  if (!rateLimitResult.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(rateLimitResult.retryAfterMs / 1000));
    c.header("Retry-After", String(retryAfterSeconds));
    return c.json(
      {
        type: "https://httpstatuses.com/429",
        title: "Too Many Requests",
        status: 429,
        detail: "Too many directory requests. Try again later.",
        instance: c.req.path,
        code: "rate_limited",
      },
      429,
    );
  }

  // ── 403: the capability gate, resolved live (ADR-0007), and not soft-deleted.
  const [callerRow, callerPermissions] = await Promise.all([
    db.user.findUnique({ where: { id: callerId }, select: { deletedAt: true } }),
    Effect.runPromise(resolveEffectivePermissions(callerId)),
  ]);

  const holdsGate = callerPermissions.some((permission) =>
    DIRECTORY_GATE_PERMISSIONS.some(
      (gate) => gate.resource === permission.resource && gate.action === permission.action,
    ),
  );

  if (!callerRow || callerRow.deletedAt !== null || !holdsGate) {
    return c.json(
      {
        type: "https://httpstatuses.com/403",
        title: "Forbidden",
        status: 403,
        detail: "You do not hold a permission that allows listing users.",
        instance: c.req.path,
        code: "directory_forbidden",
      },
      403,
    );
  }

  const rows = await db.user.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, email: true, entity: true },
  });

  const users = rows
    .map((row) => ({ id: row.id, name: row.name, email: row.email, entity: row.entity }))
    .sort(
      (a, b) =>
        nameCollator.compare(a.name ?? "", b.name ?? "") ||
        a.email.localeCompare(b.email) ||
        a.id.localeCompare(b.id),
    );

  c.header("Cache-Control", "no-store");
  return c.json({ users }, 200);
});

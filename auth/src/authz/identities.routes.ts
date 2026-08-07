/**
 * POST /authz/users/identities — id-keyed DISPLAY IDENTITY resolution (T3,
 * specs/013-estimate-sharing — refs AC-2.1, AC-10.5; plan.md "Display
 * identity"; ADR-0039).
 *
 * Lets a caller who already holds a set of opaque `sub`s (e.g. an estimate's
 * owner/collaborator ids, learned from `estimai-api`'s own data — never from
 * this endpoint) resolve them to a human-readable name + liveness status, so
 * a shared-record UI can render "Marco Rossi" or "Former wellD member"
 * instead of a raw cuid or a stale/misleading name (AC-10.5).
 *
 * THIS IS NOT THE USER DIRECTORY — that boundary is the spec's Non-goal and
 * IS the whole security argument, and it must never erode:
 *
 *   - Accepts **ids only**. No email, no name, no query, no prefix, no
 *     wildcard, no pagination. A caller who does not already hold an id
 *     cannot use this endpoint to discover one.
 *   - Capped at 100 ids per call (bounds the batch fan-out; matches
 *     `estimai-api`'s per-list-render batching plan).
 *   - Never returns an email — only `id`, `status`, `name`.
 *   - `name` is populated ONLY for `status:"active"` — a deleted or unknown
 *     user's name is never surfaced (AC-10.5: no identity information that
 *     implies an inactive account is still active).
 *
 * Any authenticated suite user may call this (`bearerJwtMiddleware`, same as
 * `/authz/resolve`) — no additional caller gate, unlike
 * `POST /authz/app-access-check` (T2), because resolving an id you already
 * hold to a display name is not itself a sensitive operation; the sensitive
 * step (learning that id in the first place) happens entirely inside the
 * calling app's own authorization (e.g. `estimai-api`'s owner/collaborator
 * grants).
 *
 * Fails SOFT at the call site (`estimai-api`'s `authClient.resolveIdentities`,
 * T5) — a throwing/erroring call there degrades every id to
 * `status:"unknown"` rather than surfacing an error, in explicit, named
 * contrast to T2's fail-CLOSED authorization decision (ADR-0039).
 *
 * DRIFT NOTE (reported, not silently resolved — see T2/T3 implementation
 * report): plan.md's API-contracts block lists a `429 + Retry-After`
 * response for this route, but neither T1 (which introduced the ONLY new
 * rate-limit env vars, `APP_ACCESS_CHECK_*`, scoped to T2's endpoint) nor
 * this task's `done when` provisions a limit/window for
 * `/authz/users/identities`. Rather than invent undocumented, unvalidated
 * constants (violating this service's "every env var validated at startup"
 * convention, CLAUDE.md), this endpoint ships WITHOUT rate limiting and the
 * 429 is omitted from its OpenAPI responses below. A future task should add
 * `IDENTITIES_RATE_LIMIT`/`_WINDOW_MS` (or similar) to `env.ts` if this is
 * confirmed as a real requirement, not a stale contract entry.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { db } from "../lib/db";
import { bearerJwtMiddleware, type ResolveAuthVariables } from "./resolveAuth.middleware";

const MAX_IDS = 100;

// ─── Schemas ──────────────────────────────────────────────────────────────────
// STRICT: `.strict()` rejects any body carrying an unrecognized key such as
// `email`/`name`/`query`/`prefix` — the directory-shape contract test's
// primary assertion. Accepting and silently ignoring those keys would be a
// worse failure mode than rejecting them outright: a caller relying on one
// of them to "work" would get a confusing partial result instead of a clear
// 400.
const IdentitiesRequestSchema = z
  .object({
    ids: z
      .array(z.string().min(1).max(64))
      .min(1, "ids must contain at least one id")
      .max(MAX_IDS, `ids must contain at most ${MAX_IDS} entries`),
  })
  .strict();

const IdentityStatusSchema = z.enum(["active", "deleted", "unknown"]);

const UserIdentitySchema = z.object({
  id: z.string(),
  status: IdentityStatusSchema,
  // Non-null ONLY for status:"active" — enforced in the handler, not just
  // documented here (a schema-level refinement would only validate the
  // OUTGOING shape at doc-generation time, not guard the handler itself).
  name: z.string().nullable(),
});

const IdentitiesResponseSchema = z.object({
  users: z.array(UserIdentitySchema),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Route ────────────────────────────────────────────────────────────────────

const postIdentitiesRoute = createRoute({
  method: "post",
  path: "/authz/users/identities",
  tags: ["Authorization"],
  summary: "Resolve a set of known user ids to display identity (id-keyed, never a directory)",
  description:
    "Accepts 1..100 ids (each 1..64 chars) the caller already holds and " +
    "returns { id, status: active|deleted|unknown, name } — name is " +
    "non-null only for status:active. Emails are never returned. Accepts " +
    "NO email/name/query/prefix input — this is not a search/directory " +
    "endpoint (spec Non-goal).",
  request: {
    body: {
      content: { "application/json": { schema: IdentitiesRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: IdentitiesResponseSchema } },
      description: "One entry per requested id, in no guaranteed order",
    },
    400: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Empty/over-cap ids array, or a body carrying a disallowed key",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Missing, invalid, expired, or wrong-issuer/audience Bearer token",
    },
    // 429 deliberately omitted — see the DRIFT NOTE in this file's header
    // doc comment: plan.md's contract lists one, but no rate-limit
    // env var / done-when test backs it for this specific route.
  },
});

// A dedicated OpenAPIHono instance with a Bearer-JWT-gated defaultHook so a
// malformed body (including one carrying a disallowed key, per `.strict()`
// above) surfaces as Problem JSON — matches appAccessCheck.routes.ts /
// catalog.routes.ts's established pattern in this service.
export const identitiesRouter = new OpenAPIHono<{
  Variables: ResolveAuthVariables;
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
          detail: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          instance: c.req.path,
        },
        400,
      );
    }
    return undefined;
  },
});

identitiesRouter.use("/authz/users/identities", bearerJwtMiddleware);

identitiesRouter.openapi(postIdentitiesRoute, async (c) => {
  const { ids } = c.req.valid("json");

  // De-duplicate — a caller sending the same id twice should not pay for or
  // receive two DB round-trip-equivalent rows; every requested id (including
  // duplicates) still gets an entry in the response below.
  const uniqueIds = Array.from(new Set(ids));

  const rows = await db.user.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true, deletedAt: true },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));

  const users = ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      return { id, status: "unknown" as const, name: null };
    }
    if (row.deletedAt !== null) {
      return { id, status: "deleted" as const, name: null };
    }
    return { id, status: "active" as const, name: row.name };
  });

  return c.json({ users }, 200);
});

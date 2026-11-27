/**
 * Admin team routes (specs/20261126-teams, plan "auth — admin routes (step 1)"; AC-1.1, 1.2, 1.4 to 1.8, 2.5, 3.1, 3.2).
 *
 *   GET    /admin/teams                  every team, archived included, in name order
 *   POST   /admin/teams                  { name, description? }                        -> 201 TeamDetail
 *   GET    /admin/teams/{id}             -> TeamDetail
 *   PATCH  /admin/teams/{id}             { baseVersion, name?, description? }          -> 200 TeamDetail
 *   POST   /admin/teams/{id}/archive     { baseVersion }                               -> 200 TeamDetail
 *   POST   /admin/teams/{id}/restore     { baseVersion }                               -> 200 TeamDetail
 *   DELETE /admin/teams/{id}             -> 405 `not_deletable`, `Allow: GET, PATCH` (a team is never deleted, AC-1.7)
 *
 *   POST   /admin/teams/{id}/members            { userId }                                    -> 200 TeamDetail
 *   DELETE /admin/teams/{id}/members/{userId}   -> 200 TeamDetail
 *
 * Every route runs behind `sessionMiddleware, requireAuth, requireAdmin`, as departments do: 401 without a session,
 * 403 for anyone who does not hold the `admin` role DIRECTLY (a department-conferred admin is refused), reads
 * included (AC-3.1). A team grants nothing, so no write touches the permission path: each successful change writes
 * exactly one audit row through `withAudit({ affectedUserIds: [] })`, which bumps no `perm_epoch` (AC-2.5, AC-3.2).
 * A refusal or a no-op writes none (`entry` yields an empty list).
 *
 * STALE FORMS (plan D5, D6, the 20261126 ADR): auth's CORS exposes no `ETag` and allows no `If-Match`, so a write of
 * the team's own fields carries `baseVersion` in the body, required (a missing one is a 400, never a skipped check).
 * The row is locked (`SELECT ... FOR UPDATE`) and the version is compared under that lock, and the update names the
 * version it was read at, so two parallel writes on one version make exactly one success. Archive and restore are
 * writes of the team's own state, so they take the precondition too.
 *
 * MEMBERS (plan D6, D7; AC-2.1 to 2.4): membership is a set operation outside the team's version, so neither route takes
`baseVersion` and neither bumps `version`. Both lock the team row (`FOR UPDATE`) first; an add then checks, in order,
that the person is an ACTIVE user (422 `user_not_active`, one body for an unknown id and a soft-deleted one, so the
route is no oracle for which ids exist), that they are not already a member (a no-op: 200, no write, no audit, so a
member at the limit is never refused for being re-added), and that the team holds fewer than 100 rows (422
`team_full` `{ limit: 100 }`; deactivated members count, they are still members). The lock makes the count and the
insert one step, so two adds at 99 cannot make 101. An archived team accepts both (AC-2.4). A remove of a person who
is not a member is a no-op. Each real change writes one audit row (`team_member.add` / `team_member.remove`,
`targetType: "team"`, `data: { userId }`, the summary names the person's email); a refusal or a no-op writes none.

ORDER of refusals: 401 -> 403 -> 400 `validation_failed` -> 404 `team_not_found` -> 409 `version_conflict`
 * (+ `currentVersion`) -> 409 `team_name_taken` (+ `existingName`). The version check is made before the name lookup,
 * so a stale form always hears `version_conflict` first. A save that changes nothing is a 200 with no bump and no audit.
 *
 * NAME CLASH (D14): the unique index on `lower("name")` decides; the pre-check inside the transaction (excluding the
 * team itself) supplies `existingName` without a failed write; a unique violation from a lost race rolls the
 * transaction back and is answered from a re-read of the committed winner (`nameTaken.ts`).
 *
 * Every answer carries `Cache-Control: no-store`. Errors are RFC 7807 with a `code`, never echoing the request.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { User } from "better-auth";
import { requireAdmin, requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { type AuditEntryInput, withAudit } from "../authz/audit";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { clashAfterConflict, findClashingName, isNameUniqueViolation, nameTakenBody } from "./nameTaken";
import { getTeamDetail, listTeamSummaries, TEAM_MEMBER_LIMIT, type TeamDetail } from "./repo";

const INT4_MAX = 2_147_483_647;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const PROBLEM_JSON = "application/problem+json";
const NO_STORE = "no-store";

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** Postgres text cannot hold U+0000: a NUL is a validation failure here, never a 500 from the database (QE D1). */
const noNul = (value: string) => !value.includes("\u0000");
const NO_NUL = "Must not contain a NUL character";

const ParamsSchema = z.object({ id: z.string().min(1).max(128).refine(noNul, NO_NUL) });

const TeamSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    archived: z.boolean(),
    activeMemberCount: z.number().int(),
    version: z.number().int(),
  })
  .openapi("TeamSummary");

const TeamMemberAdminSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    deactivated: z.boolean(),
    addedAt: z.string().datetime(),
  })
  .openapi("TeamMemberAdmin");

const TeamDetailSchema = TeamSummarySchema.extend({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  members: z.array(TeamMemberAdminSchema),
}).openapi("TeamDetail");

const TeamListSchema = z.object({ items: z.array(TeamSummarySchema) }).openapi("TeamList");

/** Trimmed, 1..80. The database CHECK is never stricter (JS `trim` and `.length` bound `btrim` and `char_length`). */
const NameSchema = z.string().refine(noNul, NO_NUL).trim().min(1).max(NAME_MAX);
/** Trimmed, at most 500; blank is "no description" (stored NULL). */
const DescriptionSchema = z
  .string()
  .refine(noNul, NO_NUL)
  .trim()
  .max(DESCRIPTION_MAX)
  .transform((value) => (value.length === 0 ? null : value));

const BaseVersionSchema = z.number().int().min(1).max(INT4_MAX);

const CreateBodySchema = z.strictObject({ name: NameSchema, description: DescriptionSchema.optional() });

const PatchBodySchema = z
  .strictObject({
    baseVersion: BaseVersionSchema,
    name: NameSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    message: "at least one of name and description is required",
  });

const StateBodySchema = z.strictObject({ baseVersion: BaseVersionSchema });

const AddMemberBodySchema = z.strictObject({ userId: z.string().min(1).max(64).refine(noNul, NO_NUL) });
const MemberParamsSchema = z.object({
  id: z.string().min(1).max(128).refine(noNul, NO_NUL),
  userId: z.string().min(1).max(128).refine(noNul, NO_NUL),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
  detail: z.string(),
  instance: z.string(),
});

/** In OpenAPI the 409 is a union by `code`: each variant requires its own member (AC-1.2). */
const TeamVersionConflictSchema = ProblemSchema.extend({
  code: z.literal("version_conflict"),
  currentVersion: z.number().int().min(1),
}).openapi("TeamVersionConflict");

const TeamNameTakenSchema = ProblemSchema.extend({
  code: z.literal("team_name_taken"),
  existingName: z.string().min(1),
}).openapi("TeamNameTaken");

const UserNotActiveSchema = ProblemSchema.extend({ code: z.literal("user_not_active") }).openapi("TeamUserNotActive");

const TeamFullSchema = ProblemSchema.extend({
  code: z.literal("team_full"),
  limit: z.literal(TEAM_MEMBER_LIMIT),
}).openapi("TeamFull");

// ─── Answers ──────────────────────────────────────────────────────────────────

/**
 * `openapi()` handlers admit only the answers their route declares, as typed `c.json` results; a `problem+json`
 * `Response` built by hand is one of those declared errors, so it is cast ONCE here (`never` is assignable to every
 * declared answer). The shapes are the schemas above, and `admin.routes.test.ts` asserts the real bodies.
 */
const declared = (response: Response): never => response as never;

function problem(c: Context, status: 400 | 404 | 405 | 409 | 422 | 500, title: string, code: string, detail: string, extra: object = {}): never {
  return declared(
    c.body(
      JSON.stringify({ type: `https://httpstatuses.com/${status}`, title, status, code, detail, instance: c.req.path, ...extra }),
      status,
      { "Content-Type": PROBLEM_JSON, "Cache-Control": NO_STORE },
    ),
  );
}

const teamNotFound = (c: Context): never => problem(c, 404, "Not Found", "team_not_found", "No team with this id");

const versionConflict = (c: Context, currentVersion: number): never =>
  problem(c, 409, "Conflict", "version_conflict", "The team was changed by someone else since it was read", { currentVersion });

const nameTaken = (c: Context, existingName: string): never =>
  declared(c.body(JSON.stringify(nameTakenBody(existingName, c.req.path)), 409, { "Content-Type": PROBLEM_JSON, "Cache-Control": NO_STORE }));

const userNotActive = (c: Context): never =>
  problem(c, 422, "Unprocessable Entity", "user_not_active", "Only an active user can be added to a team");

const teamFull = (c: Context): never =>
  problem(c, 422, "Unprocessable Entity", "team_full", `A team has at most ${TEAM_MEMBER_LIMIT} members, deactivated ones included`, {
    limit: TEAM_MEMBER_LIMIT,
  });

/** Thrown inside a transaction to roll it back with a refusal: nothing is written, no audit row. */
class Refusal extends Error {
  constructor(
    readonly kind: "not_found" | "conflict" | "name_taken" | "user_not_active" | "team_full",
    readonly value?: number | string,
  ) {
    super(kind);
    this.name = "Refusal";
  }
}

// ─── The write ────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

interface Current {
  id: string;
  name: string;
  description: string | null;
  archivedAt: Date | null;
  version: number;
}

/** What a change decides, under the row lock: nothing to do, or the update and the audit row that goes with it. */
type Decision =
  | { kind: "same" }
  | { kind: "change"; data: Prisma.TeamUpdateInput; audit: (after: TeamDetail) => AuditEntryInput };

interface Outcome {
  detail: TeamDetail;
  audit: AuditEntryInput | null;
}

/**
 * Locks the team, refuses a stale `baseVersion`, lets `decide` look at it and, when it changes something, updates it
 * naming the version it was read at (+ 1). Runs in the audit transaction: a refusal throws, which rolls it back.
 */
async function changeTeam(
  id: string,
  baseVersion: number,
  decide: (tx: Tx, current: Current) => Promise<Decision>,
): Promise<TeamDetail> {
  const outcome = await withAudit<Outcome>({
    affectedUserIds: [],
    mutate: async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "team" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw new Refusal("not_found");
      const current = await tx.team.findUniqueOrThrow({
        where: { id },
        select: { id: true, name: true, description: true, archivedAt: true, version: true },
      });
      if (current.version !== baseVersion) throw new Refusal("conflict", current.version);

      const decision = await decide(tx, current);
      if (decision.kind === "same") return { detail: (await getTeamDetail(id, tx))!, audit: null };

      await tx.team.update({
        where: { id, version: baseVersion },
        data: { ...decision.data, version: { increment: 1 } },
      });
      const detail = (await getTeamDetail(id, tx))!;
      return { detail, audit: decision.audit(detail) };
    },
    // A no-op writes no audit row: an empty list is "nothing to record".
    entry: (result) => (result.audit === null ? [] : result.audit),
  });
  return outcome.detail;
}

/**
 * The answer to a refusal thrown inside a transaction, or `undefined` when the error is not one (the caller rethrows).
 * Typed `undefined` because the answers are the `declared` casts above; at run time it is the 404 or 409 `Response`.
 */
function refusalResponse(c: Context, error: unknown): undefined {
  if (!(error instanceof Refusal)) return undefined;
  if (error.kind === "not_found") return teamNotFound(c);
  if (error.kind === "conflict") return versionConflict(c, error.value as number);
  if (error.kind === "user_not_active") return userNotActive(c);
  if (error.kind === "team_full") return teamFull(c);
  return nameTaken(c, error.value as string);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const teamsRouter = new OpenAPIHono<{ Variables: { user: User | null } }>({
  // A malformed body is RFC 7807 with a code. The issues name paths and rules, never the submitted values.
  defaultHook: (result, c) => {
    if (!result.success) {
      return problem(
        c,
        400,
        "Bad Request",
        "validation_failed",
        result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    return undefined;
  },
});

/** `no-store` first, so the 401 and 403 carry it too. */
const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", NO_STORE);
  await next();
};

teamsRouter.use("/admin/teams", noStore, sessionMiddleware, requireAuth, requireAdmin);
teamsRouter.use("/admin/teams/*", noStore, sessionMiddleware, requireAuth, requireAdmin);

const responses401403 = {
  401: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "No valid session" },
  403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Caller does not hold the admin role" },
};
const notFoundResponse = {
  404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "`team_not_found`" },
};
const validationResponse = {
  400: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "`validation_failed`" },
};
const detailResponse = (description: string) => ({
  content: { "application/json": { schema: TeamDetailSchema } },
  description,
});

const listRoute = createRoute({
  method: "get",
  path: "/admin/teams",
  tags: ["Admin"],
  summary: "List every team, archived included",
  responses: {
    200: { content: { "application/json": { schema: TeamListSchema } }, description: "Every team, in name order" },
    ...responses401403,
  },
});

const createTeamRoute = createRoute({
  method: "post",
  path: "/admin/teams",
  tags: ["Admin"],
  summary: "Create a team",
  request: { body: { required: true, content: { "application/json": { schema: CreateBodySchema } } } },
  responses: {
    201: detailResponse("The created team"),
    ...validationResponse,
    ...responses401403,
    409: {
      content: { "application/problem+json": { schema: TeamNameTakenSchema } },
      description: "`team_name_taken` + `existingName`: another team has this name, ignoring case (archived included)",
    },
  },
});

const getTeamRoute = createRoute({
  method: "get",
  path: "/admin/teams/{id}",
  tags: ["Admin"],
  summary: "Get a team with its members",
  request: { params: ParamsSchema },
  responses: { 200: detailResponse("The team"), ...responses401403, ...notFoundResponse },
});

const patchTeamRoute = createRoute({
  method: "patch",
  path: "/admin/teams/{id}",
  tags: ["Admin"],
  summary: "Rename or redescribe a team",
  request: { params: ParamsSchema, body: { required: true, content: { "application/json": { schema: PatchBodySchema } } } },
  responses: {
    200: detailResponse("The team (unchanged values: no version bump)"),
    ...validationResponse,
    ...responses401403,
    ...notFoundResponse,
    409: {
      content: { "application/problem+json": { schema: z.union([TeamVersionConflictSchema, TeamNameTakenSchema]) } },
      description: "`version_conflict` + `currentVersion` (checked first), or `team_name_taken` + `existingName`",
    },
  },
});

const stateRoute = (action: "archive" | "restore") =>
  createRoute({
    method: "post",
    path: `/admin/teams/{id}/${action}`,
    tags: ["Admin"],
    summary: action === "archive" ? "Archive a team" : "Restore an archived team",
    request: { params: ParamsSchema, body: { required: true, content: { "application/json": { schema: StateBodySchema } } } },
    responses: {
      200: detailResponse(action === "archive" ? "The team (already archived: no-op)" : "The team (already active: no-op)"),
      ...validationResponse,
      ...responses401403,
      ...notFoundResponse,
      409: {
        content: { "application/problem+json": { schema: TeamVersionConflictSchema } },
        description: "`version_conflict` + `currentVersion`",
      },
    },
  });

const addMemberRoute = createRoute({
  method: "post",
  path: "/admin/teams/{id}/members",
  tags: ["Admin"],
  summary: "Add an active user to a team",
  request: { params: ParamsSchema, body: { required: true, content: { "application/json": { schema: AddMemberBodySchema } } } },
  responses: {
    200: detailResponse("The team with its members (already a member: no-op)"),
    ...validationResponse,
    ...responses401403,
    ...notFoundResponse,
    422: {
      content: { "application/problem+json": { schema: z.union([UserNotActiveSchema, TeamFullSchema]) } },
      description: "`user_not_active` (unknown or deactivated, one body), or `team_full` + `limit`",
    },
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/admin/teams/{id}/members/{userId}",
  tags: ["Admin"],
  summary: "Remove a member from a team",
  request: { params: MemberParamsSchema },
  responses: { 200: detailResponse("The team with its members (not a member: no-op)"), ...responses401403, ...notFoundResponse },
});

const archiveRoute = stateRoute("archive");
const restoreRoute = stateRoute("restore");

const deleteTeamRoute = createRoute({
  method: "delete",
  path: "/admin/teams/{id}",
  tags: ["Admin"],
  summary: "Teams are never deleted",
  request: { params: ParamsSchema },
  responses: {
    405: {
      content: { "application/problem+json": { schema: ProblemSchema } },
      description: "`not_deletable`, with `Allow: GET, PATCH`",
    },
    ...responses401403,
  },
});

// ─── GET /admin/teams ─────────────────────────────────────────────────────────

teamsRouter.openapi(listRoute, async (c) => c.json({ items: await listTeamSummaries() }, 200));

// ─── POST /admin/teams ────────────────────────────────────────────────────────

teamsRouter.openapi(createTeamRoute, async (c) => {
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  try {
    const created = await withAudit<TeamDetail>({
      affectedUserIds: [],
      mutate: async (tx) => {
        // The common case is answered without a failed write; the unique index still decides a race.
        const clash = await findClashingName(tx, body.name);
        if (clash !== null) throw new Refusal("name_taken", clash);
        const row = await tx.team.create({
          data: { name: body.name, description: body.description ?? null },
          select: { id: true },
        });
        return (await getTeamDetail(row.id, tx))!;
      },
      entry: (team) => ({
        actorUserId,
        action: "team.create",
        targetType: "team",
        targetId: team.id,
        summary: `Created team "${team.name}"`,
      }),
    });
    return c.json(created, 201);
  } catch (error) {
    const refused = refusalResponse(c, error);
    if (refused !== undefined) return refused;
    // Lost the race: the transaction rolled back; the committed winner's name is the answer.
    if (isNameUniqueViolation(error)) return nameTaken(c, await clashAfterConflict(body.name));
    throw error;
  }
});

// ─── GET /admin/teams/{id} ────────────────────────────────────────────────────

teamsRouter.openapi(getTeamRoute, async (c) => {
  const { id } = c.req.valid("param");
  const detail = await getTeamDetail(id);
  return detail === null ? teamNotFound(c) : c.json(detail, 200);
});

// ─── PATCH /admin/teams/{id} ──────────────────────────────────────────────────

teamsRouter.openapi(patchTeamRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  try {
    const detail = await changeTeam(id, body.baseVersion, async (tx, current) => {
      const name = body.name ?? current.name;
      const description = body.description === undefined ? current.description : body.description;
      const nameChanged = name !== current.name;
      if (!nameChanged && description === current.description) return { kind: "same" };

      // The stale-form check above came first. A rename to another casing of the team's own name is no clash.
      if (nameChanged) {
        const clash = await findClashingName(tx, name, id);
        if (clash !== null) throw new Refusal("name_taken", clash);
      }
      return {
        kind: "change",
        data: { name, description },
        audit: (after) => ({
          actorUserId,
          action: "team.update",
          targetType: "team",
          targetId: id,
          summary: `Updated team "${after.name}"`,
          data: {
            before: { name: current.name, description: current.description },
            after: { name: after.name, description: after.description },
          },
        }),
      };
    });
    return c.json(detail, 200);
  } catch (error) {
    const refused = refusalResponse(c, error);
    if (refused !== undefined) return refused;
    if (isNameUniqueViolation(error) && body.name !== undefined) return nameTaken(c, await clashAfterConflict(body.name, id));
    throw error;
  }
});

// ─── POST /admin/teams/{id}/archive and /restore ──────────────────────────────

function stateHandler(action: "archive" | "restore") {
  return async (c: Context<{ Variables: { user: User | null } }>, id: string, baseVersion: number): Promise<never> => {
    const actorUserId = c.get("user")!.id;
    try {
      const detail = await changeTeam(id, baseVersion, async (_tx, current) => {
        const archived = current.archivedAt !== null;
        if (archived === (action === "archive")) return { kind: "same" };
        return {
          kind: "change",
          data: { archivedAt: action === "archive" ? new Date() : null },
          audit: (after) => ({
            actorUserId,
            action: `team.${action}`,
            targetType: "team",
            targetId: id,
            summary: `${action === "archive" ? "Archived" : "Restored"} team "${after.name}"`,
          }),
        };
      });
      return declared(c.json(detail, 200));
    } catch (error) {
      const refused = refusalResponse(c, error);
      if (refused !== undefined) return refused;
      throw error;
    }
  };
}

const archive = stateHandler("archive");
const restore = stateHandler("restore");

teamsRouter.openapi(archiveRoute, (c) => archive(c, c.req.valid("param").id, c.req.valid("json").baseVersion));
teamsRouter.openapi(restoreRoute, (c) => restore(c, c.req.valid("param").id, c.req.valid("json").baseVersion));

// ─── POST /admin/teams/{id}/members and DELETE /admin/teams/{id}/members/{userId} ───────────────────────────────

/** Locks the team row and returns its name; a missing team refuses with 404. */
async function lockTeam(tx: Tx, id: string): Promise<{ name: string }> {
  const locked = await tx.$queryRaw<{ name: string }[]>`SELECT "name" FROM "team" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new Refusal("not_found");
  return locked[0]!;
}

teamsRouter.openapi(addMemberRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { userId } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  try {
    const outcome = await withAudit<Outcome>({
      affectedUserIds: [],
      mutate: async (tx) => {
        const team = await lockTeam(tx, id);
        const person = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { email: true } });
        if (person === null) throw new Refusal("user_not_active");

        const existing = await tx.teamMember.findUnique({ where: { teamId_userId: { teamId: id, userId } }, select: { userId: true } });
        if (existing !== null) return { detail: (await getTeamDetail(id, tx))!, audit: null };

        if ((await tx.teamMember.count({ where: { teamId: id } })) >= TEAM_MEMBER_LIMIT) throw new Refusal("team_full");
        await tx.teamMember.create({ data: { teamId: id, userId, addedByUserId: actorUserId } });
        return {
          detail: (await getTeamDetail(id, tx))!,
          audit: {
            actorUserId,
            action: "team_member.add",
            targetType: "team",
            targetId: id,
            summary: `Added ${person.email} to team "${team.name}"`,
            data: { userId },
          },
        };
      },
      entry: (result) => (result.audit === null ? [] : result.audit),
    });
    return c.json(outcome.detail, 200);
  } catch (error) {
    const refused = refusalResponse(c, error);
    if (refused !== undefined) return refused;
    throw error;
  }
});

teamsRouter.openapi(removeMemberRoute, async (c) => {
  const { id, userId } = c.req.valid("param");
  const actorUserId = c.get("user")!.id;

  try {
    const outcome = await withAudit<Outcome>({
      affectedUserIds: [],
      mutate: async (tx) => {
        const team = await lockTeam(tx, id);
        // Read whether or not the person is still active: a deactivated member can be removed.
        const person = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
        const removed = await tx.teamMember.deleteMany({ where: { teamId: id, userId } });
        const detail = (await getTeamDetail(id, tx))!;
        if (removed.count === 0 || person === null) return { detail, audit: null };
        return {
          detail,
          audit: {
            actorUserId,
            action: "team_member.remove",
            targetType: "team",
            targetId: id,
            summary: `Removed ${person.email} from team "${team.name}"`,
            data: { userId },
          },
        };
      },
      entry: (result) => (result.audit === null ? [] : result.audit),
    });
    return c.json(outcome.detail, 200);
  } catch (error) {
    const refused = refusalResponse(c, error);
    if (refused !== undefined) return refused;
    throw error;
  }
});

// ─── DELETE /admin/teams/{id} ─────────────────────────────────────────────────

// A team is never deleted (AC-1.7): the same answer for every id, so it reveals nothing about which ones exist.
teamsRouter.openapi(deleteTeamRoute, (c) => {
  c.header("Allow", "GET, PATCH");
  return problem(c, 405, "Method Not Allowed", "not_deletable", "A team is never deleted: archive it instead");
});

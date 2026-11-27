/**
 * The teams of a project (specs/20261126-teams T12; AC-4.1, AC-4.2, AC-4.9, AC-5.4, AC-5.6; D13, D15).
 *
 *   PUT /projects/{id}/teams   replaces the set of attached teams (project:manage for the entity, If-Match, at most 10).
 *                              Reads the whole NEW set from auth once, fresh, and judges the added ids; a team that
 *                              stays is not re-judged (an archived one may stay, AC-4.2). The view that answers is
 *                              built from that one read.
 *   GET /attachable-teams      the attach picker's server-side search, auth's options mode, fresh, never cached, on
 *                              its own per-caller limit.
 *
 * A team carries no permission: this is presence on a project, never capability (AC-5.5).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { IdParams, assertVersion, casMiss, commonErrors, etag, requireIfMatch } from "../lib/http";
import { notFound, problem, unprocessable, validationHook } from "../lib/problem";
import { admitTeamRead, attachableTeamsLimiter } from "../lib/rateLimiter";
import { teamReader, teamsUnavailable, type TeamsRead } from "../lib/teams";
import { findProjectRow, projectInclude, toProjectView } from "./projects.routes";
import { AttachableTeamsQuery, AttachableTeamsSchema, AttachedTeamsSchema, ProjectSchema, PutTeamsSchema } from "./projects.schemas";
import type { TeamsOutcome } from "./teamView";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

/** The 429 of a person over a team limit: `retryAfterSeconds` is in the body because CORS hides `Retry-After` from the browser. */
const RateLimitedSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(429),
  code: z.literal("rate_limited"),
  detail: z.string(),
  instance: z.string(),
  retryAfterSeconds: z.number().int().min(1).max(600),
});

const rateLimited = (instance: string, detail: string, retryAfterSeconds: number): Response => {
  const res = problem({ status: 429, code: "rate_limited", detail, extras: { retryAfterSeconds } }, instance);
  res.headers.set("Retry-After", String(retryAfterSeconds));
  res.headers.set("Cache-Control", "no-store");
  return res;
};

const seconds = (ms: number): number => Math.min(600, Math.max(1, Math.ceil(ms / 1000)));

/** The attach search's own limit, per caller, counted after the guards and before `q` is looked at (D13). */
const attachableLimit = createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
  const result = attachableTeamsLimiter.consume(c.get("userId"));
  if (!result.allowed) {
    return rateLimited(c.req.path, "Too many team searches. Try again later.", seconds(result.retryAfterMs));
  }
  return next();
});

const putTeamsRoute = createRoute({
  method: "put",
  path: "/projects/{id}/teams",
  tags: ["Projects"],
  summary: "Replace the teams attached to a project (project:manage for its entity, If-Match required)",
  description:
    "At most 10. Only the teams being ADDED are judged: unknown is `team_not_found`, archived is `team_archived` " +
    "(one that is attached already may stay). Adding needs one fresh read of auth: 503 `teams_unavailable` when it " +
    "fails, 429 `rate_limited` (with `retryAfterSeconds`) when the person's own page-read limit refused it. Only " +
    "removing never fails on either.",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: PutTeamsSchema } }, required: true },
  },
  responses: {
    200: { description: "The project with its new teams", ...json(ProjectSchema) },
    404: { description: "Not found" },
    409: { description: "version_conflict" },
    422: { description: "team_not_found or team_archived, with the refused team ids in `teamIds`" },
    428: { description: "precondition_required" },
    429: { description: "rate_limited: the person's own limit on team reads", ...json(RateLimitedSchema) },
    // 503: `teams_unavailable` (auth's team read failed) or `authz_unavailable` (commonErrors).
    ...commonErrors,
  },
});

const attachableTeamsRoute = createRoute({
  method: "get",
  path: "/attachable-teams",
  tags: ["Projects"],
  summary: "Search the teams that can be attached (project:manage for any entity)",
  description:
    "Active teams only, from auth, fresh and never cached. `q` is trimmed (at most 80 characters) and matched as a " +
    "case-insensitive substring, the exact name first; at most 50 are answered, `truncated` when more matched. " +
    "120 requests per caller per 10 minutes.",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE), attachableLimit],
  request: { query: AttachableTeamsQuery },
  responses: {
    200: { description: "The teams", ...json(AttachableTeamsSchema) },
    429: { description: "rate_limited", ...json(RateLimitedSchema) },
    // 503: `teams_unavailable` (auth's team read failed) or `authz_unavailable` (commonErrors).
    ...commonErrors,
  },
});

const attachedTeamsRoute = createRoute({
  method: "get",
  path: "/attached-teams",
  tags: ["Projects"],
  summary: "The distinct teams attached to at least one project, by name (projects:access only)",
  description:
    "Feeds the list's team filter, archived teams included (a project keeps one, AC-4.2). Names come from auth through the " +
    "cached read (at most 60 s old, never limited per person); a team that cannot be read has `name: null` and " +
    "`archived: null` and is listed last, so a failed read never fails the list (AC-5.4).",
  middleware: authorized,
  responses: { 200: { description: "The teams", ...json(AttachedTeamsSchema) }, ...commonErrors },
});

/** The added ids that cannot be attached: 503 when they cannot be judged, else 422 for an unknown or an archived one. */
function judgeAdded(added: readonly string[], read: TeamsRead): void {
  if (added.some((id) => read.unavailable.has(id))) throw teamsUnavailable();
  const unknown = added.filter((id) => !read.teams.has(id));
  if (unknown.length > 0) {
    throw unprocessable("The team does not exist", { teamIds: unknown }, "team_not_found");
  }
  const archived = added.filter((id) => read.teams.get(id)!.archived);
  if (archived.length > 0) {
    throw unprocessable("An archived team cannot be attached", { teamIds: archived }, "team_archived");
  }
}

export const teamsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

teamsRouter.openapi(putTeamsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { teamIds } = c.req.valid("json");
  const wanted = [...new Set(teamIds)];
  const expected = requireIfMatch(c);
  const current = await findProjectRow(id);
  if (!current) throw notFound("Project not found");
  assertCanManage(c, current.entity);
  assertVersion(current.version, expected);

  const staying = new Set(current.attachedTeams.map((attached) => attached.teamId));
  const added = wanted.filter((teamId) => !staying.has(teamId));

  // ONE read of the whole new set (D15), admitted by the person's and the service's windows; an empty set reads and counts nothing.
  let outcome: TeamsOutcome | null = null;
  if (wanted.length > 0) {
    const admission = admitTeamRead(c.get("userId"));
    if (admission.admitted) {
      // A team that is being added is never judged from a copy; with nothing to confirm a recent entry may fill the view.
      const read = await teamReader.fresh(wanted, { fallback: added.length === 0 });
      judgeAdded(added, read);
      outcome = { kind: "read", read };
    } else if (added.length > 0) {
      if (admission.window === "person") {
        return rateLimited(c.req.path, "Too many team reads. Try again later.", admission.retryAfterSeconds ?? 1);
      }
      throw teamsUnavailable();
    } else {
      outcome = { kind: "refused", window: admission.window, retryAfterSeconds: admission.retryAfterSeconds };
    }
  }

  const attachedAt = Date.now();
  const row = await db.$transaction(async (tx) => {
    // Compare-and-set on the version: of two saves of the same version only one matches.
    const bumped = await tx.project.updateMany({ where: { id, version: expected }, data: { version: { increment: 1 } } });
    if (bumped.count === 0) {
      throw casMiss(await tx.project.findUnique({ where: { id }, select: { version: true } }), "Project not found");
    }
    await tx.attachedTeam.deleteMany({ where: { projectId: id, teamId: { notIn: wanted } } });
    // One millisecond apart, so the teams added together keep the order the request named them in.
    await tx.attachedTeam.createMany({
      data: added.map((teamId, index) => ({ projectId: id, teamId, attachedAt: new Date(attachedAt + index) })),
      skipDuplicates: true,
    });
    return tx.project.findUniqueOrThrow({ where: { id }, include: projectInclude });
  });
  c.header("ETag", etag(row.version));
  return c.json(await toProjectView(c, row, outcome), 200);
});

teamsRouter.openapi(attachableTeamsRoute, async (c) => {
  const { q } = c.req.valid("query");
  const options = await teamReader.options(q);
  c.header("Cache-Control", "no-store");
  return c.json({ items: [...options.items], truncated: options.truncated }, 200);
});

teamsRouter.openapi(attachedTeamsRoute, async (c) => {
  const rows = await db.attachedTeam.findMany({ distinct: ["teamId"], select: { teamId: true } });
  const ids = rows.map((row) => row.teamId);
  // Cached, fail soft: what an old entry still says of a team, else nothing (never a guess, never an error).
  const read = ids.length === 0 ? null : await teamReader.cached(ids);
  const items = ids.map((id) => {
    const fact = read?.teams.get(id) ?? read?.unavailable.get(id) ?? null;
    return { id, name: fact?.name ?? null, archived: fact?.archived ?? null };
  });
  items.sort(
    (a, b) =>
      Number(a.name === null) - Number(b.name === null) ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.id.localeCompare(b.id),
  );
  return c.json({ items }, 200);
});

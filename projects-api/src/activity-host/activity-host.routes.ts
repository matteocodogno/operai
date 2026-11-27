/**
 * The activity-host contract (specs/20261110-activities T5; AC-3.2, AC-3.5, AC-3.8, AC-8.1, plan.md
 * § Host contract, ADR 20261110-activities-service-access-delegated-to-host). activities-api holds the tasks of a project but no permission
 * catalog: on every request it asks THIS service, with the caller's own JWT, who the caller is
 * to the project.
 *
 *   reader     the caller holds `projects:access` (every holder reads every project, D13)
 *   may.manage `project:manage` covering the project's entity (the rule of `assertCanManage`);
 *              `may.write` is the same grant
 *   writable   the project is not `closed` or `cancelled` (AC-3.8): the project stays readable
 *              and its tasks can be completed or reopened, nothing else is accepted
 *   assignees  who is on the project (`onProject`: the project manager, the listed members and the counted members of
 *              the attached teams, specs/20261126-teams AC-4.4): the only people a task may be given to (AC-3.1,
 *              AC-5.2). `null` when an attached team's members cannot be read: "could not find out", never the listed
 *              people alone (AC-5.4, D3, ADR 20261126-a-host-says-unknown-...). Only that one field is unknown: the
 *              batch and the rest of the item are answered. A project without a team never waits on auth.
 *
 * Unlike every other route, a caller WITHOUT `projects:access` is not refused: the answer is
 * `reader:false` with every id `missing` (AC-7.4, AC-8.3 — a project one cannot read is
 * indistinguishable from one that does not exist). Only JWT and live authorization run; an `auth`
 * outage is the usual 503 `authz_unavailable`, which activities-api reads as `host_unavailable`.
 * The route reads nothing it is not asked about and writes nothing. Its team read is the CACHED path (D2), never the
 * page's windows (D15, AC-5.6): a decision is not limited per person.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECTS_ACCESS, manageScope } from "../auth/guards";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { db } from "../lib/db";
import { IdSchema } from "../lib/http";
import { validationHook } from "../lib/problem";
import { factsOrUnavailable, teamReader, type TeamFact } from "../lib/teams";
import { onProject } from "../projects/onProject";

/** Hosts answer in batches of 25 (plan.md): activities-api splits larger sets. */
export const MAX_RESOLVE_IDS = 25;

/** The project states in which a task can no longer be created, edited, reassigned or deleted (AC-3.8). */
const READ_ONLY_STATES: readonly string[] = ["closed", "cancelled"];

const ResolveBodySchema = z
  .object({
    entityType: z.literal("project"),
    ids: z.array(IdSchema).max(MAX_RESOLVE_IDS),
    // The CRM's contacts and deals: accepted so a caller that sends it everywhere is not refused,
    // never read, never answered.
    related: z.record(z.string(), z.array(IdSchema).max(100)).optional(),
  })
  .strict();

const ItemSchema = z.union([
  z.object({ id: z.string(), state: z.literal("missing") }),
  z.object({
    id: z.string(),
    state: z.literal("open"),
    writable: z.boolean(),
    label: z.string(),
    href: z.string(),
    may: z.object({ write: z.boolean(), manage: z.boolean() }),
    /** `null`: an attached team's members could not be read (D3). Never absent. */
    assignees: z.array(z.string()).nullable(),
  }),
]);

const ResolveResponseSchema = z.object({ reader: z.boolean(), items: z.array(ItemSchema) });

const resolveRoute = createRoute({
  method: "post",
  path: "/activity-host/v1/resolve",
  tags: ["Activity host"],
  summary: "What the caller may do with these projects' tasks (called by activities-api as the caller)",
  // JWT + live authorization only: a caller without projects:access gets `reader:false`, not a 403.
  middleware: [jwtMiddleware, authzMiddleware],
  request: { body: { content: { "application/json": { schema: ResolveBodySchema } }, required: true } },
  responses: {
    200: { description: "One item per distinct id, in request order", content: { "application/json": { schema: ResolveResponseSchema } } },
    401: { description: "Missing or invalid token" },
    400: { description: "Validation failed (validation_failed, as everywhere in this service)" },
    503: { description: "The authorization service is unavailable" },
  },
});

export const activityHostRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

activityHostRouter.openapi(resolveRoute, async (c) => {
  const { ids } = c.req.valid("json");
  const distinct = [...new Set(ids)];
  const { permissions } = c.get("authz");
  // Derived from the caller's live permissions on every request; the answer is never cached.
  c.header("Cache-Control", "no-store");

  const reader = hasCapability(permissions, PROJECTS_ACCESS[0], PROJECTS_ACCESS[1]);
  if (!reader || distinct.length === 0) {
    return c.json({ reader, items: distinct.map((id) => ({ id, state: "missing" as const })) }, 200);
  }

  const rows = await db.project.findMany({
    where: { id: { in: distinct } },
    select: {
      id: true,
      name: true,
      entity: true,
      state: true,
      projectManagerId: true,
      members: { select: { userId: true }, orderBy: [{ addedAt: "asc" }, { userId: "asc" }] },
      attachedTeams: { select: { teamId: true }, orderBy: [{ attachedAt: "asc" }, { teamId: "asc" }] },
    },
  });
  // One cached read for every distinct team of the batch (never one per project); none when no project has a team.
  const teamIds = [...new Set(rows.flatMap((row) => row.attachedTeams.map((team) => team.teamId)))];
  const teamsRead = teamIds.length === 0 ? null : await teamReader.cached(teamIds);
  const assigneesOf = (row: (typeof rows)[number]): string[] | null => {
    const attachedTeamIds = row.attachedTeams.map((team) => team.teamId);
    const facts: ReadonlyMap<string, TeamFact> | "unavailable" =
      attachedTeamIds.length === 0 ? new Map() : teamsRead === null ? "unavailable" : factsOrUnavailable(teamsRead, attachedTeamIds);
    const people = onProject(
      { projectManagerId: row.projectManagerId, memberIds: row.members.map((member) => member.userId), attachedTeamIds },
      facts,
    );
    return people === "unavailable" ? null : people;
  };
  const byId = new Map(rows.map((row) => [row.id, row]));
  const scope = manageScope(c);

  const items = distinct.map((id) => {
    const row = byId.get(id);
    if (!row) return { id, state: "missing" as const };
    const manage = scope.includes(row.entity);
    return {
      id,
      state: "open" as const,
      writable: !READ_ONLY_STATES.includes(row.state),
      label: row.name,
      href: `/projects/${row.id}`,
      may: { write: manage, manage },
      // A project from a deal has no project manager until its ops-manager picks one (specs/20261103-projects-handoff D42):
      // then only the team can be given a task. `null` when a team's members are unknown (D3), never the listed set alone.
      assignees: assigneesOf(row),
    };
  });
  return c.json({ reader, items }, 200);
});

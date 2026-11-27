/**
 * The meeting-host contract (specs/20261104-meetings US-11 and A18, ADR 20261104-meeting-host-contract-resolve-and-notices):
 * meetings-api asks THIS service, with the caller's own JWT, what the caller may know about the projects a
 * meeting is (or would be) linked to.
 *
 *   missing     no such project
 *   closed      the caller does not hold `projects:access` (a project they cannot open)
 *   open        the caller reads it: its name, its page and whether they are a HOST READER —
 *               `hostVisible` is true for the project's team (its project manager and members), the
 *               people a creator may let read a meeting linked to the project (A18)
 *
 * A person is on the project through a team too (specs/20261126-teams AC-5.3, AC-4.4): `hostVisible` is
 * "the caller is among `onProject`". The project manager and a listed member are answered from the rows,
 * with no team read. For anyone else on a project with attached teams the teams are read on the CACHED
 * path (D2), never the page's windows (D15, AC-5.6). When that cannot say whether the caller is on the
 * project (a team's members are unknown) the whole call is the 503 `teams_unavailable` (D3, AC-5.4,
 * ADR 20261126-a-host-says-unknown-...): `hostVisible` absent already reads as "not granted" in
 * meetings-api, so a `false` here would be a decision made from nothing. Someone found on a team that
 * could be read is answered `true` whatever else is unknown: more members never take a person off.
 *
 * Only JWT and live authorization run (no capability guard: a caller without access is answered,
 * not refused); an `auth` outage is the usual 503, which meetings-api reads as `host_unavailable`. Inside
 * meetings-api's 2 s the route waits at most `HOST_AUTHZ_WAIT_MS` (500 ms) for a permission check it has not cached
 * (`hostAuthzMiddleware`, R13 a): late is the same 503, and the check, not aborted, fills the cache for the retry.
 * Projects takes no host notices (the registry says `notices: false`): nothing about a meeting is
 * stored here. Reads only what it is asked about, writes nothing, never cached.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECTS_ACCESS } from "../auth/guards";
import { hostAuthzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { hasCapability } from "../authz/conditions";
import { db } from "../lib/db";
import { IdSchema } from "../lib/http";
import { validationHook } from "../lib/problem";
import { teamReader, teamsUnavailable } from "../lib/teams";
import { onProjectKnown } from "../projects/onProject";

/** meetings-api asks in batches of at most 25. */
export const MAX_MEETING_RESOLVE_IDS = 25;

const ResolveBodySchema = z
  .object({
    entityType: z.literal("project"),
    ids: z.array(IdSchema).min(1).max(MAX_MEETING_RESOLVE_IDS),
  })
  .strict();

const ItemSchema = z.union([
  z.object({ id: z.string(), state: z.enum(["missing", "closed"]) }),
  z.object({
    id: z.string(),
    state: z.literal("open"),
    title: z.string(),
    href: z.string(),
    hostVisible: z.boolean(),
  }),
]);

const resolveRoute = createRoute({
  method: "post",
  path: "/meeting-host/v1/resolve",
  tags: ["Meeting host"],
  summary: "What the caller may know about these projects (called by meetings-api as the caller)",
  middleware: [jwtMiddleware, hostAuthzMiddleware],
  request: { body: { content: { "application/json": { schema: ResolveBodySchema } }, required: true } },
  responses: {
    200: {
      description: "One item per distinct id, in request order",
      content: { "application/json": { schema: z.object({ items: z.array(ItemSchema) }) } },
    },
    400: { description: "Validation failed" },
    401: { description: "Missing or invalid token" },
    503: {
      description:
        "The authorization service is unavailable, or `teams_unavailable`: an attached team's members could not be read and the caller is not otherwise known to be on a project",
    },
  },
});

export const meetingHostRouter = new OpenAPIHono<{ Variables: AuthzVariables & { userId: string } }>({
  defaultHook: validationHook,
});

meetingHostRouter.openapi(resolveRoute, async (c) => {
  const distinct = [...new Set(c.req.valid("json").ids)];
  c.header("Cache-Control", "no-store");
  const { permissions } = c.get("authz");
  const userId = c.get("userId");

  const rows = await db.project.findMany({
    where: { id: { in: distinct } },
    select: {
      id: true,
      name: true,
      projectManagerId: true,
      members: { where: { userId }, select: { userId: true } },
      attachedTeams: { select: { teamId: true }, orderBy: [{ attachedAt: "asc" }, { teamId: "asc" }] },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const reader = hasCapability(permissions, PROJECTS_ACCESS[0], PROJECTS_ACCESS[1]);

  // Only a project the caller may open, on which they are not already listed, and that has teams, needs a team read.
  const listed = (row: (typeof rows)[number]) => row.projectManagerId === userId || row.members.length > 0;
  const needsTeams = reader ? rows.filter((row) => !listed(row) && row.attachedTeams.length > 0) : [];
  const teamIds = [...new Set(needsTeams.flatMap((row) => row.attachedTeams.map((team) => team.teamId)))];
  const teams = teamIds.length === 0 ? null : (await teamReader.cached(teamIds)).teams;

  const items = distinct.map((id) => {
    const row = byId.get(id);
    if (!row) return { id, state: "missing" as const };
    if (!reader) return { id, state: "closed" as const };
    let hostVisible = listed(row);
    if (!hostVisible && row.attachedTeams.length > 0) {
      // memberIds is empty: the caller is not listed (above), so only the teams can put them on the project.
      const known = onProjectKnown(
        { projectManagerId: null, memberIds: [], attachedTeamIds: row.attachedTeams.map((team) => team.teamId) },
        teams ?? "unavailable",
      );
      if (known.ids.includes(userId)) hostVisible = true;
      else if (!known.complete) throw teamsUnavailable(); // unknown is not "no" (D3): the whole call is refused
    }
    return { id, state: "open" as const, title: row.name, href: `/projects/${row.id}`, hostVisible };
  });
  return c.json({ items }, 200);
});

/**
 * The team of a project (specs/024 T7; AC-1.5, AC-1.6, AC-1.7, AC-4.4).
 *
 * `PUT /projects/:id/team` replaces the whole team. It is a write on the project: `project:manage`
 * for the project's entity, `If-Match` required, and it bumps the project's `version` — someone who
 * loaded the project before the change is asked to reload. Members are opaque `auth` user ids;
 * names are resolved live when the `Project` is shown, never stored.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { IdParams, IdSchema, assertVersion, casMiss, commonErrors, etag, requireIfMatch } from "../lib/http";
import { requireProjectUsers } from "../lib/identities";
import { notFound, validationHook } from "../lib/problem";
import { findProjectRow, projectInclude, toProjectView } from "./projects.routes";
import { ProjectSchema } from "./projects.schemas";

/** Every access check is a call to `auth` (sequential, rate-limited per caller), so a team is bounded. */
export const MAX_TEAM_SIZE = 100;

const ReplaceTeamSchema = z.object({ memberIds: z.array(IdSchema).max(MAX_TEAM_SIZE) }).strict();

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const replaceTeamRoute = createRoute({
  method: "put",
  path: "/projects/{id}/team",
  tags: ["Projects"],
  summary: "Replace a project's team (project:manage for its entity, If-Match required)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: ReplaceTeamSchema } }, required: true },
  },
  responses: {
    200: { description: "The project with its new team", ...json(ProjectSchema) },
    404: { description: "Not found" },
    409: { description: "version_conflict" },
    422: { description: "not_project_user, with the refused user ids" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

export const teamRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

teamRouter.openapi(replaceTeamRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { memberIds } = c.req.valid("json");
  const wanted = [...new Set(memberIds)];
  const expected = requireIfMatch(c);
  const current = await findProjectRow(id);
  if (!current) throw notFound("Project not found");
  assertCanManage(c, current.entity);
  assertVersion(current.version, expected);
  // Only people being ADDED must hold access (AC-1.6 guards who is given a project): a member who
  // stays is not re-checked, so one person losing access cannot block an edit of the team, and
  // taking someone off needs no identity check at all.
  const staying = new Set(current.members.map((member) => member.userId));
  const added = wanted.filter((userId) => !staying.has(userId));
  await requireProjectUsers(c, added);
  const row = await db.$transaction(async (tx) => {
    // Compare-and-set on the version: of two saves of the same version only one matches (AC-1.7).
    const bumped = await tx.project.updateMany({
      where: { id, version: expected },
      data: { version: { increment: 1 } },
    });
    if (bumped.count === 0) {
      throw casMiss(await tx.project.findUnique({ where: { id }, select: { version: true } }), "Project not found");
    }
    // Members who stay are left alone, so they keep their place in the order people joined in.
    await tx.projectMember.deleteMany({ where: { projectId: id, userId: { notIn: wanted } } });
    await tx.projectMember.createMany({
      data: added.map((userId) => ({ projectId: id, userId })),
      skipDuplicates: true,
    });
    return tx.project.findUniqueOrThrow({ where: { id }, include: projectInclude });
  });
  c.header("ETag", etag(row.version));
  return c.json(await toProjectView(c, row), 200);
});

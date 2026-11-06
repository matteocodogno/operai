/**
 * Project states (specs/021 T6; AC-1.2, AC-1.3, AC-1.7, AC-4.4). The type change of specs/021 is gone:
 * a project's type never changes (specs/022 A30, D40).
 *
 * A write on a project: `project:manage` for the project's entity, `If-Match` required,
 * compare-and-set on `version`. It answers `200 Project` like every other project write.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability, type AuthzSource } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  IdParams,
  assertVersion,
  commonErrors,
  etag,
  isRecordNotFound,
  requireIfMatch,
  versionConflict,
  type HeaderSource,
} from "../lib/http";
import { conflict, notFound, validationHook } from "../lib/problem";
import { isAwaitingProjectManager } from "./pick";
import { findProjectRow, projectInclude, toProjectView } from "./projects.routes";
import { ProjectSchema, ProjectStateSchema } from "./projects.schemas";
import { applyTransition } from "./transitions";

const TransitionSchema = z.object({ to: ProjectStateSchema }).strict();

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const transitionRoute = createRoute({
  method: "post",
  path: "/projects/{id}/transitions",
  tags: ["Projects"],
  summary: "Move a project to another state (project:manage for its entity, If-Match required)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: TransitionSchema } }, required: true },
  },
  responses: {
    200: { description: "Moved", ...json(ProjectSchema) },
    404: { description: "Not found" },
    409: { description: "invalid_transition, awaiting_project_manager (to active before the pick) or version_conflict" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

/**
 * The project a write acts on: 428 without an `If-Match`, 404 when unknown, 403 for the other
 * entity, 409 `version_conflict` when the caller edited an older version. Returns the row and
 * the version the write must still match.
 */
async function loadForWrite(c: HeaderSource & AuthzSource, id: string) {
  const expected = requireIfMatch(c);
  const current = await findProjectRow(id);
  if (!current) throw notFound("Project not found");
  assertCanManage(c, current.entity);
  assertVersion(current.version, expected);
  return { current, expected };
}

/**
 * Compare-and-set on the version: of two saves of the same version only one matches, the other
 * finds the row gone from under its `where` and gets the current version back (AC-1.7).
 */
async function updateIfVersion(id: string, expected: number, data: Prisma.ProjectUpdateInput) {
  try {
    return await db.project.update({
      where: { id, version: expected },
      data: { ...data, version: { increment: 1 } },
      include: projectInclude,
    });
  } catch (error) {
    if (!isRecordNotFound(error)) throw error;
    const now = await db.project.findUnique({ where: { id }, select: { version: true } });
    if (!now) throw notFound("Project not found");
    throw versionConflict(now.version);
  }
}

export const transitionsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

transitionsRouter.openapi(transitionRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { to } = c.req.valid("json");
  const { current, expected } = await loadForWrite(c, id);
  const next = applyTransition(current, to);
  if (!next) throw conflict("invalid_transition", `A ${current.state} project cannot move to ${to}`);
  // A project made from a deal is not started before its ops-manager has picked its project manager (AC-4.7,
  // D48); every other move, hold and cancellation included, is specs/021's as usual.
  if (to === "active" && isAwaitingProjectManager(current)) {
    throw conflict("awaiting_project_manager", "This project is awaiting its project manager and cannot be started yet");
  }
  const row = await updateIfVersion(id, expected, next);
  c.header("ETag", etag(row.version));
  return c.json(await toProjectView(c, row), 200);
});

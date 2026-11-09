/**
 * Project states and the type change (specs/024 T6; AC-1.2, AC-1.3, AC-1.7, AC-4.4).
 *
 * Both are writes on a project: `project:manage` for the project's entity, `If-Match` required,
 * compare-and-set on `version`. They answer `200 Project` like every other project write.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PROJECT_MANAGE, assertCanManage, authorized, requireCapability, type AuthzSource } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import {
  IdParams,
  assertVersion,
  commonErrors,
  etag,
  requireIfMatch,
  type HeaderSource,
} from "../lib/http";
import { conflict, notFound, validationHook } from "../lib/problem";
import { findProjectRow, toProjectView, updateProjectIfVersion } from "./projects.routes";
import { ProjectSchema, ProjectStateSchema, ProjectTypeSchema } from "./projects.schemas";
import { applyTransition, canChangeType } from "./transitions";

const TransitionSchema = z.object({ to: ProjectStateSchema }).strict();
/** Any type is a well-formed request; `canChangeType` says which one the project may take. */
const ChangeTypeSchema = z.object({ type: ProjectTypeSchema }).strict();

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
    409: { description: "invalid_transition or version_conflict" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

const changeTypeRoute = createRoute({
  method: "put",
  path: "/projects/{id}/type",
  tags: ["Projects"],
  summary: "Turn an internal project into a SaaS product; no other type change exists (If-Match required)",
  middleware: [...authorized, requireCapability(PROJECT_MANAGE)],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: ChangeTypeSchema } }, required: true },
  },
  responses: {
    200: { description: "Changed", ...json(ProjectSchema) },
    404: { description: "Not found" },
    409: { description: "type_change_refused or version_conflict" },
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

export const transitionsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

transitionsRouter.openapi(transitionRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { to } = c.req.valid("json");
  const { current, expected } = await loadForWrite(c, id);
  const next = applyTransition(current, to);
  if (!next) throw conflict("invalid_transition", `A ${current.state} project cannot move to ${to}`);
  const row = await updateProjectIfVersion(id, expected, next);
  c.header("ETag", etag(row.version));
  return c.json(await toProjectView(c, row), 200);
});

transitionsRouter.openapi(changeTypeRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { type } = c.req.valid("json");
  const { current, expected } = await loadForWrite(c, id);
  if (!canChangeType(current.type, type)) {
    throw conflict("type_change_refused", `A ${current.type} project cannot become ${type}; only an internal project can become saas`);
  }
  const row = await updateProjectIfVersion(id, expected, { type });
  c.header("ETag", etag(row.version));
  return c.json(await toProjectView(c, row), 200);
});

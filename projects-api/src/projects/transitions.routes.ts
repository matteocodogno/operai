/**
 * Project states and type change router — a mounted stub (specs/021 T3): src/index.ts mounts it now so the task that
 * fills it in (T6) never edits index.ts. No route yet.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { validationHook } from "../lib/problem";

export const transitionsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

/**
 * Permission catalog routes (T5, specs/004-auth-roles-permissions — refs
 * AC-3.1, AC-3.2). See `catalog.ts` for the full design rationale.
 *
 *   - `PUT /authz/catalog` — idempotent, full-replace upsert of ONE app's
 *     catalog (resources → actions → each action's `supportedConditions`).
 *     v1 registers EstimAI + Admin + Refund via a seed that reads each
 *     app's checked-in declaration and calls this endpoint (plan.md
 *     "Catalog registration"); it also exists so a future independently
 *     deployed app can self-register without an `auth` redeploy
 *     (ADR-0007 §7). Guarded by `requireAdmin` only for now — a
 *     service-key auth path for unattended app self-registration is
 *     explicitly out of scope for this task.
 *   - `GET /admin/catalog` — the full catalog (every registered app's
 *     resources/actions/supportedConditions), for the admin rule-builder
 *     (AC-3.1/3.3).
 *
 * Both routes are guarded by `sessionMiddleware` + `requireAuth` +
 * `requireAdmin` (403 for non-admin — AC-1.5, T4), matching every other
 * `/admin/*`-family route in this service.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  requireAdmin,
  requireAuth,
  sessionMiddleware,
} from "../auth/auth.middleware";
import { getFullCatalog, upsertAppCatalog } from "./catalog";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CatalogActionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  supportedConditions: z.array(z.string()).default([]),
});

const CatalogResourceSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  actions: z.array(CatalogActionSchema),
});

const AppCatalogSchema = z.object({
  appId: z.string().min(1),
  resources: z.array(CatalogResourceSchema),
});

const CatalogListSchema = z.object({
  apps: z.array(AppCatalogSchema),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

const putCatalogRoute = createRoute({
  method: "put",
  path: "/authz/catalog",
  tags: ["Authorization"],
  summary: "Register (idempotent, full-replace) an app's permission catalog",
  description:
    "Upserts one app's resources/actions/supportedConditions into " +
    "catalog_resource/catalog_action. Re-submitting the identical body is " +
    "a no-op on the resulting state; resources/actions previously " +
    "registered for this appId but absent from the new body are removed " +
    "(full replacement, not an additive merge).",
  request: {
    body: {
      content: { "application/json": { schema: AppCatalogSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AppCatalogSchema } },
      description: "The app's catalog as persisted",
    },
    400: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Malformed request body",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
  },
});

const getCatalogRoute = createRoute({
  method: "get",
  path: "/admin/catalog",
  tags: ["Admin"],
  summary: "Get the full permission catalog",
  description:
    "Every registered app's resources, actions, and supportedConditions " +
    "(AC-3.1/3.3) — the source the admin rule-builder builds role rules " +
    "from.",
  responses: {
    200: {
      content: { "application/json": { schema: CatalogListSchema } },
      description: "The full catalog, grouped by appId",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
  },
});

// A dedicated OpenAPIHono instance with an RFC 7807 `defaultHook` so a
// malformed PUT body surfaces as Problem JSON, not @hono/zod-openapi's
// default `{ success, error }` shape — matches audit.routes.ts.
export const catalogRouter = new OpenAPIHono({
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

catalogRouter.use(
  "/authz/catalog",
  sessionMiddleware,
  requireAuth,
  requireAdmin,
);
catalogRouter.use(
  "/admin/catalog",
  sessionMiddleware,
  requireAuth,
  requireAdmin,
);

catalogRouter.openapi(putCatalogRoute, async (c) => {
  const body = c.req.valid("json");

  const result = await upsertAppCatalog({
    appId: body.appId,
    resources: body.resources.map((resource) => ({
      key: resource.key,
      label: resource.label,
      actions: resource.actions.map((action) => ({
        key: action.key,
        label: action.label,
        supportedConditions: action.supportedConditions,
      })),
    })),
  });

  return c.json(result, 200);
});

catalogRouter.openapi(getCatalogRoute, async (c) => {
  const apps = await getFullCatalog();
  return c.json({ apps }, 200);
});

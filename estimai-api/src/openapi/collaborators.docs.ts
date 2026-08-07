/**
 * OpenAPI DOC-ONLY registration for the five collaborator-management routes
 * (T11, specs/013-estimate-sharing, plan.md "API contracts — estimai-api —
 * new").
 *
 * WHY DOC-ONLY, NOT `.openapi()`: T8 deliberately registered
 * `collaborators.routes.ts`'s five routes via plain `.get()/.post()/
 * .patch()/.delete()` rather than `.openapi()` + `createRoute()`, because
 * `POST`'s fixed 9-step handler order (plan.md) requires `resolveAccess`
 * (404/403) and the rate limiter to run BEFORE email-syntax (400)
 * validation — the OPPOSITE of what a declarative `request.body` schema
 * would enforce (zod-openapi's request validation runs BEFORE the handler
 * body, unconditionally). See collaborators.routes.ts's file header for the
 * full rationale. Restructuring those handlers to fit `.openapi()`'s
 * validation-first model would invert that fixed, security-relevant order
 * (a stranger's probe must hit 404/403 before any body parsing) — T11's own
 * scope note is explicit that this is NOT to be done to satisfy the doc
 * generator.
 *
 * THE MECHANISM: `@hono/zod-openapi`'s `OpenAPIHono` exposes
 * `openAPIRegistry` — the SAME `@asteasolutions/zod-to-openapi`
 * `OpenAPIRegistry` instance `.openapi()` populates internally — with a
 * public `registerPath(routeConfig)` method that adds a path to the
 * generated document WITHOUT wiring a handler. This lets these five routes
 * appear in `/openapi.json` and render in the Scalar reference (`/docs`)
 * with ZERO change to collaborators.routes.ts's actual request handling,
 * validation order, or the routes it already registers.
 *
 * REGISTRATION ORDER (matters): `registerCollaboratorOpenApiDocs(router)`
 * MUST be called on `estimatesRouter` BEFORE `app.route("/", estimatesRouter)`
 * runs in index.ts. `OpenAPIHono.route()` overrides base Hono's `.route()`
 * to merge the mounted sub-router's `openAPIRegistry.definitions` into the
 * parent's AT THAT CALL — anything registered on `estimatesRouter` after
 * the merge would never reach `app`'s document. `registerCollaboratorRoutes`
 * (T8) already follows this identical "call before mount" rule for the
 * request-handling routes themselves, for the same reason; index.ts calls
 * both before mounting.
 */

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { JwtVariables } from "@/auth/jwt.middleware";
import {
  AddCollaboratorRequestSchema,
  CollaboratorParamSchema,
  CollaboratorSchema,
  CollaboratorsListResponseSchema,
  CollaboratorsParamSchema,
  ProblemSchema,
  ProblemWithCodeSchema,
  UpdateCollaboratorRequestSchema,
} from "../estimates/collaborators.schemas";

export function registerCollaboratorOpenApiDocs(
  router: OpenAPIHono<{ Variables: JwtVariables }>,
): void {
  // ─── GET /estimates/{id}/collaborators — owner-only list ──────────────────

  router.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      path: "/estimates/{id}/collaborators",
      tags: ["Collaborators"],
      summary: "List an estimate's collaborators (owner only)",
      description:
        "Owner-only (AC-5.4) — a collaborator gets 403 owner_only, never a " +
        "peer listing (the spec never grants collaborators visibility of " +
        "each other, so this discloses nothing). `id` in each row is the " +
        "GRANT's id, never the collaborator's `sub` — user ids are not put " +
        "into URLs or list payloads.",
      request: { params: CollaboratorsParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: CollaboratorsListResponseSchema } },
          description: "The estimate's collaborators (owner only)",
        },
        401: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "Missing or invalid Bearer JWT",
        },
        403: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description: 'Caller is a collaborator, not the owner — code: "owner_only"',
        },
        404: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "No relationship to this estimate (AC-1.6)",
        },
      },
    }),
  );

  // ─── POST /estimates/{id}/collaborators — add (US-1) ───────────────────────

  router.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      path: "/estimates/{id}/collaborators",
      tags: ["Collaborators"],
      summary: "Add a collaborator (owner only)",
      description:
        "US-1. The handler's 9-step order is FIXED (plan.md) and " +
        "deliberately NOT expressed via this route's declared body schema — " +
        "see this module's file header. The 422 collaborator_not_eligible " +
        "rejection is ONE fixed status/code/detail for BOTH ineligibility " +
        "causes (AC-1.2: no such user, or a user without EstimAI access), " +
        "floored to SHARE_LOOKUP_FLOOR_MS so the two causes stay " +
        "indistinguishable by timing. `grantedByUserId`/the grant's " +
        "`userId` come only from the verified JWT and the `auth` " +
        "eligibility response, never the request body.",
      request: {
        params: CollaboratorsParamSchema,
        body: {
          required: true,
          content: { "application/json": { schema: AddCollaboratorRequestSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: CollaboratorSchema } },
          description: "Collaborator added (AC-1.1); a best-effort push notification follows (AC-7.1, T10)",
        },
        400: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description: 'Malformed email or accessLevel — code: "invalid_input"',
        },
        401: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "Missing or invalid Bearer JWT",
        },
        403: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description: 'Caller is a collaborator, not the owner (AC-1.5) — code: "owner_only"',
        },
        404: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "No relationship to this estimate (AC-1.6)",
        },
        409: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description:
            'Already a collaborator (AC-1.3) — code: "already_collaborator"; ' +
            "detail names the existing level and points at PATCH",
        },
        422: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description:
            'Sharing with yourself (AC-1.4, code: "cannot_share_with_self") OR ' +
            'the generic ineligibility rejection (AC-1.2, code: ' +
            '"collaborator_not_eligible") — the latter is BYTE-IDENTICAL for ' +
            "both underlying causes; no other field is ever added.",
        },
        429: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description: 'Rate limited (counts every attempt) — code: "rate_limited", Retry-After header set',
        },
        503: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description:
            'auth unreachable — fails CLOSED, no grant created — code: ' +
            '"authorization_service_unavailable"',
        },
      },
    }),
  );

  // ─── PATCH /estimates/{id}/collaborators/{collaboratorId} — level change ──

  router.openAPIRegistry.registerPath(
    createRoute({
      method: "patch",
      path: "/estimates/{id}/collaborators/{collaboratorId}",
      tags: ["Collaborators"],
      summary: "Change a collaborator's access level (owner only)",
      description:
        "AC-5.1. NO notification is sent — a level change is deliberately " +
        "silent (AC-7.3). Takes effect on the collaborator's NEXT request; " +
        "there is no live disconnection (AC-5.3).",
      request: {
        params: CollaboratorParamSchema,
        body: {
          required: true,
          content: { "application/json": { schema: UpdateCollaboratorRequestSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CollaboratorSchema } },
          description: "Updated collaborator",
        },
        401: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "Missing or invalid Bearer JWT",
        },
        403: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description: 'code: "owner_only"',
        },
        404: {
          content: { "application/json": { schema: ProblemSchema } },
          description:
            "Estimate or grant not found — a fabricated/foreign grant id, or " +
            "one shaped like the owner's own sub, is indistinguishable from " +
            "a genuinely absent one (AC-5.4)",
        },
      },
    }),
  );

  // ─── DELETE /estimates/{id}/collaborators/{collaboratorId} — revoke ───────

  router.openAPIRegistry.registerPath(
    createRoute({
      method: "delete",
      path: "/estimates/{id}/collaborators/{collaboratorId}",
      tags: ["Collaborators"],
      summary: "Remove a collaborator (owner only)",
      description:
        "AC-5.2. A best-effort push notification follows, with NO link " +
        "(AC-7.2, T10, ADR-0040) — the target would 404 on the estimate the " +
        "moment they open it.",
      request: { params: CollaboratorParamSchema },
      responses: {
        204: { description: "Grant removed" },
        401: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "Missing or invalid Bearer JWT",
        },
        403: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description: 'code: "owner_only"',
        },
        404: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "Estimate or grant not found (AC-5.4)",
        },
      },
    }),
  );

  // ─── DELETE /estimates/{id}/collaborators/me — leave (self, US-6) ─────────

  router.openAPIRegistry.registerPath(
    createRoute({
      method: "delete",
      path: "/estimates/{id}/collaborators/me",
      tags: ["Collaborators"],
      summary: "Leave a shared estimate (self)",
      description:
        "US-6. Removes the CALLER's OWN grant. NO notification is sent — " +
        "self-leave is explicitly excluded from AC-7.2. An owner has no " +
        "grant of their own to leave (AC-1.4) — they delete the estimate " +
        'instead; their attempt here is 404 "not_a_collaborator", ' +
        "identical to a genuine stranger's (AC-6.2).",
      request: { params: CollaboratorsParamSchema },
      responses: {
        204: { description: "The caller's own grant removed (AC-6.1)" },
        401: {
          content: { "application/json": { schema: ProblemSchema } },
          description: "Missing or invalid Bearer JWT",
        },
        404: {
          content: { "application/json": { schema: ProblemWithCodeSchema } },
          description:
            'The caller (including the owner) is not a collaborator on this ' +
            'estimate — code: "not_a_collaborator"',
        },
      },
    }),
  );
}

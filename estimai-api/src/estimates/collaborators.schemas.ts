/**
 * Zod schemas for the collaborator-management endpoints (T8/T9,
 * specs/013-estimate-sharing, plan.md "API contracts — estimai-api — new").
 *
 * DELIBERATELY NOT used for hono `zValidator`/`createRoute` request-body
 * validation on `POST /estimates/{id}/collaborators` — see collaborators.routes.ts's
 * file header for why: the plan's 9-step handler order requires `resolveAccess`
 * (404/403) and the rate limiter to run BEFORE email-syntax validation (400),
 * which is the OPPOSITE of every other route in this service (PUT's order is
 * 401→400→428→413→404/403→409). A declarative `request.body` schema would run
 * its 400 check before the handler body executes, which would invert that
 * order. `AddCollaboratorRequestSchema` is exported anyway for T11 (OpenAPI
 * registration) and for tests that want to assert the shape independently.
 */

import { z } from "zod";
import { IdentitySchema } from "./estimates.schemas";

// ─── Collaborator access level — viewer/editor ONLY (never "owner") ─────────
//
// A separate definition from estimates.schemas.ts's AccessLevelSchema
// ("owner"|"editor"|"viewer") — a collaborator grant can never be "owner",
// so accepting that value here would be a silent widening of the contract.

export const CollaboratorAccessLevelSchema = z.enum(["viewer", "editor"]);
export type CollaboratorAccessLevel = z.infer<typeof CollaboratorAccessLevelSchema>;

// ─── POST /estimates/{id}/collaborators — request body ──────────────────────

export const AddCollaboratorRequestSchema = z.object({
  email: z.string().max(320),
  accessLevel: CollaboratorAccessLevelSchema,
});

export type AddCollaboratorRequest = z.infer<typeof AddCollaboratorRequestSchema>;

// ─── PATCH /estimates/{id}/collaborators/{collaboratorId} — request body (T9) ──

export const UpdateCollaboratorRequestSchema = z.object({
  accessLevel: CollaboratorAccessLevelSchema,
});

export type UpdateCollaboratorRequest = z.infer<typeof UpdateCollaboratorRequestSchema>;

// ─── Wire response shapes ────────────────────────────────────────────────────

/**
 * A single collaborator, as returned by GET (list) / POST (create) / PATCH
 * (update). `id` is the GRANT's id — never the collaborator's `sub` (plan.md:
 * "user ids are not put into URLs or list payloads"). `identity` is resolved
 * live via `authClient.resolveIdentities` (ADR-0039, fails soft to "unknown").
 */
export const CollaboratorSchema = z.object({
  id: z.string(),
  email: z.string(),
  accessLevel: CollaboratorAccessLevelSchema,
  createdAt: z.string().datetime(),
  identity: IdentitySchema,
});

export type Collaborator = z.infer<typeof CollaboratorSchema>;

export const CollaboratorsListResponseSchema = z.object({
  collaborators: z.array(CollaboratorSchema),
});

export type CollaboratorsListResponse = z.infer<typeof CollaboratorsListResponseSchema>;

// ─── Route param schemas ─────────────────────────────────────────────────────

export const CollaboratorsParamSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export const CollaboratorParamSchema = z.object({
  id: z.string().min(1, "id is required"),
  collaboratorId: z.string().min(1, "collaboratorId is required"),
});

// ─── Problem JSON schemas (OpenAPI doc-only, T11) ────────────────────────────
//
// Mirrors estimates.routes.ts's own local (non-exported) ProblemSchema /
// ProblemWithCodeSchema shape byte-for-byte — kept as a separate copy here
// (not imported from there) because those are private consts scoped to that
// file, and this module is already where every other collaborator wire
// shape lives. Consumed only by src/openapi/collaborators.docs.ts's
// doc-only `registerPath` calls (see that file's header for why these
// routes are documented separately from their `.get()/.post()/...`
// handlers) — never by collaborators.routes.ts's actual response bodies,
// which build their own plain Problem-JSON objects inline (see that file's
// `problemNotFound`/`problemForbidden`/etc. helpers).

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

export const ProblemWithCodeSchema = ProblemSchema.extend({
  code: z.string(),
});

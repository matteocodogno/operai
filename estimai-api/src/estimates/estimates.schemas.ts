/**
 * Zod schemas for the Estimates API (T4, specs/20260606-estimate-persistence).
 *
 * EstimateContent  — stored verbatim in JSONB; mirrors the UI's ProjectData
 *                    shape (params / releases / acts).
 * EstimateUpsert   — POST / PUT request body.
 * EstimateListItem — lean list response (id, name, author, updatedAt).
 * EstimateFull     — full response including content (POST 201 / GET 200).
 *
 * SECURITY (A03/A04): max-length bounds are added on all string fields that the
 * UI renders or stores. Unknown keys are stripped (zod default — no .passthrough())
 * to prevent oversized payloads from sneaking extra fields into the JSONB.
 * All documented UI fields (estimai-ui/src/types.ts) are explicitly enumerated so
 * strip() never drops real data.
 *
 * Field inventory cross-referenced with estimai-ui/src/types.ts:
 *   Parameters: parallelism, sprintDays, workingDaysMonth, qaDeployDays,
 *               qaTestDays, pmDays, aiCostCoef, aiGain
 *   Release:    id, name, fte
 *   Activity:   id, num (string in UI), epic, act, prof, o, ml, p, risk,
 *               aiGain (optional), notes, release
 *
 * COERCION NOTE (bug fix): The EstimAI UI stores numeric activity and parameter
 * inputs as strings (e.g. ml:"5", risk:"2", aiGain:"0.15", fte:"1") and only
 * coerces them to numbers at compute time (useEstimator.ts). Strict z.number()
 * therefore rejected all real saved/imported estimates, producing 400 on every
 * POST /estimates, PUT /estimates/{id}, and POST /estimates/import.
 *
 * The fix uses z.coerce.number() for every field the UI may store as a string.
 * z.coerce.number() calls Number(value) then rejects NaN, so:
 *   - string "5"  → 5   (accepted)
 *   - number  5   → 5   (accepted — numbers coerce to themselves)
 *   - string ""   → 0   (accepted — matches the UI's Number(x)||0 compute behaviour)
 *   - string "abc" → NaN → zod rejects (legitimately invalid input)
 *   - undefined on an optional field stays undefined (optional short-circuits before coerce)
 *
 * `num` is intentionally kept as a string|number union (no coerce) — the UI types
 * it as a string and it is display-only (never used in arithmetic).
 */

import { z } from "zod";
import { IdSchema, text } from "@/lib/nulInput";

// ─── Sub-schemas that mirror the UI types ────────────────────────────────────

/**
 * Model parameters object stored inside every estimate.
 * All fields are optional so we accept both complete and partial params.
 * Unknown fields are stripped (no .passthrough()) to prevent oversized payloads.
 *
 * z.coerce.number() is used (not z.number()) because the UI stores these values
 * as strings in localStorage/projectData and only coerces at compute time.
 */
export const ParametersSchema = z.object({
  parallelism: z.coerce.number().optional(),
  sprintDays: z.coerce.number().optional(),
  workingDaysMonth: z.coerce.number().optional(),
  qaDeployDays: z.coerce.number().optional(),
  qaTestDays: z.coerce.number().optional(),
  pmDays: z.coerce.number().optional(),
  aiCostCoef: z.coerce.number().optional(),
  aiGain: z.coerce.number().optional(),
});

export const ReleaseSchema = z.object({
  id: text(200),
  name: text(500),
  // z.coerce.number() — UI may store fte as a string (e.g. "1") in saved data.
  fte: z.coerce.number(),
});

export const ActivitySchema = z.object({
  // `num` is typed as `string` in the UI (estimai-ui/src/types.ts Activity.num).
  // Kept as string|number union (no coerce) — display-only, never used in arithmetic.
  id: text(200),
  num: z.union([text(50), z.number()]).optional(),
  epic: text(500).optional(),
  act: text(500).optional(),
  prof: text(200).optional(),
  // z.coerce.number() — UI stores o/ml/p/risk/aiGain as strings in saved estimates.
  o: z.coerce.number().optional(),
  ml: z.coerce.number().optional(),
  p: z.coerce.number().optional(),
  risk: z.coerce.number().optional(),
  aiGain: z.coerce.number().optional(),
  notes: text(2000).optional(),
  release: text(200).optional(),
});

// ─── EstimateContent ─────────────────────────────────────────────────────────

/**
 * The JSONB payload stored in the `content` column.
 * Mirrors the UI's ProjectData (minus the top-level id/name/author that are
 * promoted to columns).
 *
 * Unknown keys are stripped (zod default) as defense-in-depth against oversized
 * payloads. All documented UI fields are enumerated above — strip() will not
 * silently drop any field the UI actually sends.
 */
export const EstimateContentSchema = z.object({
  params: ParametersSchema,
  releases: z.array(ReleaseSchema),
  acts: z.array(ActivitySchema),
});

export type EstimateContent = z.infer<typeof EstimateContentSchema>;

// ─── EstimateUpsert (POST / PUT request body) ────────────────────────────────

export const EstimateUpsertSchema = z.object({
  name: text(500).min(1, "name is required"),
  author: text(200).default(""),
  content: EstimateContentSchema,
});

export type EstimateUpsert = z.infer<typeof EstimateUpsertSchema>;

// ─── Access / identity shapes (T6, specs/20260807-estimate-sharing) ──────────────
//
// AccessLevelSchema mirrors src/estimates/access.ts's AccessLevel — kept as an
// independent zod definition (rather than z.nativeEnum over the string union)
// so this schema file has no import-time dependency on access.ts; the two are
// structurally identical by construction and access.ts's AccessLevel is used
// to type the repo layer.
//
// IdentitySchema mirrors src/lib/authClient.ts's Identity shape MINUS the
// `id` field — the wire response never puts a raw `sub`/cuid into a payload
// (plan.md "Display identity"); `estimai-api` looks the identity up by the
// owner's `userId` internally and only ever serialises {status, name}.

// `oversight` (specs/20261108-estimate-list-oversight): wire-only — a read-all permission holder with no
// relationship to the estimate. Collaborator APIs use their own schema and
// reject it.
export const AccessLevelSchema = z.enum(["owner", "editor", "viewer", "oversight"]);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;

export const IdentitySchema = z.object({
  status: z.enum(["active", "deleted", "unknown"]),
  name: z.string().nullable(),
});
export type Identity = z.infer<typeof IdentitySchema>;

// ─── Response shapes ─────────────────────────────────────────────────────────

/**
 * Lean list item — returned by GET /estimates.
 * No `content` — avoids fetching large JSONB for the list view.
 *
 * `access` — the caller's own relationship to this estimate ("owner" for
 * rows the caller created, "editor"/"viewer" for rows they hold a grant on).
 * `owner`  — `null` when `access === "owner"` (never expose an identity
 * object for your own row); otherwise the estimate owner's live-resolved
 * display identity (AC-2.1, AC-10.5).
 */
/**
 * `GET /estimates` query (specs/20261108-estimate-list-oversight). `status` absent = open AND closed (the
 * import offer dedupes against the whole account); an unknown value is a 400.
 */
export const ListStatusSchema = z.enum(["open", "closed"]);
export const ListWhoseSchema = z.enum(["mine", "all"]);
export const ListEstimatesQuerySchema = z.object({
  status: ListStatusSchema.optional(),
  whose: ListWhoseSchema.optional(),
});

export const EstimateListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  author: z.string(),
  updatedAt: z.string().datetime(),
  access: AccessLevelSchema,
  owner: IdentitySchema.nullable(),
  // ISO timestamp while the estimate is closed (read-only until reopened); null while open.
  closedAt: z.string().datetime().nullable(),
  // The CRM deal this estimate belongs to, pushed by crm-api (specs/20261108-estimate-list-oversight, ADR 20261108-crm-pushes-deal-links-to-estimai); null when unlinked.
  crmDealId: z.string().nullable(),
});

export type EstimateListItem = z.infer<typeof EstimateListItemSchema>;

/**
 * Full estimate — returned by POST (201) and GET /estimates/{id} (200).
 *
 * `version` — optimistic-concurrency counter (T4); the CAS/If-Match/ETag
 * wiring around it is T7's scope, this field only carries the current value.
 * `access`/`owner` — same meaning as EstimateListItem.
 * `collaboratorCount` — present ONLY when `access === "owner"` (a
 * collaborator is never told how many other collaborators exist, AC-5.4).
 */
export const EstimateFullSchema = z.object({
  id: z.string(),
  name: z.string(),
  author: z.string(),
  content: EstimateContentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int(),
  access: AccessLevelSchema,
  owner: IdentitySchema.nullable(),
  collaboratorCount: z.number().int().optional(),
  // Close/reopen lifecycle: `closedAt` is set while the estimate is closed —
  // read-only for everybody until reopened — and `closedBy` is the live,
  // fail-soft display identity of whoever closed it. Both null while open.
  closedAt: z.string().datetime().nullable(),
  closedBy: IdentitySchema.nullable(),
});

export type EstimateFull = z.infer<typeof EstimateFullSchema>;

// ─── Route param schema ───────────────────────────────────────────────────────

export const EstimateIdParamSchema = z.object({
  id: IdSchema,
});

// ─── Bulk import schemas (T6, AC-5.2/AC-5.4) ─────────────────────────────────

/**
 * A single element in a bulk import request.
 * Extends EstimateUpsert (name/author/content bounds apply) with a caller-supplied
 * `localId` used to correlate results back to the original local estimate.
 *
 * EstimateUpsert is reused deliberately: it excludes id/userId/timestamps so the
 * caller cannot smuggle server-controlled fields into the batch (OWASP A01).
 */
export const ImportElementSchema = EstimateUpsertSchema.extend({
  localId: text(500).min(1, "localId is required"),
});

export type ImportElement = z.infer<typeof ImportElementSchema>;

/**
 * POST /estimates/import request body.
 * Array is capped at 200 elements to bound the batch size and prevent abuse.
 */
export const ImportRequestSchema = z.object({
  estimates: z
    .array(ImportElementSchema)
    .min(1, "estimates must contain at least one element")
    .max(200, "estimates batch must not exceed 200 elements"),
});

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

/**
 * Per-element import result.
 *   status:"imported" — element was persisted; `id` is the new server-assigned id.
 *   status:"failed"   — element was NOT persisted; `error` is a human-readable reason.
 */
export const ImportResultItemSchema = z.discriminatedUnion("status", [
  z.object({
    localId: z.string(),
    status: z.literal("imported"),
    id: z.string(),
  }),
  z.object({
    localId: z.string(),
    status: z.literal("failed"),
    error: z.string(),
  }),
]);

export type ImportResultItem = z.infer<typeof ImportResultItemSchema>;

/**
 * POST /estimates/import response body.
 * One result per input element, in the same order.
 */
export const ImportResponseSchema = z.object({
  results: z.array(ImportResultItemSchema),
});

export type ImportResponse = z.infer<typeof ImportResponseSchema>;

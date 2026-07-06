/**
 * Zod schemas for the Estimates API (T4, specs/001-estimate-persistence).
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
  id: z.string().max(200),
  name: z.string().max(500),
  // z.coerce.number() — UI may store fte as a string (e.g. "1") in saved data.
  fte: z.coerce.number(),
});

export const ActivitySchema = z.object({
  // `num` is typed as `string` in the UI (estimai-ui/src/types.ts Activity.num).
  // Kept as string|number union (no coerce) — display-only, never used in arithmetic.
  id: z.string().max(200),
  num: z.union([z.string().max(50), z.number()]).optional(),
  epic: z.string().max(500).optional(),
  act: z.string().max(500).optional(),
  prof: z.string().max(200).optional(),
  // z.coerce.number() — UI stores o/ml/p/risk/aiGain as strings in saved estimates.
  o: z.coerce.number().optional(),
  ml: z.coerce.number().optional(),
  p: z.coerce.number().optional(),
  risk: z.coerce.number().optional(),
  aiGain: z.coerce.number().optional(),
  notes: z.string().max(2000).optional(),
  release: z.string().max(200).optional(),
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
  name: z.string().min(1, "name is required").max(500),
  author: z.string().max(200).default(""),
  content: EstimateContentSchema,
});

export type EstimateUpsert = z.infer<typeof EstimateUpsertSchema>;

// ─── Response shapes ─────────────────────────────────────────────────────────

/**
 * Lean list item — returned by GET /estimates.
 * No `content` — avoids fetching large JSONB for the list view.
 */
export const EstimateListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  author: z.string(),
  updatedAt: z.string().datetime(),
});

export type EstimateListItem = z.infer<typeof EstimateListItemSchema>;

/**
 * Full estimate — returned by POST (201) and GET /estimates/{id} (200).
 */
export const EstimateFullSchema = z.object({
  id: z.string(),
  name: z.string(),
  author: z.string(),
  content: EstimateContentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type EstimateFull = z.infer<typeof EstimateFullSchema>;

// ─── Route param schema ───────────────────────────────────────────────────────

export const EstimateIdParamSchema = z.object({
  id: z.string().min(1, "id is required"),
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
  localId: z.string().min(1, "localId is required").max(500),
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

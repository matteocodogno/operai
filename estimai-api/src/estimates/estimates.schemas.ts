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
 */

import { z } from "zod";

// ─── Sub-schemas that mirror the UI types ────────────────────────────────────

/**
 * Model parameters object stored inside every estimate.
 * All fields are optional so we accept both complete and partial params.
 * Unknown fields are stripped (no .passthrough()) to prevent oversized payloads.
 */
export const ParametersSchema = z.object({
  parallelism: z.number().optional(),
  sprintDays: z.number().optional(),
  workingDaysMonth: z.number().optional(),
  qaDeployDays: z.number().optional(),
  qaTestDays: z.number().optional(),
  pmDays: z.number().optional(),
  aiCostCoef: z.number().optional(),
  aiGain: z.number().optional(),
});

export const ReleaseSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(500),
  fte: z.number(),
});

export const ActivitySchema = z.object({
  // `num` is typed as `string` in the UI (estimai-ui/src/types.ts Activity.num).
  id: z.string().max(200),
  num: z.union([z.string().max(50), z.number()]).optional(),
  epic: z.string().max(500).optional(),
  act: z.string().max(500).optional(),
  prof: z.string().max(200).optional(),
  o: z.number().optional(),
  ml: z.number().optional(),
  p: z.number().optional(),
  risk: z.number().optional(),
  aiGain: z.number().optional(),
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

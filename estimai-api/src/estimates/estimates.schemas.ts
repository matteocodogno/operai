/**
 * Zod schemas for the Estimates API (T4, specs/001-estimate-persistence).
 *
 * EstimateContent  — stored verbatim in JSONB; mirrors the UI's ProjectData
 *                    shape (params / releases / acts).
 * EstimateUpsert   — POST / PUT request body.
 * EstimateListItem — lean list response (id, name, author, updatedAt).
 * EstimateFull     — full response including content (POST 201 / GET 200).
 */

import { z } from "zod";

// ─── Sub-schemas that mirror the UI types ────────────────────────────────────

/**
 * Model parameters object stored inside every estimate.
 * All fields are optional so we accept both complete and partial params
 * without enforcing a strict version contract — the UI is the source of shape.
 */
export const ParametersSchema = z
  .object({
    parallelism: z.number().optional(),
    sprintDays: z.number().optional(),
    workingDaysMonth: z.number().optional(),
    qaDeployDays: z.number().optional(),
    qaTestDays: z.number().optional(),
    pmDays: z.number().optional(),
    aiCostCoef: z.number().optional(),
    aiGain: z.number().optional(),
  })
  .passthrough(); // forward any extra fields without rejection

export const ReleaseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    fte: z.number(),
  })
  .passthrough();

export const ActivitySchema = z
  .object({
    id: z.string(),
    num: z.number().optional(),
    epic: z.string().optional(),
    act: z.string().optional(),
    prof: z.string().optional(),
    o: z.number().optional(),
    ml: z.number().optional(),
    p: z.number().optional(),
    risk: z.number().optional(),
    aiGain: z.number().optional(),
    notes: z.string().optional(),
    release: z.string().optional(),
  })
  .passthrough();

// ─── EstimateContent ─────────────────────────────────────────────────────────

/**
 * The JSONB payload stored in the `content` column.
 * Mirrors the UI's ProjectData (minus the top-level id/name/author that are
 * promoted to columns).
 *
 * .passthrough() on each sub-object means we accept and store any extra fields
 * the UI adds without this service needing a schema bump.
 */
export const EstimateContentSchema = z
  .object({
    params: ParametersSchema,
    releases: z.array(ReleaseSchema),
    acts: z.array(ActivitySchema),
  })
  .passthrough();

export type EstimateContent = z.infer<typeof EstimateContentSchema>;

// ─── EstimateUpsert (POST / PUT request body) ────────────────────────────────

export const EstimateUpsertSchema = z.object({
  name: z.string().min(1, "name is required"),
  author: z.string().default(""),
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

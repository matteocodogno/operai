/**
 * Zod schemas for the refund-settings surface (T3, specs/20260722-refund-settings,
 * plan.md § API contracts).
 */

import { z } from "zod";
import { idParam, noNul } from "../lib/inputText";

// ─── Shared :key param (GET/PUT /settings/:key) ────────────────────────────

export const SettingKeyParamSchema = z.object({
  key: idParam("key"),
});

// ─── PUT /settings/:key body ────────────────────────────────────────────────
//
// `""` is normalized to `null` (clear) by settings/service.ts — accepted
// here at the shape level so that normalization (not zod) owns the
// clear-vs-malformed distinction (AC-1.3 vs AC-1.4).
export const PutSettingBodySchema = z.object({
  value: noNul(z.string()).nullable(),
});
export type PutSettingBody = z.infer<typeof PutSettingBodySchema>;

// ─── GET/PUT /settings/:key response (AC-1.1, AC-5.3) ──────────────────────

export const SettingHistoryEntrySchema = z.object({
  value: z.string().nullable(),
  changedAt: z.string().datetime(),
  changedByEmail: z.string(),
});
export type SettingHistoryEntry = z.infer<typeof SettingHistoryEntrySchema>;

export const SettingResponseSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
  configured: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
  updatedByEmail: z.string().nullable(),
  history: z.array(SettingHistoryEntrySchema), // chronological, oldest -> newest (AC-5.3)
});
export type SettingResponse = z.infer<typeof SettingResponseSchema>;

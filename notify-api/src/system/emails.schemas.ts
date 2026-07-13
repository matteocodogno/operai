/**
 * Zod schemas for POST /system/emails (T3, specs/006-user-invitations,
 * plan.md §API contracts, ADR-0011).
 *
 * `template` is a closed enum (EMAIL_TEMPLATES, src/channels/email.channel.ts)
 * — an unrecognised template name is a 400, never silently accepted.
 * `data.*` are the ONLY variable inputs a template renders (inviteUrl,
 * inviterName, expiresAt); all are escaped at render time
 * (system/emailTemplates.ts), not here — this file only bounds their shape.
 */

import { z } from "zod";
import { EMAIL_TEMPLATES } from "@/channels/email.channel";

export const SendEmailTemplateSchema = z.enum(EMAIL_TEMPLATES);

export const SendEmailDataSchema = z.object({
  inviteUrl: z.string().min(1, "data.inviteUrl is required").max(2000),
  inviterName: z.string().min(1, "data.inviterName is required").max(200),
  // Accepts both a bare-Z and an offset ISO 8601 datetime (auth may format
  // either way) — see plan.md's `expiresAt: "2026-07-16T10:00:00Z"` example.
  expiresAt: z
    .string()
    .datetime({ offset: true, message: "data.expiresAt must be ISO 8601" }),
});

export const SendEmailRequestSchema = z.object({
  to: z.string().email("to must be a valid email address").max(320),
  template: SendEmailTemplateSchema,
  data: SendEmailDataSchema,
});

export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>;

export const SendEmailResponseSchema = z.object({
  deliveryId: z.string(),
  status: z.enum(["sent", "failed"]),
  error: z.string().optional(),
});

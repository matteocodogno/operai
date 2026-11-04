/**
 * Zod schemas for POST /system/notifications (T3, specs/007-refund-service,
 * plan.md "On decision → notify the employee" (AC-3.6), ADR-0017).
 *
 * This is the cross-user counterpart to `raise.routes.ts`'s user-JWT
 * `POST /notifications`: the recipient is a DIFFERENT user than the caller
 * (an internal service, not an end user), so — unlike RaiseNotificationSchema
 * (notifications.schemas.ts), which deliberately has NO recipient field
 * (OWASP A01, ADR-0009) — this schema REQUIRES `recipientId` and trusts it,
 * because the caller is authenticated by its own scoped service credential
 * (ADR-0044/0049), not a user JWT whose `sub` would otherwise be spoofable
 * identity. ADR-0009's reserved
 * `recipient` seam is realized here, not on the user-facing route.
 *
 * Reuses SeveritySchema / OriginAppSchema / LinkSchema / NotificationSchema
 * from notifications.schemas.ts verbatim — same enums, same open-redirect
 * guard on `link.href` — so a payload accepted here is shaped identically to
 * one the in-app channel already knows how to persist and publish.
 */

import { z } from "zod";
import {
  ItVariantSchema,
  LinkSchema,
  NotificationSchema,
  OriginAppSchema,
  SeveritySchema,
} from "@/notifications/notifications.schemas";

export const SystemNotificationRequestSchema = z.object({
  recipientId: z
    .string()
    .min(1, "recipientId is required")
    .max(200, "recipientId must be at most 200 characters"),
  originApp: OriginAppSchema,
  severity: SeveritySchema.default("info"),
  title: z.string().min(1, "title is required").max(200, "title must be at most 200 characters"),
  body: z.string().min(1, "body is required").max(2000, "body must be at most 2000 characters"),
  link: LinkSchema.optional(),
  // specs/021-meetings (ADR-0065): optional Italian rendering of title/body.
  // The reader picks it from <html lang>; omit it and the notification renders
  // exactly as before. Never combined with the email path (English template).
  it: ItVariantSchema.optional(),
  // specs/019-crm-notifications (ADR-0056): also send the notification as an
  // email to the recipient, whose address notify-api resolves from `auth`.
  // The caller never supplies an address. Needs the `emails.send` scope too.
  email: z.boolean().optional(),
});

export type SystemNotificationRequest = z.infer<typeof SystemNotificationRequestSchema>;

// The response echoes the persisted notification — same shape POST
// /notifications returns to the end user, so the internal caller can log/
// inspect the created row (id, timestamps) if it chooses to.
// `emailStatus` is present only when the request asked for `email: true`.
export const EMAIL_STATUSES = ["sent", "failed", "skipped"] as const;
export const SystemNotificationResponseSchema = NotificationSchema.extend({
  emailStatus: z.enum(EMAIL_STATUSES).optional(),
});

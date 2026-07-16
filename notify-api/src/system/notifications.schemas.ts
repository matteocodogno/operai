/**
 * Zod schemas for POST /system/notifications (T3, specs/007-refund-service,
 * plan.md "On decision → notify the employee" (AC-3.6), ADR-0017).
 *
 * This is the cross-user counterpart to `raise.routes.ts`'s user-JWT
 * `POST /notifications`: the recipient is a DIFFERENT user than the caller
 * (an internal service, not an end user), so — unlike RaiseNotificationSchema
 * (notifications.schemas.ts), which deliberately has NO recipient field
 * (OWASP A01, ADR-0009) — this schema REQUIRES `recipientId` and trusts it,
 * because the caller is authenticated by the internal token, not a user JWT
 * whose `sub` would otherwise be spoofable identity. ADR-0009's reserved
 * `recipient` seam is realized here, not on the user-facing route.
 *
 * Reuses SeveritySchema / OriginAppSchema / LinkSchema / NotificationSchema
 * from notifications.schemas.ts verbatim — same enums, same open-redirect
 * guard on `link.href` — so a payload accepted here is shaped identically to
 * one the in-app channel already knows how to persist and publish.
 */

import { z } from "zod";
import {
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
});

export type SystemNotificationRequest = z.infer<typeof SystemNotificationRequestSchema>;

// The response echoes the persisted notification — same shape POST
// /notifications returns to the end user, so the internal caller can log/
// inspect the created row (id, timestamps) if it chooses to.
export const SystemNotificationResponseSchema = NotificationSchema;

/**
 * Zod schemas for the Notifications API (T4/T5/T6/T7, specs/005-notification-center).
 *
 * RaiseNotificationSchema — POST /notifications request body.
 * NotificationSchema      — the shape returned for a single notification (201 / list items / SSE payload).
 * ListQuerySchema         — GET /notifications query params (cursor pagination).
 * ListResponseSchema      — GET /notifications response.
 * UnreadCountResponseSchema — GET /notifications/unread-count response.
 * MarkAllReadResponseSchema — POST /notifications/mark-all-read response.
 * StreamTicketResponseSchema — POST /notifications/stream-ticket response.
 *
 * SECURITY (OWASP A01): RaiseNotificationSchema deliberately has NO recipient/
 * recipientId field. Even if a caller sends one in the raw JSON body, zod's
 * default .strip() behaviour drops any key not declared on the schema — the
 * route handler never sees it, and recipientId is always derived from the
 * verified JWT `sub` (see raise.routes.ts). This is the "recipient is
 * DELIBERATELY ABSENT in v1" forward-compat seam from plan.md §API contracts.
 *
 * SECURITY (open-redirect guard, plan.md "link.href open-redirect / XSS"):
 * `link.href` must be a same-origin relative in-suite path. isRelativeSuitePath()
 * rejects:
 *   - absolute URLs with a scheme (`https://evil.example.com`, `javascript:alert(1)`)
 *   - protocol-relative URLs (`//evil.example.com` — browsers treat this as absolute)
 *   - backslash tricks some browsers normalise to forward slashes (`/\evil.example.com`)
 * and requires the path to start with a single `/`.
 */

import { z } from "zod";

// ─── originApp — known Operai suite tool ids ─────────────────────────────────
//
// Sourced from shell/src/lib/tools.ts (ToolId union) / auth's authz SUITE_APPS
// seed. plan.md: "originApp … enum of known app ids". Extend this list (and
// shell's ToolId union) together when a new tool joins the suite.
export const ORIGIN_APPS = ["estimai", "refund", "admin"] as const;
export const OriginAppSchema = z.enum(ORIGIN_APPS);

// ─── severity ─────────────────────────────────────────────────────────────────

export const SEVERITIES = ["info", "success", "warning", "error"] as const;
export const SeveritySchema = z.enum(SEVERITIES);

// ─── link.href open-redirect guard ───────────────────────────────────────────

/**
 * True if `href` is a same-origin, in-suite relative path: starts with a single
 * `/`, is not protocol-relative (`//…`), contains no backslashes (some browsers
 * normalise `\` to `/`, which can be abused to smuggle a protocol-relative URL
 * past a naive `startsWith("/")` check), and carries no scheme (`javascript:`,
 * `data:`, `https:`, …) anywhere before the first path segment.
 */
export const isRelativeSuitePath = (href: string): boolean => {
  if (href.length === 0) return false;
  if (href.includes("\\")) return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false; // protocol-relative → treated as absolute by browsers
  return true;
};

export const LinkSchema = z.object({
  href: z
    .string()
    .min(1, "link.href is required when link is provided")
    .max(2000)
    .refine(isRelativeSuitePath, {
      message:
        "link.href must be a relative in-suite path (e.g. \"/estimai/estimates/abc\") — absolute URLs, protocol-relative URLs, and non-http(s) schemes are rejected",
    }),
  label: z.string().max(200).optional(),
});

export type Link = z.infer<typeof LinkSchema>;

// ─── POST /notifications — raise (T4, AC-4.1..4.5) ───────────────────────────
//
// NOTE: no `recipient`/`recipientId` field is declared — see file header SECURITY note.
export const RaiseNotificationSchema = z.object({
  title: z.string().min(1, "title is required").max(200, "title must be at most 200 characters"),
  body: z.string().min(1, "body is required").max(2000, "body must be at most 2000 characters"),
  severity: SeveritySchema.default("info"),
  originApp: OriginAppSchema,
  link: LinkSchema.optional(),
  toast: z.boolean().default(false),
});

export type RaiseNotificationInput = z.infer<typeof RaiseNotificationSchema>;

// ─── Response shapes ──────────────────────────────────────────────────────────

export const NotificationSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  severity: SeveritySchema,
  originApp: OriginAppSchema,
  link: LinkSchema.optional(),
  toastWorthy: z.boolean(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type NotificationDto = z.infer<typeof NotificationSchema>;

// ─── GET /notifications — list (T5, AC-2.3/2.4, US-6) ────────────────────────

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

export const ListResponseSchema = z.object({
  items: z.array(NotificationSchema),
  nextCursor: z.string().nullable(),
});

// ─── GET /notifications/unread-count (T5, US-1) ──────────────────────────────

export const UnreadCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});

// ─── POST /notifications/mark-all-read (T6, US-3) ────────────────────────────

export const MarkAllReadResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  count: z.literal(0),
});

// ─── POST /notifications/stream-ticket (T7, ADR-0008) ────────────────────────

export const StreamTicketResponseSchema = z.object({
  ticket: z.string(),
  expiresIn: z.number().int().positive(),
});

// ─── Problem JSON (RFC 7807) — shared across all notify-api routes ───────────

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

export const problem = (status: number, title: string, detail: string, instance: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance,
});

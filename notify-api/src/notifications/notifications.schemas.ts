/**
 * Zod schemas for the Notifications API (T4/T5/T6/T7, specs/20260713-notification-center).
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
 *   - values that NORMALISE into a protocol-relative path (`/..//evil.example.com`, `/.//x`,
 *     `/%2e%2e//x`) or that the URL parser moves to another host (`/<TAB>/evil.example.com`)
 * and requires the path to start with a single `/`.
 */

import { z } from "zod";
import { NO_NUL, hasNoNul, text } from "@/lib/nulInput";

// ─── originApp — known Operai suite tool ids ─────────────────────────────────
//
// Sourced from shell/src/lib/tools.ts (ToolId union) / auth's authz SUITE_APPS
// seed. plan.md: "originApp … enum of known app ids". Extend this list (and
// shell's ToolId union) together when a new tool joins the suite.
export const ORIGIN_APPS = ["estimai", "refund", "admin", "inventory", "crm", "meetings", "projects"] as const;
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
 *
 * The textual checks are not enough on their own (S-M1, specs/20261111-push-notifications): a browser (and the shell's
 * `new URL(href, origin)`) NORMALISES before it resolves, and `/..//evil.io`, `/.//evil.io`,
 * `/a/..//evil.io` and `/%2e%2e//evil.io` all normalise to the path `//evil.io`, which a later
 * `https://suite` + path join or a redirect reads as a scheme-relative URL to evil.io. Tabs and
 * newlines are dropped by the URL parser too, so `/\t/evil.io` becomes `//evil.io` outright.
 * So the value is also resolved against a throwaway origin and must stay on it with a path that
 * does not start with `//`. A value that cannot be parsed is rejected.
 */
const PROBE_ORIGIN = "http://suite.invalid";

export const isRelativeSuitePath = (href: string): boolean => {
  if (href.length === 0) return false;
  if (href.includes("\\")) return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false; // protocol-relative → treated as absolute by browsers
  let resolved: URL;
  try {
    resolved = new URL(href, PROBE_ORIGIN);
  } catch {
    return false;
  }
  if (resolved.origin !== PROBE_ORIGIN) return false; // the parser moved it to another host
  if (resolved.pathname.startsWith("//")) return false; // normalised into a scheme-relative URL
  return true;
};

export const LinkSchema = z.object({
  href: z
    .string()
    .min(1, "link.href is required when link is provided")
    .max(2000)
    .refine(hasNoNul, NO_NUL)
    .refine(isRelativeSuitePath, {
      message:
        "link.href must be a relative in-suite path (e.g. \"/estimai/estimates/abc\") — absolute URLs, protocol-relative URLs, and non-http(s) schemes are rejected",
    }),
  label: text(200).optional(),
});

export type Link = z.infer<typeof LinkSchema>;

// ─── Italian variant (specs/20261104-meetings, ADR 20261104-bilingual-system-notifications) ──────────────────────────
//
// Optional second rendering of title/body for system callers that know both
// languages. Same limits as the English fields; all-or-nothing (a half-filled
// or blank variant would render empty for a reader on `<html lang="it">`).
// The reader chooses between `title`/`body` and `it`; the sender never does.
export const ItVariantSchema = z.object({
  title: z.string().min(1, "it.title is required").max(200, "it.title must be at most 200 characters").refine(hasNoNul, NO_NUL),
  body: z.string().min(1, "it.body is required").max(2000, "it.body must be at most 2000 characters").refine(hasNoNul, NO_NUL),
});

export type ItVariant = z.infer<typeof ItVariantSchema>;

// ─── POST /notifications — raise (T4, AC-4.1..4.5) ───────────────────────────
//
// NOTE: no `recipient`/`recipientId` field is declared — see file header SECURITY note.
export const RaiseNotificationSchema = z.object({
  title: z.string().min(1, "title is required").max(200, "title must be at most 200 characters").refine(hasNoNul, NO_NUL),
  body: z.string().min(1, "body is required").max(2000, "body must be at most 2000 characters").refine(hasNoNul, NO_NUL),
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
  // Italian variant or null — present on every surface that renders a
  // notification (list item, SSE payload), so a reader never loses it (ADR 20261104-bilingual-system-notifications).
  it: ItVariantSchema.nullable(),
  toastWorthy: z.boolean(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type NotificationDto = z.infer<typeof NotificationSchema>;

// ─── GET /notifications — list (T5, AC-2.3/2.4, US-6) ────────────────────────

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().refine(hasNoNul, NO_NUL).optional(),
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

// ─── POST /notifications/stream-ticket (T7, ADR 20260713-sse-stream-auth-short-lived-ticket) ────────────────────────

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

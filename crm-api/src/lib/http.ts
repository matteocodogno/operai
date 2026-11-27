/**
 * Shared request/response pieces of every crm-api route group (specs/20261101-crm,
 * plan.md § API contract): the paging query, the optimistic-concurrency
 * precondition (D-7, ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004 posture) and the shapes several groups return.
 */

import { z } from "@hono/zod-openapi";
import { ENTITIES } from "../authz/conditions";
import { ProblemError } from "./problem";

// ─── Paging (D-16) ───────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const MAX_PAGE = 100_000;

/** `page` (≥ 1) and `pageSize` (1..max) query members, coerced from strings. */
export const pageQuery = (maxPageSize = MAX_PAGE_SIZE) => ({
  // Bounded so `(page - 1) * pageSize` stays a valid OFFSET: a 422, never a Postgres 500.
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(maxPageSize).default(DEFAULT_PAGE_SIZE),
});

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });

export const skipTake = (page: number, pageSize: number) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

/** `archived` filter: hidden by default, `true` only archived, `all` both. */
export const ArchivedFilterSchema = z.enum(["false", "true", "all"]).default("false");

/**
 * A list's order (specs/20261101-crm US-9): `sort` names one of `columns`, `order` its
 * direction. Without `sort` the list keeps its default order.
 */
export const sortQuery = <const C extends readonly [string, ...string[]]>(columns: C) => ({
  sort: z.enum(columns).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});

/** Where a company or a lead came from (specs/20261101-crm US-7). */
export const LEAD_SOURCES = ["inbound", "outbound", "event", "referral", "other"] as const;
export const LeadSourceSchema = z.enum(LEAD_SOURCES);

/** Clearing the source clears its detail too: a detail never outlives what it qualifies. */
export function withSource<T extends { source?: string | null | undefined; sourceDetail?: string | null | undefined }>(
  body: T,
): T {
  return body.source === null ? { ...body, sourceDetail: null } : body;
}

export const archivedWhere = (archived: "false" | "true" | "all") =>
  archived === "all" ? {} : archived === "true" ? { archivedAt: { not: null } } : { archivedAt: null };

// ─── Concurrency (D-7) ───────────────────────────────────────────────────────

export const etag = (version: number): string => `"${version}"`;

/**
 * The version the caller's `If-Match` names. Absent, a list, a weak or a
 * non-integer tag is a 428: the caller must say which version it edited.
 */
/** What a helper needs from a request: its headers (a Hono `Context` fits). */
export interface HeaderSource {
  readonly req: { header(name: string): string | undefined };
}

export function requireIfMatch(c: HeaderSource): number {
  const header = c.req.header("If-Match")?.trim();
  const match = header ? /^"(\d{1,9})"$/.exec(header) : null;
  if (!match) {
    throw new ProblemError({
      status: 428,
      code: "precondition_required",
      detail: 'This write needs an If-Match header carrying the version you edited, e.g. If-Match: "3"',
    });
  }
  return Number(match[1]);
}

export const versionConflict = (currentVersion: number): ProblemError =>
  new ProblemError({
    status: 409,
    code: "version_conflict",
    detail: "The record was changed by someone else since you loaded it. Reload and try again.",
    extras: { currentVersion },
  });

/** 409 unless the stored version is the one the caller edited. */
export function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw versionConflict(current);
}

/** Prisma's "record to update not found" — a concurrent writer won the race. */
export const isRecordNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2025";

// ─── Shared shapes ───────────────────────────────────────────────────────────

export const EntitySchema = z.enum(ENTITIES);

export const PersonRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "deleted", "unknown", "system"]),
});

/**
 * Postgres text cannot hold U+0000: an id or a filter with one that reached a `findUnique`, a `where` or an insert was a
 * driver error, a 500 and a raw message in the log (QE D7 for a path id, QE D9 for every other id and filter). It is a
 * shape error at the schema instead — no id has one, and a search text with one matches nothing — and it is the ONE
 * mechanism: every string id or filter a route hands to Prisma (or to another service) is `idText` or `searchText`.
 */
export const hasNoNul = (value: string): boolean => !value.includes("\u0000");
export const NO_NUL_ID = "Not an id: contains a NUL character";
export const NO_NUL_TEXT = "Not text: contains a NUL character";

/** A string id, 1 to `max` characters by default (`min` 0 for an optional filter); never a NUL. */
export const idText = (max = 64, min = 1) => z.string().min(min).max(max).refine(hasNoNul, NO_NUL_ID);

/** A search text of at most `max` characters; never a NUL. */
export const searchText = (max: number) => z.string().max(max).refine(hasNoNul, NO_NUL_TEXT);

export const IdParams = z.object({ id: idText() });

/** Optional free text: trimmed, empty → null, `null` clears (PATCH). Never a NUL (security L-8). */
export const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(hasNoNul, NO_NUL_TEXT)
    .transform((v) => (v.trim() === "" ? null : v.trim()))
    .nullable()
    .optional();

/** Required free text, trimmed, 1 to `max` characters. Never a NUL (security L-8). */
export const requiredText = (max: number) =>
  z
    .string()
    .refine(hasNoNul, NO_NUL_TEXT)
    .transform((v) => v.trim())
    .pipe(z.string().min(1, "Required").max(max));

/**
 * True for `YYYY-MM-DD` naming a real calendar day, false for anything else, and it never throws (QE F4): `toISOString()` raises a
 * RangeError on an Invalid Date, and under zod 4 a refinement still runs on a string the regex already refused, so a refinement
 * must answer on whatever text it is given. It checks the shape itself, so it does not rely on a `.regex` running before it.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

/** `YYYY-MM-DD`, a real calendar date. */
export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDate, "Not a calendar date");

export const toDateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

export const fromDateOnly = (value: string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00Z`);

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

/** The error responses every gated route can give, for the OpenAPI document. */
export const commonErrors = {
  401: { description: "Missing or invalid token" },
  403: { description: "The caller lacks crm:access (or the capability the route needs)" },
  422: { description: "Validation failed", content: { "application/json": { schema: ProblemSchema } } },
  503: { description: "The authorization service is unavailable" },
} as const;

/**
 * The 503 of a route that checks an uploaded PDF in the isolated child (`entity-profiles/isolatedPdfCheck.ts`, ADR
 * 20261115-uploaded-pdf-decoded-size-bound-before-parse): it replaces `commonErrors[503]` for that route, so the document
 * says both things a 503 can mean there. The `code` tells them apart; none of them is a verdict about the file.
 */
export const pdfCheckErrors = {
  503: {
    description:
      "Nothing was decided and nothing was changed; try again. By `code`: `pdf_check_busy` (the checks of uploaded PDFs are all taken and the queue is full: " +
      "try again in a moment), `pdf_check_unavailable` (the check could not run: its process did not start or died), " +
      "or, without those codes, the authorization service is unavailable.",
    content: { "application/json": { schema: ProblemSchema } },
  },
} as const;

/**
 * Drops the members a PATCH body left out, so `exactOptionalPropertyTypes`
 * accepts it as a Prisma update (`undefined` would mean "leave", `null` clears).
 */
export function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

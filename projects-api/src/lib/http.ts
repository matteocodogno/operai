/**
 * Shared request/response pieces of every projects-api route group (specs/20261103-projects,
 * tasks.md § API contracts): the paging query, the optimistic-concurrency
 * precondition (AC-1.7, ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004) and the shapes several groups return. Copied from
 * crm-api/src/lib/http.ts.
 */

import { z } from "@hono/zod-openapi";
import { ENTITIES } from "../authz/conditions";
import { notFound, ProblemError } from "./problem";

// ─── Paging (AC-1.4: 25 per page) ───────────────────────────────────────────────────────────

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

// ─── Concurrency (AC-1.7) ───────────────────────────────────────────────────────

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

/** The 404 of a record a compare-and-set found gone: a detail, or a coded error of the record's own. */
export type Gone = string | (() => ProblemError);

/**
 * The error for a compare-and-set that matched no row (AC-1.7, ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004): someone saved first
 * (409 `version_conflict` carrying the version now stored) or the record is gone (404).
 */
export const casMiss = (now: { version: number } | null, gone: Gone): ProblemError =>
  now ? versionConflict(now.version) : typeof gone === "string" ? notFound(gone) : gone();

/**
 * Compare-and-set on the version: `update` must match `version: expected` in its `where` and
 * increment it. Of two saves of the same version only one matches; the other's miss is read back
 * through `readVersion` and becomes {@link casMiss}. The one place the mapping lives, so every
 * model's write answers a lost race the same way.
 */
export async function updateIfVersion<T>(
  update: () => Promise<T>,
  readVersion: () => Promise<{ version: number } | null>,
  gone: Gone,
): Promise<T> {
  try {
    return await update();
  } catch (error) {
    if (!isRecordNotFound(error)) throw error;
    throw casMiss(await readVersion(), gone);
  }
}

// ─── Shared shapes ───────────────────────────────────────────────────────────

export const EntitySchema = z.enum(ENTITIES);

/** `Person` of the contract: a live name (`null` when unknown or deleted) and whether the user is deleted. */
export const PersonSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  deleted: z.boolean(),
});

/** Postgres text cannot hold U+0000: every text a request can carry to a query is refused here, before the database sees it. */
export const hasNoNul = (value: string): boolean => !value.includes("\u0000");
export const NO_NUL = "Must not contain a NUL character";

/** A free-text string, at most `max` characters before trimming, never a NUL (a search `q`, a name, a note). */
export const searchText = (max: number) => z.string().max(max).refine(hasNoNul, NO_NUL);

/**
 * Ids are text (cuids), never uuids: 1–64 characters (tasks.md, "Ids are text"). A NUL is refused here: Postgres text cannot
 * hold U+0000, so one that reached a query would be a 500 instead of a validation failure (specs/20261126-teams, QE D1).
 */
export const IdSchema = z.string().min(1).max(64).refine(hasNoNul, NO_NUL);

export const IdParams = z.object({ id: IdSchema });

/** Optional free text: trimmed, empty → null, `null` clears (PATCH). */
export const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(hasNoNul, NO_NUL)
    .transform((v) => (v.trim() === "" ? null : v.trim()))
    .nullable()
    .optional();

export const requiredText = (max: number) =>
  z
    .string()
    .refine(hasNoNul, NO_NUL)
    .transform((v) => v.trim())
    .pipe(z.string().min(1, "Required").max(max));

/** `YYYY-MM-DD`, a real calendar date. */
export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Not a calendar date");

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
  403: { description: "The caller lacks projects:access (or the capability the route needs)" },
  400: { description: "Validation failed", content: { "application/json": { schema: ProblemSchema } } },
  503: { description: "The authorization service is unavailable" },
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

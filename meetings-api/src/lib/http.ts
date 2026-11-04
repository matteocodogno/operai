/**
 * Shared request/response pieces of every meetings-api route group (specs/021
 * plan.md § API contracts → Conventions): the paging query, the
 * optimistic-concurrency precondition (ADR-0038 posture) and the shapes several
 * groups return. Adapted from crm-api/src/lib/http.ts.
 */

import { z } from "@hono/zod-openapi";
import { ProblemError } from "./problem";

// ─── Paging ──────────────────────────────────────────────────────────────────

/** Fixed by the contract: `Page<T>.pageSize` is always 25 (AC-10.1). */
export const PAGE_SIZE = 25;
export const MAX_PAGE = 100_000;

/** `page` (≥ 1) coerced from the query string; bounded so OFFSET stays valid (422, never a 500). */
export const pageQuery = () => ({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
});

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.literal(PAGE_SIZE),
  });

export const skipTake = (page: number) => ({
  skip: (page - 1) * PAGE_SIZE,
  take: PAGE_SIZE,
});

// ─── Concurrency (ADR-0038) ──────────────────────────────────────────────────

export const etag = (version: number): string => `"${version}"`;

/** What a helper needs from a request: its headers (a Hono `Context` fits). */
export interface HeaderSource {
  readonly req: { header(name: string): string | undefined };
}

/**
 * The version the caller's `If-Match` names. Absent, a list, a weak or a
 * non-integer tag is a 428: the caller must say which version it edited.
 */
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

/** Prisma's "record to update not found": a concurrent writer won the race. */
export const isRecordNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2025";

// ─── Shared shapes ───────────────────────────────────────────────────────────

/** `{ id, name, status }`; `name` is null unless the person is active (AC-5.12 lineage). */
export const PersonRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "deleted", "unknown"]),
});

export const IdParams = z.object({ id: z.string().min(1).max(64) });

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
  403: { description: "The caller lacks the capability the route needs" },
  422: { description: "Validation failed", content: { "application/json": { schema: ProblemSchema } } },
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

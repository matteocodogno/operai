import { Data } from "effect";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A relationship to the record exists (caller is a collaborator, or an
 * owner-only action attempted by a non-owner collaborator) but the caller's
 * level is insufficient for the attempted operation. This is DISTINCT from
 * NotFoundError (T6, specs/013-estimate-sharing, plan.md "Access resolution
 * inside estimai-api" / ADR-0037): a stranger with NO relationship gets
 * NotFoundError → 404; a collaborator who knows the record exists but lacks
 * the required level gets ForbiddenError → 403. `code` is the stable
 * machine-readable RFC 7807 `code` extension (e.g. "owner_only",
 * "insufficient_access").
 */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly message: string;
  readonly code: string;
  readonly cause?: unknown;
}> {}

/**
 * Optimistic-concurrency conflict (T7, specs/013-estimate-sharing, ADR-0038
 * "amends ADR-0004" — supersedes last-write-wins).
 *
 * Raised by `updateEstimate`'s single-statement CAS when the caller's access
 * level IS sufficient (owner or editor — otherwise a ForbiddenError/
 * NotFoundError would already have fired first, per the plan's fixed
 * evaluation order 404/403 → 409) but the supplied `If-Match` version no
 * longer matches the stored row: someone else's write landed first.
 *
 * Carries everything the 409 Problem body needs (plan.md's API contract) —
 * `currentVersion`/`updatedAt` are DB facts and always present; the caller's
 * `lastModifiedByUserId` (a raw `sub`) is resolved to a display Identity in
 * estimates.routes.ts (best-effort, via authClient.resolveIdentities, which
 * never throws — ADR-0039) because that requires the caller's own Bearer
 * token, which this DB-only layer does not have.
 */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string;
  readonly currentVersion: number;
  readonly updatedAt: string;
  readonly lastModifiedByUserId: string | null;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly statusCode?: number;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly fields?: Record<string, string[]>;
}> {}

export class SizeError extends Data.TaggedError("SizeError")<{
  readonly message: string;
  readonly actualBytes: number;
  readonly limitBytes: number;
}> {}

export type AppError =
  | DatabaseError
  | NotFoundError
  | ForbiddenError
  | ConflictError
  | AuthError
  | ValidationError
  | SizeError;

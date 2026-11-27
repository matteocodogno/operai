/**
 * What a route throws when the database failed and it has no answer for it (specs/20261126-teams QE F1). The routes used to
 * `throw new Error("Unexpected database failure ...")` and drop the failure, so the global safety net (`app.onError`, which answers a
 * NUL the database refused with a 400) never saw why: the caller got a 500 for a request that was wrong. The wrapper now keeps the
 * cause, and `nulRefusalIn` finds a NUL refusal anywhere down that chain (the repository's tagged `DatabaseError` carries the driver's
 * error one level further down than the `Error` the route throws).
 */
import { Cause } from "effect";
import { isNulDatabaseError } from "./nul";

/** The `Error` a route throws for a database failure it has no answer for; the failure stays on its `cause`. */
export const unexpectedDbFailure = (message: string, cause: Cause.Cause<unknown>): Error =>
  new Error(message, { cause: Cause.squash(cause) });

/** How far down a `cause` chain the question is asked: route error -> tagged repository error -> Prisma error -> driver error. */
const MAX_DEPTH = 6;

/**
 * The error in `error`'s cause chain that the database raised for a NUL (the one `isNulDatabaseError` recognises, whose codes
 * `logNulRefusal` reads), or null. It reads codes only, never a message.
 */
export function nulRefusalIn(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && typeof current === "object" && current !== null; depth++) {
    if (isNulDatabaseError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

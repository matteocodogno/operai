/**
 * `Effect.runPromiseExit` for a route: a failure whose cause is the database's refusal of a NUL (U+0000) is re-thrown as that
 * error, so the global handler answers 400 `validation_failed` and logs the codes (specs/20261126-teams QE D2 follow-up, F1).
 *
 * The repo functions wrap every Prisma failure in a tagged `DatabaseError`, and the routes turn that into a 500 (or, on some,
 * into a 404 that quotes the id) without ever raising the Prisma error, so the safety net of `app.onError` was never asked.
 * Every route runs its effects through this function instead of `Effect.runPromiseExit`; nothing else changes: any other failure
 * comes back as the same `Exit` for the route to map as before.
 */
import { Cause, Chunk, Effect, type Exit } from "effect";
import { isNulDatabaseError } from "./nul";

/** The first failure or defect of the cause that is, or wraps, a NUL refusal of the database. */
function findNulRefusal(cause: Cause.Cause<unknown>): unknown {
  const candidates = [...Chunk.toArray(Cause.failures(cause)), ...Chunk.toArray(Cause.defects(cause))];
  for (const error of candidates) {
    if (isNulDatabaseError(error)) return error;
    const wrapped = typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
    if (wrapped !== undefined && isNulDatabaseError(wrapped)) return wrapped;
  }
  return undefined;
}

export async function runExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  const exit = await Effect.runPromiseExit(effect);
  // The global handler (`app.onError`) answers the 400 and writes the one log line (A09); this only gets the error there.
  if (exit._tag === "Failure") {
    const refusal = findNulRefusal(exit.cause);
    if (refusal !== undefined) throw refusal;
  }
  return exit;
}

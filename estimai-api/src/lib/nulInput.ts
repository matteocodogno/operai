/**
 * Postgres text cannot hold U+0000, nor can the text inside jsonb. A NUL a request carries to a query used to be the database's error
 * and, through a wrapper that dropped the cause, a 500 (specs/20261126-teams QE F1). Every id, query member and text a route takes is
 * refused here, at the schema, before the database sees it: a 400 like any other validation failure. `app.onError` stays as the net
 * for a NUL that is built on the server side (`lib/nul.ts`, `lib/dbFailure.ts`). Same shape as projects-api's `src/lib/http.ts`.
 */
import { z } from "zod";

export const hasNoNul = (value: string): boolean => !value.includes("\u0000");
export const NO_NUL = "Must not contain a NUL character";

/** A free-text string, at most `max` characters, never a NUL (a name, an author, a note, a label). */
export const text = (max: number) => z.string().max(max).refine(hasNoNul, NO_NUL);

/** An id of a path or a body: at least one character, never a NUL. */
export const IdSchema = z.string().min(1, "id is required").refine(hasNoNul, NO_NUL);

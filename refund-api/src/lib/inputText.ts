/**
 * A NUL (U+0000) in text a caller sends is refused where the input is read, as a 400 (specs/20261126-teams QE D2 follow-up, F1).
 * Postgres text cannot hold one, so a NUL that got past validation reaches the driver and comes back as a database error; the
 * service answers that as the caller's mistake too (`runExit.ts`, the global handler), but the schema is the first line: every id
 * (path), cursor, query and free-text member of a body goes through the helpers below, the way projects-api's `IdSchema`,
 * `requiredText` and `searchText` do.
 *
 * `nulRefusal` is the one answer a refused NUL gets, whatever the router's own validation hook says for other mistakes (some
 * answer 422, some a zod issue list): a 400 problem that names the character and quotes no value.
 */
import type { Context } from "hono";
import { z } from "zod";
import { NUL_DATABASE_DETAIL } from "./nul";

/** The message of a refused NUL; `nulRefusal` recognises a validation failure by it (a caller cannot write a zod message). */
export const NO_NUL = "Must not contain a NUL character";

export const hasNoNul = (value: string): boolean => !value.includes("\u0000");

/** Any string schema, refusing a NUL. Chain `.trim()`, `.min()`, `.max()` as before: `refine` keeps the type. */
export const noNul = <T extends z.ZodString>(schema: T): T => schema.refine(hasNoNul, { message: NO_NUL }) as T;

/** A path id: at least one character, never a NUL. `label` is the member's name in the "is required" message. */
export const idParam = (label: string) => noNul(z.string().min(1, `${label} is required`));

/** The 400 answer for a NUL, built the way the global handler builds it. */
export function nulProblemResponse(c: Context): Response {
  return c.json(
    {
      type: "https://httpstatuses.com/400",
      title: "Bad Request",
      status: 400,
      detail: NUL_DATABASE_DETAIL,
      code: "validation_failed",
      instance: c.req.path,
    },
    400,
  );
}

/**
 * First line of every router's `defaultHook`: a validation failure that includes a refused NUL is the 400 problem above, never the
 * router's own 422 or issue list. Returns `undefined` for anything else, so the hook carries on with its own answer.
 */
export function nulRefusal(
  result: { success: true } | { success: false; error: { issues: readonly unknown[] } },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  const refused = result.error.issues.some((issue) => (issue as { message?: unknown } | null)?.message === NO_NUL);
  return refused ? nulProblemResponse(c) : undefined;
}

/**
 * The name of a category or a work type (specs/029 plan § Lists and § Entries, "Counting a note and a
 * name" and "A lone surrogate in a note or a name"; AC-3.1, AC-3.8).
 *
 * A name is a label an admin types, shown exactly as typed in both languages. It is TRIMMED at the
 * ends (and only there: inner spaces and case stay as typed), then must be 1..80 Unicode CODE POINTS —
 * `[...name].length`, never zod's `.max()`, which counts UTF-16 units and would refuse 41 emoji — free
 * of NUL (Postgres `text` cannot hold it) and well-formed UTF-16 (`isWellFormed()`: JSON can carry half
 * of a surrogate pair, and the Postgres driver would silently store U+FFFD in its place). Outside any of
 * that: 400 `invalid_request` with `field: "name"`. The OpenAPI document says `maxLength: 80`, which is
 * what JSON Schema counts too (code points).
 *
 * The parsed value is the trimmed name, so a handler can only ever store a trimmed one.
 */

import { z } from "@hono/zod-openapi";

export const NAME_MAX_CODE_POINTS = 80;

export const NameSchema = z
  .string()
  .openapi({
    minLength: 1,
    maxLength: NAME_MAX_CODE_POINTS,
    description: "Trimmed at the ends, then 1..80 characters (Unicode code points); shown exactly as typed",
  })
  .transform((value, ctx) => {
    const name = value.trim();
    const refuse = (message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    };
    if (name.includes("\u0000")) return refuse("must not contain a NUL character");
    if (!name.isWellFormed()) return refuse("must be well-formed text (no lone surrogate)");
    const length = [...name].length;
    if (length < 1) return refuse("must not be empty");
    if (length > NAME_MAX_CODE_POINTS) return refuse(`must be at most ${NAME_MAX_CODE_POINTS} characters`);
    return name;
  });

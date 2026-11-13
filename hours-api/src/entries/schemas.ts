/**
 * What the entry write routes accept (specs/029 T14; plan § Entries). Every shape and format rule here is a
 * 400 `invalid_request` naming the offending member (src/lib/errors.ts), decided from the request alone
 * before any lookup, `auth` or owner call. The rules that depend on the lists, on today or on what is stored
 * are 422s raised by the route with the functions of ./rules.
 */

import { z } from "@hono/zod-openapi";
import { IdSchema } from "../lists/idRule";
import { FIRST_DAY, NOTE_MAX_CODE_POINTS, isCalendarDay } from "./rules";

/**
 * A real calendar day from 2000-01-01 (plan § Entries, "A day"): else 400 `invalid_request` naming the
 * field. Query parameters (`from`, `to`; T17, T18) build on `isCalendarDay`, the one implementation.
 */
export const DaySchema = z
  .string()
  .refine(isCalendarDay, { message: `must be a real calendar day, YYYY-MM-DD, from ${FIRST_DAY}` })
  .openapi({
    format: "date",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    example: "2026-11-12",
    description: `A real calendar day from ${FIRST_DAY}, YYYY-MM-DD. After today in Europe/Zurich is 422 future_day`,
  });

/**
 * A note as the person typed it. Only what Postgres cannot store as sent is refused here, with 400
 * `invalid_request` naming `note`: a NUL (`text` cannot hold one, a 500) and half of a surrogate pair (the
 * driver would store U+FFFD in its place). Its LENGTH is a rule, 422 `note_too_long`, raised by the route
 * after this, and a blank note becomes no note there too (plan § Entries, "A blank note").
 */
export const NoteSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (value.includes("\u0000")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain a NUL character" });
    else if (!value.isWellFormed()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a well-formed text (no lone surrogate)" });
  })
  .openapi({
    maxLength: NOTE_MAX_CODE_POINTS,
    description:
      "What the person did, at most 1000 characters (Unicode code points; more is 422 note_too_long). " +
      "A blank note (only whitespace) is no note: stored and returned as null. No NUL, no lone surrogate (400).",
  });

/** What an entry is on: a project, a deal or a meeting (by id), or no entity and then a category. */
const entityTarget = <T extends "project" | "deal" | "meeting">(type: T) => z.object({ type: z.literal(type), id: IdSchema }).strict();

export const OnSchema = z.discriminatedUnion("type", [
  entityTarget("project"),
  entityTarget("deal"),
  entityTarget("meeting"),
  z.object({ type: z.literal("none"), categoryId: IdSchema }).strict(),
]);

export type On = z.infer<typeof OnSchema>;

const MinutesSchema = z
  .number()
  .openapi({ minimum: 30, maximum: 1440, multipleOf: 30, example: 90, description: "A duration in minutes: whole half-hours, 30 to 1440 (else 422 invalid_minutes). Never a start or an end time." });

const WorkTypeIdSchema = IdSchema.nullable().openapi({ description: "A work type of the project or deal list; none on a meeting or on no entity (422 work_type_not_allowed)" });
const ActivityIdSchema = IdSchema.nullable().openapi({ description: "An activity of the same project or deal; none on a meeting or on no entity (422 activity_not_allowed)" });

/** Strict: any other key (`userId`, `start`, `end`, …) is a 400 (AC-1.6, AC-1.8). */
export const CreateEntrySchema = z
  .object({
    day: DaySchema,
    minutes: MinutesSchema,
    on: OnSchema,
    workTypeId: WorkTypeIdSchema.optional(),
    activityId: ActivityIdSchema.optional(),
    note: NoteSchema.nullable().optional(),
  })
  .strict();

export type CreateEntry = z.infer<typeof CreateEntrySchema>;

/**
 * Any subset of the members of a `POST` (`on` replaced whole), at least one: an empty body is a client that
 * forgot what it meant to change, as for the lists (T12). A member that is sent is checked like on `POST`;
 * one that is not sent keeps what is stored.
 */
export const UpdateEntrySchema = z
  .object({
    day: DaySchema.optional(),
    minutes: MinutesSchema.optional(),
    on: OnSchema.optional(),
    workTypeId: WorkTypeIdSchema.optional(),
    activityId: ActivityIdSchema.optional(),
    note: NoteSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "at least one member is required" });

export type UpdateEntry = z.infer<typeof UpdateEntrySchema>;

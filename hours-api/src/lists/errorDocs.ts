/**
 * The error answers of the list WRITES, for the OpenAPI document (specs/029 T12; plan § Lists and
 * § Errors). Documentation only: the answers themselves come from the gate (src/authz) and from
 * `invalidRequestHook`, `ProblemError` and `handleError` in src/lib.
 */

import { z } from "@hono/zod-openapi";

// Deliberately not registered as a named component: a later route's documentation of its own
// problem shape must not collide with this one in the one OpenAPI document.
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional().describe("The discriminator a client switches on"),
  field: z.string().optional().describe("On a 400: the first offending member (`name`, `id`, …)"),
});

const problem = (description: string) => ({ description, content: { "application/json": { schema: ProblemSchema } } });

/** A read of the lists answers 400 for a bad `includeRetired`, and 401 without a session. */
export const readErrors = {
  400: problem("`invalid_request`: `includeRetired` is neither `true` nor `false`, or is repeated (`field: \"includeRetired\"`)"),
  401: problem("No valid session"),
} as const;

/** What every list write can answer besides its success. */
export const writeErrors = {
  400: problem("`invalid_request`: an unknown or missing member, a name outside its rule (`field: \"name\"`), an id outside the id rule (`field: \"id\"`)"),
  401: problem("No valid session"),
  403: problem("`time_list_manage_required`: the caller does not hold time-list:manage"),
  409: problem("`name_taken`: another item of the list has this name (case-insensitively, retired items included)"),
  503: problem("`authz_unavailable`: auth could not say whether the caller holds time-list:manage; nothing was changed"),
} as const;

/** A `PATCH` also answers 404 for a well-formed id no item has. */
export const itemNotFoundError = { 404: problem("`not_found`: no item of this kind has this id") } as const;

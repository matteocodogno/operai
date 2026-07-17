/**
 * Response shapes for the submit/withdraw lifecycle endpoints (T10,
 * specs/007-refund-service, AC-1.5/1.6).
 *
 * CONTRACT NOTE: the frontend (T16) parses the incomplete-line 422 response
 * expecting the offending line ids under the EXACT field name
 * `offendingLineIds` (array of line id strings), alongside the standard RFC
 * 7807 Problem fields. Keep this name stable — a rename here requires a
 * matching frontend change.
 */

import { z } from "zod";
import { ProblemSchema } from "./requests.schemas";

export const SubmitValidationProblemSchema = ProblemSchema.extend({
  offendingLineIds: z.array(z.string()).optional(),
});
export type SubmitValidationProblem = z.infer<
  typeof SubmitValidationProblemSchema
>;

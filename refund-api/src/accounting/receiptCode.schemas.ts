/**
 * Zod schemas of the receipt-code surface (T5, specs/20261124-receipt-numbers-from-the-register; plan § API contracts, D8; design
 * sync DS-2 and DS-8; AC-4.1, AC-4.2, AC-4.3, AC-4.7, AC-4.9).
 */

import { z } from "zod";
import { noNul } from "../lib/inputText";

export const ReceiptCodeRowSchema = z.object({
  userId: z.string(),
  /** The newest request's owner name; `null` when it has none. */
  name: z.string().nullable(),
  email: z.string(),
  initials: z.string(),
  code: z.string().nullable(),
  /** `code ?? initials`: what the next number uses. */
  prefix: z.string(),
  prefixSource: z.enum(["code", "initials"]),
  /** The highest (year, sequence) numbered line, as issued. */
  lastNumber: z.string().nullable(),
  /** DS-2: the newest `receipt_code_change`, a clear included; `null` when the employee has none. */
  changedAt: z.string().datetime().nullable(),
  changedByEmail: z.string().nullable(),
  /** DS-8: the prefix equals another employee's code, another codeless employee's initials, or the prefix of a number issued or imported to another employee. */
  sharesPrefix: z.boolean(),
});

export const ReceiptCodesResponseSchema = z.object({ employees: z.array(ReceiptCodeRowSchema) });

/**
 * A strict object: any other key is a 422 `receipt_code_invalid`, like a value that is not text or null. `""` and `null` clear the
 * code; the shape of a code is decided by `normaliseReceiptCode`, not here.
 */
export const PutReceiptCodeBodySchema = z.strictObject({ code: noNul(z.string()).nullable() });

export const UserIdParamSchema = z.object({ userId: noNul(z.string().min(1).max(128)) });

export const ReceiptCodeHistoryResponseSchema = z.object({
  entries: z.array(
    z.object({
      codeBefore: z.string().nullable(),
      codeAfter: z.string().nullable(),
      changedBy: z.object({ userId: z.string(), email: z.string() }),
      changedAt: z.string().datetime(),
    }),
  ),
});

export const ReceiptCodeProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

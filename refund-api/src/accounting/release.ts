/**
 * The accounting release gate (T8, specs/20261118-refund-accounting-export;
 * plan D6; ADR 20261118-receipt-numbers-come-from-a-row-locked-per-employee-
 * and-year-counter-...).
 *
 * Until the one-time release script (`accounting:release`, T11) has run,
 * approving a request is refused with 409 `accounting_release_pending`.
 * Reason: a legacy line has to be numbered by expense date, and any starting
 * offset has to be loaded, BEFORE the first number is issued from the counter.
 * The marker is an ordinary append-only `refund_setting` row, so it is its own
 * audit trail and the immutability trigger already protects it.
 */

import type { Prisma } from "../lib/generated/prisma/client";

/** The `refund_setting` key whose latest non-null value is the time the release script completed. */
export const RELEASE_MARKER_KEY = "accounting-release-completed-at";

/** `true` once the release script has written the marker (a latest row with a value). */
export async function isAccountingReleased(tx: Prisma.TransactionClient): Promise<boolean> {
  const latest = await tx.refundSetting.findFirst({
    where: { key: RELEASE_MARKER_KEY },
    orderBy: { createdAt: "desc" },
    select: { value: true },
  });
  return latest?.value != null && latest.value !== "";
}

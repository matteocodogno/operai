/**
 * Test-only: the accounting release marker (T12, specs/20261118-refund-accounting-
 * export; plan D6 and R14).
 *
 * Approving a request is refused (409 `accounting_release_pending`) until the
 * `accounting-release-completed-at` marker exists. A test database is emptied by
 * `truncateRefundTables()`, which would take the marker with it and refuse every
 * approval of the existing suite, so the cleanup puts the marker back through
 * `markAccountingReleased()`. A test that needs the pre-release state (the gate
 * itself, the release script) empties the tables with
 * `truncateRefundTables({ released: false })`.
 *
 * It writes the same row the real script writes, as the script's system actor,
 * but it is not the script: it does no seeding, no backfill and no offsets.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { isAccountingReleased, RELEASE_MARKER_KEY } from "../accounting/release";

type Client = Prisma.TransactionClient | typeof db;

const MARKER_ACTOR = { createdByUserId: "system:accounting-release", createdByEmail: "system-accounting-release@welld.ch" };

/** Writes the release marker unless it is already there. Returns `true` when it wrote one. */
export async function markAccountingReleased(client: Client = db): Promise<boolean> {
  if (await isAccountingReleased(client as Prisma.TransactionClient)) return false;
  await client.refundSetting.create({
    data: { key: RELEASE_MARKER_KEY, value: new Date().toISOString(), ...MARKER_ACTOR },
  });
  return true;
}

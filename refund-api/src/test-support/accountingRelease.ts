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

const BY = { createdByUserId: "test-admin", createdByEmail: "admin@welld.ch" };

export interface AccountingFixtures {
  readonly account: { id: string; number: string };
  readonly vatCode: { id: string; code: string };
}

/**
 * Test-only: a configured catalog, so that a test which approves WellD CH lines
 * without being about classification still approves (AC-3.4 refuses a CH line
 * with no account or VAT code). One account (6101), one VAT code (`IMP81`, 8.1 %),
 * the pair as the default of every expense type, and the same VAT code
 * designated for foreign currencies. Call it AFTER `truncateRefundTables()`.
 */
export async function seedAccountingFixtures(client: typeof db = db): Promise<AccountingFixtures> {
  const { ExpenseType } = await import("../lib/generated/prisma/enums");
  const account = await client.ledgerAccount.create({ data: { entity: "welld_ch", number: "6101", name: "Spese materiale ufficio", ...BY } });
  const vatCode = await client.vatCode.create({ data: { entity: "welld_ch", code: "IMP81", label: "IVA 8.1%", rateBasisPoints: 810, ...BY } });
  for (const type of Object.values(ExpenseType)) {
    await client.expenseTypeDefault.create({
      data: { entity: "welld_ch", type, ledgerAccountId: account.id, vatCodeId: vatCode.id, ...BY },
    });
  }
  await client.refundSetting.create({
    data: { key: "accounting.welld_ch.foreign-currency-vat-code", value: vatCode.id, ...BY },
  });
  return { account: { id: account.id, number: account.number }, vatCode: { id: vatCode.id, code: vatCode.code } };
}

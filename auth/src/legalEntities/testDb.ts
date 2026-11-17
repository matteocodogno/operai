/**
 * Isolation for tests that touch `legal_entity_version` (specs/20261117-legal-entities, T1, plan R10).
 *
 * The table is Tier 1: raising triggers refuse UPDATE, DELETE and TRUNCATE, so a test cannot clean it by
 * removing rows the way the rest of the auth suite does in teardown. Every test that writes to it therefore
 * runs inside ONE database transaction that is always rolled back: nothing is ever committed, nothing needs
 * removing, and parallel files never see each other's rows.
 *
 *   await inRolledBackTx(async (tx) => {
 *     await attempt(tx, insertSql(validImportRow("welld_it")));
 *     ...
 *   });
 *
 * Rules for registry tests:
 *   - never write to the model outside `inRolledBackTx` (it would commit for good);
 *   - never write a teardown that removes rows from the table (it raises `legal_entity_version_immutable`);
 *   - a statement that is EXPECTED to be refused goes through `attempt`, which wraps it in a savepoint:
 *     a failed statement aborts a Postgres transaction, and the savepoint keeps the rest of the test usable.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { LegalEntity } from "./entities";

export type Tx = Prisma.TransactionClient;

/** Thrown on purpose at the end of `inRolledBackTx` to make Prisma roll the transaction back. */
class Rollback extends Error {
  constructor() {
    super("legal-entities test transaction rollback");
  }
}

/**
 * Runs `fn` in an interactive transaction and ALWAYS rolls it back. Returns what `fn` returned; an error
 * thrown by `fn` is rethrown (the transaction is rolled back either way).
 */
export async function inRolledBackTx<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        result = { value: await fn(tx) };
        throw new Rollback();
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  // `fn` completed (otherwise its own error was rethrown above).
  return (result as { value: T }).value;
}

/** The message of a database error, including what Prisma and the pg adapter nest under `cause`/`meta`. */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      const meta = (current as { meta?: unknown }).meta;
      if (meta != null) parts.push(JSON.stringify(meta));
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

/**
 * Runs `sql` inside a savepoint and returns the text of the database error it raised, or `null` if it
 * succeeded (the savepoint is then released and the effect stays in the surrounding transaction).
 * After a refusal the savepoint is rolled back, so the surrounding transaction stays usable.
 */
export async function attempt(tx: Tx, sql: string): Promise<string | null> {
  await tx.$executeRawUnsafe("SAVEPOINT le_attempt");
  try {
    await tx.$executeRawUnsafe(sql);
  } catch (error) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT le_attempt");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT le_attempt");
    return errorText(error);
  }
  await tx.$executeRawUnsafe("RELEASE SAVEPOINT le_attempt");
  return null;
}

/** Number of committed rows, to assert that a test left nothing behind. */
export async function committedVersionCount(): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT count(*) AS n FROM legal_entity_version",
  );
  return Number(rows[0]?.n ?? 0);
}

/** The columns the CHECK constraints look at; the details are left empty by `insertSql`. */
export type VersionRow = {
  entity: string;
  version: number;
  action: string;
  restoredFrom: number | null;
  createdByUserId: string | null;
  createdByName: string | null;
};

/** A valid system import (version 1); override fields to build the invalid variants. */
export function validImportRow(entity: LegalEntity): VersionRow {
  return {
    entity,
    version: 1,
    action: "import",
    restoredFrom: null,
    createdByUserId: null,
    createdByName: null,
  };
}

const lit = (value: string | number | null): string =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replace(/'/g, "''")}'`;

/** An INSERT statement for one version row with the details left empty (the CHECKs do not look at them). */
export function insertSql(row: VersionRow): string {
  return (
    `INSERT INTO legal_entity_version ` +
    `("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",` +
    `"action","restoredFrom","changedFields","createdByUserId","createdByName") VALUES (` +
    `${lit(row.entity)},${lit(row.version)},'',ARRAY[]::text[],ARRAY[]::text[],'','','','',` +
    `${lit(row.action)},${lit(row.restoredFrom)},ARRAY[]::text[],${lit(row.createdByUserId)},${lit(row.createdByName)})`
  );
}

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
 *
 * The ONE exception: a "committed-transaction" group (T8's real transactions, T59's) needs real commits and removes
 * its own rows afterwards by turning the table's triggers off for its own session, which the Tier 1 rules forbid elsewhere.
 * That is only acceptable on a throwaway database, so such a group runs ONLY when `DATABASE_URL` names a local host
 * (`isLocalDatabaseHost`, `committedTransactionsSkipReason`); against any other host it is skipped, with one line
 * that names the reason and never the URL (it carries credentials). Wrap the group like this:
 *
 *   const skip = committedTransactionsSkipReason(process.env.DATABASE_URL);
 *   if (skip) console.warn(skip);
 *   (skip ? describe.skip : describe)("real transactions", ...);
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

/** The hosts a committed-transaction group may run against: this machine, or the compose database. */
const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal", "postgres"]);

/**
 * True only when `databaseUrl` is a PostgreSQL URL whose host is one of `LOCAL_DATABASE_HOSTS`. Fails closed: a missing,
 * blank or unparseable value, a multi-host URL, or a `?host=` override that is not local all answer false.
 */
export function isLocalDatabaseHost(databaseUrl: string | undefined): boolean {
  if (databaseUrl === undefined || databaseUrl.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(databaseUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return false;
  // libpq lets `?host=` override the authority: every host it names must be local too.
  const overrides = url.searchParams.getAll("host");
  const hosts = [url.hostname, ...overrides].map((h) => h.toLowerCase().replace(/^\[|\]$/g, ""));
  return hosts.every((h) => LOCAL_DATABASE_HOSTS.has(h));
}

/** `null` when a committed-transaction group may run; otherwise the one line to log when it is skipped (no URL in it). */
export function committedTransactionsSkipReason(databaseUrl: string | undefined): string | null {
  if (isLocalDatabaseHost(databaseUrl)) return null;
  return (
    "legal-entities tests: the committed-transaction group is SKIPPED because DATABASE_URL does not name a local " +
    "database host (localhost, 127.0.0.1, ::1, host.docker.internal, postgres); it commits rows and bypasses the " +
    "append-only triggers to remove them, so it never runs against a shared or remote database."
  );
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

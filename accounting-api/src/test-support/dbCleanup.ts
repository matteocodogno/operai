/**
 * Shared test-only database helpers (T5, specs/20261119-accounting). Modelled on
 * refund-api/src/test-support/dbCleanup.ts and inventory-api's.
 *
 * TRUNCATE, not DELETE: TRUNCATE does not fire the row-level BEFORE DELETE trigger that makes all
 * five tables append-only (ADR 20260716-immutable-financial-audit-trail-refund), so cleanup is never
 * blocked by the very guarantee under test. Every table is listed explicitly, in one statement, so a
 * table added later cannot be left behind by a cleanup that forgot it.
 *
 * REFUSES to run against anything but a local, non-production database. The suite empties the five
 * tables, so a `DATABASE_URL` that still points at a shared or deployed database (a developer's
 * `.envrc`, a mistyped CI variable) must never reach a TRUNCATE.
 */

import { db } from "../lib/db";

/** Every table of the init migration, the order irrelevant (one statement, CASCADE). */
export const ACCOUNTING_TABLES = [
  "catalog_status_change",
  "ledger_account",
  "vat_code",
  "exchange_rate_entry",
  "exchange_rate_fetch_attempt",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** Throws unless `DATABASE_URL` names a local database and the process is not a production one. */
export function assertDisposableDatabase(url = process.env["DATABASE_URL"] ?? ""): void {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("test cleanup refused: NODE_ENV is production");
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("test cleanup refused: DATABASE_URL is not a URL");
  }
  if (!LOCAL_HOSTS.has(host)) {
    // The host only: a URL carries a password.
    throw new Error(`test cleanup refused: DATABASE_URL host "${host}" is not local`);
  }
}

export async function truncateAccountingTables(): Promise<void> {
  assertDisposableDatabase();
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${ACCOUNTING_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

// ─── Reading a refusal back ───────────────────────────────────────────────────

/** What Postgres said when it refused a statement: its SQLSTATE and its message (which names the constraint). */
export interface Violation {
  readonly code: string;
  readonly message: string;
}

type DriverError = {
  meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } };
};

/**
 * Awaits a query that MUST be refused and returns the SQLSTATE and message of the refusal. Throws if the
 * statement succeeded, so a test cannot pass because a bad row got in. Prisma 7 queries are lazy
 * `PrismaPromise`s, hence the `PromiseLike`.
 */
export async function violation(query: PromiseLike<unknown>): Promise<Violation> {
  try {
    await query;
  } catch (error) {
    const cause = (error as DriverError).meta?.driverAdapterError?.cause;
    return { code: cause?.originalCode ?? "?", message: cause?.originalMessage ?? String(error) };
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

/** SQLSTATEs the tests assert on. */
export const SQLSTATE = {
  /** `RAISE EXCEPTION` with `ERRCODE = 'raise_exception'`: the immutability and entity triggers. */
  raise: "P0001",
  /** unique_violation. */
  unique: "23505",
  /** check_violation. */
  check: "23514",
  /** foreign_key_violation. */
  foreignKey: "23503",
} as const;

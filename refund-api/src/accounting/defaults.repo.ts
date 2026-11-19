/**
 * Data access for the default classification of WellD CH (T7, specs/20261118-refund-accounting-export; reworked by T18,
 * specs/20261119-accounting; AC-4.4, AC-4.5, AC-4.7, AC-6.9, AC-3.7; ADR 20260722-refund-settings-append-only-self-
 * auditing-store, ADR 20261119-accounting-reference-data-belongs-to-accounting-api-...).
 *
 * Two append-only tables of COPIES, one derivation rule: the CURRENT value is the LATEST row, and no row is ever
 * updated or deleted (triggers, T16).
 * - `expense_type_accounting_default`: one row per change of an expense type's default account (number, name) and VAT
 *   code (code, label, rate); `null` = no default for that half.
 * - `foreign_currency_vat_designation`: one row per designation of the VAT code applied to every non-CHF line;
 *   all-null = cleared.
 *
 * What a row holds is what the entry was when it was chosen, so the history reads the same whatever happens in Accounting
 * afterwards (AC-4.7). Accounting's present state of an entry (`active`, `deactivated`, `not_found`, `unverified`) is
 * added ON TOP at read time, from a snapshot the caller read (never from here); a default that is not `active` counts as
 * no default for a new classification (`classification.ts`, AC-4.5, SA-3) and comes back by itself on reactivation.
 *
 * A write is validated against that snapshot: only an ACTIVE WellD CH entry can be chosen (AC-4.4). Entries are keyed by
 * their natural key, so a number that exists only for WellD Italia is simply "not found" (AC-4.3).
 *
 * Writes lock the (entity, type) or the designation with a transaction-scoped advisory lock and stamp each new row
 * strictly after the previous one, so "latest" is the latest decision however the clocks of two requests compare. A write
 * of what is already current (same natural keys and same copied values) is suppressed: no row.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { ExpenseType } from "../lib/generated/prisma/enums";
import { basisPointsToPercent, type RecordedDefaults, type RecordedVat, type TypeDefaultsByType } from "./classification";
import type { ReferenceSnapshot, ReferenceState } from "./referenceSnapshot";
import type { DefaultsResponse, ForeignCurrencyVatCodeState, TypeDefaultRow } from "./defaults.schemas";

type Client = Prisma.TransactionClient;

/** The one entity Accounting's reference data is kept for in Refund (D19 of 20261119: WellD Italia has none). */
export const DEFAULTS_ENTITY = "welld_ch" as const;

/** The actor of a write: always from the verified JWT. */
export interface Actor {
  readonly userId: string;
  readonly email: string;
}

/** The twelve expense types, in enum order. */
export const EXPENSE_TYPES: readonly ExpenseType[] = Object.values(ExpenseType);

export const isExpenseType = (value: string): value is ExpenseType =>
  (EXPENSE_TYPES as readonly string[]).includes(value);

// ─── Reading ─────────────────────────────────────────────────────────────────

const compareRows = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The full history of the type defaults, oldest first. */
async function typeRows(client: Client) {
  const rows = await client.expenseTypeAccountingDefault.findMany({ where: { entity: DEFAULTS_ENTITY } });
  return rows.sort(compareRows);
}

/** The designation history, oldest first. */
async function designationRows(client: Client) {
  const rows = await client.foreignCurrencyVatDesignation.findMany({ where: { entity: DEFAULTS_ENTITY } });
  return rows.sort(compareRows);
}

interface VatCopyColumns {
  readonly vatCode: string | null;
  readonly vatLabel: string | null;
  readonly vatRateBasisPoints: number | null;
}
interface AccountCopyColumns {
  readonly accountNumber: string | null;
  readonly accountName: string | null;
}

const recordedVat = (row: VatCopyColumns): RecordedVat | null =>
  row.vatCode !== null && row.vatLabel !== null && row.vatRateBasisPoints !== null
    ? { code: row.vatCode, label: row.vatLabel, rateBasisPoints: row.vatRateBasisPoints }
    : null;

const recordedAccount = (row: AccountCopyColumns) =>
  row.accountNumber !== null && row.accountName !== null ? { number: row.accountNumber, name: row.accountName } : null;

/**
 * The defaults a line is resolved against: the latest recorded account copy of each type (accounts only: there is no VAT
 * default, SO-2). They are returned AS RECORDED; whether an entry is still usable is the resolver's question, against a
 * snapshot.
 */
export async function loadRecordedDefaults(client: Client = db): Promise<RecordedDefaults> {
  const rows = await typeRows(client);
  const latestByType = new Map<ExpenseType, (typeof rows)[number]>();
  for (const row of rows) latestByType.set(row.type, row);

  const defaults: Partial<Record<ExpenseType, { account: { number: string; name: string } | null }>> = {};
  for (const [type, row] of latestByType) defaults[type] = { account: recordedAccount(row) };
  const byType: TypeDefaultsByType = defaults;
  return { defaults: byType };
}

const stateOfAccount = (snapshot: ReferenceSnapshot, number: string): ReferenceState => snapshot.lookupAccount(number).state;
const stateOfVat = (snapshot: ReferenceSnapshot, code: string): ReferenceState => snapshot.lookupVat(code).state;

const historyVat = (v: RecordedVat) => ({ code: v.code, label: v.label, ratePercent: basisPointsToPercent(v.rateBasisPoints) });

function foreignCurrencyState(
  rows: Awaited<ReturnType<typeof designationRows>>,
  snapshot: ReferenceSnapshot,
): ForeignCurrencyVatCodeState {
  const current = rows.length > 0 ? recordedVat(rows[rows.length - 1]!) : null;
  const state = current ? stateOfVat(snapshot, current.code) : null;
  return {
    foreignCurrencyVatCode: current
      ? { code: current.code, label: current.label, ratePercent: basisPointsToPercent(current.rateBasisPoints), state: state! }
      : null,
    foreignCurrencyVatCodeUsable: state === "active",
    foreignCurrencyVatCodeHistory: rows.map((row) => {
      const vat = recordedVat(row);
      return { vatCode: vat ? historyVat(vat) : null, at: row.createdAt.toISOString(), byEmail: row.createdByEmail };
    }),
  };
}

/** The foreign-currency VAT code state: the designation as recorded, its state, whether it is usable, its history. */
export async function loadForeignCurrencyVatCodeState(
  snapshot: ReferenceSnapshot,
  client: Client = db,
): Promise<ForeignCurrencyVatCodeState> {
  return foreignCurrencyState(await designationRows(client), snapshot);
}

function buildTypeRows(rows: Awaited<ReturnType<typeof typeRows>>, snapshot: ReferenceSnapshot): TypeDefaultRow[] {
  return EXPENSE_TYPES.map((type) => {
    const own = rows.filter((r) => r.type === type);
    const latest = own[own.length - 1];
    const account = latest ? recordedAccount(latest) : null;
    const vat = latest ? recordedVat(latest) : null;
    return {
      type,
      account: account && { ...account, state: stateOfAccount(snapshot, account.number) },
      vatCode: vat && {
        code: vat.code,
        label: vat.label,
        ratePercent: basisPointsToPercent(vat.rateBasisPoints),
        state: stateOfVat(snapshot, vat.code),
      },
      updatedAt: latest ? latest.createdAt.toISOString() : null,
      updatedByEmail: latest ? latest.createdByEmail : null,
      history: own.map((row) => {
        const rowAccount = recordedAccount(row);
        const rowVat = recordedVat(row);
        return {
          account: rowAccount,
          vatCode: rowVat && historyVat(rowVat),
          at: row.createdAt.toISOString(),
          byEmail: row.createdByEmail,
        };
      }),
    };
  });
}

/**
 * Everything `GET /accounting/expense-type-defaults` returns: always the twelve types, `null` where unset, each with
 * Accounting's present state of its entries. `snapshot` is `UNVERIFIED_SNAPSHOT` when Accounting could not be read, and
 * `accounting` says so (AC-6.9): the values are then exactly as recorded.
 */
export async function loadDefaultsView(snapshot: ReferenceSnapshot, client: Client = db): Promise<DefaultsResponse> {
  const rows = await typeRows(client);
  return {
    entity: DEFAULTS_ENTITY,
    accounting: snapshot.available ? "available" : "unavailable",
    ...foreignCurrencyState(await designationRows(client), snapshot),
    types: buildTypeRows(rows, snapshot),
  };
}

/** One type's row, as `loadDefaultsView` shows it. */
async function loadTypeRow(client: Client, type: ExpenseType, snapshot: ReferenceSnapshot): Promise<TypeDefaultRow> {
  return buildTypeRows(await typeRows(client), snapshot).find((row) => row.type === type)!;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export type RefusalCode =
  | "ledger_account_not_found"
  | "ledger_account_inactive"
  | "vat_code_not_found"
  | "vat_code_inactive";

export type WriteOutcome<T> =
  | { readonly kind: "recorded"; readonly value: T }
  | { readonly kind: "unchanged"; readonly value: T }
  | { readonly kind: "refused"; readonly code: RefusalCode; readonly detail: string };

type Refusal = { code: RefusalCode; detail: string };

/**
 * The refusals are generic English with no number, code, name or id in them: the person chose the entry and knows
 * which, and an echo of input is not needed (AC-6.10).
 */
export function accountRefusal(snapshot: ReferenceSnapshot, number: string): Refusal | null {
  const found = snapshot.lookupAccount(number);
  if (found.state === "active") return null;
  return found.state === "deactivated"
    ? { code: "ledger_account_inactive", detail: "That ledger account is deactivated in Accounting and cannot be chosen" }
    : { code: "ledger_account_not_found", detail: "That ledger account was not found in Accounting for WellD CH" };
}

export function vatRefusal(snapshot: ReferenceSnapshot, code: string): Refusal | null {
  const found = snapshot.lookupVat(code);
  if (found.state === "active") return null;
  return found.state === "deactivated"
    ? { code: "vat_code_inactive", detail: "That VAT code is deactivated in Accounting and cannot be chosen" }
    : { code: "vat_code_not_found", detail: "That VAT code was not found in Accounting for WellD CH" };
}

const strictlyAfter = (previous: Date | undefined): Date => {
  const now = Date.now();
  return new Date(previous !== undefined && previous.getTime() >= now ? previous.getTime() + 1 : now);
};

/**
 * Sets the default account and VAT code of one expense type (AC-4.4, AC-4.7). `snapshot` is Accounting as the route read
 * it for this operation, and must be available: the route answers 503 before calling this otherwise.
 */
export async function setTypeDefault(
  type: ExpenseType,
  input: { accountNumber: string | null; vatCode: string | null },
  actor: Actor,
  snapshot: ReferenceSnapshot,
): Promise<WriteOutcome<TypeDefaultRow>> {
  // Validated first, against the live read: nothing is locked while it is decided.
  if (input.accountNumber !== null) {
    const refusal = accountRefusal(snapshot, input.accountNumber);
    if (refusal) return { kind: "refused", ...refusal };
  }
  if (input.vatCode !== null) {
    const refusal = vatRefusal(snapshot, input.vatCode);
    if (refusal) return { kind: "refused", ...refusal };
  }
  // What is copied is Accounting's entry as it is now (the snapshot just read), not the caller's text.
  const account = input.accountNumber === null ? null : snapshot.lookupAccount(input.accountNumber);
  const vat = input.vatCode === null ? null : snapshot.lookupVat(input.vatCode);
  const accountCopy = account && account.state === "active" ? { number: account.number, name: account.name } : null;
  const vatCopy = vat && vat.state === "active" ? { code: vat.code, label: vat.label, rateBasisPoints: vat.rateBasisPoints } : null;

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`expense-type-accounting-default:${DEFAULTS_ENTITY}:${type}`}))`;
    const rows = (await tx.expenseTypeAccountingDefault.findMany({ where: { entity: DEFAULTS_ENTITY, type } })).sort(compareRows);
    const latest = rows[rows.length - 1];
    const sameAccount = latest ? sameAccountCopy(recordedAccount(latest), accountCopy) : accountCopy === null;
    const sameVat = latest ? sameVatCopy(recordedVat(latest), vatCopy) : vatCopy === null;
    if (sameAccount && sameVat) {
      return { kind: "unchanged", value: await loadTypeRow(tx, type, snapshot) } as const;
    }
    await tx.expenseTypeAccountingDefault.create({
      data: {
        entity: DEFAULTS_ENTITY,
        type,
        accountNumber: accountCopy?.number ?? null,
        accountName: accountCopy?.name ?? null,
        vatCode: vatCopy?.code ?? null,
        vatLabel: vatCopy?.label ?? null,
        vatRateBasisPoints: vatCopy?.rateBasisPoints ?? null,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
        createdAt: strictlyAfter(latest?.createdAt),
      },
    });
    return { kind: "recorded", value: await loadTypeRow(tx, type, snapshot) } as const;
  });
}

/** Designates (or clears, with `null`) the foreign-currency VAT code (AC-4.4, AC-4.7). */
export async function setForeignCurrencyVatCode(
  vatCode: string | null,
  actor: Actor,
  snapshot: ReferenceSnapshot,
): Promise<WriteOutcome<ForeignCurrencyVatCodeState>> {
  if (vatCode !== null) {
    const refusal = vatRefusal(snapshot, vatCode);
    if (refusal) return { kind: "refused", ...refusal };
  }
  const vat = vatCode === null ? null : snapshot.lookupVat(vatCode);
  const vatCopy = vat && vat.state === "active" ? { code: vat.code, label: vat.label, rateBasisPoints: vat.rateBasisPoints } : null;

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`foreign-currency-vat-designation:${DEFAULTS_ENTITY}`}))`;
    const rows = await designationRows(tx);
    const latest = rows[rows.length - 1];
    if (latest ? sameVatCopy(recordedVat(latest), vatCopy) : vatCopy === null) {
      return { kind: "unchanged", value: foreignCurrencyState(rows, snapshot) } as const;
    }
    await tx.foreignCurrencyVatDesignation.create({
      data: {
        entity: DEFAULTS_ENTITY,
        vatCode: vatCopy?.code ?? null,
        vatLabel: vatCopy?.label ?? null,
        vatRateBasisPoints: vatCopy?.rateBasisPoints ?? null,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
        createdAt: strictlyAfter(latest?.createdAt),
      },
    });
    return { kind: "recorded", value: await loadForeignCurrencyVatCodeState(snapshot, tx) } as const;
  });
}

const sameAccountCopy = (a: { number: string; name: string } | null, b: { number: string; name: string } | null) =>
  a === null || b === null ? a === b : a.number === b.number && a.name === b.name;

const sameVatCopy = (a: RecordedVat | null, b: RecordedVat | null) =>
  a === null || b === null ? a === b : a.code === b.code && a.label === b.label && a.rateBasisPoints === b.rateBasisPoints;

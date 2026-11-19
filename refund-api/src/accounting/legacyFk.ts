/**
 * LEGACY, TEMPORARY (T18, specs/20261119-accounting): the foreign-key world of 20261118, kept ONLY for the code that has
 * not moved to copies yet.
 *
 * T18 moves the resolver, the defaults and the review/approval code to copies by natural key (ADR 20261119-accounting-
 * reference-data-belongs-to-accounting-api-...). Three consumers are rewritten by later tasks and meanwhile still read and
 * write the old catalog through the old FK columns, which stay until T24:
 *   - `export.repo.ts` (T21): reads the frozen classification of a line stored-only;
 *   - `scripts/accounting-release.ts` (T22): `classifyAndNumberFk` and the old defaults snapshot;
 *   - `classification.repo.ts` (T19) and `review/decide.repo.ts` (T20) until those two tasks land.
 * Each task that switches a consumer deletes what it no longer needs here; T23 and T22 empty this file, and it is deleted
 * with the old catalog. Nothing new may import from it.
 */

import type { Currency, Entity, ExpenseType } from "../lib/generated/prisma/enums";
import type { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";
import { basisPointsToPercent, CATALOG_ENTITY, loadActiveFlags } from "./catalog.repo";

type Client = Prisma.TransactionClient;


/** A ledger account as the resolver needs it: the entry and whether it is active now. */
export interface AccountRefFk {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly active: boolean;
}

/** A VAT code as the resolver needs it: the entry and whether it is active now. */
export interface VatCodeRefFk {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly rateBasisPoints: number;
  readonly active: boolean;
}

/** The line, with the classification stored on it (null = follow the live default). */
export interface ClassifiableLineFk {
  readonly entity: Entity;
  readonly currency: Currency;
  readonly type: ExpenseType;
  /** `rejectionReason` is set: a rejected line has no classification. */
  readonly rejected: boolean;
  readonly ledgerAccount: AccountRefFk | null;
  readonly ledgerAccountIsDefault: boolean | null;
  readonly vatCode: VatCodeRefFk | null;
  readonly vatCodeIsDefault: boolean | null;
}

/** The current default of one expense type for WellD CH (either half may be unset). */
export interface TypeDefaultsFk {
  readonly account: AccountRefFk | null;
  readonly vatCode: VatCodeRefFk | null;
}

/** The type defaults, keyed by expense type; a type with no entry has no default. */
export type TypeDefaultsByTypeFk = Readonly<Partial<Record<ExpenseType, TypeDefaultsFk>>>;

export type MissingPartFk = "account" | "vatCode";

/** The live defaults a classification is resolved against, each entry with its current `active`. */
export interface DefaultsSnapshotFk {
  readonly defaults: TypeDefaultsByTypeFk;
  readonly foreignCurrencyVatCode: VatCodeRefFk | null;
}

export interface ClassificationFk {
  readonly account: AccountRefFk | null;
  readonly accountIsDefault: boolean;
  readonly vatCode: VatCodeRefFk | null;
  readonly vatCodeIsDefault: boolean;
  readonly missing: readonly MissingPartFk[];
}

/**
 * @param line the line with its stored classification
 * @param defaults the current type defaults of WellD CH, each entry with its `active`
 * @param foreignCurrencyVatCode the designated foreign-currency VAT code with its
 *   `active`, or `null` when none is designated (never set, or cleared)
 */
export function resolveClassificationFk(
  line: ClassifiableLineFk,
  defaults: TypeDefaultsByTypeFk,
  foreignCurrencyVatCode: VatCodeRefFk | null,
): ClassificationFk | null {
  if (line.entity !== "welld_ch" || line.rejected) return null;

  const typeDefaults = defaults[line.type];

  // ── Account ─────────────────────────────────────────────────────────────
  let account: AccountRefFk | null;
  let accountIsDefault: boolean;
  if (line.ledgerAccount !== null) {
    account = line.ledgerAccount;
    accountIsDefault = line.ledgerAccountIsDefault === true;
  } else {
    const candidate = typeDefaults?.account ?? null;
    account = candidate !== null && candidate.active ? candidate : null;
    accountIsDefault = account !== null;
  }

  // ── VAT code ────────────────────────────────────────────────────────────
  let vatCode: VatCodeRefFk | null;
  let vatCodeIsDefault: boolean;
  if (line.vatCode !== null) {
    vatCode = line.vatCode;
    vatCodeIsDefault = line.vatCodeIsDefault === true;
  } else {
    const candidate = line.currency === "CHF" ? (typeDefaults?.vatCode ?? null) : foreignCurrencyVatCode;
    vatCode = candidate !== null && candidate.active ? candidate : null;
    vatCodeIsDefault = vatCode !== null;
  }

  const missing: MissingPartFk[] = [];
  if (account === null) missing.push("account");
  if (vatCode === null) missing.push("vatCode");

  return { account, accountIsDefault, vatCode, vatCodeIsDefault, missing };
}

// ─── The line, as the old classification select reads it ────────────────────

export interface FkLineRow {
  readonly entity: Entity;
  readonly currency: Currency;
  readonly type: ExpenseType;
  readonly rejectionReason: string | null;
  readonly ledgerAccountIsDefault: boolean | null;
  readonly vatCodeIsDefault: boolean | null;
  readonly ledgerAccount: { readonly id: string; readonly number: string; readonly name: string } | null;
  readonly vatCode: { readonly id: string; readonly code: string; readonly label: string; readonly rateBasisPoints: number } | null;
}

/** What `resolveClassificationFk` needs of a line: its facts, and what is stored on it with the entry's current `active`. */
export function classifiableInputFk(
  line: FkLineRow,
  accountFlags: ReadonlyMap<string, boolean>,
  vatFlags: ReadonlyMap<string, boolean>,
): ClassifiableLineFk {
  return {
    entity: line.entity,
    currency: line.currency,
    type: line.type,
    rejected: line.rejectionReason !== null,
    ledgerAccount: line.ledgerAccount
      ? { ...line.ledgerAccount, active: accountFlags.get(line.ledgerAccount.id) ?? true }
      : null,
    ledgerAccountIsDefault: line.ledgerAccountIsDefault,
    vatCode: line.vatCode ? { ...line.vatCode, active: vatFlags.get(line.vatCode.id) ?? true } : null,
    vatCodeIsDefault: line.vatCodeIsDefault,
  };
}


// ─── The old defaults store ──────────────────────────────────────────────────

/** The `refund_setting` key holding the foreign-currency VAT code designation (a VAT code id, or `null` when cleared). */
export const FOREIGN_CURRENCY_VAT_CODE_KEY = "accounting.welld_ch.foreign-currency-vat-code";


interface AccountInfo { id: string; number: string; name: string }
interface VatInfo { id: string; code: string; label: string; rateBasisPoints: number }

const compareRows = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function loadAccounts(client: Client, ids: readonly string[]): Promise<Map<string, AccountRefFk>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await client.ledgerAccount.findMany({ where: { id: { in: unique } }, select: { id: true, number: true, name: true } });
  const flags = await loadActiveFlags(client, "ledger_account", unique);
  return new Map(rows.map((r: AccountInfo) => [r.id, { ...r, active: flags.get(r.id) ?? true }]));
}

async function loadVatCodes(client: Client, ids: readonly string[]): Promise<Map<string, VatCodeRefFk>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await client.vatCode.findMany({
    where: { id: { in: unique } },
    select: { id: true, code: true, label: true, rateBasisPoints: true },
  });
  const flags = await loadActiveFlags(client, "vat_code", unique);
  return new Map(rows.map((r: VatInfo) => [r.id, { ...r, active: flags.get(r.id) ?? true }]));
}

/** The designation rows, oldest first. */
async function designationRows(client: Client) {
  const rows = await client.refundSetting.findMany({
    where: { key: FOREIGN_CURRENCY_VAT_CODE_KEY },
    select: { id: true, value: true, createdAt: true, createdByEmail: true },
  });
  return rows.sort(compareRows);
}

/** The latest default row of each type, folded from the full history (oldest first). */
async function typeRows(client: Client) {
  const rows = await client.expenseTypeDefault.findMany({ where: { entity: CATALOG_ENTITY } });
  return rows.sort(compareRows);
}

/**
 * The defaults a line is resolved against: the type defaults and the
 * foreign-currency VAT code, each with its current `active` flag. A default or a
 * designation that points at an inactive entry is returned AS IS (with
 * `active: false`); it is `resolveClassification` that treats it as "none".
 */
export async function loadDefaultsSnapshotFk(client: Client = db): Promise<DefaultsSnapshotFk> {
  const rows = await typeRows(client);
  const designations = await designationRows(client);
  const latestByType = new Map<ExpenseType, (typeof rows)[number]>();
  for (const row of rows) latestByType.set(row.type, row);
  const designatedId = designations.length > 0 ? designations[designations.length - 1]!.value : null;

  const accounts = await loadAccounts(client, [...latestByType.values()].flatMap((r) => (r.ledgerAccountId ? [r.ledgerAccountId] : [])));
  const vats = await loadVatCodes(client, [
    ...[...latestByType.values()].flatMap((r) => (r.vatCodeId ? [r.vatCodeId] : [])),
    ...(designatedId ? [designatedId] : []),
  ]);

  const defaults: Partial<Record<ExpenseType, TypeDefaultsFk>> = {};
  for (const [type, row] of latestByType) {
    defaults[type] = {
      account: row.ledgerAccountId ? (accounts.get(row.ledgerAccountId) ?? null) : null,
      vatCode: row.vatCodeId ? (vats.get(row.vatCodeId) ?? null) : null,
    };
  }
  const defaultsByType: TypeDefaultsByTypeFk = defaults;
  return { defaults: defaultsByType, foreignCurrencyVatCode: designatedId ? (vats.get(designatedId) ?? null) : null };
}


const vatView = (v: VatCodeRefFk) => ({
  id: v.id,
  code: v.code,
  label: v.label,
  ratePercent: basisPointsToPercent(v.rateBasisPoints),
  active: v.active,
});

/** The old designation state (the release script's test reads it): the designation, whether it is usable, its history. */
export async function loadForeignCurrencyVatCodeStateFk(client: Client = db) {
  const rows = await designationRows(client);
  const vats = await loadVatCodes(client, rows.flatMap((r) => (r.value ? [r.value] : [])));
  const currentId = rows.length > 0 ? rows[rows.length - 1]!.value : null;
  const current = currentId ? (vats.get(currentId) ?? null) : null;
  return {
    foreignCurrencyVatCode: current ? vatView(current) : null,
    foreignCurrencyVatCodeUsable: current !== null && current.active,
    foreignCurrencyVatCodeHistory: rows.map((row) => ({
      vatCode: row.value ? { id: row.value, code: vats.get(row.value)?.code ?? null } : null,
      at: row.createdAt.toISOString(),
      byEmail: row.createdByEmail,
    })),
  };
}

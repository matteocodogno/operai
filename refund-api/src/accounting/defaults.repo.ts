/**
 * Data access for the default classification of WellD CH (T7, specs/20261118-
 * refund-accounting-export; AC-1.9, AC-1.10, AC-2.1, AC-2.2, AC-2.4 to AC-2.8;
 * ADR 20260722-refund-settings-append-only-self-auditing-store, plan "Foreign-
 * currency VAT code rules").
 *
 * Two append-only stores, one derivation rule: the CURRENT value is the LATEST
 * row, and no row is ever updated.
 * - `expense_type_default`: one row per change of an expense type's default
 *   account and VAT code (`null` = no default for that half).
 * - the `refund_setting` key {@link FOREIGN_CURRENCY_VAT_CODE_KEY}: one row per
 *   designation of the VAT code applied to every non-CHF line. The key is NOT in
 *   the generic `/settings/{key}` registry, so this module is its only writer
 *   apart from the release script's seed (`system:accounting-seed`).
 *
 * Only an ACTIVE catalog entry can be chosen (AC-2.4, AC-2.6); an entry
 * deactivated afterwards stays recorded and simply counts as "no default" when
 * a line is resolved (`classification.ts`, G3, AC-2.7), and comes back by itself
 * on reactivation (AC-1.9, AC-1.10).
 *
 * `loadDefaultsSnapshot(tx)` is the one read the approval freeze, the release
 * script, the accounting view and the export all resolve a line against.
 *
 * Writes lock the (entity, type) or the key with a transaction-scoped advisory
 * lock and stamp each new row strictly after the previous one, so "latest" is
 * the latest decision however the clocks of two requests compare. A same-value
 * write is suppressed (no row).
 */

import type { Prisma } from "../lib/generated/prisma/client";
import { ExpenseType } from "../lib/generated/prisma/enums";
import { db } from "../lib/db";
import { basisPointsToPercent, CATALOG_ENTITY, isActiveFromStatus, loadActiveFlags, type Actor } from "./catalog.repo";
import type { AccountRef, TypeDefaults, TypeDefaultsByType, VatCodeRef } from "./classification";
import type {
  DefaultsResponse,
  ForeignCurrencyVatCodeState,
  TypeDefaultRow,
} from "./defaults.schemas";
import type { DefaultsSnapshot } from "./numbering.repo";

type Client = Prisma.TransactionClient;

/** The `refund_setting` key holding the foreign-currency VAT code designation (a VAT code id, or `null` when cleared). */
export const FOREIGN_CURRENCY_VAT_CODE_KEY = "accounting.welld_ch.foreign-currency-vat-code";

/** The twelve expense types, in enum order. */
export const EXPENSE_TYPES: readonly ExpenseType[] = Object.values(ExpenseType);

export const isExpenseType = (value: string): value is ExpenseType =>
  (EXPENSE_TYPES as readonly string[]).includes(value);

// ─── Reading ─────────────────────────────────────────────────────────────────

interface AccountInfo { id: string; number: string; name: string }
interface VatInfo { id: string; code: string; label: string; rateBasisPoints: number }

const compareRows = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function loadAccounts(client: Client, ids: readonly string[]): Promise<Map<string, AccountRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await client.ledgerAccount.findMany({ where: { id: { in: unique } }, select: { id: true, number: true, name: true } });
  const flags = await loadActiveFlags(client, "ledger_account", unique);
  return new Map(rows.map((r: AccountInfo) => [r.id, { ...r, active: flags.get(r.id) ?? true }]));
}

async function loadVatCodes(client: Client, ids: readonly string[]): Promise<Map<string, VatCodeRef>> {
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
export async function loadDefaultsSnapshot(client: Client = db): Promise<DefaultsSnapshot> {
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

  const defaults: Partial<Record<ExpenseType, TypeDefaults>> = {};
  for (const [type, row] of latestByType) {
    defaults[type] = {
      account: row.ledgerAccountId ? (accounts.get(row.ledgerAccountId) ?? null) : null,
      vatCode: row.vatCodeId ? (vats.get(row.vatCodeId) ?? null) : null,
    };
  }
  const defaultsByType: TypeDefaultsByType = defaults;
  return { defaults: defaultsByType, foreignCurrencyVatCode: designatedId ? (vats.get(designatedId) ?? null) : null };
}

const vatView = (v: VatCodeRef) => ({
  id: v.id,
  code: v.code,
  label: v.label,
  ratePercent: basisPointsToPercent(v.rateBasisPoints),
  active: v.active,
});

/** The foreign-currency VAT code state: the designation, whether it is usable, and its history (AC-2.5, AC-2.7). */
export async function loadForeignCurrencyVatCodeState(client: Client = db): Promise<ForeignCurrencyVatCodeState> {
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

/** Everything `GET /accounting/expense-type-defaults` returns: always the twelve types, `null` where unset. */
export async function loadDefaultsView(client: Client = db): Promise<DefaultsResponse> {
  const rows = await typeRows(client);
  const accounts = await loadAccounts(client, rows.flatMap((r) => (r.ledgerAccountId ? [r.ledgerAccountId] : [])));
  const vats = await loadVatCodes(client, rows.flatMap((r) => (r.vatCodeId ? [r.vatCodeId] : [])));

  const types: TypeDefaultRow[] = EXPENSE_TYPES.map((type) => {
    const own = rows.filter((r) => r.type === type);
    const latest = own[own.length - 1];
    const accountOf = (id: string | null) => (id ? (accounts.get(id) ?? null) : null);
    const vatOf = (id: string | null) => (id ? (vats.get(id) ?? null) : null);
    const account = accountOf(latest?.ledgerAccountId ?? null);
    const vatCode = vatOf(latest?.vatCodeId ?? null);
    return {
      type,
      account: account && { id: account.id, number: account.number, name: account.name, active: account.active },
      vatCode: vatCode && vatView(vatCode),
      updatedAt: latest ? latest.createdAt.toISOString() : null,
      updatedByEmail: latest ? latest.createdByEmail : null,
      history: own.map((row) => {
        const a = accountOf(row.ledgerAccountId);
        const v = vatOf(row.vatCodeId);
        return {
          account: a && { id: a.id, number: a.number, name: a.name },
          vatCode: v && { id: v.id, code: v.code, label: v.label, ratePercent: basisPointsToPercent(v.rateBasisPoints) },
          at: row.createdAt.toISOString(),
          byEmail: row.createdByEmail,
        };
      }),
    };
  });
  return { entity: "welld_ch", ...(await loadForeignCurrencyVatCodeState(client)), types };
}

/** One type's row, as `loadDefaultsView` shows it. */
export async function loadTypeRow(client: Client, type: ExpenseType): Promise<TypeDefaultRow> {
  const view = await loadDefaultsView(client);
  return view.types.find((row) => row.type === type)!;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export type RefusalCode =
  | "unknown_ledger_account"
  | "ledger_account_inactive"
  | "unknown_vat_code"
  | "vat_code_inactive";

export type WriteOutcome<T> =
  | { readonly kind: "recorded"; readonly value: T }
  | { readonly kind: "unchanged"; readonly value: T }
  | { readonly kind: "refused"; readonly code: RefusalCode; readonly detail: string };

async function checkAccount(tx: Client, id: string): Promise<{ code: RefusalCode; detail: string } | null> {
  const found = await tx.ledgerAccount.findFirst({ where: { id, entity: CATALOG_ENTITY }, select: { id: true, number: true } });
  if (!found) return { code: "unknown_ledger_account", detail: "That ledger account does not exist" };
  const status = await tx.accountingCatalogStatus.findMany({ where: { ledgerAccountId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { active: true } });
  return isActiveFromStatus(status)
    ? null
    : { code: "ledger_account_inactive", detail: `Account ${found.number} is deactivated and cannot be chosen` };
}

async function checkVatCode(tx: Client, id: string): Promise<{ code: RefusalCode; detail: string } | null> {
  const found = await tx.vatCode.findFirst({ where: { id, entity: CATALOG_ENTITY }, select: { id: true, code: true } });
  if (!found) return { code: "unknown_vat_code", detail: "That VAT code does not exist" };
  const status = await tx.accountingCatalogStatus.findMany({ where: { vatCodeId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { active: true } });
  return isActiveFromStatus(status)
    ? null
    : { code: "vat_code_inactive", detail: `VAT code ${found.code} is deactivated and cannot be chosen` };
}

const strictlyAfter = (previous: Date | undefined): Date => {
  const now = Date.now();
  return new Date(previous !== undefined && previous.getTime() >= now ? previous.getTime() + 1 : now);
};

/** Sets the default account and VAT code of one expense type (AC-2.1, AC-2.4). */
export async function setTypeDefault(
  type: ExpenseType,
  input: { ledgerAccountId: string | null; vatCodeId: string | null },
  actor: Actor,
): Promise<WriteOutcome<TypeDefaultRow>> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`expense-type-default:${CATALOG_ENTITY}:${type}`}))`;
    if (input.ledgerAccountId !== null) {
      const refusal = await checkAccount(tx, input.ledgerAccountId);
      if (refusal) return { kind: "refused", ...refusal } as const;
    }
    if (input.vatCodeId !== null) {
      const refusal = await checkVatCode(tx, input.vatCodeId);
      if (refusal) return { kind: "refused", ...refusal } as const;
    }
    const rows = (await tx.expenseTypeDefault.findMany({ where: { entity: CATALOG_ENTITY, type } })).sort(compareRows);
    const latest = rows[rows.length - 1];
    if ((latest?.ledgerAccountId ?? null) === input.ledgerAccountId && (latest?.vatCodeId ?? null) === input.vatCodeId) {
      return { kind: "unchanged", value: await loadTypeRow(tx, type) } as const;
    }
    await tx.expenseTypeDefault.create({
      data: {
        entity: CATALOG_ENTITY,
        type,
        ledgerAccountId: input.ledgerAccountId,
        vatCodeId: input.vatCodeId,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
        createdAt: strictlyAfter(latest?.createdAt),
      },
    });
    return { kind: "recorded", value: await loadTypeRow(tx, type) } as const;
  });
}

/** Designates (or clears, with `null`) the foreign-currency VAT code (AC-2.5, AC-2.6). */
export async function setForeignCurrencyVatCode(
  vatCodeId: string | null,
  actor: Actor,
): Promise<WriteOutcome<ForeignCurrencyVatCodeState>> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FOREIGN_CURRENCY_VAT_CODE_KEY}))`;
    if (vatCodeId !== null) {
      const refusal = await checkVatCode(tx, vatCodeId);
      if (refusal) return { kind: "refused", ...refusal } as const;
    }
    const rows = await designationRows(tx);
    const latest = rows[rows.length - 1];
    if ((latest?.value ?? null) === vatCodeId) {
      return { kind: "unchanged", value: await loadForeignCurrencyVatCodeState(tx) } as const;
    }
    await tx.refundSetting.create({
      data: {
        key: FOREIGN_CURRENCY_VAT_CODE_KEY,
        value: vatCodeId,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
        createdAt: strictlyAfter(latest?.createdAt),
      },
    });
    return { kind: "recorded", value: await loadForeignCurrencyVatCodeState(tx) } as const;
  });
}

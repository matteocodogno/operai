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
import { writeAuditEntry } from "../requests/audit";
import { formatReceiptNumber, initials } from "./receiptNumber";
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

// ─── The old numbering (classifyAndNumber on the foreign keys), kept for the release script until T22 ──────────

export type NumberingCauseFk = "approval" | "release";

export interface ActorFk {
  readonly userId: string;
  readonly email: string;
}

export interface ClassifyAndNumberInputFk {
  /** Every request must belong to this employee: the counters are per employee. */
  readonly owner: { readonly userId: string; readonly name: string | null; readonly email: string };
  /** The requests whose unnumbered, non-rejected lines are to be handled (one for an approval, several for a release). */
  readonly requestIds: readonly string[];
  readonly cause: NumberingCauseFk;
  readonly actor: ActorFk;
  readonly snapshot: DefaultsSnapshotFk;
  /** Only lines of these entities are handled; the release script passes `["welld_ch"]` (AC-7.3). Default: all. */
  readonly entities?: readonly Entity[];
}

export interface MissingLineFk {
  readonly lineId: string;
  readonly requestId: string;
  /** `YYYY-MM-DD` */
  readonly date: string;
  readonly type: ExpenseType;
  readonly missing: readonly MissingPartFk[];
}

export interface NumberedLineFk {
  readonly lineId: string;
  readonly requestId: string;
  readonly entity: Entity;
  readonly receiptNumber: string;
  readonly year: number;
  readonly seq: number;
  /** `null` for a WellD Italia line. `missing` is empty when the line is fully classified. */
  readonly missing: readonly MissingPartFk[] | null;
}

export type ClassifyAndNumberResultFk =
  | { readonly ok: true; readonly lines: readonly NumberedLineFk[] }
  /** `cause: "approval"` only: nothing was written. */
  | { readonly ok: false; readonly reason: "classification_missing"; readonly missing: readonly MissingLineFk[] };

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const accountSummary = (a: Pick<AccountRefFk, "id" | "number"> | null) => (a ? { id: a.id, number: a.number } : null);
const vatSummary = (v: Pick<VatCodeRefFk, "id" | "code" | "rateBasisPoints"> | null) =>
  v ? { id: v.id, code: v.code, rateBasisPoints: v.rateBasisPoints } : null;

export async function classifyAndNumberFk(
  tx: Prisma.TransactionClient,
  input: ClassifyAndNumberInputFk,
): Promise<ClassifyAndNumberResultFk> {
  if (input.requestIds.length === 0) return { ok: true, lines: [] };

  // ── 1. Candidates, locked ────────────────────────────────────────────────
  const candidates = await tx.refundLine.findMany({
    where: {
      requestId: { in: [...input.requestIds] },
      rejectionReason: null,
      receiptNumber: null,
      ...(input.entities ? { entity: { in: [...input.entities] } } : {}),
    },
    select: { id: true },
  });
  if (candidates.length === 0) return { ok: true, lines: [] };
  const lockedIds = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "refund_line" WHERE "id" = ANY(${candidates.map((l) => l.id)}::text[]) ORDER BY "id" FOR UPDATE`
  ).map((row) => row.id);

  const lines = await tx.refundLine.findMany({
    where: { id: { in: lockedIds }, rejectionReason: null, receiptNumber: null },
    select: {
      id: true,
      requestId: true,
      date: true,
      type: true,
      entity: true,
      currency: true,
      createdAt: true,
      ledgerAccountId: true,
      ledgerAccountIsDefault: true,
      vatCodeId: true,
      vatCodeIsDefault: true,
      ledgerAccount: { select: { id: true, number: true, name: true } },
      vatCode: { select: { id: true, code: true, label: true, rateBasisPoints: true } },
    },
  });
  lines.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (lines.length === 0) return { ok: true, lines: [] };

  // ── 2. Resolve ───────────────────────────────────────────────────────────
  const accountFlags = await loadActiveFlags(
    tx,
    "ledger_account",
    lines.flatMap((l) => (l.ledgerAccountId ? [l.ledgerAccountId] : [])),
  );
  const vatFlags = await loadActiveFlags(
    tx,
    "vat_code",
    lines.flatMap((l) => (l.vatCodeId ? [l.vatCodeId] : [])),
  );

  const resolved = new Map<string, ClassificationFk | null>();
  const missingLines: MissingLineFk[] = [];
  for (const line of lines) {
    const classification = resolveClassificationFk(
      {
        entity: line.entity,
        currency: line.currency,
        type: line.type,
        rejected: false,
        ledgerAccount: line.ledgerAccount
          ? { ...line.ledgerAccount, active: accountFlags.get(line.ledgerAccount.id) ?? true }
          : null,
        ledgerAccountIsDefault: line.ledgerAccountIsDefault,
        vatCode: line.vatCode ? { ...line.vatCode, active: vatFlags.get(line.vatCode.id) ?? true } : null,
        vatCodeIsDefault: line.vatCodeIsDefault,
      },
      input.snapshot.defaults,
      input.snapshot.foreignCurrencyVatCode,
    );
    resolved.set(line.id, classification);
    if (classification !== null && classification.missing.length > 0) {
      missingLines.push({
        lineId: line.id,
        requestId: line.requestId,
        date: isoDate(line.date),
        type: line.type,
        missing: classification.missing,
      });
    }
  }
  if (input.cause === "approval" && missingLines.length > 0) {
    return { ok: false, reason: "classification_missing", missing: missingLines };
  }

  // ── 3. Counters, years ascending, one upsert each ────────────────────────
  const yearOf = (line: { date: Date }) => line.date.getUTCFullYear();
  const perYear = new Map<number, number>();
  for (const line of lines) perYear.set(yearOf(line), (perYear.get(yearOf(line)) ?? 0) + 1);
  const nextSeq = new Map<number, number>();
  for (const year of [...perYear.keys()].sort((a, b) => a - b)) {
    const count = perYear.get(year)!;
    const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO "receipt_counter" ("ownerUserId", "year", "lastSeq", "startAfter", "updatedAt")
      VALUES (${input.owner.userId}, ${year}::int, ${count}::int, 0, now())
      ON CONFLICT ("ownerUserId", "year") DO UPDATE
        SET "lastSeq" = "receipt_counter"."lastSeq" + ${count}::int, "updatedAt" = now()
      RETURNING "lastSeq"`;
    const last = rows[0]?.lastSeq;
    if (typeof last !== "number") throw new Error("receipt_counter upsert returned no row");
    nextSeq.set(year, last - count + 1);
  }

  // ── 4 + 5. One UPDATE per line, then the audit rows ──────────────────────
  const initialsOfOwner = initials(input.owner.name, input.owner.email);
  const numberedAt = new Date();
  const out: NumberedLineFk[] = [];
  for (const line of lines) {
    const year = yearOf(line);
    const seq = nextSeq.get(year)!;
    nextSeq.set(year, seq + 1);
    const receiptNumber = formatReceiptNumber(initialsOfOwner, year, seq);
    const classification = resolved.get(line.id) ?? null;

    await tx.refundLine.update({
      where: { id: line.id },
      data: {
        receiptNumber,
        receiptOwnerUserId: input.owner.userId,
        receiptYear: year,
        receiptSeq: seq,
        numberedAt,
        ...(classification
          ? {
              ledgerAccountId: classification.account?.id ?? null,
              ledgerAccountIsDefault: classification.account ? classification.accountIsDefault : null,
              vatCodeId: classification.vatCode?.id ?? null,
              vatCodeIsDefault: classification.vatCode ? classification.vatCodeIsDefault : null,
            }
          : {}),
      },
    });

    if (classification) {
      await writeAuditEntry(tx, {
        requestId: line.requestId,
        lineId: line.id,
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        action: "line_classified",
        detail: {
          cause: input.cause,
          account: {
            from: accountSummary(line.ledgerAccount),
            to: accountSummary(classification.account),
            fromDefault: line.ledgerAccount === null ? true : line.ledgerAccountIsDefault === true,
            toDefault: classification.accountIsDefault,
          },
          vatCode: {
            from: vatSummary(line.vatCode),
            to: vatSummary(classification.vatCode),
            fromDefault: line.vatCode === null ? true : line.vatCodeIsDefault === true,
            toDefault: classification.vatCodeIsDefault,
          },
        },
      });
    }
    await writeAuditEntry(tx, {
      requestId: line.requestId,
      lineId: line.id,
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      action: "receipt_number_assigned",
      detail: { cause: input.cause, receiptNumber, year, seq },
    });

    out.push({
      lineId: line.id,
      requestId: line.requestId,
      entity: line.entity,
      receiptNumber,
      year,
      seq,
      missing: classification ? classification.missing : null,
    });
  }
  return { ok: true, lines: out };
}

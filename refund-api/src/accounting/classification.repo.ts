/**
 * Data access and view building of the line-classification surface (T13,
 * specs/20261118-refund-accounting-export; AC-1.3, AC-1.6, AC-2.7, AC-3.1,
 * AC-3.2, AC-3.8, AC-3.9, AC-3.10, AC-4.6; ADR 20261118-accounting-
 * classification-is-live-until-approval-then-frozen-and-changing-it-afterwards-
 * needs-request-reclassify-and-is-refused-by-the-database-once-paid, ADR
 * 20261118-chf-and-vat-amounts-are-derived-on-read-...).
 *
 * What a line shows, by the state of its request
 * - `submitted` (state `review`): LIVE. A line with nothing stored follows the
 *   current default of its type, the foreign-currency VAT code for a non-CHF
 *   line, through `resolveClassification`, the same function the approve freeze
 *   and the release use. An override stored on the line wins and is no longer
 *   marked as a default.
 * - `approved` or `paid` (states `post_approval`, `locked`): FROZEN. Only what is
 *   STORED on the line is shown; a defaults change never moves it (AC-2.3,
 *   AC-3.5). A half the approval or the release could not resolve (AC-7.2) is
 *   shown as missing, and stays missing until accounting sets it (AC-3.6): the
 *   live defaults are NOT consulted for an approved line, otherwise a default
 *   added next month would silently classify a booked line. Anything that
 *   decides "is this line classified" for an approved line (the export blockers,
 *   T18) must read it the same way: `resolveClassification` with NO defaults.
 * - `draft`, `rejected` (state `none`): nothing is classified, nothing is shown.
 *
 * CHF and VAT amounts are derived on read from the rate in effect and the VAT
 * code's basis points (`amounts.ts`), never stored, never computed by a browser.
 * This view never asks the federal source for a rate: a missing rate is
 * reported as `rateMissing`, and only the export fetches on demand.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { Currency } from "../lib/generated/prisma/enums";
import { dateToMonth, type RateCurrency, type RateEntry } from "../fx/fx.repo";
import { formatRate } from "../fx/fx.routes";
import { fxService, rateKey } from "../fx/fx.service";
import { chfCents, vatCents } from "./amounts";
import { basisPointsToPercent, listLedgerAccounts, listVatCodes, loadActiveFlags } from "./catalog.repo";
import { resolveClassification, type TypeDefaultsByType } from "./classification";
import type {
  AccountingLine,
  AccountingOptions,
  ClassificationState,
  RequestAccounting,
} from "./classification.schemas";
import { loadDefaultsSnapshot } from "./defaults.repo";

type Client = Prisma.TransactionClient;

// ─── Reading the request ─────────────────────────────────────────────────────

const lineSelect = {
  id: true,
  date: true,
  type: true,
  entity: true,
  currency: true,
  requestedAmountCents: true,
  approvedTotalCents: true,
  rejectionReason: true,
  receiptNumber: true,
  createdAt: true,
  ledgerAccountId: true,
  ledgerAccountIsDefault: true,
  vatCodeId: true,
  vatCodeIsDefault: true,
  ledgerAccount: { select: { id: true, number: true, name: true } },
  vatCode: { select: { id: true, code: true, label: true, rateBasisPoints: true } },
} satisfies Prisma.RefundLineSelect;

export const accountingRequestSelect = {
  id: true,
  status: true,
  ownerUserId: true,
  ownerEmail: true,
  ownerName: true,
  batch: { select: { id: true, status: true } },
  lines: { select: lineSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.RefundRequestSelect;

export type AccountingRequestRow = Prisma.RefundRequestGetPayload<{ select: typeof accountingRequestSelect }>;
export type AccountingLineRow = AccountingRequestRow["lines"][number];

/** The request, its lines with what is stored on them, and its batch: `null` when there is no such request. */
export async function readAccountingRequest(requestId: string, client: Client = db): Promise<AccountingRequestRow | null> {
  return client.refundRequest.findUnique({ where: { id: requestId }, select: accountingRequestSelect });
}

// ─── The state of a request ──────────────────────────────────────────────────

/**
 * `submitted` is under review; `approved` accepts a post-approval change until
 * its batch is paid (a `paid` batch always marks its requests `paid`, the batch
 * test is a second line of defense); `paid` is locked; `draft` and `rejected`
 * have nothing to classify.
 */
export function classificationStateOf(status: string, batchStatus: string | null): ClassificationState {
  if (status === "submitted") return "review";
  if (status === "approved") return batchStatus === "paid" ? "locked" : "post_approval";
  if (status === "paid") return "locked";
  return "none";
}

// ─── Building the view ───────────────────────────────────────────────────────

export type RatesInEffect = (
  pairs: readonly { currency: RateCurrency; month: string }[],
) => Promise<Map<string, RateEntry | null>>;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const NO_CHF = { amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateMissing: false } as const;

/**
 * The accounting view of a request: its lines with classification, CHF amount
 * and VAT amount, and the state that tells the UI what may be changed.
 */
export async function buildAccountingView(
  row: AccountingRequestRow,
  options: { client?: Client; ratesInEffect?: RatesInEffect } = {},
): Promise<RequestAccounting> {
  const client = options.client ?? db;
  const ratesInEffect = options.ratesInEffect ?? ((pairs) => fxService.ratesInEffect(pairs));
  const state = classificationStateOf(row.status, row.batch?.status ?? null);

  // Which lines carry a classification at all: WellD CH, not rejected, in a classifiable request.
  const classifiable = (line: AccountingLineRow) =>
    state !== "none" && line.entity === "welld_ch" && line.rejectionReason === null;
  const subject = row.lines.filter(classifiable);

  const accountFlags = await loadActiveFlags(
    client,
    "ledger_account",
    subject.flatMap((l) => (l.ledgerAccountId ? [l.ledgerAccountId] : [])),
  );
  const vatFlags = await loadActiveFlags(
    client,
    "vat_code",
    subject.flatMap((l) => (l.vatCodeId ? [l.vatCodeId] : [])),
  );
  // The live defaults matter only while the request is under review.
  const snapshot = state === "review" ? await loadDefaultsSnapshot(client) : null;
  const defaults: TypeDefaultsByType = snapshot?.defaults ?? {};
  const foreignVat = snapshot?.foreignCurrencyVatCode ?? null;

  const needed = new Map<string, { currency: RateCurrency; month: string }>();
  for (const line of subject) {
    if (line.currency === "CHF") continue;
    const pair = { currency: line.currency as RateCurrency, month: dateToMonth(line.date) };
    needed.set(rateKey(pair.currency, pair.month), pair);
  }
  const rates = needed.size > 0 ? await ratesInEffect([...needed.values()]) : new Map<string, RateEntry | null>();

  const lines = row.lines.map((line): AccountingLine => {
    const amountCents = line.approvedTotalCents ?? line.requestedAmountCents;
    const base = {
      lineId: line.id,
      entity: line.entity,
      date: isoDate(line.date),
      type: line.type,
      currency: line.currency as Currency,
      amountCents,
      receiptNumber: line.receiptNumber,
      employee: { name: row.ownerName, email: row.ownerEmail },
      rejected: line.rejectionReason !== null,
    };
    if (!classifiable(line)) {
      return { ...base, classification: null, chf: { ...NO_CHF }, vatAmountCents: null };
    }

    const input = {
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
    };
    const classification = resolveClassification(input, defaults, foreignVat);
    if (classification === null) return { ...base, classification: null, chf: { ...NO_CHF }, vatAmountCents: null };

    let chf: AccountingLine["chf"];
    if (line.currency === "CHF") {
      chf = { ...NO_CHF, amountCents: chfCents(amountCents, "CHF", null) };
    } else {
      const month = dateToMonth(line.date);
      const entry = rates.get(rateKey(line.currency, month)) ?? null;
      chf = {
        amountCents: chfCents(amountCents, line.currency, entry?.rateMicros ?? null),
        rateMicros: entry?.rateMicros ?? null,
        rate: entry ? formatRate(entry.rateMicros) : null,
        rateMonth: month,
        rateMissing: entry === null,
      };
    }

    return {
      ...base,
      classification: {
        account: classification.account,
        accountIsDefault: classification.accountIsDefault,
        vatCode: classification.vatCode
          ? {
              id: classification.vatCode.id,
              code: classification.vatCode.code,
              label: classification.vatCode.label,
              ratePercent: basisPointsToPercent(classification.vatCode.rateBasisPoints),
              active: classification.vatCode.active,
            }
          : null,
        vatCodeIsDefault: classification.vatCodeIsDefault,
      },
      chf,
      vatAmountCents: vatCents(chf.amountCents, classification.vatCode?.rateBasisPoints ?? null),
    };
  });

  return {
    requestId: row.id,
    status: row.status,
    batch: row.batch ? { id: row.batch.id, status: row.batch.status } : null,
    classificationState: state,
    lines,
  };
}

// ─── Options ─────────────────────────────────────────────────────────────────

/** The entries a line can be classified with today: active only (AC-1.3, AC-1.6, AC-2.4). */
export async function loadAccountingOptions(client: Client = db): Promise<AccountingOptions> {
  const [accounts, vatCodes] = await Promise.all([listLedgerAccounts(client), listVatCodes(client)]);
  return {
    ledgerAccounts: accounts.filter((a) => a.active).map((a) => ({ id: a.id, number: a.number, name: a.name })),
    vatCodes: vatCodes
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, code: v.code, label: v.label, ratePercent: v.ratePercent })),
  };
}


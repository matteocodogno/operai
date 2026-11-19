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
 *   line, through `resolveClassificationFk`, the same function the approve freeze
 *   and the release use. An override stored on the line wins and is no longer
 *   marked as a default.
 * - `approved` or `paid` (states `post_approval`, `locked`): FROZEN. Only what is
 *   STORED on the line is shown; a defaults change never moves it (AC-2.3,
 *   AC-3.5). A half the approval or the release could not resolve (AC-7.2) is
 *   shown as missing, and stays missing until accounting sets it (AC-3.6): the
 *   live defaults are NOT consulted for an approved line, otherwise a default
 *   added next month would silently classify a booked line. Anything that
 *   decides "is this line classified" for an approved line (the export blockers,
 *   T18) must read it the same way: `resolveClassificationFk` with NO defaults.
 * - `draft`, `rejected` (state `none`): nothing is classified, nothing is shown.
 *
 * CHF and VAT amounts are derived on read from the rate in effect and the VAT
 * code's basis points (`amounts.ts`), never stored, never computed by a browser.
 * This view never asks the federal source for a rate: a missing rate is
 * reported as `rateMissing`, and only the export fetches on demand.
 */

import { GLOBAL_ENTITY_SCOPE, requestInScope, type EntityScope } from "../authz/conditions";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { writeAuditEntry } from "../requests/audit";
import type { Currency } from "../lib/generated/prisma/enums";
import { dateToMonth, type RateCurrency, type RateEntry } from "../fx/fx.repo";
import { formatRate } from "../fx/fx.routes";
import { fxService, rateKey } from "../fx/fx.service";
import { chfCents, vatCents } from "./amounts";
import { basisPointsToPercent, listLedgerAccounts, listVatCodes, loadActiveFlags } from "./catalog.repo";
import { classifiableInputFk, loadDefaultsSnapshotFk, resolveClassificationFk, type TypeDefaultsByTypeFk } from "./legacyFk";
import type {
  AccountingLine,
  AccountingOptions,
  ClassificationState,
  ClassifyBody,
  RequestAccounting,
} from "./classification.schemas";

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

/**
 * What the caller may do, per action: `undefined` = no such grant at all, `null` = a conditioned grant with no
 * resolved entity (matches nothing), otherwise the entity scope of the grant.
 */
export type ActionScope = EntityScope | null | undefined;

/**
 * SR-1 (security review S-01): the LINE-level entity rule. The request-level predicate (`requestInScope`, ADR
 * 20260716-entity-scoped-abac-refund-api) decides whether a request is visible at all; the accounting data of one line
 * (account, VAT code, CHF and VAT amounts, and any change of them) is the books of that line's entity, so it is read or
 * written only when the scope of the grant for the action is global or equal to the line's own entity. `null` (a scope
 * with no entity) and `undefined` (no grant) cover nothing.
 */
export function lineInScope(scope: ActionScope, lineEntity: string): boolean {
  return scope === GLOBAL_ENTITY_SCOPE || (typeof scope === "string" && scope === lineEntity);
}

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
  options: {
    /** The caller's scope for the action behind this view: `request:review` for the GET, the gating grant for a PUT's answer (SR-1). */
    scope: ActionScope;
    /** SR-2: the caller owns the request and may not classify it. */
    selfRestricted?: boolean;
    client?: Client;
    ratesInEffect?: RatesInEffect;
  },
): Promise<RequestAccounting> {
  const client = options.client ?? db;
  const scope = options.scope;
  const ratesInEffect = options.ratesInEffect ?? ((pairs) => fxService.ratesInEffect(pairs));
  const state = classificationStateOf(row.status, row.batch?.status ?? null);

  // Which lines carry a classification at all: WellD CH, not rejected, in a classifiable request, and covered by the
  // caller's scope (SR-1): for a line outside it nothing is read, so nothing can leak, not even through the rates.
  const classifiable = (line: AccountingLineRow) =>
    state !== "none" && line.entity === "welld_ch" && line.rejectionReason === null && lineInScope(scope, line.entity);
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
  const snapshot = state === "review" ? await loadDefaultsSnapshotFk(client) : null;
  const defaults: TypeDefaultsByTypeFk = snapshot?.defaults ?? {};
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
      inScope: lineInScope(scope, line.entity),
    };
    if (!base.inScope) {
      return { ...base, classification: null, chf: null, vatAmountCents: null };
    }
    if (!classifiable(line)) {
      return { ...base, classification: null, chf: { ...NO_CHF }, vatAmountCents: null };
    }

    const input = classifiableInputFk(line, accountFlags, vatFlags);
    const classification = resolveClassificationFk(input, defaults, foreignVat);
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
    selfRestricted: options.selfRestricted === true,
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


// ─── Changing a line's classification (T14) ──────────────────────────────────

export interface ClassifyCaller {
  readonly userId: string;
  readonly email: string;
  /** `request:set-approved-total`: what may change a line while the request is `submitted`. */
  readonly setApprovedTotal: ActionScope;
  /** `request:reclassify`: what may change a line once the request is `approved` (D5). */
  readonly reclassify: ActionScope;
  /** SR-2: the caller's `request:approve` grant carries `self-approval: deny`. */
  readonly approveSelfRestricted: boolean;
  /** SR-2: the caller's `request:reclassify` grant carries `self-approval: deny`. */
  readonly reclassifySelfRestricted: boolean;
}

/**
 * SR-2 (security review S-02), segregation of duties: whoever may not approve their own request may not shape its
 * booking. True when the caller OWNS the request and the grant of the action that would change it is self-restricted:
 * `approve` while the request is `submitted` (`set-approved-total` itself stays unconditioned, specs/20260721-self-
 * approval-control D3), `reclassify` once it is `approved`. Once approved, an `approve` restriction counts too: the
 * seed gives both grants the same conditions, so they differ only in a hand-edited role, and then the stricter reading
 * (fail closed) is the one that keeps the control. A paid, draft or rejected request cannot change anyway: false.
 */
export function classificationSelfRestricted(
  request: { readonly status: string; readonly ownerUserId: string },
  caller: Pick<ClassifyCaller, "userId" | "approveSelfRestricted" | "reclassifySelfRestricted">,
): boolean {
  if (request.ownerUserId !== caller.userId) return false;
  if (request.status === "submitted") return caller.approveSelfRestricted;
  if (request.status === "approved") return caller.reclassifySelfRestricted || caller.approveSelfRestricted;
  return false;
}

export type ClassifyRefusal =
  | "ledger_account_inactive"
  | "vat_code_inactive"
  | "unknown_ledger_account"
  | "unknown_vat_code";

export type ClassifyOutcome =
  | { readonly kind: "ok"; readonly line: AccountingLine; readonly changed: boolean }
  /** No such request or line, or the caller is not in scope: one answer, so nothing is revealed (404). */
  | { readonly kind: "not_found" }
  /** The grant the request's CURRENT status needs is missing (403). */
  | { readonly kind: "forbidden"; readonly needs: "request:set-approved-total" | "request:reclassify" }
  /** SR-2: the caller owns the request and is barred from approving it, so from classifying it (403 `self_approval_forbidden`). */
  | { readonly kind: "self_restricted" }
  /** The request is paid (409 `classification_locked`). */
  | { readonly kind: "locked" }
  /** The request is a draft or rejected (409 `not_classifiable_status`). */
  | { readonly kind: "not_classifiable" }
  | { readonly kind: "line_rejected" }
  | { readonly kind: "not_welld_ch" }
  | { readonly kind: "refused"; readonly code: ClassifyRefusal };

const accountSummary = (a: { id: string; number: string } | null) => (a ? { id: a.id, number: a.number } : null);
const vatSummary = (v: { id: string; code: string; rateBasisPoints: number } | null) =>
  v ? { id: v.id, code: v.code, rateBasisPoints: v.rateBasisPoints } : null;

/**
 * Sets the account and/or the VAT code of one line (AC-3.3, AC-3.6, AC-3.7, AC-3.9, AC-1.3, AC-1.6).
 *
 * The whole decision is taken INSIDE one transaction, on the status read AFTER
 * `SELECT … FOR UPDATE` of the request row. Approve (CAS on the same row), mark-paid and withdraw
 * all update that row, so they serialize with this: a change lands either before the freeze
 * (an override the approval then freezes, audited `review`), or after it, when the request is `approved` and
 * needs `request:reclassify`, or not at all once it is paid (R7). Which grant is needed depends on that
 * locked status, never on the status the caller saw.
 *
 * Only the named half is written, and only a half that really changes. On an approved line the other half is
 * NOT resolved from the live defaults and written along: an approved line shows what is stored, and a half left
 * unclassified at release (AC-7.2) stays so until accounting sets it (see the header of this module).
 * `approvedTotalCents`, the status and `decided*` are never touched (AC-3.6), nor is the request row.
 */
export async function classifyLine(
  requestId: string,
  lineId: string,
  body: ClassifyBody,
  caller: ClassifyCaller,
): Promise<ClassifyOutcome> {
  // No grant of either kind: nothing to look up (403 whatever the request is).
  if (caller.setApprovedTotal === undefined && caller.reclassify === undefined) {
    return { kind: "forbidden", needs: "request:set-approved-total" };
  }

  const outcome = await db.$transaction(async (tx): Promise<ClassifyOutcome | { kind: "written"; changed: boolean; scope: ActionScope }> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "refund_request" WHERE "id" = ${requestId} FOR UPDATE`;
    if (locked.length === 0) return { kind: "not_found" };
    const request = await readAccountingRequest(requestId, tx);
    if (!request) return { kind: "not_found" };

    // SR-2, before every scope 404 as approve does (the caller provably owns the record, so a 403 reveals nothing):
    // the owner of a request they may not approve does not shape its booking, in either state.
    if (classificationSelfRestricted(request, caller)) return { kind: "self_restricted" };

    // Visible at all? In scope under one of the two grants the caller holds, else it is a stranger's request.
    const inScope = (scope: ActionScope) => scope !== undefined && scope !== null && requestInScope(request.lines, scope);
    if (!inScope(caller.setApprovedTotal) && !inScope(caller.reclassify)) return { kind: "not_found" };

    // The grant THIS status needs, evaluated on the locked status.
    if (request.status === "paid") return { kind: "locked" };
    if (request.status !== "submitted" && request.status !== "approved") return { kind: "not_classifiable" };
    const needs = request.status === "submitted" ? ("request:set-approved-total" as const) : ("request:reclassify" as const);
    const scope = request.status === "submitted" ? caller.setApprovedTotal : caller.reclassify;
    if (scope === undefined) return { kind: "forbidden", needs };
    if (!inScope(scope)) return { kind: "not_found" };
    const cause = request.status === "submitted" ? ("review" as const) : ("post_approval" as const);

    const line = request.lines.find((l) => l.id === lineId);
    if (!line) return { kind: "not_found" };
    // SR-1: the scope of the grant THIS status needs must cover THIS line's entity, else it is a stranger's line (404).
    if (!lineInScope(scope, line.entity)) return { kind: "not_found" };
    if (line.entity !== "welld_ch") return { kind: "not_welld_ch" };
    if (line.rejectionReason !== null) return { kind: "line_rejected" };

    // A value the line already stores is no change (and is not re-validated: it is not a new classification).
    const newAccountId = body.ledgerAccountId !== undefined && body.ledgerAccountId !== line.ledgerAccountId ? body.ledgerAccountId : null;
    const newVatId = body.vatCodeId !== undefined && body.vatCodeId !== line.vatCodeId ? body.vatCodeId : null;

    let account: { id: string; number: string; name: string } | null = null;
    if (newAccountId !== null) {
      account = await tx.ledgerAccount.findFirst({ where: { id: newAccountId, entity: "welld_ch" }, select: { id: true, number: true, name: true } });
      if (!account) return { kind: "refused", code: "unknown_ledger_account" };
      if (!(await loadActiveFlags(tx, "ledger_account", [account.id])).get(account.id)) return { kind: "refused", code: "ledger_account_inactive" };
    }
    let vat: { id: string; code: string; label: string; rateBasisPoints: number } | null = null;
    if (newVatId !== null) {
      vat = await tx.vatCode.findFirst({ where: { id: newVatId, entity: "welld_ch" }, select: { id: true, code: true, label: true, rateBasisPoints: true } });
      if (!vat) return { kind: "refused", code: "unknown_vat_code" };
      if (!(await loadActiveFlags(tx, "vat_code", [vat.id])).get(vat.id)) return { kind: "refused", code: "vat_code_inactive" };
    }
    if (account === null && vat === null) return { kind: "written", changed: false, scope };

    // What the accountant saw before, for the audit row: live while under review, stored once approved.
    const accountFlags = await loadActiveFlags(tx, "ledger_account", line.ledgerAccountId ? [line.ledgerAccountId] : []);
    const vatFlags = await loadActiveFlags(tx, "vat_code", line.vatCodeId ? [line.vatCodeId] : []);
    const snapshot = request.status === "submitted" ? await loadDefaultsSnapshotFk(tx) : null;
    const before = resolveClassificationFk(classifiableInputFk(line, accountFlags, vatFlags), snapshot?.defaults ?? {}, snapshot?.foreignCurrencyVatCode ?? null);

    await tx.refundLine.update({
      where: { id: lineId },
      data: {
        ...(account ? { ledgerAccountId: account.id, ledgerAccountIsDefault: false } : {}),
        ...(vat ? { vatCodeId: vat.id, vatCodeIsDefault: false } : {}),
      },
    });
    await writeAuditEntry(tx, {
      requestId,
      lineId,
      actorUserId: caller.userId,
      actorEmail: caller.email,
      action: "line_classified",
      detail: {
        cause,
        account: {
          from: accountSummary(before?.account ?? null),
          to: accountSummary(account ?? before?.account ?? null),
          fromDefault: before?.accountIsDefault ?? false,
          toDefault: account ? false : (before?.accountIsDefault ?? false),
        },
        vatCode: {
          from: vatSummary(before?.vatCode ?? null),
          to: vatSummary(vat ?? before?.vatCode ?? null),
          fromDefault: before?.vatCodeIsDefault ?? false,
          toDefault: vat ? false : (before?.vatCodeIsDefault ?? false),
        },
      },
    });
    return { kind: "written", changed: true, scope };
  });

  if (outcome.kind !== "written") return outcome;
  const row = await readAccountingRequest(requestId);
  // The scope of the grant that gated the change (decided on the locked status): the line passed `lineInScope` under it.
  const line = row ? (await buildAccountingView(row, { scope: outcome.scope })).lines.find((l) => l.lineId === lineId) : undefined;
  if (!line) return { kind: "not_found" };
  return { kind: "ok", line, changed: outcome.changed };
}

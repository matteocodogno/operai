/**
 * Data access and view building of the line-classification surface (T13, specs/20261118-refund-accounting-export;
 * reworked by T19, specs/20261119-accounting; AC-4.1, AC-4.2, AC-4.3, AC-4.9, AC-5.2, AC-5.3, AC-5.6, AC-5.7, AC-6.5,
 * AC-6.10, AC-7.3; plan § "What a WellD CH line holds", § API contracts; ADR 20261118-accounting-classification-is-live-
 * until-approval-then-frozen-and-changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid,
 * as amended; ADR 20261118-chf-and-vat-amounts-are-derived-on-read-..., as amended; ADR
 * 20261119-accounting-reference-data-belongs-to-accounting-api-...).
 *
 * What a line shows, by the state of its request
 * - `submitted` (state `review`): LIVE. A line with nothing stored follows the recorded default of its type (the
 *   account only: there is no VAT default) as long as Accounting still lists the entry as active, through
 *   `resolveClassification`, the same function the approval and the release use. A copy stored on the line wins and is no
 *   longer marked as a default. A foreign-currency line shows the rate in effect now, which is copied at approval.
 * - `approved` (state `post_approval`): the copies stored on the line, each with Accounting's present state, so a booked
 *   account that was deactivated since is visible and can be changed (`request:reclassify`). The exchange rate is the
 *   line's own copy, or "pending" until the first export copies it (AC-5.6). The live defaults are NOT consulted, otherwise
 *   a default added next month would silently classify a booked line.
 * - `paid` (state `locked`): the same, with no read of Accounting at all: nothing can change, so nothing is checked.
 * - `draft`, `rejected` (state `none`): nothing is classified, nothing is shown.
 *
 * CHF and VAT amounts are derived on read from the COPIED rate (or, under review, the rate in effect) and the copied VAT
 * rate (`amounts.ts`), never stored, never computed by a browser. A foreign-currency line approved with no rate has no CHF
 * and no VAT amount: unknown is never 0.
 *
 * ACCOUNTING IS READ AT MOST ONCE PER OPERATION (D2): `buildAccountingView` and `classifyLine` read through the
 * `AccountingOperation` they are given, whose answers are memoised. A view that cannot read Accounting is still a view
 * (`accounting: "unavailable"`, AC-6.5); a classification that cannot is refused before anything is locked or written
 * (503, AC-6.5, AC-6.2).
 */

import { GLOBAL_ENTITY_SCOPE, requestInScope, type EntityScope } from "../authz/conditions";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { writeAuditEntry, type AuditAccountCopy, type AuditVatCopy, type LineClassifiedDetail } from "../requests/audit";
import type { Currency } from "../lib/generated/prisma/enums";
import {
  accountingPort,
  AccountingUnavailableError,
  ratePairKey,
  tryReferenceSnapshot,
  type AccountingOperation,
  type AccountingPort,
  type RatePair,
} from "./accountingClient";
import type { RatePairWire } from "./accountingWire";
import { chfCents, vatCents } from "./amounts";
import {
  basisPointsToPercent,
  classifiableInput,
  formatRate,
  monthOf,
  resolveClassification,
  type RecordedDefaults,
} from "./classification";
import type {
  AccountingLine,
  AccountingOptions,
  ClassificationState,
  ClassifyBody,
  RequestAccounting,
} from "./classification.schemas";
import { loadRecordedDefaults, accountRefusal, vatRefusal, type RefusalCode } from "./defaults.repo";
import { UNVERIFIED_SNAPSHOT, type ReferenceSnapshot } from "./referenceSnapshot";

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
  // The copies (T16): what the line books. The old foreign keys are never read.
  accountNumber: true,
  accountName: true,
  ledgerAccountIsDefault: true,
  vatCodeCopy: true,
  vatRateBasisPoints: true,
  fxRateMicros: true,
  fxRateMonth: true,
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

/** The request, its lines with the copies stored on them, and its batch: `null` when there is no such request. */
export async function readAccountingRequest(requestId: string, client: Client = db): Promise<AccountingRequestRow | null> {
  return client.refundRequest.findUnique({ where: { id: requestId }, select: accountingRequestSelect });
}

// ─── The state of a request ──────────────────────────────────────────────────

/**
 * `submitted` is under review; `approved` accepts a post-approval change until its batch is paid (a `paid` batch always
 * marks its requests `paid`, the batch test is a second line of defense); `paid` is locked; `draft` and `rejected` have
 * nothing to classify.
 */
export function classificationStateOf(status: string, batchStatus: string | null): ClassificationState {
  if (status === "submitted") return "review";
  if (status === "approved") return batchStatus === "paid" ? "locked" : "post_approval";
  if (status === "paid") return "locked";
  return "none";
}

// ─── Building the view ───────────────────────────────────────────────────────

/**
 * What the caller may do, per action: `undefined` = no such grant at all, `null` = a conditioned grant with no resolved
 * entity (matches nothing), otherwise the entity scope of the grant.
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

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const NO_CHF = { amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateStatus: "not_applicable" } as const;

const NO_DEFAULTS: RecordedDefaults = { defaults: {} };

/** The pairs of the foreign-currency lines of a request under review that have no copy yet: what the view asks Accounting. */
function pairsUnderReview(lines: readonly AccountingLineRow[]): RatePair[] {
  const pairs = new Map<string, RatePair>();
  for (const line of lines) {
    if (line.currency === "CHF" || line.fxRateMicros !== null) continue;
    const pair: RatePair = { currency: line.currency, month: monthOf(line.date) };
    pairs.set(ratePairKey(pair), pair);
  }
  return [...pairs.values()];
}

/** The rates of `pairs`, or `null` when Accounting cannot be read. */
async function tryRates(operation: AccountingOperation, pairs: readonly RatePair[]): Promise<Map<string, RatePairWire> | null> {
  if (pairs.length === 0) return new Map();
  try {
    return new Map((await operation.rates(pairs)).map((answer) => [ratePairKey(answer), answer] as const));
  } catch (error) {
    if (error instanceof AccountingUnavailableError) return null;
    throw error;
  }
}

/**
 * The accounting view of a request: its lines with classification, CHF amount and VAT amount, the state that tells the UI
 * what may be changed, and whether Accounting could be read.
 */
export async function buildAccountingView(
  row: AccountingRequestRow,
  options: {
    /** The caller's scope for the action behind this view: `request:review` for the GET, the gating grant for a PUT's answer (SR-1). */
    scope: ActionScope;
    /** The operation whose reads (and memo) this view uses: one per Refund operation (D2). */
    operation: AccountingOperation;
    /** AC-7.3: decided by the route from the caller's permissions (`authz/accountingViewer.ts`). */
    canOpenAccountingRates: boolean;
    /** SR-2: the caller owns the request and may not classify it. */
    selfRestricted?: boolean;
    client?: Client;
  },
): Promise<RequestAccounting> {
  const client = options.client ?? db;
  const scope = options.scope;
  const state = classificationStateOf(row.status, row.batch?.status ?? null);

  // Which lines carry a classification at all: WellD CH, not rejected, in a classifiable request, and covered by the
  // caller's scope (SR-1): for a line outside it nothing is read, so nothing can leak, not even through the rates.
  const classifiable = (line: AccountingLineRow) =>
    state !== "none" && line.entity === "welld_ch" && line.rejectionReason === null && lineInScope(scope, line.entity);
  const subject = row.lines.filter(classifiable);

  // Accounting is read only for what it can tell: the state of each entry and the live defaults (under review and until
  // paid), and the rate in effect of a line not yet booked (under review). A request with nothing to classify (WellD Italia
  // only, all rejected, out of scope), and a paid one, never call Accounting (AC-4.9, AC-6.4 spirit).
  const readsAccounting = (state === "review" || state === "post_approval") && subject.length > 0;
  let snapshot: ReferenceSnapshot = UNVERIFIED_SNAPSHOT;
  let rates: Map<string, RatePairWire> | null = new Map();
  let accounting: "available" | "unavailable" = "available";
  if (readsAccounting) {
    const pairs = state === "review" ? pairsUnderReview(subject) : [];
    const [reference, rateAnswers] = await Promise.all([tryReferenceSnapshot(options.operation), tryRates(options.operation, pairs)]);
    if (reference !== null) snapshot = reference;
    rates = rateAnswers;
    if (reference === null || rateAnswers === null) accounting = "unavailable";
  }
  // The recorded defaults matter only while the request is under review.
  const recorded = state === "review" ? await loadRecordedDefaults(client) : NO_DEFAULTS;

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

    const classification = resolveClassification(classifiableInput(line), recorded.defaults, snapshot);
    if (classification === null) return { ...base, classification: null, chf: { ...NO_CHF }, vatAmountCents: null };

    let chf: NonNullable<AccountingLine["chf"]>;
    if (line.currency === "CHF") {
      chf = { ...NO_CHF, amountCents: chfCents(amountCents, "CHF", null) };
    } else if (line.fxRateMicros !== null) {
      // The line's own copy of the rate: fixed as booked, whatever Accounting does afterwards (AC-5.3).
      chf = {
        amountCents: chfCents(amountCents, line.currency, line.fxRateMicros),
        rateMicros: line.fxRateMicros,
        rate: formatRate(line.fxRateMicros),
        rateMonth: line.fxRateMonth ? monthOf(line.fxRateMonth) : monthOf(line.date),
        rateStatus: "copied",
      };
    } else {
      const month = monthOf(line.date);
      if (state !== "review") {
        // Approved with no rate to copy: copied at the first export (AC-5.6). No CHF and no VAT amount, never 0.
        chf = { amountCents: null, rateMicros: null, rate: null, rateMonth: month, rateStatus: "pending" };
      } else if (rates === null) {
        chf = { amountCents: null, rateMicros: null, rate: null, rateMonth: month, rateStatus: "unavailable" };
      } else {
        const answer = rates.get(ratePairKey({ currency: line.currency, month }));
        if (answer?.status === "in_effect") {
          chf = {
            amountCents: chfCents(amountCents, line.currency, answer.rateMicros),
            rateMicros: answer.rateMicros,
            rate: formatRate(answer.rateMicros),
            rateMonth: month,
            rateStatus: "in_effect",
          };
        } else {
          chf = { amountCents: null, rateMicros: null, rate: null, rateMonth: month, rateStatus: "missing" };
        }
      }
    }

    return {
      ...base,
      classification: {
        account: classification.account && {
          number: classification.account.number,
          name: classification.account.name,
          state: classification.account.state,
        },
        accountIsDefault: classification.accountIsDefault,
        vatCode: classification.vatCode && {
          code: classification.vatCode.code,
          label: classification.vatCode.label,
          ratePercent: basisPointsToPercent(classification.vatCode.rateBasisPoints),
          state: classification.vatCode.state,
        },
      },
      chf,
      // The VAT amount only with a code (AC-3.8): the copied rate of the line's own code, none without one.
      vatAmountCents: vatCents(chf.amountCents, classification.bookable.vatCode?.rateBasisPoints ?? null),
    };
  });

  return {
    requestId: row.id,
    status: row.status,
    batch: row.batch ? { id: row.batch.id, status: row.batch.status } : null,
    classificationState: state,
    selfRestricted: options.selfRestricted === true,
    accounting,
    viewer: { canOpenAccountingRates: options.canOpenAccountingRates },
    lines,
  };
}

// ─── Options ─────────────────────────────────────────────────────────────────

/**
 * The entries a line can be classified with today: Accounting's active WellD CH entries, by natural key, and nothing else
 * (AC-4.1). `null` when Accounting cannot be read: no options are offered (AC-6.5), never a stale list.
 */
export async function loadAccountingOptions(operation: AccountingOperation): Promise<AccountingOptions | null> {
  const snapshot = await tryReferenceSnapshot(operation);
  if (snapshot === null) return null;
  return {
    ledgerAccounts: snapshot.activeAccounts().map((a) => ({ number: a.number, name: a.name })),
    vatCodes: snapshot.activeVatCodes().map((v) => ({
      code: v.code,
      label: v.label,
      ratePercent: basisPointsToPercent(v.rateBasisPoints),
      rateBasisPoints: v.rateBasisPoints,
    })),
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
  /** AC-7.3 for the line the PUT answers with (the view's flag is not part of a line). */
  readonly canOpenAccountingRates?: boolean;
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

export type ClassifyRefusal = RefusalCode;

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
  | { readonly kind: "refused"; readonly code: ClassifyRefusal }
  /** Accounting could not be read, so nothing can be chosen or checked: nothing was changed (503, AC-6.5). */
  | { readonly kind: "unavailable" }
  /** The line changed under the caller twice in a row: nothing was written, retry (409). */
  | { readonly kind: "conflict" };

/** What an authorization-and-state check of one request decides, before any Accounting read or write. */
type Decision =
  | Exclude<ClassifyOutcome, { readonly kind: "ok" | "refused" | "unavailable" | "conflict" }>
  | {
      readonly kind: "go";
      readonly request: AccountingRequestRow;
      readonly line: AccountingLineRow;
      readonly scope: Exclude<ActionScope, undefined | null>;
      readonly cause: "review" | "post_approval";
      /** The natural key this call would set: a value the line already stores is no change (and no Accounting read). */
      readonly newAccountNumber: string | null;
      /** The VAT code this call would set or clear (`null` in the body): storing what is stored, or clearing none, is no change. */
      readonly vatChange: VatChange;
    };

/** What the body asks of the VAT code, relative to what the line stores. */
type VatChange = { readonly kind: "none" } | { readonly kind: "set"; readonly code: string } | { readonly kind: "clear" };

const NO_VAT_CHANGE: VatChange = { kind: "none" };

function vatChangeOf(body: ClassifyBody, stored: string | null): VatChange {
  if (body.vatCode === undefined) return NO_VAT_CHANGE;
  if (body.vatCode === null) return stored === null ? NO_VAT_CHANGE : { kind: "clear" };
  return body.vatCode === stored ? NO_VAT_CHANGE : { kind: "set", code: body.vatCode };
}

/** Accounting is read only to check an entry that is being CHOSEN: clearing a VAT code has nothing to check. */
const needsAccounting = (decision: { newAccountNumber: string | null; vatChange: VatChange }): boolean =>
  decision.newAccountNumber !== null || decision.vatChange.kind === "set";

/**
 * The refusals that need no Accounting and no write, in the order that keeps the line-level scope (SR-1) and segregation
 * of duties (SR-2) ahead of everything else, evaluated on the request as given: first on an unlocked read (so a caller who
 * may not touch the request never causes an Accounting read), then again, authoritatively, on the locked row.
 */
function decide(request: AccountingRequestRow, lineId: string, body: ClassifyBody, caller: ClassifyCaller): Decision {
  // SR-2, before every scope 404 as approve does (the caller provably owns the record, so a 403 reveals nothing): the
  // owner of a request they may not approve does not shape its booking, in either state.
  if (classificationSelfRestricted(request, caller)) return { kind: "self_restricted" };

  // Visible at all? In scope under one of the two grants the caller holds, else it is a stranger's request.
  const inScope = (scope: ActionScope) => scope !== undefined && scope !== null && requestInScope(request.lines, scope);
  if (!inScope(caller.setApprovedTotal) && !inScope(caller.reclassify)) return { kind: "not_found" };

  // The grant THIS status needs, evaluated on the status as given.
  if (request.status === "paid") return { kind: "locked" };
  if (request.status !== "submitted" && request.status !== "approved") return { kind: "not_classifiable" };
  const needs = request.status === "submitted" ? ("request:set-approved-total" as const) : ("request:reclassify" as const);
  const scope = request.status === "submitted" ? caller.setApprovedTotal : caller.reclassify;
  if (scope === undefined) return { kind: "forbidden", needs };
  if (!inScope(scope) || scope === null) return { kind: "not_found" };
  const cause = request.status === "submitted" ? ("review" as const) : ("post_approval" as const);

  const line = request.lines.find((l) => l.id === lineId);
  if (!line) return { kind: "not_found" };
  // SR-1: the scope of the grant THIS status needs must cover THIS line's entity, else it is a stranger's line (404).
  if (!lineInScope(scope, line.entity)) return { kind: "not_found" };
  if (line.entity !== "welld_ch") return { kind: "not_welld_ch" };
  if (line.rejectionReason !== null) return { kind: "line_rejected" };

  return {
    kind: "go",
    request,
    line,
    scope,
    cause,
    newAccountNumber: body.accountNumber !== undefined && body.accountNumber !== line.accountNumber ? body.accountNumber : null,
    vatChange: vatChangeOf(body, line.vatCodeCopy),
  };
}

const accountSummary = (a: AuditAccountCopy | null) => (a ? { number: a.number, name: a.name } : null);
const vatSummary = (v: AuditVatCopy | null) => (v ? { code: v.code, rateBasisPoints: v.rateBasisPoints } : null);

/**
 * Sets the account and/or the VAT code of one line by natural key (AC-4.3, AC-5.2, AC-5.7, AC-6.5, AC-1.8).
 *
 * Order, so that nothing is held across a call to Accounting (plan "Order inside a route"):
 * 1. Authorization and the cheap refusals, on an unlocked read. A caller who may not touch the request never causes a
 *    read of Accounting.
 * 2. The live read of Accounting, only when a value actually changes: the entry must exist, be of WellD CH and be active
 *    (422 otherwise). Unreachable: 503, the line is unchanged.
 * 3. One transaction: `SELECT … FOR UPDATE` of the request row, the checks of step 1 again on the LOCKED status (approve,
 *    mark-paid and withdraw all update that row, so a change lands either before the freeze, audited `review`, or after
 *    it when the request is `approved` and needs `request:reclassify`, or not at all once it is paid, R7), the copy, and
 *    the audit row.
 *
 * Only the named half is written, and only a half that really changes, as a COPY: the number and the name Accounting
 * holds now, or the code and its rate. On an approved line the other half is NOT resolved from the live defaults and
 * written along: an approved line shows what is stored, and a half left unclassified at release (AC-7.2) stays so until
 * accounting sets it. The exchange rate copy, `approvedTotalCents`, the status and `decided*` are never touched (AC-5.7),
 * nor is the request row.
 */
export async function classifyLine(
  requestId: string,
  lineId: string,
  body: ClassifyBody,
  caller: ClassifyCaller,
  deps: { readonly accounting?: AccountingPort } = {},
): Promise<ClassifyOutcome> {
  // No grant of either kind: nothing to look up (403 whatever the request is).
  if (caller.setApprovedTotal === undefined && caller.reclassify === undefined) {
    return { kind: "forbidden", needs: "request:set-approved-total" };
  }
  const operation = (deps.accounting ?? accountingPort()).begin("classify");
  let snapshot: ReferenceSnapshot | null = null;

  // A second pass only when the line changed between the unlocked read and the lock in a way that now needs Accounting.
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await readAccountingRequest(requestId);
    if (!first) return { kind: "not_found" };
    const early = decide(first, lineId, body, caller);
    if (early.kind !== "go") return early;
    if (needsAccounting(early) && snapshot === null) {
      snapshot = await tryReferenceSnapshot(operation);
      if (snapshot === null) return { kind: "unavailable" };
    }

    const outcome = await db.$transaction(
      async (
        tx,
      ): Promise<
        ClassifyOutcome | { kind: "written"; changed: boolean; scope: Exclude<ActionScope, undefined | null> } | { kind: "retry" }
      > => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "refund_request" WHERE "id" = ${requestId} FOR UPDATE`;
        if (locked.length === 0) return { kind: "not_found" };
        const request = await readAccountingRequest(requestId, tx);
        if (!request) return { kind: "not_found" };

        const decision = decide(request, lineId, body, caller);
        if (decision.kind !== "go") return decision;
        const { line, scope, cause } = decision;
        if (decision.newAccountNumber === null && decision.vatChange.kind === "none") return { kind: "written", changed: false, scope };
        const read = snapshot;
        let account: { number: string; name: string } | null = null;
        let vat: { code: string; rateBasisPoints: number } | null = null;
        if (needsAccounting(decision)) {
          // A change that was not one at the unlocked read: Accounting has not been read yet, and no call is made under a lock.
          if (read === null) return { kind: "retry" };
          if (decision.newAccountNumber !== null) {
            const refusal = accountRefusal(read, decision.newAccountNumber);
            if (refusal) return { kind: "refused", code: refusal.code };
            const found = read.lookupAccount(decision.newAccountNumber);
            if (found.state !== "active") return { kind: "refused", code: "ledger_account_not_found" };
            account = { number: found.number, name: found.name };
          }
          if (decision.vatChange.kind === "set") {
            const refusal = vatRefusal(read, decision.vatChange.code);
            if (refusal) return { kind: "refused", code: refusal.code };
            const found = read.lookupVat(decision.vatChange.code);
            if (found.state !== "active") return { kind: "refused", code: "vat_code_not_found" };
            vat = { code: found.code, rateBasisPoints: found.rateBasisPoints };
          }
        }

        // What the accountant saw before, for the audit row: live while under review, stored once approved.
        const recorded = request.status === "submitted" ? await loadRecordedDefaults(tx) : NO_DEFAULTS;
        // A clear alone read no Accounting: the audit then needs only the copies, which the unverified snapshot keeps.
        const before = resolveClassification(classifiableInput(line), recorded.defaults, read ?? UNVERIFIED_SNAPSHOT);

        await tx.refundLine.update({
          where: { id: lineId },
          data: {
            ...(account ? { accountNumber: account.number, accountName: account.name, ledgerAccountIsDefault: false } : {}),
            // `vatCodeIsDefault` stays in the table but nothing reads it (SO-2): false for a hand copy, NULL for none.
            ...(vat ? { vatCodeCopy: vat.code, vatRateBasisPoints: vat.rateBasisPoints, vatCodeIsDefault: false } : {}),
            ...(decision.vatChange.kind === "clear" ? { vatCodeCopy: null, vatRateBasisPoints: null, vatCodeIsDefault: null } : {}),
          },
        });
        const detail: LineClassifiedDetail = {
          v: 2,
          cause,
          account: {
            from: accountSummary(before?.account ?? null),
            to: accountSummary(account ?? before?.account ?? null),
            fromDefault: before?.accountIsDefault ?? false,
            toDefault: account ? false : (before?.accountIsDefault ?? false),
          },
          vatCode: {
            from: vatSummary(before?.vatCode ?? null),
            // A clear is recorded as `to: null`, read as "none" (AC-3.3). A VAT code is never a default (SO-2).
            to: decision.vatChange.kind === "clear" ? null : vatSummary(vat ?? before?.vatCode ?? null),
            fromDefault: false,
            toDefault: false,
          },
        };
        await writeAuditEntry(tx, {
          requestId,
          lineId,
          actorUserId: caller.userId,
          actorEmail: caller.email,
          action: "line_classified",
          detail: detail as unknown as Record<string, unknown>,
        });
        return { kind: "written", changed: true, scope };
      },
    );

    if (outcome.kind === "retry") continue;
    if (outcome.kind !== "written") return outcome;
    const row = await readAccountingRequest(requestId);
    // The scope of the grant that gated the change (decided on the locked status): the line passed `lineInScope` under it.
    const answer = row
      ? await buildAccountingView(row, {
          scope: outcome.scope,
          operation,
          canOpenAccountingRates: caller.canOpenAccountingRates ?? false,
        })
      : undefined;
    const line = answer?.lines.find((l) => l.lineId === lineId);
    if (!line) return { kind: "not_found" };
    return { kind: "ok", line, changed: outcome.changed };
  }
  return { kind: "conflict" };
}

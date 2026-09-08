/**
 * Display labels for refund DOCUMENTS — the same words the UI shows, so a PDF
 * and the screen it was exported from never disagree.
 *
 * WHY THIS EXISTS. `exportPdf.ts` used to interpolate the raw enum straight
 * into the document: an expense line read `travel_km — welld_ch` and the
 * header read `Status: approved`, while the screen beside it said
 * "Travel — mileage (km)", "WellD CH" and "Approved". Those are database
 * values leaking into an accounting artifact, and they also broke CLAUDE.md's
 * "no hardcoded strings that appear in the UI" rule — a PDF is UI.
 *
 * WHY IT IS A COPY, NOT AN IMPORT. refund-api (Bun) and refund-ui (pnpm) are
 * deliberately not npm-linked — CLAUDE.md's ### Git section explains that a
 * workspace would break the per-app installs and the Vercel/Railway deploys.
 * So the labels are mirrored, exactly as `computeMileageAmountCents` is
 * mirrored (ADR-0025), and `document-labels.json` beside this file is the
 * contract both sides check themselves against: `labels.test.ts` here, and
 * `documentLabels.parity.test.ts` in refund-ui. Change the JSON first.
 *
 * ENGLISH, DELIBERATELY. The suite needs Italian eventually, and
 * `refund-ui/src/lib/expenseTypes.ts` already carries `labelIt` — the wording
 * from the paper form Ticino accounting used before this app. English was
 * chosen for the document on 2026-09-08 as an explicit decision rather than a
 * default; switching means adding an Italian column to the JSON and a locale
 * argument here, not rewriting the callers.
 */

import labels from "./document-labels.json";

const EXPENSE_TYPE: Record<string, string> = labels.expenseType;
const ENTITY: Record<string, string> = labels.entity;
const REQUEST_STATUS: Record<string, string> = labels.requestStatus;

/**
 * Each lookup falls back to the raw value rather than throwing. A document
 * that renders one unknown enum is recoverable; one that fails to generate
 * because a new expense type shipped before this table was updated is not —
 * and the raw value is at least the truth, which is what an archive owes its
 * reader.
 */
export const expenseTypeLabel = (type: string): string => EXPENSE_TYPE[type] ?? type;
export const entityLabel = (entity: string): string => ENTITY[entity] ?? entity;
export const requestStatusLabel = (status: string): string => REQUEST_STATUS[status] ?? status;

/** Distinct entity labels across a request's lines, in a stable order — a request may straddle both (AC-3.5/6.6). */
export const entityLabels = (entities: readonly string[]): string =>
  [...new Set(entities)].sort().map(entityLabel).join(", ");

/**
 * The shapes shared by offer templates, the generate route and the contract
 * renderer (specs/20261102-crm-offer-document). Pure types: no I/O, no Prisma.
 *
 * Money is integer minor units throughout; a percentage discount is basis
 * points (1–10 000) and is turned into cents exactly once, at generation time
 * (ADR 20260720-mileage-rate-money-precision-integer-micros posture). The renderer never computes money: it prints what the
 * snapshot says.
 */

import type { WizardAnswers } from "./engine/answers";
import type { CostKind as EngineCostKind } from "./engine/costs";
import type { ResolvedCostRow } from "./engine/resolve";
import type { Scope } from "./scope";

export type OfferLanguage = "en" | "it";
export type CostKind = "one_off" | "yearly" | "discount";

/** One section of a template or an offer. `body` uses the markup of spec AC-1.6. */
export interface OfferSection {
  readonly heading: string;
  readonly body: string;
  /** Exactly one section per template/offer carries the cost table. */
  readonly costs: boolean;
  /** A wizard offer only: the text was edited by hand (display only; the renderer ignores it). */
  readonly handEdited?: boolean;
}

export interface CostColumns {
  /** "Pos." — one-off and yearly lines numbered, discounts not. */
  readonly position: boolean;
  /** "<currency> / unità" and "Qt." columns. */
  readonly unit: boolean;
}

/** A template's default cost line, before the draft resolves it. */
export interface TemplateCostLine {
  /** May contain placeholders, resolved in the draft. */
  readonly description: string;
  readonly kind: CostKind;
  /**
   * - `"deal"`: the deal amount;
   * - `"perRelease"`: one line per estimate release, the deal amount split by
   *   expected man-days, whole units, remainder on the last (D-13);
   * - `{ cents }`: a fixed unit amount;
   * - `{ percentBp }`: discounts only, a percentage of the one-off sum.
   */
  readonly amount: "deal" | "perRelease" | { readonly cents: number } | { readonly percentBp: number };
  /** A whole number, or the estimate's total man-days rounded half up (D-14). */
  readonly quantity: number | "manDays";
}

/** Everything a template holds besides its identity (spec domain language). */
export interface OfferTemplateContent {
  readonly name: string;
  readonly language: OfferLanguage;
  readonly salutation: string;
  readonly opening: string;
  readonly sections: readonly OfferSection[];
  readonly costLines: readonly TemplateCostLine[];
  readonly costColumns: CostColumns;
  readonly showTotal: boolean;
  /** "Il Cliente" above the signature lines, or null. */
  readonly acceptanceLabel: string | null;
  /** Annex A — effort detail on by default. */
  readonly annex: boolean;
}

/** A cost line as the dialog sends it and the snapshot stores it; `option` only on a wizard offer (never counted in a total). */
export interface OfferCostLine {
  readonly description: string;
  readonly kind: EngineCostKind;
  /** Unit amount in cents; null only for a percentage discount. */
  readonly unitCents: number | null;
  /** Discounts only: basis points of the one-off sum; null otherwise. */
  readonly percentBp: number | null;
  readonly quantity: number;
  /** Computed at generation: unit × quantity, or the rounded percentage. Always ≥ 0. */
  readonly totalCents: number;
}

export interface OfferCosts {
  readonly currency: "CHF" | "EUR";
  readonly columns: CostColumns;
  readonly showTotal: boolean;
  readonly lines: readonly OfferCostLine[];
  /** One-off lines minus discounts: the offer's stored price (D-6). */
  readonly oneOffCents: number;
  readonly yearlyCents: number;
  /**
   * A wizard offer only: the table as printed — lines and total rows in order, the engine's input. The renderer
   * hands it to the engine's `computeCosts` for positions and span totals; a legacy snapshot has none and its
   * `lines` are one span.
   */
  readonly rows?: readonly ResolvedCostRow[];
  /** A wizard offer only: the template's own column headers (plain surfaces, DD-47); null keeps the default. */
  readonly labels?: { readonly unit: string | null; readonly quantity: string | null };
}

/** A text annex of a wizard offer (plan § Data model; DD-45): drawn from a new page, before the effort-detail annex. */
export interface OfferTextAnnex {
  /** "A", "SLA": the word the heading and the "Allegati:" line print after "Allegato". */
  readonly designation: string;
  /** Plain surface (DD-47). */
  readonly title: string;
  /** Plain surface (DD-47); null when there is none. */
  readonly subtitle: string | null;
  /** 018 markup drawn before the first section, unnumbered ("" when none). */
  readonly intro: string;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
}

export interface OfferAttachmentRef {
  readonly id: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

/** The snapshot of a specs/20261102-crm-offer-document offer. Older (018) snapshots have no `kind`. */
export interface ContractSnapshot {
  readonly kind: "contract";
  readonly template: { readonly id: string; readonly name: string };
  readonly language: OfferLanguage;
  /** "0017/2026" or "0017/2026r1". */
  readonly reference: string;
  readonly issuedOn: string; // YYYY-MM-DD
  readonly validUntil: string; // YYYY-MM-DD
  readonly validityDays: number;
  readonly place: string;
  readonly issuer: {
    readonly legalName: string;
    readonly addressLines: readonly string[];
    readonly vatNumber: string | null;
    readonly iban: string | null;
  };
  /**
   * The version of the registry's legal-entity details `issuer` was read from (specs/20261117-legal-entities, plan § Data
   * model; AC-6.2). Absent in a snapshot made before the registry: those are never touched (AC-6.4).
   */
  readonly legalEntityVersion?: number;
  readonly salutation: string;
  /** First line printed bold (AC-1.2). */
  readonly clientLines: readonly string[];
  /** Names after "A.c.a.", 0–5. */
  readonly contacts: readonly string[];
  /** The contacts' ids, so an edit or a revision starts from them (US-7); absent before it. */
  readonly contactIds?: readonly string[];
  readonly opening: string;
  readonly sections: readonly OfferSection[];
  readonly costs: OfferCosts;
  readonly acceptanceLabel: string | null;
  /** The effort detail when Annex A is on, else null. */
  readonly annex: Scope | null;
  /** Deal PDFs appended after the contract, in order. */
  readonly attachments: readonly OfferAttachmentRef[];
  readonly aiAssisted: boolean;
  readonly preparedBy: string | null;
  /** A wizard offer only (plan § Data model): enough to reopen the wizard. The template text is not stored (DD-20). */
  readonly wizard?: { readonly templateVersion: number; readonly answers: WizardAnswers };
  /** A wizard offer only: the text annexes, in template order. */
  readonly textAnnexes?: readonly OfferTextAnnex[];
}

/** What the renderer needs besides the snapshot. */
export interface RenderInputs {
  /** The entity's letterhead PDF, or null (AC-2.4). */
  readonly letterhead: Uint8Array | null;
  /** The bytes of `snapshot.attachments`, same order. */
  readonly attachments: readonly Uint8Array[];
}

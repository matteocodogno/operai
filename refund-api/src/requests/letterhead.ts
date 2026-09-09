/**
 * Issuing-company identity for a refund document.
 *
 * A reimbursement record leaves the building — it goes to accounting, into a
 * ten-year archive, and potentially to a third party in a dispute. Nothing on
 * the page identified who issued it, which is odd for a document of that kind.
 *
 * ONE ESTABLISHMENT PER ENTITY, the REGISTERED one. wellD operates from
 * several offices in each country, but a letterhead states the legal seat and
 * the tax identifier — the operational addresses are not what identifies the
 * issuer, and listing three of them would turn a header into a directory.
 *
 * NAMING CAVEAT: the values below carry the establishment descriptors as
 * supplied ("Switzerland — headquarters", "Italy — branch"). If the registered
 * legal name of either establishment differs (a legal form such as SA/Sagl/
 * Srl), it belongs here verbatim — a document asserting a company identity
 * should carry the name on the commercial register, not a product label.
 */

export interface Letterhead {
  readonly name: string;
  readonly address: string;
  /** CHE / VAT number — the authoritative identifier on a fiscal document. */
  readonly taxId: string;
  readonly contact: string;
}

const SWITZERLAND: Letterhead = {
  name: "wellD — Switzerland (headquarters)",
  address: "Via Pessina 9, c.p. 1920, CH-6901 Lugano",
  taxId: "CHE-114.591.536",
  contact: "info@welld.ch · +41 (0)91 921 21 08",
};

const ITALY: Letterhead = {
  name: "wellD — Italy (branch)",
  address: "Via Corsica 9/7 Scala E, I-16128 Genova",
  taxId: "CF / P. IVA 01975370998",
  contact: "info@welld.it · +39 010 8939955",
};

const BY_ENTITY: Record<string, Letterhead> = {
  welld_ch: SWITZERLAND,
  welld_it: ITALY,
};

/**
 * The letterhead for a request, from the entities its lines belong to.
 *
 * A MIXED-entity request takes the Swiss headquarters. Italy is a branch of
 * it, so the headquarters is the issuing company either way; the per-line
 * entity remains the record of which establishment each expense belongs to,
 * and the header says "Multiple" rather than implying one.
 *
 * An unrecognised entity also falls back to the headquarters rather than
 * rendering no letterhead: a document that silently loses its issuer is worse
 * than one naming the parent company.
 */
export const letterheadFor = (entities: readonly string[]): Letterhead => {
  const distinct = [...new Set(entities)];
  if (distinct.length === 1) {
    return BY_ENTITY[distinct[0]!] ?? SWITZERLAND;
  }
  return SWITZERLAND;
};

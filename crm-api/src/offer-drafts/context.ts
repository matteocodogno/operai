/**
 * What the wizard knows about a deal (specs/20261115-crm-offer-wizard § Wizard context; DD-41): the engine's
 * `WizardContext` for one offer language, and the context route's answer, both built from the same facts so the
 * browser's preview and the server's generation start from the same figures.
 *
 * The client block, the estimate's epics, phases and timeline, the per-release man-days and the deal's contacts and
 * PDFs are read here; the engine itself has no clock and no locale, so the template's language and the server's UTC
 * day come in as arguments.
 */

import { db } from "../lib/db";
import { getEstimate, type EstimateDocument } from "../lib/estimai";
import type { OfferLanguage } from "../offers/contract";
import { clientLinesOf } from "../offers/draft";
import type { WizardContext } from "../offers/engine/answers";
import { estimateLinkOf, isoDate, loadDealInScope, loadIssuer, loadProfile, offerOrigin, latestOffer, type StoredSnapshot } from "../offers/generation";
import type { LegalEntityDetails } from "../lib/legalEntities";
import { scopeLabels } from "../offers/pdf";
import { buildScope, releaseManDays, roundHalfUp, totalManDays, type Scope } from "../offers/scope";
import { buildTimeline, timelineTable } from "../offers/timeline";

const DEFAULT_PLACE = "Lugano";

/** The server's UTC day: 018's rule for `issuedOn`, and the one day the wizard's defaults and date window read (DD-41). */
export const serverToday = (): string => isoDate(new Date());

type EstimateState = "ready" | "override" | "missing";

/** The estimate's figures in one offer language (the labels of an unassigned release and of a missing epic). */
export function estimateFacts(estimate: EstimateDocument | null, language: OfferLanguage) {
  if (!estimate) {
    return { manDays: 0, manDaysAi: 0, epics: [] as string[], phases: [] as { release: string; epics: string[] }[], timeline: { it: "", en: "" }, releases: [] as { name: string; manDays: number }[] };
  }
  const options = { aiAssisted: false, ...scopeLabels(language) };
  const scope = buildScope(estimate, options);
  const timeline = buildTimeline(estimate);
  return {
    manDays: roundHalfUp(totalManDays(estimate, false)),
    manDaysAi: roundHalfUp(totalManDays(estimate, true)),
    epics: [...new Set(estimate.content.acts.map((act) => act.epic?.trim() ?? "").filter(Boolean))],
    phases: scope.releases.map((release) => ({ release: release.name, epics: release.epics.map((epic) => epic.epic) })),
    timeline: { it: timelineTable(timeline, "it"), en: timelineTable(timeline, "en") },
    releases: releaseManDays(estimate, options),
  };
}

/** Everything read about the deal, once: the pieces a context, a draft and a generation are built from. */
export interface WizardInputs {
  readonly deal: Awaited<ReturnType<typeof loadDealInScope>>["deal"];
  /** The CRM's own row of the entity (terms, place of issue, classic letterhead); null while it does not exist (E4). */
  readonly profile: Awaited<ReturnType<typeof loadProfile>>;
  /** The issuer's legal details, from the registry (the legal name and the address in each language). */
  readonly issuer: LegalEntityDetails;
  readonly estimateState: EstimateState;
  readonly estimate: EstimateDocument | null;
  readonly contacts: { id: string; name: string }[];
  readonly attachments: { id: string; fileName: string; sizeBytes: number }[];
}

export interface LoadOptions {
  /** `true`: no ready estimate and no override is 409 `estimate_not_ready` (a draft is made from one, AC-2.4). */
  readonly requireEstimate: boolean;
  /** A contact archived since an offer chose it still prints (018 never filtered them); the picker does not offer it. */
  readonly archivedContacts: boolean;
  /**
   * `true`: details the registry judges incomplete are 409 `legal_entity_incomplete` (generation, the previews). `false`: the
   * values as they are (the context, a draft being started or switched: an autosave is never refused, E4). Either way an
   * unreadable registry is 503 `legal_entities_unavailable`.
   */
  readonly requireCompleteIssuer: boolean;
}

export async function loadWizardInputs(
  c: Parameters<typeof getEstimate>[0],
  deal: Awaited<ReturnType<typeof loadDealInScope>>["deal"],
  options: LoadOptions,
): Promise<WizardInputs> {
  let link: ReturnType<typeof estimateLinkOf> = null;
  let estimateState: EstimateState;
  if (options.requireEstimate) {
    link = estimateLinkOf(deal);
    estimateState = link ? "ready" : "override";
  } else if (deal.estimate?.estimateId && deal.estimate.state === "ready") {
    link = deal.estimate;
    estimateState = "ready";
  } else {
    estimateState = deal.estimate?.overrideAt ? "override" : "missing";
  }
  const issuer = await loadIssuer(deal.entity, { requireComplete: options.requireCompleteIssuer });
  const profile = await loadProfile(deal.entity);
  const estimate = link ? await getEstimate(c, link.estimateId) : null;
  const contactRows = await db.contact.findMany({
    where: { companyId: deal.companyId, ...(options.archivedContacts ? {} : { archivedAt: null }) },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });
  const attachmentRows = await db.dealAttachment.findMany({
    where: { dealId: deal.id, status: "stored", deletedAt: null, contentType: "application/pdf" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return {
    deal,
    profile,
    issuer,
    estimateState,
    estimate,
    contacts: contactRows.map((contact) => ({ id: contact.id, name: `${contact.firstName} ${contact.lastName}`.trim() })),
    attachments: attachmentRows.map((row) => ({ id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes })),
  };
}

const clientLinesBoth = (inputs: WizardInputs) => ({
  it: clientLinesOf(inputs.deal.company, "it"),
  en: clientLinesOf(inputs.deal.company, "en"),
});

/** The engine's context for an offer in `language` on `today`. */
export function wizardContextOf(inputs: WizardInputs, language: OfferLanguage, today: string): WizardContext {
  const { deal, profile } = inputs;
  const facts = estimateFacts(inputs.estimate, language);
  return {
    language,
    today,
    dealTitle: deal.title,
    currency: deal.currency,
    dealAmountCents: deal.amountCents === null ? null : Number(deal.amountCents),
    issuerLegalName: inputs.issuer.legalName,
    issuerAddressLines: inputs.issuer.address[language],
    placeOfIssue: profile?.placeOfIssue ?? DEFAULT_PLACE,
    clientLines: clientLinesBoth(inputs),
    contacts: inputs.contacts,
    attachments: inputs.attachments,
    estimate: inputs.estimate ? { state: inputs.estimateState, ...facts } : null,
  };
}

const annexOf = (estimate: EstimateDocument, language: OfferLanguage, aiAssisted: boolean): Scope =>
  buildScope(estimate, { aiAssisted, ...scopeLabels(language) });

/** The body of `GET /deals/{id}/offer-wizard/context`: no language (the browser takes the template's), the server's day. */
export async function contextResponse(inputs: WizardInputs, today: string) {
  const { deal, profile, issuer, estimate } = inputs;
  // The route is read before a template is chosen (DD-41), so the two labels that depend on the language are Italian here.
  const facts = estimateFacts(estimate, "it");
  const latest = await latestOffer(db, deal.id);
  const snapshot = latest ? (latest.snapshot as unknown as StoredSnapshot) : null;
  return {
    dealTitle: deal.title,
    currency: deal.currency,
    dealAmountCents: deal.amountCents === null ? null : Number(deal.amountCents),
    // The registry's values as they are, also for an incomplete entity (an autosave is never refused; generation and the previews are where
    // incompleteness refuses, E4): the legal name and the address in each language.
    issuerLegalName: issuer.legalName,
    issuerAddress: { it: [...issuer.address.it], en: [...issuer.address.en] },
    // The Italian address, kept for an old crm-ui until step 6.
    issuerAddressLines: [...issuer.address.it],
    // Whether there is a classic letterhead (DD-54, DD-57); never the key or a link: the browser asks the profile's link route.
    letterhead: profile?.letterheadKey != null,
    placeOfIssue: profile?.placeOfIssue ?? DEFAULT_PLACE,
    clientLines: clientLinesBoth(inputs),
    contacts: inputs.contacts,
    attachments: inputs.attachments,
    estimate: {
      state: inputs.estimateState,
      ...facts,
      annex: estimate
        ? { it: annexOf(estimate, "it", false), en: annexOf(estimate, "en", false), itAi: annexOf(estimate, "it", true), enAi: annexOf(estimate, "en", true) }
        : null,
    },
    latestOffer:
      latest && snapshot
        ? { id: latest.id, reference: snapshot.reference, sent: latest.sentAt !== null, version: latest.version, origin: offerOrigin(snapshot) }
        : null,
    today,
  };
}

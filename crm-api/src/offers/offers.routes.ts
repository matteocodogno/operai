/**
 * Offer documents (specs/20261101-crm-sales-flow US-4; specs/20261102-crm-offer-document plan.md § API).
 *
 *   GET    /deals/{id}/offers                      versions, deleted ones included (the gap is visible)
 *   GET    /deals/{id}/offers/draft?templateId=    the dialog prefill from a template (placeholders resolved)
 *   POST   /deals/{id}/offers                      generate the next version from a template-based body
 *   GET    /deals/{id}/offers/{offerId}/download   60 s presigned GET
 *   DELETE /deals/{id}/offers/{offerId}            author or admin; the number is never reused
 *
 * Every route is financial (`deal:financials`, ADR 20261101-crm-financial-visibility-permission): an offer prints the
 * price. Drafting and generating also need `deal:manage` over the deal's entity
 * and a ready estimate. The PDF is rendered here from a snapshot that is stored
 * with the row, so the figures a client received can always be shown again; it
 * lives in the CRM's EU bucket. Generating reads the entity's letterhead and the
 * chosen deal PDFs from that bucket (ADR 20261102-crm-api-reads-attachment-bytes-for-offer-annexes): sizes are bounded from the
 * database before any byte is read.
 *
 * The reference is `NNNN/YYYY` (D-5): the next number of the deal's entity in
 * the year of the deal's first offer, then `r1`, `r2`… for each later version of
 * the same deal. Specs/018 offers (`OF-…`, no `kind` in their snapshot) keep
 * listing and downloading as they were.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  DEAL_FINANCIALS,
  DEAL_MANAGE,
  authorized,
  dealScope,
  managesAllDeals,
  requireCapability,
} from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { getEstimate, type EstimateDocument } from "../lib/estimai";
import {
  IdParams,
  PersonRefSchema,
  assertVersion,
  commonErrors,
  pdfCheckErrors,
  etag,
  requireIfMatch,
  versionConflict,
  type HeaderSource,
  idText,
} from "../lib/http";
import { env } from "../lib/env";
import { MAX_NAME, announce, clip } from "../lib/notify";
import { loadPeople } from "../lib/people";
import { conflict, forbidden, notFound, validationHook } from "../lib/problem";
import { requireStorage } from "../lib/storage";
import { assertInScope } from "../deals/deals.routes";
import type { ContractSnapshot } from "./contract";
import { DEFAULT_VALIDITY_DAYS, buildDraft, type OfferPrefill } from "./draft";
import {
  blocksRevision,
  createOfferVersion,
  inOfferTransaction,
  isContract,
  latestOffer,
  assertLegacyTemplate,
  legalEntitiesRetryAfter,
  letterheadProfileOf,
  loadContext,
  notSent,
  offerOrigin,
  prepareOffer,
  referenceFileName,
  renderOffer,
  renderOfferThroughService,
  renderedOf,
  snapshotOf,
  type OfferRow,
  type Prepared,
  type Rendered,
  type StoredSnapshot,
} from "./generation";
import { snapshotToBlocks } from "./blocks";
import { legacyContent } from "./legacyContent";
import { CostColumnsSchema, GenerateOfferSchema, OfferSchema, SectionSchema } from "./offerSchemas";
import { roundHalfUp, totalManDays } from "./scope";

export { offerReference, offerReferenceOf } from "./generation";
export { DEFAULT_VALIDITY_DAYS };

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });
const financial = [...authorized, requireCapability(DEAL_FINANCIALS)];
const generating = [...authorized, requireCapability(DEAL_FINANCIALS), requireCapability(DEAL_MANAGE)];

const OfferParams = z.object({ id: idText(), offerId: idText() });

const DraftCostLineSchema = z.object({
  description: z.string(),
  kind: z.enum(["one_off", "yearly", "discount"]),
  unitCents: z.number().int().nullable(),
  percentBp: z.number().int().nullable(),
  quantity: z.number().int(),
});

/** The dialog prefill: every field the generate body takes, plus the template's identity. */
const DraftSchema = z.object({
  templateId: z.string(),
  templateName: z.string(),
  language: z.enum(["en", "it"]),
  currency: z.enum(["CHF", "EUR"]),
  salutation: z.string(),
  clientLines: z.array(z.string()),
  opening: z.string(),
  sections: z.array(SectionSchema),
  costColumns: CostColumnsSchema,
  showTotal: z.boolean(),
  costLines: z.array(DraftCostLineSchema),
  acceptanceLabel: z.string().nullable(),
  annex: z.boolean(),
  validityDays: z.number().int(),
  aiAssisted: z.boolean(),
  /** The estimate's total expected man-days, rounded half up (AI-assisted when asked). */
  manDays: z.number().int(),
});

const DraftQuery = z.object({
  templateId: idText(),
  aiAssisted: z.enum(["true", "false"]).default("false"),
});

export async function toViews(c: HeaderSource, rows: readonly OfferRow[]) {
  const { person } = await loadPeople(c, rows.flatMap((row) => [row.createdBy, ...(row.sentBy ? [row.sentBy] : [])]));
  return rows.map((row) => {
    const snapshot = row.snapshot as unknown as StoredSnapshot;
    const common = {
      id: row.id,
      number: row.number,
      reference: snapshot.reference,
      language: row.language,
      priceCents: Number(row.priceCents),
      currency: row.currency,
      validityDays: row.validityDays,
      validUntil: snapshot.validUntil,
      sizeBytes: row.sizeBytes,
      createdBy: person(row.createdBy),
      createdAt: row.createdAt.toISOString(),
      deleted: row.deletedAt !== null,
      sent: row.sentAt ? { at: row.sentAt.toISOString(), by: person(row.sentBy ?? row.createdBy) } : null,
      version: row.version,
      origin: offerOrigin(snapshot),
      letterheadVersion: row.letterheadVersion,
    };
    return isContract(snapshot)
      ? {
          ...common,
          yearlyCents: snapshot.costs.yearlyCents,
          aiAssisted: snapshot.aiAssisted,
          manDaysTenths: snapshot.annex?.manDaysTenths ?? 0,
          templateName: snapshot.template.name,
        }
      : {
          ...common,
          yearlyCents: 0,
          aiAssisted: snapshot.scope.aiAssisted,
          manDaysTenths: snapshot.scope.manDaysTenths,
          templateName: null,
        };
  });
}

const listRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offers",
  tags: ["Offers"],
  summary: "Offer versions of a deal (deal:financials)",
  middleware: financial,
  request: { params: IdParams },
  responses: { 200: { description: "Offers, newest first", ...json(z.object({ items: z.array(OfferSchema) })) }, 404: { description: "Not found" }, ...commonErrors },
});

const draftRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offers/draft",
  tags: ["Offers"],
  summary: "The generate dialog's prefill from a template (deal:manage in scope + deal:financials)",
  description:
    "Resolves the template's placeholders against the deal, the company and the ready estimate. " +
    "404 when the template does not exist or belongs to another entity, 409 `template_archived`, " +
    "409 `estimate_not_ready`, 409 `legal_entity_incomplete` (the registry's details of the entity are incomplete), 503 `legal_entities_unavailable` with `Retry-After: 5`.",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: { params: IdParams, query: DraftQuery },
  responses: {
    200: { description: "The prefill", ...json(DraftSchema) },
    404: { description: "Deal or template not found" },
    409: { description: "estimate_not_ready / legal_entity_incomplete / template_archived / template_format_mismatch" },
    ...commonErrors,
    503: { description: "legal_entities_unavailable (Retry-After: 5), or the authorization service is unavailable" },
  },
});

/**
 * The renderer of a classic offer (a legacy-template contract): crm-api's own pages, or with the switch on (AC-10.1, AC-10.8)
 * the layout service's, from the same snapshot the offer stores and the entity profile as it is now (AC-10.10). Read once per
 * request. With the switch on the service draws every page, the letterhead included, and the chosen deal PDFs follow them.
 */
function rendererOf(prepared: Prepared): (snapshot: ContractSnapshot) => Promise<Rendered> {
  if (!env.LETTERHEAD_SERVICE_ENABLED) return (snapshot) => renderOffer(snapshot, prepared);
  return (snapshot) =>
    renderOfferThroughService(
      snapshotToBlocks(snapshot, letterheadProfileOf(prepared.issuer, snapshot.language, prepared.profile?.placeOfIssue ?? null), prepared.deal.entity),
      {
        fileNames: prepared.attachments.map((attachment) => attachment.fileName),
        bytes: prepared.attachmentBytes,
      },
    );
}

const generateRoute = createRoute({
  method: "post",
  path: "/deals/{id}/offers",
  tags: ["Offers"],
  summary: "Generate the next offer version (deal:manage in scope + deal:financials)",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: { params: IdParams, body: { content: { "application/json": { schema: GenerateOfferSchema } }, required: true } },
  responses: {
    ...commonErrors,
    ...pdfCheckErrors,
    201: { description: "Generated", ...json(OfferSchema) },
    404: { description: "Not found" },
    503: {
      ...pdfCheckErrors[503],
      description: `${pdfCheckErrors[503].description} With the switch on, also \`layout_service_unavailable\` (the layout service cannot be reached or is busy: no offer, no number, no PDF; try again), and \`legal_entities_unavailable\` (the registry of the issuer's details cannot be read; \`Retry-After: 5\`).`,
    },
    409: {
      description:
        "estimate_not_ready / legal_entity_incomplete (`entity`, `missing[]`: the registry says the issuer is incomplete; no number is used) / template_archived / template_format_mismatch / " +
        "letterhead_unusable (switch off only: the stored letterhead of the deal's entity fails the check: `entity`, `reason`; nothing is rendered or written; upload the letterhead again) / " +
        "letterhead_not_configured (switch on: the entity has no active letterhead in the service) / letterhead_overflow (switch on: `frame`, `entity`); nothing is stored, no number is consumed",
    },
    422: {
      description:
        "Validation; contact_not_in_company, attachment_invalid, attachment_not_pdf, attachments_too_large, " +
        "attachment_unreadable (names the file), discounts_exceed_one_off, cost_total_too_large",
    },
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offers/{offerId}/download",
  tags: ["Offers"],
  summary: "A short-lived download link for an offer PDF",
  middleware: financial,
  request: { params: OfferParams },
  responses: { 200: { description: "Presigned URL", ...json(z.object({ url: z.string() })) }, 404: { description: "Not found" }, ...commonErrors },
});

const formRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offers/{offerId}/form",
  tags: ["Offers"],
  summary: "The dialog's prefill from an offer: to edit it, or to start its next revision (specs/20261102-crm-offer-document US-7)",
  middleware: generating,
  request: { params: OfferParams },
  responses: {
    200: {
      description: "The prefill, with the offer's contacts, still-stored PDFs, version and sent state",
      ...json(
        DraftSchema.extend({
          contactIds: z.array(z.string()),
          attachmentIds: z.array(z.string()),
          version: z.number().int(),
          sent: z.boolean(),
        }),
      ),
    },
    404: { description: "Not found" },
    409: { description: "offer_legacy / offer_wizard" },
    ...commonErrors,
  },
});

const editRoute = createRoute({
  method: "put",
  path: "/deals/{id}/offers/{offerId}",
  tags: ["Offers"],
  summary: "Edit an offer that has not been sent: same reference, new PDF (If-Match required)",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: { params: OfferParams, body: { content: { "application/json": { schema: GenerateOfferSchema } }, required: true } },
  responses: {
    ...commonErrors,
    ...pdfCheckErrors,
    200: { description: "Edited", ...json(OfferSchema) },
    404: { description: "Not found" },
    409: {
      description:
        "offer_sent / offer_not_latest / offer_legacy / offer_wizard / version_conflict / template_archived / legal_entity_incomplete (`entity`, `missing[]`) / " +
        "letterhead_not_configured / letterhead_overflow (switch on: nothing is stored, the offer is as it was)",
    },
    428: { description: "precondition_required" },
    503: {
      ...pdfCheckErrors[503],
      description: `${pdfCheckErrors[503].description} With the switch on, also \`layout_service_unavailable\` (the layout service cannot be reached or is busy: the offer is as it was; try again), and \`legal_entities_unavailable\` (the registry of the issuer's details cannot be read; \`Retry-After: 5\`).`,
    },
  },
});

const sentRoute = createRoute({
  method: "post",
  path: "/deals/{id}/offers/{offerId}/sent",
  tags: ["Offers"],
  summary: "Mark an offer sent: it is frozen, and the deal moves to \"Offer sent\" (specs/20261102-crm-offer-document US-7)",
  middleware: generating,
  request: { params: OfferParams },
  responses: { 200: { description: "The offer", ...json(OfferSchema) }, 404: { description: "Not found" }, ...commonErrors },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/deals/{id}/offers/{offerId}",
  tags: ["Offers"],
  summary: "Delete an offer version (author or admin); its number stays used",
  middleware: financial,
  request: { params: OfferParams },
  responses: { 204: { description: "Deleted" }, 404: { description: "Not found" }, ...commonErrors },
});

export const offersRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

/** The prefill reads a template's legacy columns through `legacyContent` (a wizard template is a 409). */
const templateContentOf = legacyContent;

/** The stand-in for a deal that goes without an estimate: no releases, no activities. */
const NO_ESTIMATE: EstimateDocument = { id: "", name: "", content: { params: {}, releases: [], acts: [] } };

offersRouter.openapi(listRoute, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await db.deal.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Deal not found");
  const rows = await db.dealOffer.findMany({ where: { dealId: id }, orderBy: { number: "desc" } });
  return c.json({ items: await toViews(c, rows) }, 200);
});

offersRouter.openapi(draftRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { templateId, aiAssisted } = c.req.valid("query");
  const { deal, link, issuer, template } = await loadContext(id, templateId, dealScope(c));
  assertLegacyTemplate(template);
  const estimate = link ? await getEstimate(c, link.estimateId) : NO_ESTIMATE;
  const built = buildDraft({
    template: templateContentOf(template),
    deal: { title: deal.title, amountCents: deal.amountCents === null ? null : Number(deal.amountCents), currency: deal.currency },
    company: deal.company,
    issuerLegalName: issuer.legalName,
    estimate,
    aiAssisted: aiAssisted === "true",
    validityDays: DEFAULT_VALIDITY_DAYS,
  });
  // Without an estimate there is no scope to append.
  const draft: OfferPrefill = link ? built : { ...built, annex: false };
  return c.json(draft, 200);
});

offersRouter.openapi(generateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const latest = await latestOffer(db, id);
  if (blocksRevision(latest)) throw notSent(latest);
  const prepared = await prepareOffer(c, dealScope(c), id, body);
  const { deal } = prepared;
  const issued = new Date();
  const render = rendererOf(prepared);

  const created = await inOfferTransaction(id, async (tx) => {
    const newest = await latestOffer(tx, id);
    if (blocksRevision(newest)) throw notSent(newest);
    return createOfferVersion(tx, {
      dealId: id,
      entity: deal.entity,
      currency: deal.currency,
      storage: prepared.storage,
      issued,
      userId,
      language: prepared.language,
      priceCents: prepared.costs.oneOffCents,
      validityDays: body.validityDays,
      snapshotFor: (reference) => snapshotOf(prepared, body, reference, issued),
      render,
    });
  });
  const [view] = await toViews(c, [created]);
  // E9 — the owner learns an offer exists (no figure in it, AC-1.2).
  await announce(c, {
    kind: "offer_generated",
    dealId: id,
    recipientIds: [deal.ownerUserId],
    severity: "info",
    email: false,
    href: `/crm/deals/${id}`,
    copy: (actor) => ({
      title: `Offer generated: ${clip(deal.title, MAX_NAME)}`,
      body: `${actor} generated offer ${view!.reference} for ${clip(deal.title, MAX_NAME)} (${clip(deal.company.name, MAX_NAME)}).`,
    }),
  });
  c.header("ETag", etag(created.version));
  return c.json(view!, 201);
});

/** The offer of this deal, not deleted, generated from a template (specs/20261102-crm-offer-document), or a 404/409. */
async function editableTarget(dealId: string, offerId: string) {
  const offer = await db.dealOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.dealId !== dealId || offer.deletedAt) throw notFound("Offer not found");
  if (!isContract(offer.snapshot as unknown as StoredSnapshot)) {
    throw conflict("offer_legacy", "An offer generated before offer documents cannot be edited or revised", { offerId });
  }
  if (offerOrigin(offer.snapshot as unknown as StoredSnapshot) === "wizard") {
    throw conflict("offer_wizard", "An offer made with the wizard is edited through a draft, not the classic dialog", { offerId });
  }
  return offer;
}

offersRouter.openapi(formRoute, async (c) => {
  const { id, offerId } = c.req.valid("param");
  const offer = await editableTarget(id, offerId);
  const deal = await db.deal.findUnique({ where: { id }, include: { estimate: true } });
  if (!deal) throw notFound("Deal not found");
  assertInScope(dealScope(c), deal.entity);
  const snapshot = offer.snapshot as unknown as ContractSnapshot;
  // The PDFs it appended that are still this deal's: a removed one is simply not offered again.
  const stored = await db.dealAttachment.findMany({
    where: { id: { in: snapshot.attachments.map((ref) => ref.id) }, dealId: id, status: "stored", deletedAt: null },
    select: { id: true },
  });
  const storedIds = new Set(stored.map((row) => row.id));
  const link = deal.estimate?.estimateId ? deal.estimate : null;
  const manDays = link ? roundHalfUp(totalManDays(await getEstimate(c, link.estimateId), snapshot.aiAssisted)) : 0;
  c.header("ETag", etag(offer.version));
  return c.json(
    {
      templateId: snapshot.template.id,
      templateName: snapshot.template.name,
      language: snapshot.language,
      currency: snapshot.costs.currency,
      salutation: snapshot.salutation,
      clientLines: [...snapshot.clientLines],
      opening: snapshot.opening,
      sections: [...snapshot.sections],
      costColumns: snapshot.costs.columns,
      showTotal: snapshot.costs.showTotal,
      costLines: snapshot.costs.lines.map(({ description, kind, unitCents, percentBp, quantity }) => ({
        description,
        kind,
        unitCents,
        percentBp,
        quantity,
      })),
      acceptanceLabel: snapshot.acceptanceLabel,
      annex: snapshot.annex !== null,
      validityDays: snapshot.validityDays,
      aiAssisted: snapshot.aiAssisted,
      manDays,
      contactIds: [...(snapshot.contactIds ?? [])],
      attachmentIds: snapshot.attachments.map((ref) => ref.id).filter((attachmentId) => storedIds.has(attachmentId)),
      version: offer.version,
      sent: offer.sentAt !== null,
    },
    200,
  );
});

offersRouter.openapi(editRoute, async (c) => {
  const { id, offerId } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const expected = requireIfMatch(c);
  const offer = await editableTarget(id, offerId);
  assertVersion(offer.version, expected);
  if (offer.sentAt) {
    throw conflict("offer_sent", "This offer has been sent: make a new revision instead", { offerId });
  }
  const prepared = await prepareOffer(c, dealScope(c), id, body);
  const issued = new Date();
  const previousKey = offer.objectKey;
  const render = rendererOf(prepared);

  const updated = await inOfferTransaction(
    id,
    async (tx) => {
      const newest = await latestOffer(tx, id);
      if (newest?.id !== offerId) {
        throw conflict("offer_not_latest", "Only the newest version of an offer can be edited", { offerId });
      }
      const reference = (offer.snapshot as unknown as ContractSnapshot).reference;
      const snapshot = snapshotOf(prepared, body, reference, issued);
      const { pdf, letterheadVersion } = renderedOf(await render(snapshot));
      const objectKey = `offers/${id}/${crypto.randomUUID()}.pdf`;
      await prepared.storage.putObject(objectKey, pdf, "application/pdf");
      // Compare-and-set on the version, and never on a sent offer.
      const changed = await tx.dealOffer.updateMany({
        where: { id: offerId, version: expected, sentAt: null, deletedAt: null },
        data: {
          language: prepared.language,
          priceCents: BigInt(prepared.costs.oneOffCents),
          currency: prepared.deal.currency,
          validityDays: body.validityDays,
          snapshot: snapshot as unknown as object,
          objectKey,
          sizeBytes: pdf.byteLength,
          // The version of the letterhead this PDF was drawn with, or null when crm-api drew it (AC-10.2).
          letterheadVersion,
          version: { increment: 1 },
          updatedBy: userId,
          updatedAt: issued,
        },
      });
      if (changed.count === 0) {
        await prepared.storage.deleteObject(objectKey).catch(() => undefined);
        const now = await tx.dealOffer.findUnique({ where: { id: offerId }, select: { version: true, sentAt: true } });
        if (now?.sentAt) throw conflict("offer_sent", "This offer has been sent: make a new revision instead", { offerId });
        throw versionConflict(now?.version ?? expected);
      }
      return tx.dealOffer.findUniqueOrThrow({ where: { id: offerId } });
    },
  );
  // The old PDF is unreachable now; a failed delete leaves an orphan, never a wrong document.
  await prepared.storage.deleteObject(previousKey).catch((error: unknown) => {
    console.error("[offers] could not delete the replaced PDF:", previousKey, error instanceof Error ? error.message : error);
  });
  const [view] = await toViews(c, [updated]);
  c.header("ETag", etag(updated.version));
  return c.json(view!, 200);
});

offersRouter.openapi(sentRoute, async (c) => {
  const { id, offerId } = c.req.valid("param");
  const userId = c.get("userId");
  const offer = await db.dealOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.dealId !== id || offer.deletedAt) throw notFound("Offer not found");
  const deal = await db.deal.findUnique({ where: { id }, select: { entity: true, stage: true } });
  if (!deal) throw notFound("Deal not found");
  assertInScope(dealScope(c), deal.entity);
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    // Idempotent: a second "sent" keeps the first moment and person.
    if (!offer.sentAt) {
      await tx.dealOffer.update({
        where: { id: offerId },
        data: { sentAt: now, sentBy: userId, version: { increment: 1 } },
      });
    }
    // AC-7.3: the deal moves to "Offer sent" when it was before it.
    if (SENDABLE_STAGES.includes(deal.stage)) {
      await tx.deal.update({
        where: { id },
        data: { stage: "negotiation", closedAt: null, lostReason: null, version: { increment: 1 }, updatedBy: userId },
      });
    }
    return tx.dealOffer.findUniqueOrThrow({ where: { id: offerId } });
  });
  const [view] = await toViews(c, [updated]);
  c.header("ETag", etag(updated.version));
  return c.json(view!, 200);
});

/** The stages from which marking an offer sent moves the deal to `negotiation` ("Offer sent"). */
const SENDABLE_STAGES: readonly string[] = ["lead", "qualified", "proposal"];

offersRouter.openapi(downloadRoute, async (c) => {
  const { id, offerId } = c.req.valid("param");
  const offer = await db.dealOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.dealId !== id || offer.deletedAt) throw notFound("Offer not found");
  const snapshot = offer.snapshot as unknown as StoredSnapshot;
  const url = await requireStorage().mintPresignedGet(offer.objectKey, {
    contentType: "application/pdf",
    fileName: referenceFileName(snapshot.reference),
  });
  return c.json({ url }, 200);
});

offersRouter.openapi(deleteRoute, async (c) => {
  const { id, offerId } = c.req.valid("param");
  const userId = c.get("userId");
  const offer = await db.dealOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.dealId !== id || offer.deletedAt) throw notFound("Offer not found");
  if (offer.createdBy !== userId && !managesAllDeals(c)) {
    throw forbidden("Only the author or an admin deletes an offer", "author_only");
  }
  await db.dealOffer.update({ where: { id: offerId }, data: { deletedAt: new Date(), deletedBy: userId } });
  try {
    await requireStorage().deleteObject(offer.objectKey);
  } catch (error) {
    // The row is what the CRM shows; an object left behind is unreachable without it.
    console.error("[offers] could not delete the PDF object:", offer.objectKey, error instanceof Error ? error.message : error);
  }
  return c.body(null, 204);
});

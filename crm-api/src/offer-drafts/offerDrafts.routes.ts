/**
 * The offer wizard's draft (specs/20261115-crm-offer-wizard; ADR 20261115-offer-draft-server-held-generated-from-stored-state):
 *
 *   GET    /deals/{id}/offer-wizard/context        what the wizard knows about the deal (no language: the template's, DD-41)
 *   GET    /deals/{id}/offer-draft                 the deal's one draft, answers included
 *   GET    /deals/{id}/offer-draft/summary         what the deal page needs, never the answers (DD-27)
 *   POST   /deals/{id}/offer-draft                 start a draft; the answers are built here (If-None-Match: *)
 *   POST   /deals/{id}/offer-draft/preview         the pages the layout service draws for an UNSAVED body (switch on; stores nothing)
 *
 * Every route is "generating": `deal:financials` + `deal:manage`, then the deal is loaded (404) and its entity checked
 * (403 `out_of_scope`) BEFORE anything about a draft is read, so the answer to a caller outside the gate or the scope is
 * the same whether a draft exists or not (AC-6.2). Responses carry the deal's client data and the person's answers, so
 * they are `Cache-Control: no-store`; nothing here logs a body.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { DEAL_FINANCIALS, DEAL_MANAGE, authorized, dealScope, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { IdParams, PersonRefSchema, assertVersion, commonErrors, pdfCheckErrors, etag, requireIfMatch, versionConflict, type HeaderSource } from "../lib/http";
import { loadPeople } from "../lib/people";
import { ProblemError, conflict, notFound, problem, unprocessable, validationHook } from "../lib/problem";
import type { ContractSnapshot } from "../offers/contract";
import { MAX_NAME, announce, clip } from "../lib/notify";
import { requireStorage } from "../lib/storage";
import { usableLetterhead } from "../entity-profiles/letterheadUse";
import { OfferSchema } from "../offers/offerSchemas";
import { toViews } from "../offers/offers.routes";
import { resolveOffer, type ResolvedOffer } from "../offers/engine/resolve";
import { scopeLabels } from "../offers/pdf";
import { buildScope } from "../offers/scope";
import {
  blocksRevision,
  createOfferVersion,
  inOfferTransaction,
  isContract,
  isoDate,
  latestOffer,
  loadAttachments,
  loadDealInScope,
  notSent,
  renderOffer,
  renderOfferThroughService,
  renderedOf,
  legalEntitiesRetryAfter,
  issuerValuesOf,
  letterheadProfileOf,
  wizardSnapshotOf,
  type OfferRow,
  type StoredSnapshot,
} from "../offers/generation";
import { checkAnswers, initialAnswers, reconcileAnswers, switchTemplate, type WizardAnswers } from "../offers/engine/answers";
import type { TemplateAst } from "../offers/engine/syntax";
import { parseTemplate } from "../offers/engine/syntax";
import type { Prisma } from "../lib/generated/prisma/client";
import { isDeepStrictEqual } from "node:util";
import { draftToBlocks } from "../offers/blocks";
import { PreviewQuerySchema, PreviewResponseSchema, previewThroughService, requireLetterheadService } from "../offers/contentSchema";
import { AnswersSchema, PutDraftSchema, PutTargetSchema, TemplateIdSchema, jsonPath, parseStoredAnswers } from "./answersSchema";
import { contextResponse, loadWizardInputs, serverToday, wizardContextOf } from "./context";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });
const generating = [...authorized, requireCapability(DEAL_FINANCIALS), requireCapability(DEAL_MANAGE)];

// ─── Shapes ──────────────────────────────────────────────────────────────────

const TargetSchema = z.union([
  z.object({ kind: z.literal("new") }),
  z.object({ kind: z.enum(["edit", "revision"]), offerId: z.string(), offerVersion: z.number().int(), reference: z.string() }),
]);

const TemplateRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.enum(["en", "it"]),
  version: z.number().int(),
  archived: z.boolean(),
});

const DraftViewSchema = z.object({
  dealId: z.string(),
  template: TemplateRefSchema,
  templateVersion: z.number().int(),
  target: TargetSchema,
  answers: z.record(z.string(), z.unknown()),
  version: z.number().int(),
  updatedBy: PersonRefSchema,
  updatedAt: z.string(),
  createdAt: z.string(),
});

const DraftSummarySchema = z.object({
  dealId: z.string(),
  template: TemplateRefSchema.omit({ version: true }),
  templateChanged: z.boolean(),
  target: TargetSchema,
  version: z.number().int(),
  updatedBy: PersonRefSchema,
  updatedAt: z.string(),
  createdAt: z.string(),
});

const CreateDraftSchema = z
  .object({
    templateId: TemplateIdSchema.optional(),
    target: PutTargetSchema.optional(),
  })
  .strict();

// ─── Reading a draft ─────────────────────────────────────────────────────────

const referenceOf = (snapshot: unknown): string => (snapshot as StoredSnapshot).reference;

type DraftTargetRow = {
  targetKind: "new" | "edit" | "revision";
  targetOfferId: string | null;
  targetOfferVersion: number | null;
  targetOffer: { snapshot: unknown } | null;
};

function targetOf(row: DraftTargetRow) {
  if (row.targetKind === "new" || row.targetOfferId === null || row.targetOfferVersion === null || row.targetOffer === null) {
    return { kind: "new" as const };
  }
  return {
    kind: row.targetKind,
    offerId: row.targetOfferId,
    offerVersion: row.targetOfferVersion,
    reference: referenceOf(row.targetOffer.snapshot),
  };
}

const draftWith = { template: true, targetOffer: { select: { snapshot: true } } } as const;
type DraftRow = NonNullable<Awaited<ReturnType<typeof findDraft>>>;
const findDraft = (dealId: string) => db.offerDraft.findUnique({ where: { dealId }, include: draftWith });

/** The stored answers as the engine may read them: re-validated (ADR § Decision 4); a row that no longer fits is 409 `draft_invalid`. */
function storedAnswers(row: { answers: unknown }): WizardAnswers {
  const answers = parseStoredAnswers(row.answers);
  if (!answers) {
    throw conflict("draft_invalid", "The stored draft is not valid any more: discard it and start again");
  }
  return answers;
}

const draftNotFound = () => new ProblemError({ status: 404, code: "draft_not_found", detail: "This deal has no offer draft" });

/** 422 `answers_invalid` naming where (a JSON path under `answers`, or `templateVersion` / `target`). */
const answersInvalid = (path: string, reason: string) =>
  new ProblemError({ status: 422, code: "answers_invalid", detail: `The answers are not valid at "${path}" (${reason})`, extras: { path, reason } });

/** What a draft built or rebuilt here must satisfy before it is stored: the caps, and the engine's check of its text. */
function assertAnswersFit(ast: TemplateAst, answers: WizardAnswers): void {
  const parsed = AnswersSchema.safeParse(answers);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw answersInvalid(jsonPath(issue.path), "shape");
  }
  const [issue] = checkAnswers(ast, answers);
  if (issue) throw answersInvalid(issue.path, issue.code);
}

async function viewOf(c: HeaderSource, row: DraftRow) {
  const answers = storedAnswers(row);
  const { person } = await loadPeople(c, [row.updatedBy]);
  return {
    dealId: row.dealId,
    template: {
      id: row.template.id,
      name: row.template.name,
      language: row.template.language,
      version: row.template.version,
      archived: row.template.archivedAt !== null,
    },
    templateVersion: row.templateVersion,
    target: targetOf(row),
    answers: answers as unknown as Record<string, unknown>,
    version: row.version,
    updatedBy: person(row.updatedBy),
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * The members the issuer's block adds to the context (DD-54, DD-57, DD-61); the rest is documented in the route's
 * description and passes through. `issuerLegalName` is the registry's, as it is: a blank one is the browser's reason to block Generate. `issuerAddress` holds both languages.
 */
const ContextSchema = z
  .object({
    issuerLegalName: z.string(),
    issuerAddress: z.object({ it: z.array(z.string()), en: z.array(z.string()) }).describe("The issuer's address lines in each language, from the legal entities registry"),
    issuerAddressLines: z.array(z.string()).describe("The Italian address lines, kept for an old browser"),
    letterhead: z.boolean().describe("The entity profile has a letterhead; the bytes come through GET /entity-profiles/{entity}/letterhead"),
  })
  .passthrough();

const contextRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offer-wizard/context",
  tags: ["Offer wizard"],
  summary: "What the wizard knows about the deal (deal:manage in scope + deal:financials)",
  description:
    "The issuer's legal name and address lines (`issuerAddress`: Italian and English; `issuerAddressLines`: the Italian, for an old browser) as the legal entities registry holds them, also when it is incomplete (the answer is 200: an autosave is never refused; generation and the previews refuse), whether it has a letterhead (never a link), the client block per language, contacts, place of issue, stored PDFs, the estimate's figures and the server's UTC day (`today`). " +
    "It has no `language`: the browser takes the template's (DD-41). `Cache-Control: no-store`.",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: { params: IdParams },
  responses: {
    200: { description: "The context", ...json(ContextSchema) },
    404: { description: "Deal not found" },
    ...commonErrors,
    503: { description: "legal_entities_unavailable (Retry-After: 5), or the authorization service is unavailable" },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offer-draft",
  tags: ["Offer wizard"],
  summary: "The deal's offer draft",
  middleware: generating,
  request: { params: IdParams },
  responses: {
    200: { description: "The draft", ...json(DraftViewSchema) },
    404: { description: "deal_not_found / draft_not_found" },
    ...commonErrors,
  },
});

const summaryRoute = createRoute({
  method: "get",
  path: "/deals/{id}/offer-draft/summary",
  tags: ["Offer wizard"],
  summary: "The draft without its answers, for the deal page (DD-27)",
  description: "`{ draft: null }` when there is none (absence is the common answer). Same gate and scope as the draft.",
  middleware: generating,
  request: { params: IdParams },
  responses: {
    200: { description: "The summary", ...json(z.object({ draft: DraftSummarySchema.nullable() })) },
    404: { description: "Deal not found" },
    ...commonErrors,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/deals/{id}/offer-draft",
  tags: ["Offer wizard"],
  summary: "Start the deal's offer draft (If-None-Match: * required)",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: { params: IdParams, body: { content: { "application/json": { schema: CreateDraftSchema } }, required: true } },
  responses: {
    ...commonErrors,
    201: { description: "Created", ...json(DraftViewSchema) },
    404: { description: "Deal or template not found" },
    409: { description: "draft_exists / estimate_not_ready / template_archived / template_format_mismatch / offer_not_sent" },
    422: { description: "template_required" },
    428: { description: "precondition_required" },
  },
});

export const offerDraftsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

const noStore = (c: { header(name: string, value: string): void }) => c.header("Cache-Control", "no-store");

offerDraftsRouter.openapi(contextRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { deal } = await loadDealInScope(id, dealScope(c));
  const inputs = await loadWizardInputs(c, deal, { requireEstimate: false, archivedContacts: false, requireCompleteIssuer: false });
  noStore(c);
  return c.json(await contextResponse(inputs, serverToday()), 200);
});

offerDraftsRouter.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  await loadDealInScope(id, dealScope(c));
  const row = await findDraft(id);
  if (!row) throw draftNotFound();
  noStore(c);
  c.header("ETag", etag(row.version));
  return c.json(await viewOf(c, row), 200);
});

offerDraftsRouter.openapi(summaryRoute, async (c) => {
  const { id } = c.req.valid("param");
  await loadDealInScope(id, dealScope(c));
  // One query that never selects `answers` (DD-27).
  const row = await db.offerDraft.findUnique({
    where: { dealId: id },
    select: {
      dealId: true,
      templateVersion: true,
      targetKind: true,
      targetOfferId: true,
      targetOfferVersion: true,
      version: true,
      updatedBy: true,
      updatedAt: true,
      createdAt: true,
      template: { select: { id: true, name: true, language: true, version: true, archivedAt: true } },
      targetOffer: { select: { snapshot: true } },
    },
  });
  noStore(c);
  if (!row) return c.json({ draft: null }, 200);
  const { person } = await loadPeople(c, [row.updatedBy]);
  c.header("ETag", etag(row.version));
  return c.json(
    {
      draft: {
        dealId: row.dealId,
        template: { id: row.template.id, name: row.template.name, language: row.template.language, archived: row.template.archivedAt !== null },
        templateChanged: row.templateVersion !== row.template.version,
        target: targetOf(row),
        version: row.version,
        updatedBy: person(row.updatedBy),
        updatedAt: row.updatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
    },
    200,
  );
});

/** A wizard template of the deal's entity that is active: 404 for another entity's, 409 archived / not a wizard template. */
export async function loadWizardTemplate(templateId: string, entity: "welld_ch" | "welld_it") {
  const template = await db.offerTemplate.findUnique({ where: { id: templateId } });
  if (!template || template.entity !== entity) throw notFound("Template not found");
  if (template.archivedAt) throw conflict("template_archived", "This template is archived; choose an active one", { templateId });
  if (template.format !== "wizard" || template.source === null) {
    throw conflict("template_format_mismatch", "This template is not a wizard template", { templateId });
  }
  return { ...template, source: template.source };
}

const requireIfNoneMatch = (c: HeaderSource): void => {
  if (c.req.header("If-None-Match")?.trim() !== "*") {
    throw new ProblemError({
      status: 428,
      code: "precondition_required",
      detail: "Creating a draft needs an If-None-Match: * header, so a second draft is refused instead of replacing the first",
    });
  }
};

/** The offer a draft edits or revises: this deal's, not deleted, made from a template, the latest, and in the state the target needs. */
async function loadTargetOffer(dealId: string, kind: "edit" | "revision", offerId: string) {
  const offer = await db.dealOffer.findUnique({ where: { id: offerId } });
  // Proven to belong to the deal before anything of its snapshot is read (DD-28).
  if (!offer || offer.dealId !== dealId || offer.deletedAt) throw notFound("Offer not found");
  const snapshot = offer.snapshot as unknown as StoredSnapshot;
  if (!isContract(snapshot)) {
    throw conflict("offer_legacy", "An offer generated before offer documents cannot be edited or revised", { offerId });
  }
  const newest = await latestOffer(db, dealId);
  if (newest?.id !== offer.id) throw conflict("offer_not_latest", "Only the newest version of an offer can be edited or revised", { offerId });
  if (kind === "edit" && offer.sentAt) throw conflict("offer_sent", "This offer has been sent: make a new revision instead", { offerId });
  if (kind === "revision" && !offer.sentAt) throw notSent(offer);
  return { offer, snapshot };
}

offerDraftsRouter.openapi(createRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  const { deal } = await loadDealInScope(id, dealScope(c));
  requireIfNoneMatch(c);

  const existing = await db.offerDraft.findUnique({ where: { dealId: id }, select: { updatedBy: true, updatedAt: true } });
  if (existing) throw await draftExists(c, existing);

  const target = body.target ?? { kind: "new" as const };
  let targetOffer: Awaited<ReturnType<typeof loadTargetOffer>> | null = null;
  let templateId = body.templateId;
  if (target.kind === "new") {
    if (!templateId) throw unprocessable("A new offer starts from a template", { field: "templateId" }, "template_required");
    const newest = await latestOffer(db, id);
    if (blocksRevision(newest)) throw notSent(newest);
  } else {
    targetOffer = await loadTargetOffer(id, target.kind, target.offerId);
    // Omitted: the template the offer was made with, when it was made by the wizard (DD-28).
    templateId ??= targetOffer.snapshot.wizard ? targetOffer.snapshot.template.id : undefined;
    if (!templateId) throw unprocessable("This offer was not made with a wizard template: choose one", { field: "templateId" }, "template_required");
  }
  const template = await loadWizardTemplate(templateId, deal.entity);

  // The values as they are: a draft is started (and autosaved) for an incomplete issuer too; generation and the previews refuse (E4).
  const inputs = await loadWizardInputs(c, deal, { requireEstimate: true, archivedContacts: false, requireCompleteIssuer: false });
  const { ast } = parseTemplate(template.source);
  const context = wizardContextOf(inputs, template.language, serverToday());
  let answers: WizardAnswers;
  let templateVersion = template.version;
  if (targetOffer === null) {
    answers = initialAnswers(ast, context);
  } else {
    const { snapshot } = targetOffer;
    const previous = snapshot.wizard ? parseStoredAnswers(snapshot.wizard.answers) : null;
    if (snapshot.wizard && previous === null) {
      throw conflict("draft_invalid", "The offer's saved answers are not valid any more: start it again from a template");
    }
    if (previous && snapshot.template.id === template.id) {
      // The same template: its answers, reconciled to the template as it is now. The draft keeps the version the offer
      // was made at, so the AC-8.4 notice fires when the template moved.
      answers = reconcileAnswers(ast, previous).answers;
      templateVersion = snapshot.wizard!.templateVersion;
    } else if (previous) {
      answers = switchTemplate(ast, previous, context);
    } else {
      // A contract made with a legacy template has no answers: its client block is what carries over (AC-7.3).
      const contactIds = new Set(inputs.contacts.map((contact) => contact.id));
      answers = initialAnswers(ast, context);
      answers.client = {
        lines: [...snapshot.clientLines],
        contactIds: (snapshot.contactIds ?? []).filter((contactId) => contactIds.has(contactId)),
        place: snapshot.place,
        date: null,
      };
    }
  }
  assertAnswersFit(ast, answers);

  let row: DraftRow;
  try {
    row = await db.offerDraft.create({
      data: {
        dealId: id,
        templateId: template.id,
        templateVersion,
        targetKind: target.kind,
        ...(targetOffer ? { targetOfferId: targetOffer.offer.id, targetOfferVersion: targetOffer.offer.version } : {}),
        answers: answers as unknown as Prisma.InputJsonValue,
        createdBy: userId,
        updatedBy: userId,
      },
      include: draftWith,
    });
  } catch (error) {
    // Another tab created it between the check and the insert: the primary key arbitrates (AC-6.3).
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002") {
      const winner = await db.offerDraft.findUnique({ where: { dealId: id }, select: { updatedBy: true, updatedAt: true } });
      if (winner) throw await draftExists(c, winner);
    }
    throw error;
  }
  noStore(c);
  c.header("ETag", etag(row.version));
  return c.json(await viewOf(c, row), 201);
});

/**
 * What a save and a preview of the same body both ask of it (a preview is a save that is not made, so what cannot be saved
 * is not drawn): the draft's own target, a template version not yet reached, and the engine's check of the answers' text.
 * Returns the answers as the engine reads them.
 */
function checkedAnswers(row: DraftRow, body: z.infer<typeof PutDraftSchema>): WizardAnswers {
  const stored = targetOf(row);
  const sameTarget = body.target.kind === stored.kind && (body.target.kind === "new" || ("offerId" in stored && stored.offerId === body.target.offerId));
  if (!sameTarget) throw answersInvalid("target", "target_changed");
  const { template } = row;
  if (body.templateVersion > template.version) throw answersInvalid("templateVersion", "not_reached");
  if (template.source === null) throw conflict("template_format_mismatch", "This template is not a wizard template", { templateId: template.id });

  // A draft saved against an older template version is never refused for its options (DD-8, DD-38).
  const answers = body.answers as unknown as WizardAnswers;
  const [issue] = checkAnswers(parseTemplate(template.source).ast, answers, { options: body.templateVersion === template.version });
  if (issue) throw answersInvalid(issue.path, issue.code);
  return answers;
}

const putRoute = createRoute({
  method: "put",
  path: "/deals/{id}/offer-draft",
  tags: ["Offer wizard"],
  summary: "Save the draft's answers (If-Match required)",
  description:
    "The whole document: `{ templateVersion, target, answers }`. A body deep-equal to the stored draft is a no-op (200, same version). " +
    "Strict shape and caps, the reserved characters, and — while `templateVersion` is the template's — a text outside its field's options " +
    "are 422 `answers_invalid` `{ path }`. More than 512 KiB is 413 `draft_too_large`. A date outside the ±90-day window is never refused here.",
  middleware: generating,
  request: { params: IdParams, body: { content: { "application/json": { schema: PutDraftSchema } }, required: true } },
  responses: {
    ...commonErrors,
    200: { description: "Saved", ...json(DraftViewSchema) },
    404: { description: "Deal or draft not found" },
    409: { description: "version_conflict" },
    413: { description: "draft_too_large" },
    428: { description: "precondition_required" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/deals/{id}/offer-draft",
  tags: ["Offer wizard"],
  summary: "Discard the draft (If-Match required)",
  middleware: generating,
  request: { params: IdParams },
  responses: {
    ...commonErrors,
    204: { description: "Discarded" },
    404: { description: "Deal or draft not found" },
    409: { description: "version_conflict" },
    428: { description: "precondition_required" },
  },
});

const switchRoute = createRoute({
  method: "post",
  path: "/deals/{id}/offer-draft/template",
  tags: ["Offer wizard"],
  summary: "Move the draft to another template, keeping the client block (If-Match required)",
  description:
    "The client lines, contacts, place and date stay (AC-6.5); everything else starts again from the new template. " +
    "Choosing the draft's own template changes nothing.",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: z.object({ templateId: TemplateIdSchema }).strict() } }, required: true },
  },
  responses: {
    ...commonErrors,
    200: { description: "The draft on the new template", ...json(DraftViewSchema) },
    404: { description: "Deal, draft or template not found" },
    409: { description: "version_conflict / estimate_not_ready / template_archived / template_format_mismatch" },
    428: { description: "precondition_required" },
  },
});

/** A refused save is `answers_invalid` with the path under `answers` (a zod issue is turned into the same answer). */
const putHook = (
  result: { success: true } | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string; code: string; keys?: string[] }[] } },
  c: { req: { path: string } },
): Response | undefined => {
  if (result.success) return undefined;
  const issue = result.error.issues[0]!;
  const parts = issue.path[0] === "answers" ? issue.path.slice(1) : [...issue.path];
  if (issue.code === "unrecognized_keys" && issue.keys?.[0] !== undefined) parts.push(issue.keys[0]);
  const path = jsonPath(parts);
  return problem(
    {
      status: 422,
      code: "answers_invalid",
      detail: `The answers are not valid at "${path}" (${issue.message})`,
      extras: { path, reason: "shape" },
    },
    c.req.path,
  );
};

offerDraftsRouter.openapi(
  putRoute,
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const userId = c.get("userId");
    await loadDealInScope(id, dealScope(c));
    const expected = requireIfMatch(c);
    const row = await findDraft(id);
    if (!row) throw draftNotFound();
    assertVersion(row.version, expected);

    const answers = checkedAnswers(row, body);

    noStore(c);
    // Nothing changed (a step click alone sends nothing, but a retry may): no write, same version (DD-31).
    if (body.templateVersion === row.templateVersion && isDeepStrictEqual(answers, row.answers)) {
      c.header("ETag", etag(row.version));
      return c.json(await viewOf(c, row), 200);
    }
    const changed = await db.offerDraft.updateMany({
      where: { dealId: id, version: expected },
      data: {
        templateVersion: body.templateVersion,
        answers: answers as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
        updatedBy: userId,
      },
    });
    if (changed.count === 0) throw await staleDraft(id);
    const saved = (await findDraft(id))!;
    c.header("ETag", etag(saved.version));
    return c.json(await viewOf(c, saved), 200);
  },
  putHook as never,
);

const previewRoute = createRoute({
  method: "post",
  path: "/deals/{id}/offer-draft/preview",
  tags: ["Offer wizard"],
  summary: "The pages the layout service draws for an unsaved draft body (same gate and scope as the draft; nothing is stored)",
  description:
    "Only with `LETTERHEAD_SERVICE_ENABLED=true`; otherwise 404, as if the route did not exist. The body is the draft PUT's `{ templateVersion, target, answers }` and is " +
    "checked as a save would check it (422 `answers_invalid`). It needs the deal's draft (404 `draft_not_found`) for its template and target, but changes nothing: " +
    "no version moves and no `If-Match` is read. The answer is the service's preview unchanged plus `missingFields`; `?pages=1,2` asks for those pages only. " +
    "409 `letterhead_not_configured` (the entity has no active letterhead), 409 `letterhead_overflow` with `frame` (a profile value too long for the header or the footer), " +
    "409 `legal_entity_incomplete` (`entity`, `missing[]`), and 503 `legal_entities_unavailable` (with `Retry-After: 5`) or `layout_service_unavailable` for a service that is unreachable, answers an error, is busy or times out. `Cache-Control: no-store`.",
  middleware: [...generating, legalEntitiesRetryAfter, requireLetterheadService],
  request: { params: IdParams, query: PreviewQuerySchema, body: { content: { "application/json": { schema: PutDraftSchema } }, required: true } },
  responses: {
    ...commonErrors,
    200: { description: "The pages", ...json(PreviewResponseSchema) },
    404: { description: "Deal or draft not found; or the switch is off" },
    409: { description: "letterhead_not_configured / letterhead_overflow / legal_entity_incomplete / estimate_not_ready / template_format_mismatch" },
    413: { description: "Request body is too large" },
    422: { description: "answers_invalid" },
    503: { description: "layout_service_unavailable / legal_entities_unavailable (Retry-After: 5)" },
  },
});

offerDraftsRouter.openapi(
  previewRoute,
  async (c) => {
    const { id } = c.req.valid("param");
    const { pages } = c.req.valid("query");
    const body = c.req.valid("json");
    const { deal } = await loadDealInScope(id, dealScope(c));
    const row = await findDraft(id);
    if (!row) throw draftNotFound();
    const answers = checkedAnswers(row, body);
    const { template } = row;
    // The letterhead is the deal's entity's: a template of another one is not drawn on it (as generate refuses it).
    if (template.entity !== deal.entity) throw notFound("Template not found");

    // Everything below is what generation reads, from the same places, so the pages are the PDF's (AC-10.3).
    const inputs = await loadWizardInputs(c, deal, { requireEstimate: true, archivedContacts: true, requireCompleteIssuer: true });
    const { ast } = parseTemplate(template.source!);
    const context = wizardContextOf(inputs, template.language, serverToday());
    const first = resolveOffer(ast, answers, context);
    const annex = first.effortAnnex && inputs.estimate ? buildScope(inputs.estimate, { aiAssisted: first.aiAssisted, ...scopeLabels(template.language) }) : null;
    // An edit keeps its offer's reference; a new offer and a revision have none yet, and the title says so.
    const target = targetOf(row);
    const blocks = draftToBlocks(
      { entity: deal.entity, ast, answers, context, annex, reference: target.kind === "edit" ? target.reference : null },
      letterheadProfileOf(inputs.issuer, template.language, inputs.profile?.placeOfIssue ?? null),
    );
    noStore(c);
    return c.json(await previewThroughService(blocks, pages), 200);
  },
  // A refused body is a refused save (`answers_invalid`); a refused `pages` is the plain 422 naming it.
  ((result: { success: boolean; target?: string }, c: Context) =>
    result.target === "query" ? validationHook(result as never, c) : putHook(result as never, c)) as never,
);

/** Zero rows matched the version: someone else saved (409) or discarded (404) in between. */
async function staleDraft(dealId: string): Promise<ProblemError> {
  const now = await db.offerDraft.findUnique({ where: { dealId }, select: { version: true } });
  return now ? versionConflict(now.version) : draftNotFound();
}

offerDraftsRouter.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  await loadDealInScope(id, dealScope(c));
  const expected = requireIfMatch(c);
  const row = await db.offerDraft.findUnique({ where: { dealId: id }, select: { version: true } });
  if (!row) throw draftNotFound();
  assertVersion(row.version, expected);
  const deleted = await db.offerDraft.deleteMany({ where: { dealId: id, version: expected } });
  if (deleted.count === 0) throw await staleDraft(id);
  return c.body(null, 204);
});

offerDraftsRouter.openapi(switchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { templateId } = c.req.valid("json");
  const userId = c.get("userId");
  const { deal } = await loadDealInScope(id, dealScope(c));
  const expected = requireIfMatch(c);
  const row = await findDraft(id);
  if (!row) throw draftNotFound();
  assertVersion(row.version, expected);
  const kept = storedAnswers(row);
  const template = await loadWizardTemplate(templateId, deal.entity);

  noStore(c);
  // The same template again is not a reset: the person's answers are never thrown away by a click on the current card.
  if (template.id === row.templateId) {
    c.header("ETag", etag(row.version));
    return c.json(await viewOf(c, row), 200);
  }
  const inputs = await loadWizardInputs(c, deal, { requireEstimate: true, archivedContacts: false, requireCompleteIssuer: false });
  const { ast } = parseTemplate(template.source);
  const answers = switchTemplate(ast, kept, wizardContextOf(inputs, template.language, serverToday()));
  assertAnswersFit(ast, answers);
  const changed = await db.offerDraft.updateMany({
    where: { dealId: id, version: expected },
    data: {
      templateId: template.id,
      templateVersion: template.version,
      answers: answers as unknown as Prisma.InputJsonValue,
      version: { increment: 1 },
      updatedBy: userId,
    },
  });
  if (changed.count === 0) throw await staleDraft(id);
  const saved = (await findDraft(id))!;
  c.header("ETag", etag(saved.version));
  return c.json(await viewOf(c, saved), 200);
});

const generateRouteDef = createRoute({
  method: "post",
  path: "/deals/{id}/offer-draft/generate",
  tags: ["Offer wizard"],
  summary: "Generate the offer from the stored draft (If-Match: the draft's version; no body)",
  description:
    "The offer is made from what is STORED, at the version the person reviewed: nothing in the request says what it contains. " +
    "422 `offer_incomplete` lists, by name and template label only, exactly what `resolveOffer` lists for the stored draft (DD-32). " +
    "201 for a new offer or a revision, 200 for an edit. The draft is deleted in the same transaction, conditioned on its version. " +
    "With `LETTERHEAD_SERVICE_ENABLED=true` the pages are the layout service's (the deal PDFs follow them, unnumbered) and the offer records the letterhead version it was drawn with; " +
    "a service that is unreachable, answers an error, is busy or times out is 503 `layout_service_unavailable`, an entity with no active letterhead is 409 `letterhead_not_configured`, " +
    "and a profile value too long for the header or the footer is 409 `letterhead_overflow` with `frame`: in each case no offer, no number, no PDF, and the draft is kept (AC-10.6).",
  middleware: [...generating, legalEntitiesRetryAfter],
  request: { params: IdParams },
  responses: {
    ...commonErrors,
    ...pdfCheckErrors,
    200: { description: "Edited", ...json(OfferSchema) },
    201: { description: "Generated", ...json(OfferSchema) },
    404: { description: "Deal, draft or template not found" },
    409: {
      description:
        "version_conflict / template_changed / template_archived / estimate_not_ready / offer_not_sent / offer_sent / offer_not_latest / offer_changed / " +
        "legal_entity_incomplete (`entity`, `missing[]`: the registry says the issuer is incomplete; no number is used, the draft is kept) / " +
        "letterhead_unusable (the stored letterhead of the deal's entity fails the check: `entity`, `reason`; nothing is rendered or written, the draft is kept; upload the letterhead again; switch off only) / " +
        "letterhead_not_configured (switch on: the entity has no active letterhead; `entity`) / letterhead_overflow (switch on: `frame`, `entity`)",
    },
    422: { description: "offer_incomplete / contact_not_in_company / attachment_invalid / attachment_not_pdf / attachments_too_large / attachment_unreadable" },
    428: { description: "precondition_required" },
    503: {
      description:
        "legal_entities_unavailable (the registry of the issuer's details cannot be read; `Retry-After: 5`), " +
        "layout_service_unavailable (switch on: the layout service is unreachable, answers an error, is busy or timed out; nothing was written, try again), " +
        "or the PDF check / authorization service answers described for `pdfCheckErrors`: `pdf_check_busy`, `pdf_check_unavailable`",
      content: pdfCheckErrors[503].content,
    },
  },
});

/** 422 `offer_incomplete`: the names and template labels `resolveOffer` lists — never a value (§ Security). */
const offerIncomplete = (resolved: ResolvedOffer) =>
  new ProblemError({
    status: 422,
    code: "offer_incomplete",
    detail: "The offer is not complete",
    extras: {
      missing: resolved.missing.map(({ name, label, step }) => ({ name, label, step })),
      invalid: resolved.invalid.map(({ name, label, step, code }) => ({ name, label, step, code })),
    },
  });

offerDraftsRouter.openapi(generateRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");
  const { deal } = await loadDealInScope(id, dealScope(c));
  const expected = requireIfMatch(c);
  const row = await findDraft(id);
  if (!row) throw draftNotFound();
  assertVersion(row.version, expected);
  const answers = storedAnswers(row);

  // The template is an input of the commit too: the draft pins its version (DD-8).
  const { template } = row;
  if (template.entity !== deal.entity) throw notFound("Template not found");
  if (template.archivedAt) throw conflict("template_archived", "This template is archived; choose an active one", { templateId: template.id });
  if (template.format !== "wizard" || template.source === null) {
    throw conflict("template_format_mismatch", "This template is not a wizard template", { templateId: template.id });
  }
  if (template.version !== row.templateVersion) {
    throw conflict("template_changed", "The template was edited since this draft was last saved: review the draft first", {
      templateId: template.id,
      templateVersion: row.templateVersion,
      currentVersion: template.version,
    });
  }

  const issued = new Date();
  // The registry is read here, before the transaction and any resolve or byte read: incomplete details are 409 `legal_entity_incomplete`
  // (a blank legal name too, AC-12.7, DD-61), an unreadable registry 503 `legal_entities_unavailable`; no number is taken either way.
  const inputs = await loadWizardInputs(c, deal, { requireEstimate: true, archivedContacts: true, requireCompleteIssuer: true });
  const context = wizardContextOf(inputs, template.language, isoDate(issued));
  const { ast } = parseTemplate(template.source);

  // The first resolve has no reference: the pending one is not an issue (DD-44), the printed date's window is (DD-42).
  const first = resolveOffer(ast, answers, context);
  if (first.missing.length > 0 || first.invalid.length > 0) throw offerIncomplete(first);
  const oneOffCents = first.costs.result.oneOffCents;
  if (oneOffCents === null) throw new Error("generate: a complete offer has no price");

  // What only the database knows (018's 422s).
  if (answers.client.contactIds.some((contactId) => !inputs.contacts.some((contact) => contact.id === contactId))) {
    throw unprocessable("A contact is not one of the company's", { field: "contactIds" }, "contact_not_in_company");
  }
  const storage = requireStorage();
  const { refs, bytes } = await loadAttachments(storage, id, answers.attachmentIds);
  // The switch (AC-10.1), read once: the pages are the layout service's, or crm-api's own as they always were.
  const viaService = env.LETTERHEAD_SERVICE_ENABLED;
  // A stored letterhead is used only once checked in this process: 409 `letterhead_unusable` before any render (DD-76).
  // With the switch on nothing reads the uploaded letterhead (AC-10.11), so it is neither read nor checked.
  // No profile row: no letterhead, a plain page (E4).
  const letterhead = !viaService && inputs.profile?.letterheadKey ? await usableLetterhead(storage, deal.entity, inputs.profile.letterheadKey) : null;
  const { person } = await loadPeople(c, [userId]);
  const annex = first.effortAnnex && inputs.estimate ? buildScope(inputs.estimate, { aiAssisted: first.aiAssisted, ...scopeLabels(template.language) }) : null;

  const snapshotFor = (reference: string) =>
    wizardSnapshotOf({
      template: { id: template.id, name: template.name },
      templateVersion: row.templateVersion,
      answers,
      // The second resolve, with the reference the offer takes: it prints where the template says so (DD-44, DD-52).
      resolved: resolveOffer(ast, answers, context, { reference }),
      reference,
      currency: deal.currency,
      profile: issuerValuesOf(inputs.issuer, template.language),
      annex,
      attachments: refs,
      preparedBy: person(userId).name,
    });
  const render = viaService
    ? (snapshot: ContractSnapshot) =>
        renderOfferThroughService(
          // The preview's own conversion (AC-10.3), with the reference the offer takes and the profile as it is now (AC-10.10).
          draftToBlocks(
            { entity: deal.entity, ast, answers, context, annex, reference: snapshot.reference },
            letterheadProfileOf(inputs.issuer, template.language, inputs.profile?.placeOfIssue ?? null),
          ).content,
          { fileNames: refs.map((ref) => ref.fileName), bytes },
        )
    : (snapshot: ContractSnapshot) => renderOffer(snapshot, { letterhead, attachmentBytes: bytes });

  // The object is put inside the transaction: whatever fails after it, the object goes too (ADR § Decision 3).
  const written: { objectKey: string | null } = { objectKey: null };
  let created: OfferRow;
  let replacedKey: string | null = null;
  try {
    created = await inOfferTransaction(id, async (tx) => {
      const newest = await latestOffer(tx, id);
      let made: OfferRow;
      if (row.targetKind === "edit") {
        // Edit: the same row, the same reference, a new PDF — only while it is still the unsent latest the person opened.
        const target = row.targetOfferId === null ? null : await tx.dealOffer.findUnique({ where: { id: row.targetOfferId } });
        if (!target || target.deletedAt || target.dealId !== id) throw notFound("Offer not found");
        if (newest?.id !== target.id) throw conflict("offer_not_latest", "Only the newest version of an offer can be edited", { offerId: target.id });
        if (target.sentAt) throw conflict("offer_sent", "This offer has been sent: make a new revision instead", { offerId: target.id });
        if (target.version !== row.targetOfferVersion) {
          throw conflict("offer_changed", "The offer was changed since this draft was started: discard the draft and start again", { offerId: target.id });
        }
        const snapshot = snapshotFor((target.snapshot as unknown as ContractSnapshot).reference);
        const { pdf, letterheadVersion } = renderedOf(await render(snapshot));
        const objectKey = `offers/${id}/${crypto.randomUUID()}.pdf`;
        await storage.putObject(objectKey, pdf, "application/pdf");
        written.objectKey = objectKey;
        // Compare-and-set on the offer's version, and never on a sent offer.
        const changed = await tx.dealOffer.updateMany({
          where: { id: target.id, version: target.version, sentAt: null, deletedAt: null },
          data: {
            language: template.language,
            priceCents: BigInt(oneOffCents),
            currency: deal.currency,
            validityDays: first.validityDays,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            objectKey,
            sizeBytes: pdf.byteLength,
            // The pages were drawn now: with the entity's active letterhead (AC-10.9), or by crm-api (null).
            letterheadVersion,
            version: { increment: 1 },
            updatedBy: userId,
            updatedAt: issued,
          },
        });
        if (changed.count === 0) throw conflict("offer_changed", "The offer was changed since this draft was started", { offerId: target.id });
        replacedKey = target.objectKey;
        made = await tx.dealOffer.findUniqueOrThrow({ where: { id: target.id } });
      } else {
        if (row.targetKind === "revision") {
          // Revision: the sent latest offer stays as it is; a new version follows it.
          if (newest?.id !== row.targetOfferId) {
            throw conflict("offer_not_latest", "Only the newest version of an offer can be revised", { offerId: row.targetOfferId });
          }
          if (!newest.sentAt) throw notSent(newest);
        } else if (blocksRevision(newest)) {
          throw notSent(newest);
        }
        made = await createOfferVersion(tx, {
          dealId: id,
          entity: deal.entity,
          currency: deal.currency,
          storage,
          issued,
          userId,
          language: template.language,
          priceCents: oneOffCents,
          validityDays: first.validityDays,
          snapshotFor,
          render,
        });
        written.objectKey = made.objectKey;
      }
      // Conditioned on the version that was reviewed: a draft saved since is not consumed (ADR § Decision 2).
      const removed = await tx.offerDraft.deleteMany({ where: { dealId: id, version: expected } });
      if (removed.count === 0) throw await staleDraft(id);
      return made;
    });
  } catch (error) {
    if (written.objectKey) await storage.deleteObject(written.objectKey).catch(() => undefined);
    throw error;
  }
  // The replaced PDF is unreachable now; a failed delete leaves an orphan, never a wrong document.
  if (replacedKey !== null) {
    const previous: string = replacedKey;
    await storage.deleteObject(previous).catch((error: unknown) => {
      console.error("[offers] could not delete the replaced PDF:", previous, error instanceof Error ? error.message : error);
    });
  }

  const [view] = await toViews(c, [created]);
  console.log(
    `[offers] wizard offer generated dealId=${id} offerId=${created.id} templateId=${template.id} templateVersion=${row.templateVersion} target=${row.targetKind} letterheadVersion=${created.letterheadVersion ?? "-"}`,
  );
  if (row.targetKind !== "edit") {
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
  }
  noStore(c);
  c.header("ETag", etag(created.version));
  return c.json(view!, row.targetKind === "edit" ? 200 : 201);
});

async function draftExists(c: HeaderSource, row: { updatedBy: string; updatedAt: Date }) {
  const { person } = await loadPeople(c, [row.updatedBy]);
  return conflict("draft_exists", "This deal already has an offer draft", { updatedBy: person(row.updatedBy), updatedAt: row.updatedAt.toISOString() });
}

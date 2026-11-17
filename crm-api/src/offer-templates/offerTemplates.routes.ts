/**
 * Offer templates (specs/20261102-crm-offer-document US-2; plan.md § API): the named starting points of
 * an offer, owned by one entity and written in one language.
 *
 *   GET    /offer-templates?entity=&includeArchived=&formats=   deal:financials; `formats` = sections (default) |
 *                                                      wizard | sections,wizard; seeds the fourteen defaults on first read
 *   GET    /offer-templates/{id}                       deal:financials
 *   POST   /offer-templates                           deal:manage over the entity (+ deal:financials); a WIZARD template
 *                                                      only (specs/20261115-crm-offer-wizard DD-9): 422 template_invalid + problems
 *   POST   /offer-templates/{id}/duplicate            as create; the copy has its source's format
 *   PUT    /offer-templates/{id}                      as create; If-Match required (428 / 409); the body is the row's format's
 *   POST   /offer-templates/{id}/archive | /restore   as create; If-Match required
 *   POST   /offer-templates/{id}/try-preview?pages=    deal:financials (the READ guard, no entity scope: reads are team knowledge); the pages the layout
 *                                                      service draws for the UNSAVED text and sample answers, no deal needed (switch on; stores nothing;
 *                                                      AC-10.14, plan G1)
 *   POST   /offer-templates/try-preview?pages=         the same for a template that was never saved: the body names the entity (T53, AC-10.14)
 *
 * Reads are open to every `deal:financials` holder of either entity (a template
 * carries prices; ADR 20261101-crm-tool-shape-and-authorization's "reads are team knowledge" posture). Writes outside
 * the caller's entity are 403 `out_of_scope`, not 404: the caller can read the
 * template (ADR 20261101-crm-tool-shape-and-authorization's branch). Seeding is lazy and idempotent (ADR 20260714-invitation-lifecycle-derived-expiry-state posture:
 * no migration data, no cron): an entity with NO template row at all - archived
 * ones count - gets the defaults, under an advisory lock so concurrent first
 * reads insert them once.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  DEAL_FINANCIALS,
  DEAL_MANAGE,
  authorized,
  dealScope,
  requireCapability,
} from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import type { Entity } from "../authz/conditions";
import { assertInScope } from "../deals/deals.routes";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import {
  EntitySchema,
  IdParams,
  PersonRefSchema,
  assertVersion,
  commonErrors,
  etag,
  isRecordNotFound,
  requireIfMatch,
  requiredText,
  versionConflict,
  type HeaderSource,
} from "../lib/http";
import { loadPeople } from "../lib/people";
import { ProblemError, conflict, notFound, unprocessable, validationHook } from "../lib/problem";
import type { OfferTemplateContent } from "../offers/contract";
import { checkAnswers, type WizardAnswers } from "../offers/engine/answers";
import { parseTemplate } from "../offers/engine/syntax";
import { templateToBlocks } from "../offers/blocks";
import { PreviewQuerySchema, PreviewResponseSchema, previewThroughService, requireLetterheadService } from "../offers/contentSchema";
import { legalEntitiesRetryAfter, letterheadProfileOf, loadIssuer, loadProfile } from "../offers/generation";
import { AnswersSchema } from "../offer-drafts/answersSchema";
import { legacyContent } from "../offers/legacyContent";
import { DEFAULT_TEMPLATES_EN } from "../offers/defaultTemplates.en";
import { DEFAULT_TEMPLATES_IT } from "../offers/defaultTemplates";
import { upgradeWizardSeeds } from "./wizardSeeds/upgrade";
import { WELLD_CH_IT_V1 } from "./wizardSeeds/welldChIt";
import {
  assertNotLastActive,
  assertNotSuperseded,
  inTemplateTransaction,
  lockTemplates,
  supersedeLegacy,
  type TemplateTx,
} from "./supersession";
import {
  CostColumnsSchema,
  SectionSchema,
  TemplateContentSchema,
  TemplateCostLineSchema,
  type TemplateContentInput,
} from "../offers/offerSchemas";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });
const reading = [...authorized, requireCapability(DEAL_FINANCIALS)];
const writing = [...authorized, requireCapability(DEAL_FINANCIALS), requireCapability(DEAL_MANAGE)];

/** The author recorded on the seeded defaults. */
const SEED_AUTHOR = "system:crm-api";

const TemplateSchema = z.object({
  id: z.string(),
  entity: EntitySchema,
  name: z.string(),
  language: z.enum(["en", "it"]),
  /** `sections`: the 018 contract text; `wizard`: the text the offer wizard reads (ADR 20261115-offer-template-format-supersession-per-entity-language). */
  format: z.enum(["sections", "wizard"]),
  /** Wizard only: one line on the template card. */
  description: z.string().nullable(),
  /** Wizard only: what the template typically covers. */
  uses: z.array(z.string()),
  /** Wizard only: the template text; null for a legacy template. */
  source: z.string().nullable(),
  /** The legacy content members are null for a wizard template. */
  salutation: z.string().nullable(),
  opening: z.string().nullable(),
  sections: z.array(SectionSchema).nullable(),
  costLines: z.array(TemplateCostLineSchema).nullable(),
  costColumns: CostColumnsSchema.nullable(),
  showTotal: z.boolean(),
  acceptanceLabel: z.string().nullable(),
  annex: z.boolean(),
  /** Created by the system from the catalog (a `seedKey` is set). */
  seeded: z.boolean(),
  version: z.number().int(),
  archived: z.boolean(),
  updatedBy: PersonRefSchema,
  updatedAt: z.string(),
  createdAt: z.string(),
});

/** Postgres text cannot hold NUL: refused here as a 422 instead of surfacing as a 500 on insert. */
const noNul = (value: string) => !value.includes("\u0000");
const NO_NUL = { message: "Must not contain a NUL character" };

/** The body of a wizard template (plan.md § API contracts); a create names its entity beside it. */
export const WizardTemplateBody = z
  .object({
    name: requiredText(80).refine(noNul, NO_NUL),
    language: z.enum(["en", "it"]),
    description: z
      .string()
      .max(160)
      .regex(/^[^\r\n]*$/, "Must be one line")
      .refine(noNul, NO_NUL),
    uses: z.array(requiredText(40).refine(noNul, NO_NUL)).max(6),
    source: z.string().min(1).max(150_000).refine(noNul, NO_NUL),
  })
  .strict();
const CreateWizardTemplateBody = WizardTemplateBody.extend({ entity: EntitySchema });
type WizardTemplateInput = z.infer<typeof WizardTemplateBody>;

const FormatsQuery = z
  .string()
  .default("sections")
  .transform((value) => value.split(","))
  .pipe(z.array(z.enum(["sections", "wizard"])).min(1));

type TemplateRow = Awaited<ReturnType<typeof db.offerTemplate.findMany>>[number];

async function toViews(c: HeaderSource, rows: readonly TemplateRow[]) {
  const { person } = await loadPeople(c, rows.map((row) => row.updatedBy));
  return rows.map((row) => {
    // A wizard row has no legacy content: its members are null, never an empty shell.
    const legacy = row.format === "sections" ? legacyContent(row) : null;
    return {
      id: row.id,
      entity: row.entity,
      name: row.name,
      language: row.language,
      format: row.format,
      description: row.description,
      uses: row.uses,
      source: row.source,
      salutation: legacy?.salutation ?? null,
      opening: legacy?.opening ?? null,
      sections: legacy?.sections ?? null,
      costLines: legacy?.costLines ?? null,
      costColumns: legacy?.costColumns ?? null,
      showTotal: row.showTotal,
      acceptanceLabel: row.acceptanceLabel,
      annex: row.annex,
      seeded: row.seedKey !== null,
      version: row.version,
      archived: row.archivedAt !== null,
      updatedBy: person(row.updatedBy),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** The JSON columns and scalars of a template's content, as Prisma wants them. */
const dataOf = (content: TemplateContentInput | OfferTemplateContent) => ({
  name: content.name,
  language: content.language,
  salutation: content.salutation,
  opening: content.opening,
  sections: content.sections as unknown as Prisma.InputJsonValue,
  costLines: content.costLines as unknown as Prisma.InputJsonValue,
  costColumns: content.costColumns as unknown as Prisma.InputJsonValue,
  showTotal: content.showTotal,
  acceptanceLabel: content.acceptanceLabel ?? null,
  annex: content.annex,
});

/** The columns of a wizard template; its legacy columns stay null (the CHECK `offer_template_format_content`). */
const wizardDataOf = (content: WizardTemplateInput) => ({
  format: "wizard" as const,
  name: content.name,
  language: content.language,
  description: content.description.trim() === "" ? null : content.description.trim(),
  uses: content.uses,
  source: content.source,
});

/**
 * Checks a wizard text with the shared engine (AC-8.3): any error is a 422 `template_invalid` listing every
 * problem as `{ line, code, severity, name? }` (warnings included, they never block). Positions and codes only:
 * the text itself is never echoed.
 */
function assertTemplateValid(source: string): void {
  const { problems } = parseTemplate(source);
  const errors = problems.filter((problem) => problem.severity === "error").length;
  if (errors === 0) return;
  throw new ProblemError({
    status: 422,
    code: "template_invalid",
    detail: `The template has ${errors} ${errors === 1 ? "error" : "errors"}`,
    extras: { problems },
  });
}

/** No template body is nested deeper than a few levels; a deeper one is refused instead of walked (QE D10). */
const MAX_BODY_DEPTH = 32;

interface ScanFrame {
  readonly value: unknown;
  readonly parent: ScanFrame | null;
  /** The member name or index under `parent`; null for the root. */
  readonly at: string | number | null;
  readonly depth: number;
}

const pathOfFrame = (frame: ScanFrame | null): string => {
  const names: (string | number)[] = [];
  for (let at = frame; at?.parent; at = at.parent) names.push(at.at as string | number);
  return names.reverse().join(".");
};

/**
 * The dotted path of the first string or key holding U+0000 in a JSON value (never the value itself), `null` when there is
 * none, or `"too_deep"` past `MAX_BODY_DEPTH`. Iterative with an explicit stack and parent links, so it is linear in the
 * size of the value and cannot overflow the call stack however deep a body is (QE D10: the recursive version copied the
 * path at every level, quadratic, and threw a RangeError, a 500, past about ten thousand levels). Document order is kept.
 */
function pathOfNul(root: unknown): string | null | "too_deep" {
  const stack: ScanFrame[] = [{ value: root, parent: null, at: null, depth: 0 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { value } = frame;
    if (typeof value === "string") {
      if (value.includes("\u0000")) return pathOfFrame(frame);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (frame.depth >= MAX_BODY_DEPTH) return "too_deep";
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push({ value: value[index], parent: frame, at: index, depth: frame.depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    if (entries.some(([key]) => key.includes("\u0000"))) return pathOfFrame(frame);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, item] = entries[index]!;
      stack.push({ value: item, parent: frame, at: key, depth: frame.depth + 1 });
    }
  }
  return null;
}

/** A body parsed here, after the row's format is known, with the same 422 shape as the route validator. */
function parseBody<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  // a legacy body is a nest of text members and Postgres refuses U+0000 in any of them: refused here, once, wherever it is (QE D7)
  const nul = pathOfNul(value);
  if (nul === "too_deep") {
    const message = `Nested more than ${MAX_BODY_DEPTH} levels deep`;
    throw new ProblemError({ status: 422, detail: `body: ${message}`, extras: { field: "", errors: [{ field: "", message }] } });
  }
  if (nul !== null) {
    throw new ProblemError({
      status: 422,
      detail: `${nul || "body"}: ${NO_NUL.message}`,
      extras: { field: nul, errors: [{ field: nul, message: NO_NUL.message }] },
    });
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const errors = parsed.error.issues.map((issue) => ({ field: issue.path.map(String).join("."), message: issue.message }));
  throw new ProblemError({
    status: 422,
    detail: errors[0] ? `${errors[0].field || "body"}: ${errors[0].message}` : "Invalid request",
    extras: { field: errors[0]?.field ?? "", errors },
  });
}

/** Inserts the fourteen defaults once for an entity that has no template row. */
export async function seedTemplatesIfEmpty(entity: Entity): Promise<void> {
  if ((await db.offerTemplate.count({ where: { entity } })) > 0) return;
  await db.$transaction(async (tx) => {
    await lockTemplates(tx, entity);
    if ((await tx.offerTemplate.count({ where: { entity } })) > 0) return;
    await tx.offerTemplate.createMany({
      data: [...DEFAULT_TEMPLATES_IT, ...DEFAULT_TEMPLATES_EN].map((template) => ({
        entity,
        ...dataOf(template),
        createdBy: SEED_AUTHOR,
        updatedBy: SEED_AUTHOR,
      })),
    });
  });
}

/**
 * Inserts the wizard seeds of an entity (specs/20261115-crm-offer-wizard AC-9.1, DD-10): only `welld_ch`, only the
 * seeds whose `seedKey` has NO row at all (an archived seed is never re-created), as `system:crm-api`, and the
 * Italian legacy templates archived in the same transaction (supersession, AC-9.2), BEFORE the insert so a legacy
 * "Formazione" does not refuse the new one. Lazy and idempotent: the common case is one count and no lock.
 *
 * A seed whose name an active template that stays active already holds (a template made by hand, an English
 * default) is left for a later read, not inserted: the read must not fail on the name index, and nothing is
 * archived unless at least one seed goes in, so an (entity, language) never ends with no active template.
 */
export async function seedWizardTemplates(entity: Entity): Promise<void> {
  if (entity !== "welld_ch") return;
  const total = WELLD_CH_IT_V1.length;
  // The common case, no lock: no row still carries a first-set key (nothing to upgrade) and every code has a row under
  // its v2 or kept key. A database that never held the first set, or one already decided, stops here.
  const [firstSet, decided] = await Promise.all([
    db.offerTemplate.count({ where: { entity, seedKey: { in: WELLD_CH_IT_V1.map((seed) => seed.previousKey) } } }),
    db.offerTemplate.count({ where: { entity, seedKey: { in: WELLD_CH_IT_V1.flatMap((seed) => [seed.seedKey, seed.keptKey]) } } }),
  ]);
  if (firstSet === 0 && decided >= total) return;
  await inTemplateTransaction(entity, async (tx) => {
    // The one-time upgrade of the first set (DD-60), before anything is inserted: it changes keys, so the step below
    // sees an upgraded or kept row where the first release's row was and never inserts a second template for the code.
    await upgradeWizardSeeds(tx, entity);
    const have = new Set(
      (await tx.offerTemplate.findMany({ where: { entity, seedKey: { not: null } }, select: { seedKey: true } })).map((row) => row.seedKey),
    );
    // A code with a row under ANY of its three keys is never inserted again (archived rows count).
    const missing = WELLD_CH_IT_V1.filter((seed) => ![seed.seedKey, seed.previousKey, seed.keptKey].some((key) => have.has(key)));
    if (missing.length === 0) return;
    // Names held by active templates the supersession will not archive (everything but the Italian legacy ones).
    const staying = new Set(
      (
        await tx.offerTemplate.findMany({
          where: { entity, archivedAt: null, NOT: { format: "sections", language: "it" } },
          select: { name: true },
        })
      ).map((row) => row.name.toLowerCase()),
    );
    const insertable = missing.filter((seed) => !staying.has(seed.name.toLowerCase()));
    if (insertable.length === 0) return;
    await supersedeLegacy(tx, entity, "it", SEED_AUTHOR);
    await tx.offerTemplate.createMany({
      data: insertable.map((seed) => ({
        entity,
        ...wizardDataOf({
          name: seed.name,
          language: "it",
          description: seed.description,
          uses: [...seed.uses],
          source: seed.source,
        }),
        seedKey: seed.seedKey,
        createdBy: SEED_AUTHOR,
        updatedBy: SEED_AUTHOR,
      })),
    });
  });
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

const nameTaken = (name: string) =>
  new ProblemError({
    status: 409,
    code: "template_name_taken",
    detail: `An active template named "${name}" already exists for this entity`,
    extras: { field: "name" },
  });

async function loadTemplate(id: string) {
  const row = await db.offerTemplate.findUnique({ where: { id } });
  if (!row) throw notFound("Template not found");
  return row;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/offer-templates",
  tags: ["Offer templates"],
  summary: "An entity's offer templates (deal:financials); seeds the defaults on first read",
  description:
    "`formats` is `sections` (the default: the legacy templates only, so a client that predates the wizard never " +
    "receives a wizard row), `wizard`, or `sections,wizard`.",
  middleware: reading,
  request: {
    query: z.object({
      entity: EntitySchema,
      includeArchived: z.enum(["true", "false"]).default("false"),
      formats: FormatsQuery,
    }),
  },
  responses: { 200: { description: "Templates, by name", ...json(z.object({ items: z.array(TemplateSchema) })) }, ...commonErrors },
});

const getRoute = createRoute({
  method: "get",
  path: "/offer-templates/{id}",
  tags: ["Offer templates"],
  summary: "One template (deal:financials); returns an ETag",
  middleware: reading,
  request: { params: IdParams },
  responses: { 200: { description: "The template", ...json(TemplateSchema) }, 404: { description: "Not found" }, ...commonErrors },
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/offer-templates",
  tags: ["Offer templates"],
  summary: "Create a wizard template (deal:manage over the entity)",
  description: "New templates are always wizard templates. 422 `template_invalid` lists the text's `problems`.",
  middleware: writing,
  request: { body: { content: { "application/json": { schema: CreateWizardTemplateBody } }, required: true } },
  responses: {
    ...commonErrors,
    201: { description: "Created", ...json(TemplateSchema) },
    403: { description: "out_of_scope" },
    409: { description: "template_name_taken" },
    422: { description: "Invalid body, or template_invalid with `problems`" },
  },
});

const duplicateRoute = createRoute({
  method: "post",
  path: "/offer-templates/{id}/duplicate",
  tags: ["Offer templates"],
  summary: "Copy a template under a fresh name, e.g. \"Training (copy)\" (deal:manage over the entity)",
  middleware: writing,
  request: { params: IdParams },
  responses: {
    ...commonErrors,
    201: { description: "The copy", ...json(TemplateSchema) },
    403: { description: "out_of_scope" },
    404: { description: "Not found" },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/offer-templates/{id}",
  tags: ["Offer templates"],
  summary: "Replace a template's content (If-Match required)",
  description:
    "The body is the row's format's: a wizard template takes `{ name, language, description, uses, source }`, a legacy " +
    "one its 018 content. 422 `template_invalid` lists a wizard text's `problems`.",
  middleware: writing,
  request: {
    params: IdParams,
    body: { content: { "application/json": { schema: z.object({}).passthrough() } }, required: true },
  },
  responses: {
    ...commonErrors,
    200: { description: "Saved", ...json(TemplateSchema) },
    403: { description: "out_of_scope" },
    404: { description: "Not found" },
    409: { description: "version_conflict or template_name_taken" },
    428: { description: "precondition_required" },
  },
});

const archiveRoute = (action: "archive" | "restore") =>
  createRoute({
    method: "post",
    path: `/offer-templates/{id}/${action}`,
    tags: ["Offer templates"],
    summary:
      action === "archive"
        ? "Archive a template: hidden from the dialog, offers keep their snapshot (If-Match required)"
        : "Restore an archived template (If-Match required)",
    middleware: writing,
    request: { params: IdParams },
    responses: {
    ...commonErrors,
      200: { description: "The template", ...json(TemplateSchema) },
      403: { description: "out_of_scope" },
      404: { description: "Not found" },
      409: { description: "version_conflict or template_name_taken" },
      428: { description: "precondition_required" },
  },
  });

/** The body of a try-preview (plan amendment G1): the editor's text as typed, its sample answers, and the entity and language it shows. */
const TryPreviewBody = z
  .object({
    content: WizardTemplateBody,
    answers: AnswersSchema.optional(),
    entity: EntitySchema,
    language: z.enum(["en", "it"]),
  })
  .strict();

const TRY_PREVIEW_DESCRIPTION =
  "Only with `LETTERHEAD_SERVICE_ENABLED=true`; otherwise 404, as if the route did not exist. The guard is the template editor's READ guard: `deal:financials` " +
  "(a person who may only read the template previews it too; template reads carry no entity scope, so neither does this). The body is `{ content, answers?, entity, language }`: `content` is the template PUT's " +
  "body, `answers` the editor's sample answers (absent: the template's own samples), `entity` and `language` the template's and the text's. A text with errors is 422 " +
  "`template_invalid`; answers are checked as a draft's are, except that a value outside its field's options is not refused, because the text moves under the answers " +
  "while it is being typed. The made-up deal and the sample answers are made by the same conversion as an offer's draft, with the issuer values of the legal entities registry; " +
  "nothing is saved and no version moves. The answer and the errors are those of `POST /deals/{id}/offer-draft/preview`: the service's preview plus `missingFields`; " +
  "409 `letterhead_not_configured`, 409 `letterhead_overflow` with `frame`, 409 `legal_entity_incomplete` (`entity`, `missing[]`), 422 `section_too_long`, 429 `preview_busy` (at most 2 previews " +
  "in flight per person, across both preview routes), 503 `layout_service_unavailable` or `legal_entities_unavailable` (with `Retry-After: 5`). `Cache-Control: no-store`.";

const tryPreviewRoute = createRoute({
  method: "post",
  path: "/offer-templates/{id}/try-preview",
  tags: ["Offer templates"],
  summary: "The pages the layout service draws for an unsaved wizard template with sample answers (deal:financials; stores nothing)",
  description:
    `${TRY_PREVIEW_DESCRIPTION} Here \`entity\` and \`language\` must be the stored template's own (422 when they differ: the pages are drawn on the template's own ` +
    "entity's letterhead), and only a wizard template can be tried (409 `template_format_mismatch`); an unknown id is 404.",
  middleware: [...reading, legalEntitiesRetryAfter, requireLetterheadService],
  request: {
    params: IdParams,
    query: PreviewQuerySchema,
    body: { content: { "application/json": { schema: z.object({}).passthrough() } }, required: true },
  },
  responses: {
    ...commonErrors,
    200: { description: "The pages", ...json(PreviewResponseSchema) },
    404: { description: "Template not found; or the switch is off" },
    409: { description: "letterhead_not_configured / letterhead_overflow / legal_entity_incomplete / template_format_mismatch" },
    422: { description: "Invalid body, entity or language not the template's, template_invalid, answers_invalid, or section_too_long" },
    429: { description: "preview_busy" },
    503: { description: "layout_service_unavailable / legal_entities_unavailable (Retry-After: 5)" },
  },
});

/** The same preview for a template that has no id yet (T53, AC-10.14): the unsaved text, with the entity it will belong to. */
const tryPreviewUnsavedRoute = createRoute({
  method: "post",
  path: "/offer-templates/try-preview",
  tags: ["Offer templates"],
  summary: "The pages the layout service draws for a wizard template that was never saved (deal:financials; stores nothing)",
  description:
    `${TRY_PREVIEW_DESCRIPTION} The body is validated as a template create's is (\`name\`, \`language\`, \`description\`, \`uses\`, \`source\`: 422 with the same ` +
    "codes), and `entity` is the entity the template will be created for; a name that another template holds is not refused here, only a save refuses it.",
  middleware: [...reading, legalEntitiesRetryAfter, requireLetterheadService],
  request: {
    query: PreviewQuerySchema,
    body: { content: { "application/json": { schema: z.object({}).passthrough() } }, required: true },
  },
  responses: {
    ...commonErrors,
    200: { description: "The pages", ...json(PreviewResponseSchema) },
    404: { description: "The switch is off" },
    409: { description: "letterhead_not_configured / letterhead_overflow / legal_entity_incomplete" },
    422: { description: "Invalid body, language not the text's, template_invalid, answers_invalid, or section_too_long" },
    429: { description: "preview_busy" },
    503: { description: "layout_service_unavailable / legal_entities_unavailable (Retry-After: 5)" },
  },
});

export const offerTemplatesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

offerTemplatesRouter.openapi(listRoute, async (c) => {
  const { entity, includeArchived, formats } = c.req.valid("query");
  await seedTemplatesIfEmpty(entity);
  // The wizard seeds only when the caller asks for wizard rows: a client that predates the wizard never triggers
  // the archival of the legacy templates (deploy order, plan R4).
  if (formats.includes("wizard")) await seedWizardTemplates(entity);
  const rows = await db.offerTemplate.findMany({
    where: { entity, format: { in: formats }, ...(includeArchived === "true" ? {} : { archivedAt: null }) },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return c.json({ items: await toViews(c, rows) }, 200);
});

offerTemplatesRouter.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  const row = await loadTemplate(id);
  c.header("ETag", etag(row.version));
  return c.json((await toViews(c, [row]))[0]!, 200);
});

offerTemplatesRouter.openapi(createTemplateRoute, async (c) => {
  const { entity, ...content } = c.req.valid("json");
  assertInScope(dealScope(c), entity);
  assertTemplateValid(content.source);
  const userId = c.get("userId");
  // Archive the pair's legacy templates and insert in ONE transaction, the archive first: a name taken
  // by a legacy template ("Formazione") must not refuse the new one, and a refused insert must archive nothing.
  const row = await inTemplateTransaction(entity, async (tx) => {
    await supersedeLegacy(tx, entity, content.language, userId);
    return tx.offerTemplate.create({ data: { entity, ...wizardDataOf(content), createdBy: userId, updatedBy: userId } });
  }).catch((error: unknown) => {
    throw isUniqueViolation(error) ? nameTaken(content.name) : error;
  });
  c.header("ETag", etag(row.version));
  return c.json((await toViews(c, [row]))[0]!, 201);
});

const COPY_SUFFIX = { en: "(copy)", it: "(copia)" } as const;

offerTemplatesRouter.openapi(duplicateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const found = await loadTemplate(id);
  assertInScope(dealScope(c), found.entity);
  const userId = c.get("userId");
  const suffix = COPY_SUFFIX[found.language];
  let attempted = "";
  const row = await inTemplateTransaction(found.entity, async (tx) => {
    const source = await tx.offerTemplate.findUnique({ where: { id } });
    if (!source) throw notFound("Template not found");
    const taken = new Set(
      (await tx.offerTemplate.findMany({ where: { entity: source.entity, archivedAt: null }, select: { name: true } })).map(
        (other) => other.name.toLowerCase(),
      ),
    );
    const make = (n: number) => {
      const tail = n === 1 ? ` ${suffix}` : ` ${suffix} ${n}`;
      return `${source.name.slice(0, 80 - tail.length).trimEnd()}${tail}`;
    };
    let n = 1;
    while (taken.has(make(n).toLowerCase())) n += 1;
    attempted = make(n);
    let copy;
    if (source.format === "wizard") {
      // A copy of a wizard template is an active wizard template: it supersedes like a create.
      await supersedeLegacy(tx, source.entity, source.language, userId);
      copy = wizardDataOf({
        name: attempted,
        language: source.language,
        description: source.description ?? "",
        uses: source.uses,
        source: source.source ?? "",
      });
    } else {
      // A copy of a legacy template is an active legacy template: not in a pair a wizard template replaced.
      await assertNotSuperseded(tx, source.entity, source.language);
      copy = dataOf({ ...legacyContent(source), name: attempted });
    }
    return tx.offerTemplate.create({ data: { entity: source.entity, ...copy, createdBy: userId, updatedBy: userId } });
  }).catch((error: unknown) => {
    // A concurrent duplicate took the same name: the caller simply retries.
    throw isUniqueViolation(error) ? nameTaken(attempted) : error;
  });
  c.header("ETag", etag(row.version));
  return c.json((await toViews(c, [row]))[0]!, 201);
});

/**
 * Loads, checks scope and precondition, and applies the change with a version CAS, all under the entity's
 * template lock. `step` runs in the transaction, after the precondition: it runs the supersession and the
 * guards that apply to this change (see supersession.ts) and returns the data to write.
 */
async function casUpdate(
  c: HeaderSource & { get(key: "userId"): string; get(key: "authz"): AuthzVariables["authz"] },
  id: string,
  step: (tx: TemplateTx, current: TemplateRow) => Promise<Prisma.OfferTemplateUpdateInput>,
  conflictName: (current: TemplateRow) => string,
) {
  const expected = requireIfMatch(c);
  const found = await loadTemplate(id);
  assertInScope(dealScope(c), found.entity);
  try {
    return await inTemplateTransaction(found.entity, async (tx) => {
      // Read again under the lock: another writer may have changed the row since the check above.
      const current = await tx.offerTemplate.findUnique({ where: { id } });
      if (!current) throw notFound("Template not found");
      assertVersion(current.version, expected);
      const data = await step(tx, current);
      return tx.offerTemplate.update({
        where: { id, version: expected },
        data: { ...data, version: { increment: 1 }, updatedBy: c.get("userId") },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(conflictName(found));
    if (isRecordNotFound(error)) {
      const now = await db.offerTemplate.findUnique({ where: { id }, select: { version: true } });
      if (!now) throw notFound("Template not found");
      throw versionConflict(now.version);
    }
    throw error;
  }
}

offerTemplatesRouter.openapi(updateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const raw = c.req.valid("json") as Record<string, unknown>;
  const actor = c.get("userId");
  const row = await casUpdate(
    c,
    id,
    async (tx, current) => {
      const leavesItsPair = (language: "en" | "it") => current.archivedAt === null && language !== current.language;
      if (current.format === "wizard") {
        const content = parseBody(WizardTemplateBody, raw);
        assertTemplateValid(content.source);
        if (leavesItsPair(content.language)) {
          // An active wizard template moves between pairs: the old one must keep a template, the new one is superseded.
          await assertNotLastActive(tx, current);
          await supersedeLegacy(tx, current.entity, content.language, actor);
        }
        return wizardDataOf(content);
      }
      const content = parseBody(TemplateContentSchema, raw);
      if (leavesItsPair(content.language)) {
        await assertNotLastActive(tx, current);
        await assertNotSuperseded(tx, current.entity, content.language);
      }
      return dataOf(content);
    },
    () => (typeof raw["name"] === "string" ? raw["name"].trim() : ""),
  );
  c.header("ETag", etag(row.version));
  return c.json((await toViews(c, [row]))[0]!, 200);
});

for (const action of ["archive", "restore"] as const) {
  offerTemplatesRouter.openapi(archiveRoute(action), async (c) => {
    const { id } = c.req.valid("param");
    const actor = c.get("userId");
    const row = await casUpdate(
      c,
      id,
      async (tx, current) => {
        if (action === "archive") {
          // Archiving an archived template removes nothing; an active one must not be the last of its pair.
          if (current.archivedAt === null) await assertNotLastActive(tx, current);
          return { archivedAt: new Date() };
        }
        if (current.format === "wizard") await supersedeLegacy(tx, current.entity, current.language, actor);
        else await assertNotSuperseded(tx, current.entity, current.language);
        return { archivedAt: null };
      },
      (current) => current.name,
    );
    c.header("ETag", etag(row.version));
    return c.json((await toViews(c, [row]))[0]!, 200);
  });
}

/**
 * The preview both try-preview routes make: the text as typed, the sample answers and the entity's profile through the layout
 * service, the way an offer's draft is (the cap and the switch are the routes' guard; `section_too_long`, the overflow and the
 * service's failures are `previewThroughService`'s). Nothing is read from or written to a template row.
 */
async function tryPreviewOf(
  c: { header(name: string, value: string): void },
  entity: Entity,
  body: z.infer<typeof TryPreviewBody>,
  pages: string | undefined,
) {
  if (body.language !== body.content.language) throw unprocessable("language: Not the text's language", { field: "language" });
  assertTemplateValid(body.content.source);

  const { ast } = parseTemplate(body.content.source);
  const answers = body.answers as unknown as WizardAnswers | undefined;
  if (answers) {
    const [issue] = checkAnswers(ast, answers, { options: false });
    if (issue) {
      throw new ProblemError({
        status: 422,
        code: "answers_invalid",
        detail: `The answers are not valid at "${issue.path}" (${issue.code})`,
        extras: { path: issue.path, reason: issue.code },
      });
    }
  }
  // The issuer is the registry's (409 `legal_entity_incomplete` when it is incomplete, 503 `legal_entities_unavailable` when unreadable);
  // the CRM's own row only gives the place of issue and may not exist (E4).
  const issuer = await loadIssuer(entity, { requireComplete: true });
  const profile = await loadProfile(entity);
  const blocks = templateToBlocks(
    { entity, ast, language: body.language, ...(answers ? { answers } : {}) },
    letterheadProfileOf(issuer, body.language, profile?.placeOfIssue ?? null),
  );
  c.header("Cache-Control", "no-store");
  return previewThroughService(blocks, pages);
}

offerTemplatesRouter.openapi(tryPreviewRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { pages } = c.req.valid("query");
  const raw = c.req.valid("json") as Record<string, unknown>;
  const found = await loadTemplate(id);
  const body = parseBody(TryPreviewBody, raw);
  if (found.format !== "wizard") throw conflict("template_format_mismatch", "Only a wizard template can be tried", { templateId: found.id });
  // The letterhead is the template's entity's; the body names it and the text's language beside the content only so the three can be told apart.
  if (body.entity !== found.entity) throw unprocessable("entity: Not the template's entity", { field: "entity" });
  return c.json(await tryPreviewOf(c, found.entity, body, pages), 200);
});

offerTemplatesRouter.openapi(tryPreviewUnsavedRoute, async (c) => {
  const { pages } = c.req.valid("query");
  const raw = c.req.valid("json") as Record<string, unknown>;
  const body = parseBody(TryPreviewBody, raw);
  return c.json(await tryPreviewOf(c, body.entity, body, pages), 200);
});

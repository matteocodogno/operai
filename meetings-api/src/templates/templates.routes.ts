/**
 * Summary templates (specs/021-meetings US-8; plan.md § API contracts → Templates).
 * Capability `meetings:access`.
 *
 *   GET    /templates?meetingId=   the picker: recommended for the meeting's host, then personal, shared, built-in
 *   POST   /templates              create a personal template, or a shared one with `template:manage`
 *   PATCH  /templates/:id          change one; If-Match required (428 / 409, G8, ADR-0038)
 *   DELETE /templates/:id          delete one
 *   POST   /templates/:id/duplicate  a personal copy of a built-in, shared or own template (AC-8.4)
 *
 * Built-in templates live in code (`builtin.ts`); personal and shared ones are
 * `summary_template` rows. Built-ins render in the UI language (`Accept-Language`);
 * personal and shared headings are shown as written (AC-8.6).
 *
 * WHO MAY DO WHAT. Every route needs `meetings:access`. A personal template exists only for its
 * owner: for anyone else (a template manager included) it does not exist - 404, identical to an id
 * that was never issued. A shared one is visible to every holder and changed only by a
 * `template:manage` holder (403 otherwise: the caller can see it, ADR-0037's branch). A built-in is
 * read-only for everyone: 403 `builtin_readonly`.
 *
 * EDITS NEVER REACH A SUMMARY (AC-7.5, AC-8.7): a summary keeps its own snapshot, and nothing
 * here touches `summary`.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { MEETINGS_ACCESS, TEMPLATE_MANAGE, capability, holds } from "../auth/guards";
import { hostRegistry } from "../hosts/registry";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { IdParams, commonErrors, etag, requireIfMatch, versionConflict } from "../lib/http";
import { ProblemError, forbidden, notFound, unprocessable, validationHook } from "../lib/problem";
import { BUILTIN_TEMPLATES, TEMPLATE_LIMITS, builtinView, parseAcceptLanguage, type TemplateLanguage, type TemplateSection } from "./builtin";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

// ─── Shapes ──────────────────────────────────────────────────────────────────

export const SectionSchema = z.object({
  heading: z.string().min(1).max(TEMPLATE_LIMITS.heading),
  instruction: z.string().max(TEMPLATE_LIMITS.instruction),
});

// Input: text is trimmed before the limits apply, so "  " is an empty name and not a 2-character one.
const NameInput = z.string().trim().min(1).max(TEMPLATE_LIMITS.name);
const SectionInput = z.object({
  heading: z.string().trim().min(1).max(TEMPLATE_LIMITS.heading),
  instruction: z.string().max(TEMPLATE_LIMITS.instruction).default(""),
});
const SectionsInput = z.array(SectionInput).min(1).max(TEMPLATE_LIMITS.sections);
const GeneralInput = z.string().max(TEMPLATE_LIMITS.generalInstructions);

const CreateBody = z.object({
  scope: z.enum(["personal", "shared"]),
  name: NameInput,
  sections: SectionsInput,
  generalInstructions: GeneralInput.nullish(),
});
const UpdateBody = z.object({
  name: NameInput.optional(),
  sections: SectionsInput.optional(),
  generalInstructions: GeneralInput.nullish(),
});
const DuplicateBody = z.object({ language: z.enum(["en", "it"]).optional() });

export const TemplateItemSchema = z.object({
  id: z.string(),
  source: z.enum(["builtin", "shared", "personal"]),
  name: z.string(),
  sections: z.array(SectionSchema),
  generalInstructions: z.string().nullable(),
  recommended: z.boolean(),
  /** The `If-Match` precondition of a PATCH (ADR-0038, G8). */
  version: z.number().int(),
});

export type TemplateItem = z.infer<typeof TemplateItemSchema>;

type Row = Awaited<ReturnType<typeof db.summaryTemplate.findMany>>[number];

const itemOfRow = (row: Row): Omit<TemplateItem, "recommended"> => ({
  id: row.id,
  source: row.scope,
  name: row.name,
  sections: row.sections as unknown as TemplateSection[],
  generalInstructions: row.generalInstructions,
  version: row.version,
});

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * AC-8.5 as a pure function: the recommended ones first (in the host's own order), then
 * personal, shared and built-in. Within a group: personal and shared by name, built-ins in
 * their fixed order.
 */
export function orderTemplates(
  items: readonly Omit<TemplateItem, "recommended">[],
  recommendedIds: readonly string[],
): TemplateItem[] {
  const rank = new Map(recommendedIds.map((id, index) => [id, index]));
  const groupOrder = { personal: 0, shared: 1, builtin: 2 } as const;
  const builtinOrder = new Map(BUILTIN_TEMPLATES.map((t, index) => [t.id, index]));

  return items
    .map((item) => ({ ...item, recommended: rank.has(item.id) }))
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      if (a.recommended) return rank.get(a.id)! - rank.get(b.id)!;
      if (a.source !== b.source) return groupOrder[a.source] - groupOrder[b.source];
      return a.source === "builtin" ? builtinOrder.get(a.id)! - builtinOrder.get(b.id)! : byName(a, b);
    });
}

/**
 * The templates the host of `meetingId` recommends for `userId`. Only a meeting the caller
 * created or was added to counts: for any other, and for a meeting that does not exist, the
 * answer is "none", which is also the answer for no meeting at all, so the picker cannot be
 * used to learn whether a meeting exists or what it is linked to (AC-5.3).
 */
async function recommendedFor(meetingId: string | undefined, userId: string): Promise<string[]> {
  if (!meetingId) return [];
  const meeting = await db.meeting.findFirst({
    where: { id: meetingId, OR: [{ creatorUserId: userId }, { participants: { some: { userId } } }] },
    select: { hostApp: true, hostEntityType: true },
  });
  if (!meeting?.hostApp || !meeting.hostEntityType) return [];
  return [...(hostRegistry().get(meeting.hostApp, meeting.hostEntityType)?.recommendedTemplates ?? [])];
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/templates",
  tags: ["Templates"],
  summary: "The template picker (meetings:access)",
  middleware: capability(MEETINGS_ACCESS),
  request: { query: z.object({ meetingId: z.string().min(1).max(64).optional() }) },
  responses: { 200: { description: "Templates in picker order", ...json(z.object({ items: z.array(TemplateItemSchema) })) }, ...commonErrors },
});

export const templatesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

templatesRouter.openapi(listRoute, async (c) => {
  const { meetingId } = c.req.valid("query");
  const userId = c.get("userId");
  const language = parseAcceptLanguage(c.req.header("Accept-Language"));

  const [rows, recommendedIds] = await Promise.all([
    db.summaryTemplate.findMany({ where: { OR: [{ scope: "shared" }, { scope: "personal", ownerUserId: userId }] } }),
    recommendedFor(meetingId, userId),
  ]);

  const builtins = BUILTIN_TEMPLATES.map((t) => {
    const view = builtinView(t.id, language)!;
    return {
      id: view.id,
      source: "builtin" as const,
      name: view.name,
      sections: view.sections,
      generalInstructions: view.generalInstructions,
      version: 1,
    };
  });

  return c.json({ items: orderTemplates([...rows.map(itemOfRow), ...builtins], recommendedIds) }, 200);
});

// ─── Writing ─────────────────────────────────────────────────────────────────

const BUILTIN_PREFIX = "builtin:";

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

const nameTaken = (): ProblemError =>
  new ProblemError({
    status: 409,
    code: "template_name_taken",
    detail: "A template with this name already exists",
    extras: { field: "name" },
  });

const builtinReadonly = (): ProblemError => forbidden("Built-in templates cannot be changed or deleted", "builtin_readonly");

/** Blank general instructions are no instructions. */
const generalOf = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value === null || value.trim() === "" ? null : value;

const sectionsJson = (sections: readonly TemplateSection[]): Prisma.InputJsonValue =>
  sections.map((s) => ({ heading: s.heading, instruction: s.instruction }));

const withEtag = (c: { header(name: string, value: string): void }, item: Omit<TemplateItem, "recommended">): TemplateItem => {
  c.header("ETag", etag(item.version));
  return { ...item, recommended: false };
};

/**
 * A row the caller may see: shared, or their own personal. Anything else is a 404 with the
 * same body as an id that never existed.
 */
async function visibleRow(id: string, userId: string): Promise<Row> {
  const row = await db.summaryTemplate.findUnique({ where: { id } });
  if (!row || (row.scope === "personal" && row.ownerUserId !== userId)) throw notFound("Template not found");
  return row;
}

type WriteContext = Parameters<typeof holds>[0];

/** A shared template is changed only by a `template:manage` holder. A personal one has already been narrowed to its owner. */
function assertCanWrite(c: WriteContext, row: Row): void {
  if (row.scope === "shared" && !holds(c, TEMPLATE_MANAGE)) {
    throw forbidden("Changing a shared template needs the template:manage permission", "template_manage_required");
  }
}

const bodyOf = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true as const });

const createTemplateRoute = createRoute({
  method: "post",
  path: "/templates",
  tags: ["Templates"],
  summary: "Create a personal template, or a shared one (template:manage)",
  middleware: capability(MEETINGS_ACCESS),
  request: { body: bodyOf(CreateBody) },
  responses: {
    ...commonErrors,
    201: { description: "Created", ...json(TemplateItemSchema) },
    409: { description: "template_name_taken" },
  },
});

const updateTemplateRoute = createRoute({
  method: "patch",
  path: "/templates/{id}",
  tags: ["Templates"],
  summary: "Change a template; If-Match carries the version of the item as listed (G8)",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: IdParams, body: bodyOf(UpdateBody) },
  responses: {
    ...commonErrors,
    200: { description: "Saved", ...json(TemplateItemSchema) },
    403: { description: "builtin_readonly, or a shared template without template:manage" },
    404: { description: "Not found" },
    409: { description: "version_conflict or template_name_taken" },
    428: { description: "precondition_required" },
  },
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/templates/{id}",
  tags: ["Templates"],
  summary: "Delete a template; summaries already made keep their snapshot",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: IdParams },
  responses: {
    ...commonErrors,
    204: { description: "Deleted" },
    403: { description: "builtin_readonly, or a shared template without template:manage" },
    404: { description: "Not found" },
  },
});

const duplicateTemplateRoute = createRoute({
  method: "post",
  path: "/templates/{id}/duplicate",
  tags: ["Templates"],
  summary: "A personal copy of a built-in, shared or own template (AC-8.4)",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: IdParams },
  responses: {
    ...commonErrors,
    201: { description: "The copy", ...json(TemplateItemSchema) },
    404: { description: "Not found" },
    409: { description: "template_name_taken" },
  },
});

templatesRouter.openapi(createTemplateRoute, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");
  if (body.scope === "shared" && !holds(c, TEMPLATE_MANAGE)) {
    throw forbidden("Creating a shared template needs the template:manage permission", "template_manage_required");
  }
  const row = await db.summaryTemplate
    .create({
      data: {
        scope: body.scope,
        ownerUserId: body.scope === "personal" ? userId : null,
        name: body.name,
        sections: sectionsJson(body.sections),
        generalInstructions: generalOf(body.generalInstructions) ?? null,
        createdBy: userId,
        updatedBy: userId,
      },
    })
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? nameTaken() : error;
    });
  return c.json(withEtag(c, itemOfRow(row)), 201);
});

templatesRouter.openapi(updateTemplateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const userId = c.get("userId");
  if (id.startsWith(BUILTIN_PREFIX)) throw builtinReadonly();

  const row = await visibleRow(id, userId);
  assertCanWrite(c, row);
  const expected = requireIfMatch(c);
  if (row.version !== expected) throw versionConflict(row.version);

  const general = generalOf(body.generalInstructions);
  const changes = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.sections !== undefined ? { sections: sectionsJson(body.sections) } : {}),
    ...(general !== undefined ? { generalInstructions: general } : {}),
  };
  if (Object.keys(changes).length === 0) return c.json(withEtag(c, itemOfRow(row)), 200);

  // Compare-and-set on the version the caller edited (ADR-0038): a concurrent writer makes this match nothing.
  const saved = await db.summaryTemplate
    .updateMany({ where: { id, version: expected }, data: { ...changes, updatedBy: userId, version: { increment: 1 } } })
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? nameTaken() : error;
    });
  if (saved.count === 0) {
    const current = await db.summaryTemplate.findUnique({ where: { id }, select: { version: true } });
    if (!current) throw notFound("Template not found");
    throw versionConflict(current.version);
  }
  return c.json(withEtag(c, itemOfRow(await db.summaryTemplate.findUniqueOrThrow({ where: { id } }))), 200);
});

templatesRouter.openapi(deleteTemplateRoute, async (c) => {
  const { id } = c.req.valid("param");
  if (id.startsWith(BUILTIN_PREFIX)) throw builtinReadonly();
  const row = await visibleRow(id, c.get("userId"));
  assertCanWrite(c, row);
  // A concurrent delete already did what was asked: not an error.
  await db.summaryTemplate.deleteMany({ where: { id } });
  return c.body(null, 204);
});

const COPY_SUFFIX: Record<TemplateLanguage, string> = { en: "(copy)", it: "(copia)" };

templatesRouter.openapi(duplicateTemplateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId");

  // The body is optional; when present it is validated like any other (422, field `language`).
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = DuplicateBody.safeParse(raw ?? {});
  if (!parsed.success) throw unprocessable("language: must be en or it", { field: "language" });
  const language = parsed.data.language ?? parseAcceptLanguage(c.req.header("Accept-Language"));

  let source: { name: string; sections: TemplateSection[]; generalInstructions: string | null };
  if (id.startsWith(BUILTIN_PREFIX)) {
    const view = builtinView(id, language);
    if (!view) throw notFound("Template not found");
    source = view;
  } else {
    const row = await visibleRow(id, userId);
    source = { name: row.name, sections: row.sections as unknown as TemplateSection[], generalInstructions: row.generalInstructions };
  }

  const taken = new Set(
    (await db.summaryTemplate.findMany({ where: { scope: "personal", ownerUserId: userId }, select: { name: true } })).map((r) => r.name.toLowerCase()),
  );
  const suffix = COPY_SUFFIX[language];
  const nameFor = (n: number): string => {
    const tail = n === 1 ? ` ${suffix}` : ` ${suffix.slice(0, -1)} ${n})`;
    return `${source.name.slice(0, TEMPLATE_LIMITS.name - tail.length).trimEnd()}${tail}`;
  };
  let n = 1;
  while (taken.has(nameFor(n).toLowerCase())) n += 1;

  const row = await db.summaryTemplate
    .create({
      data: {
        scope: "personal",
        ownerUserId: userId,
        name: nameFor(n),
        sections: sectionsJson(source.sections),
        generalInstructions: source.generalInstructions,
        createdBy: userId,
        updatedBy: userId,
      },
    })
    .catch((error: unknown) => {
      // A concurrent duplicate took the same name: the caller simply tries again.
      throw isUniqueViolation(error) ? nameTaken() : error;
    });
  return c.json(withEtag(c, itemOfRow(row)), 201);
});

/**
 * Summary templates (specs/021-meetings US-8; plan.md § API contracts → Templates).
 * Capability `meetings:access`.
 *
 *   GET    /templates?meetingId=   the picker: recommended for the meeting's host, then personal, shared, built-in
 *
 * Built-in templates live in code (`builtin.ts`); personal and shared ones are
 * `summary_template` rows. Built-ins render in the UI language (`Accept-Language`);
 * personal and shared headings are shown as written (AC-8.6).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { MEETINGS_ACCESS, capability } from "../auth/guards";
import { hostRegistry } from "../hosts/registry";
import { db } from "../lib/db";
import { commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";
import { BUILTIN_TEMPLATES, TEMPLATE_LIMITS, builtinView, parseAcceptLanguage, type TemplateSection } from "./builtin";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

// ─── Shapes ──────────────────────────────────────────────────────────────────

export const SectionSchema = z.object({
  heading: z.string().min(1).max(TEMPLATE_LIMITS.heading),
  instruction: z.string().max(TEMPLATE_LIMITS.instruction),
});

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

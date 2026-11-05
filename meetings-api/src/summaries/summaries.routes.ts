/**
 * Summaries (specs/021-meetings US-7; plan.md § API contracts → Summaries; ADR-0062, ADR-0067).
 *
 *   GET    /meetings/:id/summaries                       selfScoped + visibility; `can` per item (G4)
 *   POST   /meetings/:id/summaries                       capability + visibility; 202, enqueues `summarize`
 *   POST   /meetings/:id/summaries/:sid/regenerate       a NEW row, same snapshot and language
 *   POST   /meetings/:id/summaries/:sid/retry            the SAME row, a new attemptId
 *   PATCH  /meetings/:id/summaries/:sid                  author or creator, If-Match
 *   DELETE /meetings/:id/summaries/:sid                  selfScoped: author or creator, no capability
 *
 * REQUEST AND JOB. A request validates, takes its slots and writes the `generating` row and the job
 * in ONE transaction (so a refusal or a crash leaves neither, and a rolled-back request gives its
 * AI slot back); the in-process runner picks the job up after commit. The job reads the row's own
 * snapshot, never the live template (AC-7.5).
 *
 * SPEAKER NAMES. A job has no caller token, so the names of Operai participants are resolved HERE,
 * once per request, with the caller's JWT and stored in the snapshot (`template.speakerNames`,
 * `speakerNamesFor`). The look-up is soft (ADR-0039): an outage leaves a speaker as "Speaker n".
 *
 * LOCKS. The 20-summary limit is counted under `pg_advisory_xact_lock` on the meeting, taken BEFORE
 * the per-user lock of the AI limiter, always in that order, so two requests cannot take the 21st
 * slot and cannot deadlock. A refused request throws inside the transaction and writes nothing.
 *
 * DERIVED STATE (ADR-0013/0062). `stale` is `summary.transcriptVersion < meeting.transcriptVersion`
 * of a READY summary. A `generating` row whose current attempt is older than 10 minutes READS
 * `failed` (code `timed_out`) and can be retried; nothing writes that. The attempt's age is its
 * job's `createdAt` (a retry restarts the clock without touching `summary.createdAt`).
 *
 * `can` (per item) mirrors the route outcomes: edit = (author or creator) and `meetings:access` and
 * ready; delete = author or creator (no capability, removing content is never gated); retry = failed
 * and `meetings:access` (regenerate follows the meeting's own `can.summarise`).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { MEETINGS_ACCESS, capability, selfScoped } from "../auth/guards";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { PersonRefSchema, commonErrors, etag, requireIfMatch, versionConflict } from "../lib/http";
import { resolveIdentities, toPersonRef, type PersonRef } from "../lib/identities";
import { conflict, forbidden, notFound, unprocessable, validationHook } from "../lib/problem";
import { enqueueJob } from "../jobs/runner";
import { MAX_SECTION_BODY } from "../ai/prompts/summary";
import { AI_TX, callerOf, type CallerContext, readyForAi, summaryNotFound, takeAiRequest } from "../meetings/aiGate";
import { speakerNamesFor, type SpeakerNames } from "../meetings/promptSegments";
import { openMeeting, type MeetingRole } from "../meetings/visibility";
import { TEMPLATE_LIMITS, builtinSnapshot, parseAcceptLanguage, type TemplateLanguage, type TemplateSection, type TemplateSnapshot } from "../templates/builtin";

/** AC-7.3. */
export const MAX_SUMMARIES_PER_MEETING = 20;
/** AC-7.9, plan § Summaries: a `generating` attempt older than this reads `failed`. */
export const GENERATING_TIMEOUT_MS = 10 * 60_000;

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });
const bodyOf = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true as const });

// ─── Shapes ──────────────────────────────────────────────────────────────────

const SummaryItemSchema = z.object({
  id: z.string(),
  template: z.object({ name: z.string(), source: z.enum(["builtin", "shared", "personal"]) }),
  language: z.enum(["en", "it"]),
  author: PersonRefSchema,
  status: z.enum(["generating", "ready", "failed"]),
  sections: z.array(z.object({ heading: z.string(), body: z.string(), notDiscussed: z.boolean() })).optional(),
  edited: z.boolean(),
  stale: z.boolean(),
  /** Additive to the plan's shape: why a failed summary failed (a closed code), for the plain-language reason (AC-7.9). */
  failure: z.object({ code: z.string() }).nullable(),
  createdAt: z.string(),
  version: z.number().int(),
  can: z.object({ edit: z.boolean(), delete: z.boolean(), retry: z.boolean() }),
});
export type SummaryItem = z.infer<typeof SummaryItemSchema>;

const Params = z.object({ id: z.string().min(1).max(64) });
const SummaryParams = Params.extend({ sid: z.string().min(1).max(64) });

const GenerateBody = z.object({
  templateId: z.string().min(1).max(64),
  language: z.enum(["en", "it"]).optional(),
});
const EditBody = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(TEMPLATE_LIMITS.heading),
        body: z
          .string()
          .max(MAX_SECTION_BODY)
          .refine((text) => text.trim() !== "", "must not be empty"),
      }),
    )
    .min(1)
    .max(TEMPLATE_LIMITS.sections),
});

// ─── The item ────────────────────────────────────────────────────────────────

type Row = Awaited<ReturnType<typeof db.summary.findMany>>[number];

interface ItemContext {
  readonly now: Date;
  readonly meetingVersion: number;
  readonly role: MeetingRole;
  readonly userId: string;
  readonly holdsAccess: boolean;
  readonly people: ReadonlyMap<string, PersonRef>;
  /** When the row's CURRENT attempt began. */
  readonly attemptStart: ReadonlyMap<string, Date>;
}

const snapshotOf = (row: Row): Partial<TemplateSnapshot> => (typeof row.template === "object" && row.template !== null ? (row.template as Partial<TemplateSnapshot>) : {});

function itemOf(row: Row, ctx: ItemContext): SummaryItem {
  const start = ctx.attemptStart.get(row.id) ?? row.createdAt;
  const timedOut = row.status === "generating" && ctx.now.getTime() - start.getTime() >= GENERATING_TIMEOUT_MS;
  const status = timedOut ? "failed" : row.status;
  const snapshot = snapshotOf(row);
  const mine = row.authorUserId === ctx.userId || ctx.role === "creator";

  return {
    id: row.id,
    template: { name: snapshot.name ?? "", source: snapshot.source ?? "personal" },
    language: row.language,
    author: ctx.people.get(row.authorUserId) ?? { id: row.authorUserId, name: null, status: "unknown" },
    status,
    ...(status === "ready" && Array.isArray(row.sections) ? { sections: row.sections as unknown as NonNullable<SummaryItem["sections"]> } : {}),
    edited: row.edited,
    stale: status === "ready" && row.transcriptVersion < ctx.meetingVersion,
    failure: status !== "failed" ? null : { code: timedOut ? "timed_out" : (row.failureCode ?? "internal_error") },
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    can: { edit: mine && ctx.holdsAccess && status === "ready", delete: mine, retry: status === "failed" && ctx.holdsAccess },
  };
}

/** When each row's current attempt began: its job's `createdAt`, else the row's own. */
async function attemptStarts(rows: readonly Row[]): Promise<Map<string, Date>> {
  const generating = rows.filter((r) => r.status === "generating");
  const starts = new Map<string, Date>();
  if (generating.length === 0) return starts;
  const jobs = await db.meetingJob.findMany({
    where: { kind: "summarize", summaryId: { in: generating.map((r) => r.id) } },
    select: { summaryId: true, attemptId: true, createdAt: true },
  });
  for (const row of generating) {
    const times = jobs.filter((j) => j.summaryId === row.id && j.attemptId === row.attemptId).map((j) => j.createdAt.getTime());
    if (times.length > 0) starts.set(row.id, new Date(Math.max(...times)));
  }
  return starts;
}

async function itemsOf(rows: readonly Row[], c: CallerContext, role: MeetingRole, meetingVersion: number): Promise<SummaryItem[]> {
  const caller = callerOf(c);
  const identities = await resolveIdentities(caller.authorization, [...new Set(rows.map((r) => r.authorUserId))]);
  const ctx: ItemContext = {
    now: new Date(),
    meetingVersion,
    role,
    userId: caller.userId,
    holdsAccess: caller.holdsAccess,
    people: new Map([...identities].map(([id, identity]) => [id, toPersonRef(identity)])),
    attemptStart: await attemptStarts(rows),
  };
  return rows.map((row) => itemOf(row, ctx));
}

const meetingVersionOf = async (meetingId: string): Promise<number> =>
  (await db.meeting.findUnique({ where: { id: meetingId }, select: { transcriptVersion: true } }))?.transcriptVersion ?? 0;

/** The summary `sid` of meeting `meetingId`, or the 404. */
async function summaryOf(meetingId: string, sid: string): Promise<Row> {
  const row = await db.summary.findFirst({ where: { id: sid, meetingId } });
  if (!row) throw summaryNotFound();
  return row;
}

// ─── Creating a generating row ───────────────────────────────────────────────

interface NewAttempt {
  readonly meetingId: string;
  readonly userId: string;
  readonly kind: "summary" | "regenerate";
  readonly snapshot: TemplateSnapshot & { speakerNames: SpeakerNames };
  readonly language: TemplateLanguage;
}

/** The limit, the AI slot, the row and the job: all or nothing. */
async function startSummary(input: NewAttempt): Promise<Row> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`summaries:${input.meetingId}`}, 0))`;
    // Re-read inside the transaction: the transcript version stored is the one this request saw ready.
    const meeting = await readyForAi(input.meetingId, tx);
    if ((await tx.summary.count({ where: { meetingId: input.meetingId } })) >= MAX_SUMMARIES_PER_MEETING) {
      throw conflict("summary_limit", `A meeting holds at most ${MAX_SUMMARIES_PER_MEETING} summaries. Delete one first.`);
    }
    await takeAiRequest(tx, input.userId, input.kind);
    const attemptId = crypto.randomUUID();
    const row = await tx.summary.create({
      data: {
        meetingId: input.meetingId,
        authorUserId: input.userId,
        template: input.snapshot as unknown as Prisma.InputJsonValue,
        language: input.language,
        status: "generating",
        attemptId,
        transcriptVersion: meeting.transcriptVersion,
      },
    });
    await enqueueJob(tx, { kind: "summarize", meetingId: input.meetingId, summaryId: row.id, attemptId });
    return row;
  }, AI_TX);
}

const sectionsOf = (sections: readonly TemplateSection[]): TemplateSection[] => sections.map((s) => ({ heading: s.heading, instruction: s.instruction }));

// ─── Routes ──────────────────────────────────────────────────────────────────

export const summariesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

const listRoute = createRoute({
  method: "get",
  path: "/meetings/{id}/summaries",
  tags: ["Summaries"],
  summary: "A meeting's summaries, newest first (anyone who can open the meeting)",
  middleware: selfScoped,
  request: { params: Params },
  responses: { 200: { description: "The summaries", ...json(z.object({ items: z.array(SummaryItemSchema) })) }, 401: commonErrors[401], 404: { description: "Not found" } },
});

const generateRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/summaries",
  tags: ["Summaries"],
  summary: "Generate a summary from a template (meetings:access)",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: Params, body: bodyOf(GenerateBody) },
  responses: {
    ...commonErrors,
    202: { description: "Accepted: generating", ...json(SummaryItemSchema) },
    404: { description: "Meeting or template not found" },
    409: { description: "not_ready, no_speech or summary_limit" },
    429: { description: "ai_rate_limited" },
  },
});

const regenerateRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/summaries/{sid}/regenerate",
  tags: ["Summaries"],
  summary: "A new summary with the same snapshot and language; the earlier one is kept",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: SummaryParams },
  responses: {
    ...commonErrors,
    202: { description: "Accepted: generating", ...json(SummaryItemSchema) },
    404: { description: "Not found" },
    409: { description: "not_ready, no_speech or summary_limit" },
    429: { description: "ai_rate_limited" },
  },
});

const retryRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/summaries/{sid}/retry",
  tags: ["Summaries"],
  summary: "Try a failed summary again: the same row under a new attempt",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: SummaryParams },
  responses: {
    ...commonErrors,
    202: { description: "Accepted: generating", ...json(SummaryItemSchema) },
    404: { description: "Not found" },
    409: { description: "not_ready, no_speech or not_failed" },
    429: { description: "ai_rate_limited" },
  },
});

const editRoute = createRoute({
  method: "patch",
  path: "/meetings/{id}/summaries/{sid}",
  tags: ["Summaries"],
  summary: "Edit a ready summary's text (author or creator; If-Match)",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: SummaryParams, body: bodyOf(EditBody) },
  responses: {
    ...commonErrors,
    200: { description: "Saved", ...json(SummaryItemSchema) },
    403: { description: "author_only, or no meetings:access" },
    404: { description: "Not found" },
    409: { description: "version_conflict or summary_not_ready" },
    428: { description: "precondition_required" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/meetings/{id}/summaries/{sid}",
  tags: ["Summaries"],
  summary: "Delete a summary (author or creator; no capability)",
  middleware: selfScoped,
  request: { params: SummaryParams },
  responses: { 204: { description: "Deleted" }, 401: commonErrors[401], 403: { description: "author_only" }, 404: { description: "Not found" } },
});

summariesRouter.openapi(listRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { role } = await openMeeting(id, callerOf(c));
  const [rows, version] = await Promise.all([
    db.summary.findMany({ where: { meetingId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    meetingVersionOf(id),
  ]);
  return c.json({ items: await itemsOf(rows, c, role, version) }, 200);
});

summariesRouter.openapi(generateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const caller = callerOf(c);
  await openMeeting(id, caller);
  await readyForAi(id);

  const language: TemplateLanguage = body.language ?? parseAcceptLanguage(c.req.header("Accept-Language"));
  let snapshot: TemplateSnapshot;
  if (body.templateId.startsWith("builtin:")) {
    const built = builtinSnapshot(body.templateId, language);
    if (!built) throw notFound("Template not found");
    snapshot = built;
  } else {
    const row = await db.summaryTemplate.findUnique({ where: { id: body.templateId } });
    // Another user's personal template does not exist for this caller.
    if (!row || (row.scope === "personal" && row.ownerUserId !== caller.userId)) throw notFound("Template not found");
    snapshot = {
      source: row.scope,
      templateId: row.id,
      name: row.name,
      sections: sectionsOf(row.sections as unknown as TemplateSection[]),
      generalInstructions: row.generalInstructions,
    };
  }

  const speakerNames = await speakerNamesFor(db, id, caller.authorization);
  const row = await startSummary({ meetingId: id, userId: caller.userId, kind: "summary", snapshot: { ...snapshot, speakerNames }, language });
  const [item] = await itemsOf([row], c, "participant", row.transcriptVersion);
  return c.json(item!, 202);
});

/** The snapshot of `row` with the caller's freshly resolved speaker names. */
async function refreshedSnapshot(row: Row, meetingId: string, authorization: string): Promise<TemplateSnapshot & { speakerNames: SpeakerNames }> {
  const old = snapshotOf(row);
  return {
    source: old.source ?? "personal",
    templateId: old.templateId ?? "",
    name: old.name ?? "",
    sections: old.sections ?? [],
    generalInstructions: old.generalInstructions ?? null,
    speakerNames: await speakerNamesFor(db, meetingId, authorization),
  };
}

summariesRouter.openapi(regenerateRoute, async (c) => {
  const { id, sid } = c.req.valid("param");
  const caller = callerOf(c);
  const { role } = await openMeeting(id, caller);
  const source = await summaryOf(id, sid);
  await readyForAi(id);

  const snapshot = await refreshedSnapshot(source, id, caller.authorization);
  const row = await startSummary({ meetingId: id, userId: caller.userId, kind: "regenerate", snapshot, language: source.language });
  const [item] = await itemsOf([row], c, role, row.transcriptVersion);
  return c.json(item!, 202);
});

summariesRouter.openapi(retryRoute, async (c) => {
  const { id, sid } = c.req.valid("param");
  const caller = callerOf(c);
  const { role } = await openMeeting(id, caller);
  const source = await summaryOf(id, sid);

  // "Failed" is what a reader sees: stored, or a generating attempt past its time.
  const failedNow = async (row: Row) => (await itemsOf([row], c, role, 0))[0]!.status === "failed";
  await readyForAi(id);
  if (!(await failedNow(source))) throw conflict("not_failed", "Only a failed summary can be retried");

  const snapshot = await refreshedSnapshot(source, id, caller.authorization);
  const updated = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`summaries:${id}`}, 0))`;
    const meeting = await readyForAi(id, tx);
    await takeAiRequest(tx, caller.userId, "summary_retry");
    const attemptId = crypto.randomUUID();
    // Compare-and-set on the attempt that failed: a concurrent retry (or a late success) makes this match nothing.
    const moved = await tx.summary.updateMany({
      where: { id: sid, meetingId: id, attemptId: source.attemptId, status: source.status },
      data: {
        status: "generating",
        attemptId,
        failureCode: null,
        template: snapshot as unknown as Prisma.InputJsonValue,
        transcriptVersion: meeting.transcriptVersion,
      },
    });
    if (moved.count === 0) throw conflict("not_failed", "Only a failed summary can be retried");
    await enqueueJob(tx, { kind: "summarize", meetingId: id, summaryId: sid, attemptId });
    return tx.summary.findUniqueOrThrow({ where: { id: sid } });
  }, AI_TX);

  const [item] = await itemsOf([updated], c, role, updated.transcriptVersion);
  return c.json(item!, 202);
});

summariesRouter.openapi(editRoute, async (c) => {
  const { id, sid } = c.req.valid("param");
  const body = c.req.valid("json");
  const caller = callerOf(c);
  const { role } = await openMeeting(id, caller);
  const row = await summaryOf(id, sid);
  if (row.authorUserId !== caller.userId && role !== "creator") {
    throw forbidden("Only the author of the summary or the creator of the meeting can edit it", "author_only");
  }
  const expected = requireIfMatch(c);
  const existing = Array.isArray(row.sections) ? (row.sections as unknown as { heading: string; body: string; notDiscussed: boolean }[]) : [];
  if (row.status !== "ready") throw conflict("summary_not_ready", "Only a ready summary can be edited");
  if (row.version !== expected) throw versionConflict(row.version);
  if (body.sections.length !== existing.length) {
    throw unprocessable(`sections: a summary has ${existing.length} sections`, { field: "sections" });
  }

  const sections = body.sections.map((s, index) => ({ heading: s.heading, body: s.body, notDiscussed: existing[index]!.notDiscussed && existing[index]!.body === s.body }));
  // Compare-and-set on the version the caller edited (ADR-0038).
  const saved = await db.summary.updateMany({
    where: { id: sid, version: expected, status: "ready" },
    data: { sections: sections as unknown as Prisma.InputJsonValue, edited: true, version: { increment: 1 } },
  });
  if (saved.count === 0) {
    const current = await db.summary.findUnique({ where: { id: sid }, select: { version: true, status: true } });
    if (!current) throw summaryNotFound();
    if (current.status !== "ready") throw conflict("summary_not_ready", "Only a ready summary can be edited");
    throw versionConflict(current.version);
  }
  const fresh = await db.summary.findUniqueOrThrow({ where: { id: sid } });
  const [item] = await itemsOf([fresh], c, role, await meetingVersionOf(id));
  c.header("ETag", etag(fresh.version));
  return c.json(item!, 200);
});

summariesRouter.openapi(deleteRoute, async (c) => {
  const { id, sid } = c.req.valid("param");
  const caller = callerOf(c);
  const { role } = await openMeeting(id, caller);
  const row = await summaryOf(id, sid);
  if (row.authorUserId !== caller.userId && role !== "creator") {
    throw forbidden("Only the author of the summary or the creator of the meeting can delete it", "author_only");
  }
  // A concurrent delete already did what was asked. A job still running for it finds nothing to write.
  await db.summary.deleteMany({ where: { id: sid, meetingId: id } });
  return c.body(null, 204);
});

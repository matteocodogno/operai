/**
 * Create, read and edit a meeting (specs/021-meetings plan.md § API contracts → Meetings;
 * AC-1.1 to AC-1.8, AC-2.3, AC-3.5, AC-11.6).
 *
 *   POST  /meetings        `meetings:access`. A host reference is verified AS THE CALLER
 *                          (`hosts/reference.ts`) before anything is written, and a linked
 *                          host that takes notices is told in the same transaction's outbox.
 *   GET   /meetings/:id    visibility only (creator, participant, host reader); never
 *                          depends on `auth` being up (AC-10.6).
 *   PATCH /meetings/:id    creator control: title, date-time, format, language, source.
 *                          The language locks once processing has started (AC-1.8); the
 *                          source locks once audio, a chunk or text exists, NOT on consent
 *                          (G1): a draft may switch between recorded and uploaded keeping
 *                          its attestation, and switching to `text` clears it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MEETINGS_ACCESS, capability, selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { IdParams, commonErrors } from "../lib/http";
import { conflict, validationHook } from "../lib/problem";
import { verifyHostReference } from "../hosts/reference";
import { deliverNotices, recordNotice } from "../hosts/notices";
import { callerOf, creatorControl } from "./caller";
import { lockMeeting } from "./lock";
import {
  HostRefSchema,
  InstantSchema,
  MEETING_FORMATS,
  MEETING_LANGUAGES,
  MEETING_SOURCES,
  MeetingSchema,
  TitleSchema,
} from "./schemas";
import { loadMeetingView } from "./view";
import { assertCreatorControl, meetingNotFound, openMeeting } from "./visibility";

const CreateBody = z.object({
  title: TitleSchema,
  format: z.enum(MEETING_FORMATS),
  startsAt: InstantSchema.optional(),
  language: z.enum(MEETING_LANGUAGES),
  source: z.enum(MEETING_SOURCES),
  host: HostRefSchema.optional(),
});

const PatchBody = z.object({
  title: TitleSchema.optional(),
  startsAt: InstantSchema.optional(),
  format: z.enum(MEETING_FORMATS).optional(),
  language: z.enum(MEETING_LANGUAGES).optional(),
  source: z.enum(MEETING_SOURCES).optional(),
});

const createMeeting = createRoute({
  method: "post",
  path: "/meetings",
  tags: ["Meetings"],
  summary: "Create a meeting (meetings:access)",
  middleware: capability(MEETINGS_ACCESS),
  request: { body: { content: { "application/json": { schema: CreateBody } }, required: true } },
  responses: {
    201: { description: "The meeting", content: { "application/json": { schema: MeetingSchema } } },
    401: commonErrors[401],
    403: commonErrors[403],
    422: { description: "An invalid field, host_not_registered or host_entity_not_found" },
    503: { description: "host_unavailable, or auth is unavailable" },
  },
});

const getMeeting = createRoute({
  method: "get",
  path: "/meetings/{id}",
  tags: ["Meetings"],
  summary: "A meeting the caller may open",
  middleware: selfScoped,
  request: { params: IdParams },
  responses: {
    200: { description: "The meeting", content: { "application/json": { schema: MeetingSchema } } },
    401: commonErrors[401],
    404: { description: "Not found (identical for a meeting the caller may not open)" },
  },
});

const patchMeeting = createRoute({
  method: "patch",
  path: "/meetings/{id}",
  tags: ["Meetings"],
  summary: "Edit a meeting (creator control)",
  middleware: creatorControl,
  request: { params: IdParams, body: { content: { "application/json": { schema: PatchBody } }, required: true } },
  responses: {
    200: { description: "The meeting", content: { "application/json": { schema: MeetingSchema } } },
    401: commonErrors[401],
    403: commonErrors[403],
    404: { description: "Not found" },
    409: { description: "language_locked or source_locked" },
    422: commonErrors[422],
    503: commonErrors[503],
  },
});

export const coreRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

coreRouter.openapi(createMeeting, async (c) => {
  const body = c.req.valid("json");
  const caller = callerOf(c);

  // Verified before anything is written, as the caller; fails closed (AC-1.5, AC-1.6, AC-11.6).
  if (body.host) await verifyHostReference(body.host, caller.authorization);

  const { id, noticeId } = await db.$transaction(async (tx) => {
    const meeting = await tx.meeting.create({
      data: {
        title: body.title,
        format: body.format,
        startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
        language: body.language,
        source: body.source,
        creatorUserId: caller.userId,
        ...(body.host ? { hostApp: body.host.app, hostEntityType: body.host.entityType, hostEntityId: body.host.entityId } : {}),
      },
    });
    const noticeId = body.host
      ? await recordNotice(tx, meeting, { app: body.host.app, entityType: body.host.entityType, entityId: body.host.entityId }, { event: "linked", title: meeting.title, startsAt: meeting.startsAt })
      : null;
    return { id: meeting.id, noticeId };
  });

  // One awaited attempt; whatever happens the meeting exists (AC-11.9).
  await deliverNotices([noticeId]);
  return c.json(await loadMeetingView(id, caller, new Date()), 201);
});

coreRouter.openapi(getMeeting, async (c) => {
  const { id } = c.req.valid("param");
  return c.json(await loadMeetingView(id, callerOf(c), new Date()), 200);
});

/** G1: the source is locked once the meeting left `draft` or any audio, chunk or text exists. Mirrors `can.changeSource`. */
async function sourceIsLocked(tx: Prisma.TransactionClient, meeting: { id: string; status: string; audioKey: string | null; audioCreatedAt: Date | null }): Promise<boolean> {
  if (meeting.status !== "draft" || meeting.audioKey !== null || meeting.audioCreatedAt !== null) return true;
  const [chunks, segments] = await Promise.all([
    tx.recordingChunk.count({ where: { meetingId: meeting.id } }),
    tx.transcriptSegment.count({ where: { meetingId: meeting.id } }),
  ]);
  return chunks > 0 || segments > 0;
}

coreRouter.openapi(patchMeeting, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const caller = callerOf(c);
  const { meeting: visible, role } = await openMeeting(id, caller);
  await assertCreatorControl(role, caller, visible.creatorUserId);

  await db.$transaction(async (tx) => {
    await lockMeeting(tx, id);
    const row = await tx.meeting.findUnique({ where: { id } });
    if (!row) throw meetingNotFound();

    const data: Prisma.MeetingUpdateInput = {};
    if (body.title !== undefined && body.title !== row.title) data.title = body.title;
    if (body.format !== undefined && body.format !== row.format) data.format = body.format;
    if (body.startsAt !== undefined && new Date(body.startsAt).getTime() !== row.startsAt.getTime()) data.startsAt = new Date(body.startsAt);

    if (body.language !== undefined && body.language !== row.language) {
      if (row.processingStartedAt !== null) throw conflict("language_locked", "The language cannot change once processing has started");
      data.language = body.language;
    }

    if (body.source !== undefined && body.source !== row.source) {
      if (await sourceIsLocked(tx, row)) throw conflict("source_locked", "The source cannot change once audio, a recording or text exists");
      data.source = body.source;
      // A pasted text carries no consent attestation (G1, AC-3.4); recorded <-> uploaded keeps it.
      if (body.source === "text") {
        data.consentUserId = null;
        data.consentAt = null;
        data.consentNoticeVersion = null;
      }
    }

    if (Object.keys(data).length > 0) await tx.meeting.update({ where: { id }, data });
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 200);
});

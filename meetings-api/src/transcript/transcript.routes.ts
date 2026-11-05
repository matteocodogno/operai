/**
 * The transcript: read it, correct a segment, name a speaker (specs/021-meetings
 * plan.md § API contracts "Transcript"; AC-6.1, AC-6.2, AC-6.3, AC-6.8).
 *
 *   GET   /meetings/:id/transcript                      selfScoped + visibility
 *   PATCH /meetings/:id/transcript/segments/:segmentId  creator-control + If-Match (segment version)
 *   PUT   /meetings/:id/transcript/speakers/:key        creator-control
 *
 * A segment edit bumps the segment's `version` (ADR-0038 CAS) and the MEETING's
 * `transcriptVersion`, which is how a summary made from an earlier text reads "stale"
 * (AC-6.8). An edit enqueues nothing: nothing is regenerated automatically. A speaker
 * label is per KEY, so naming one applies to every segment that carries it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../lib/db";
import { IdParams, commonErrors, etag, requireIfMatch, versionConflict } from "../lib/http";
import { ProblemError, conflict, notFound, validationHook } from "../lib/problem";
import { openMeeting } from "../meetings/visibility";
import { selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { callerOf, creatorControl, openForControl } from "../capture/caller";

export const MAX_SEGMENT_CHARS = 10_000;
export const MAX_SPEAKER_LABEL_CHARS = 100;

// ─── Shapes ──────────────────────────────────────────────────────────────────

const SegmentSchema = z.object({
  id: z.string(),
  ordinal: z.number().int(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
  speakerKey: z.string().nullable(),
  text: z.string(),
  edited: z.boolean(),
  version: z.number().int(),
});

const LabelSchema = z.union([
  z.object({ kind: z.literal("default"), index: z.number().int() }),
  z.object({ kind: z.literal("participant"), participantId: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
]);
type Label = z.infer<typeof LabelSchema>;

const TranscriptSchema = z.object({
  version: z.number().int(),
  segments: z.array(SegmentSchema),
  speakers: z.array(z.object({ key: z.string(), label: LabelSchema })),
});

interface SegmentRow {
  readonly id: string;
  readonly ordinal: number;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly speakerKey: string | null;
  readonly text: string;
  readonly edited: boolean;
  readonly version: number;
}

const toSegment = (row: SegmentRow) => ({
  id: row.id,
  ordinal: row.ordinal,
  startMs: row.startMs,
  endMs: row.endMs,
  speakerKey: row.speakerKey,
  text: row.text,
  edited: row.edited,
  version: row.version,
});

/** Speaker keys in order of first appearance: that order is the "Speaker n" numbering. */
const speakerKeysOf = (segments: readonly { speakerKey: string | null }[]): string[] => {
  const keys: string[] = [];
  for (const { speakerKey } of segments) if (speakerKey !== null && !keys.includes(speakerKey)) keys.push(speakerKey);
  return keys;
};

const labelOf = (
  key: string,
  order: readonly string[],
  stored: { participantId: string | null; customLabel: string | null } | undefined,
): Label => {
  if (stored?.participantId) return { kind: "participant", participantId: stored.participantId };
  if (stored?.customLabel) return { kind: "text", text: stored.customLabel };
  return { kind: "default", index: order.indexOf(key) + 1 };
};

// ─── Routes ──────────────────────────────────────────────────────────────────

const getRoute = createRoute({
  method: "get",
  path: "/meetings/{id}/transcript",
  tags: ["Transcript"],
  summary: "Segments in time order and the speakers",
  middleware: selfScoped,
  request: { params: IdParams },
  responses: {
    200: { description: "The transcript", content: { "application/json": { schema: TranscriptSchema } } },
    404: { description: "No such meeting, or not visible to the caller" },
    401: { description: "Missing or invalid token" },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/meetings/{id}/transcript/segments/{segmentId}",
  tags: ["Transcript"],
  summary: "Correct a segment's text",
  middleware: creatorControl,
  request: {
    params: IdParams.extend({ segmentId: z.string().min(1).max(64) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            text: z.string().min(1).max(MAX_SEGMENT_CHARS).refine((t) => t.trim().length > 0, "must not be empty"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "The segment", content: { "application/json": { schema: SegmentSchema } } },
    409: { description: "version_conflict or not_ready" },
    428: { description: "If-Match is required" },
    ...commonErrors,
  },
});

const speakerBody = z.union([
  z.object({ participantId: z.string().min(1).max(64) }).strict(),
  z.object({ text: z.string().trim().min(1).max(MAX_SPEAKER_LABEL_CHARS) }).strict(),
  z.null(),
]);

const speakerRoute = createRoute({
  method: "put",
  path: "/meetings/{id}/transcript/speakers/{key}",
  tags: ["Transcript"],
  summary: "Name a speaker after a participant or free text, or reset it",
  middleware: creatorControl,
  request: {
    params: IdParams.extend({ key: z.string().min(1).max(64) }),
    body: { content: { "application/json": { schema: speakerBody } } },
  },
  responses: {
    200: { description: "The speaker's label", content: { "application/json": { schema: z.object({ key: z.string(), label: LabelSchema }) } } },
    ...commonErrors, // 422 participant_not_in_meeting
  },
});

export const transcriptRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

transcriptRouter.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  await openMeeting(id, callerOf(c));

  const [meeting, segments, labels] = await Promise.all([
    db.meeting.findUniqueOrThrow({ where: { id }, select: { transcriptVersion: true } }),
    db.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" } }),
    db.speakerLabel.findMany({ where: { meetingId: id } }),
  ]);
  const storedByKey = new Map(labels.map((l) => [l.speakerKey, l]));
  const order = speakerKeysOf(segments);
  return c.json(
    {
      version: meeting.transcriptVersion,
      segments: segments.map(toSegment),
      speakers: order.map((key) => ({ key, label: labelOf(key, order, storedByKey.get(key)) })),
    },
    200,
  );
});

transcriptRouter.openapi(patchRoute, async (c) => {
  const { id, segmentId } = c.req.valid("param");
  const { text } = c.req.valid("json");
  await openForControl(id, callerOf(c));
  const expected = requireIfMatch(c);

  const segment = await db.$transaction(async (tx) => {
    const meeting = await tx.meeting.findUniqueOrThrow({ where: { id }, select: { status: true, noSpeech: true } });
    const current = await tx.transcriptSegment.findFirst({ where: { id: segmentId, meetingId: id } });
    if (!current) throw notFound("Segment not found");
    if (meeting.status !== "ready" || meeting.noSpeech) throw conflict("not_ready", "The transcript can only be edited once it is ready");
    if (current.version !== expected) throw versionConflict(current.version);
    // Nothing changed: no new version, and no summary turns stale for it.
    if (current.text === text) return current;

    // Compare-and-set on the version the caller edited: a concurrent edit wins or loses cleanly.
    const updated = await tx.transcriptSegment.updateMany({
      where: { id: segmentId, meetingId: id, version: expected },
      data: { text, edited: true, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      const now = await tx.transcriptSegment.findFirstOrThrow({ where: { id: segmentId, meetingId: id }, select: { version: true } });
      throw versionConflict(now.version);
    }
    await tx.meeting.update({ where: { id }, data: { transcriptVersion: { increment: 1 } } });
    return tx.transcriptSegment.findUniqueOrThrow({ where: { id: segmentId } });
  });

  c.header("ETag", etag(segment.version));
  return c.json(toSegment(segment), 200);
});

transcriptRouter.openapi(speakerRoute, async (c) => {
  const { id, key } = c.req.valid("param");
  const body = c.req.valid("json");
  await openForControl(id, callerOf(c));

  const label = await db.$transaction(async (tx) => {
    const segments = await tx.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" }, select: { speakerKey: true } });
    const order = speakerKeysOf(segments);
    if (!order.includes(key)) throw notFound("Speaker not found");

    if (body === null) {
      await tx.speakerLabel.deleteMany({ where: { meetingId: id, speakerKey: key } });
      return labelOf(key, order, undefined);
    }
    if ("participantId" in body) {
      const participant = await tx.meetingParticipant.findFirst({ where: { id: body.participantId, meetingId: id }, select: { id: true } });
      if (!participant) {
        throw new ProblemError({ status: 422, code: "participant_not_in_meeting", detail: "That person is not a participant of this meeting", extras: { field: "participantId" } });
      }
      await tx.speakerLabel.upsert({
        where: { meetingId_speakerKey: { meetingId: id, speakerKey: key } },
        create: { meetingId: id, speakerKey: key, participantId: participant.id },
        update: { participantId: participant.id, customLabel: null },
      });
      return labelOf(key, order, { participantId: participant.id, customLabel: null });
    }
    await tx.speakerLabel.upsert({
      where: { meetingId_speakerKey: { meetingId: id, speakerKey: key } },
      create: { meetingId: id, speakerKey: key, customLabel: body.text },
      update: { customLabel: body.text, participantId: null },
    });
    return labelOf(key, order, { participantId: null, customLabel: body.text });
  });

  return c.json({ key, label }, 200);
});

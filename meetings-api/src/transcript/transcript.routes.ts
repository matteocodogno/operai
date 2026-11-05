/**
 * The transcript: read it, correct a segment, name a speaker (specs/021-meetings
 * plan.md § API contracts "Transcript"; AC-6.1, AC-6.2, AC-6.3, AC-6.8).
 *
 *   GET   /meetings/:id/transcript                      selfScoped + visibility
 *   PATCH /meetings/:id/transcript/segments/:segmentId  creator-control + If-Match (segment version)
 *   PUT   /meetings/:id/transcript/speakers/:key        creator-control
 *   POST  /meetings/:id/transcript/speakers/:key/separate   creator-control (AC-6.16)
 *
 * A segment edit bumps the segment's `version` (ADR-0038 CAS) and the MEETING's
 * `transcriptVersion`, which is how a summary made from an earlier text reads "stale"
 * (AC-6.8). An edit enqueues nothing: nothing is regenerated automatically. A speaker
 * label is per KEY, so naming one applies to every segment that carries it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { speakerIndexOf, speakerKeyOf } from "../ai/segments";
import { db } from "../lib/db";
import { IdParams, commonErrors, etag, requireIfMatch, versionConflict } from "../lib/http";
import { ProblemError, conflict, notFound, validationHook } from "../lib/problem";
import { openMeeting } from "../meetings/visibility";
import { selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { openForControl } from "../capture/caller";
import { callerOf, creatorControl } from "../meetings/caller";

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
  /** The transcript part (1-based) the segment comes from; null for a text meeting and for rows older than the column. */
  part: z.number().int().nullable(),
});

const LabelSchema = z.union([
  z.object({ kind: z.literal("default"), index: z.number().int() }),
  z.object({ kind: z.literal("participant"), participantId: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
]);
type Label = z.infer<typeof LabelSchema>;

const SpeakerSchema = z.object({
  key: z.string(),
  label: LabelSchema,
  /** The transcript parts the key's segments come from, ascending; `[]` for a text meeting and for rows with no part. */
  parts: z.array(z.number().int().min(1)),
  /** True when the key covers more than one part: the overlap showed it to be the same speaker (AC-6.14, AC-6.16). */
  joined: z.boolean(),
});
type Speaker = z.infer<typeof SpeakerSchema>;

const RangeSchema = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0) });

const TranscriptSchema = z.object({
  version: z.number().int(),
  /**
   * The transcript parts (ADR-0070, H-6): `[]` for a text meeting and for one that heard nothing, else one entry per
   * part (1-based `index`), overlapping: a part's end is not the next part's start.
   */
  parts: z.array(z.object({ index: z.number().int().min(1), startMs: z.number().int().min(0), endMs: z.number().int().min(0) })),
  segments: z.array(SegmentSchema),
  speakers: z.array(SpeakerSchema),
  /** Stretches that may be missing from the transcript (AC-6.12): meeting time, merged, ascending. `[]` = no notice. */
  gaps: z.array(RangeSchema),
  /** AC-6.15's notice: more than one part and at least one label of a later part that is not joined. */
  separateLabels: z.boolean(),
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
  readonly part: number | null;
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
  part: row.part,
});

/** Speaker keys in order of first appearance: that order is the "Speaker n" numbering. */
const speakerKeysOf = (segments: readonly { speakerKey: string | null }[]): string[] => {
  const keys: string[] = [];
  for (const { speakerKey } of segments) if (speakerKey !== null && !keys.includes(speakerKey)) keys.push(speakerKey);
  return keys;
};

/**
 * The label a key reads as. The default "Speaker n" is the KEY'S OWN number (`s3` is Speaker 3) unless the label row
 * stored a `defaultIndex` (a separated label that inherits an unnamed "Speaker n", AC-6.16): so separating a joined
 * label never renumbers anyone else (H-5). A key that is not of the `s<n>` form reads as its position of first
 * appearance, as before.
 */
export const labelOf = (
  key: string,
  order: readonly string[],
  stored: { participantId: string | null; customLabel: string | null; defaultIndex?: number | null } | undefined,
): Label => {
  if (stored?.participantId) return { kind: "participant", participantId: stored.participantId };
  if (stored?.customLabel) return { kind: "text", text: stored.customLabel };
  return { kind: "default", index: stored?.defaultIndex ?? speakerIndexOf(key) ?? order.indexOf(key) + 1 };
};

/** The speakers of a transcript, in order of first appearance, with the parts each covers (derived on read, H-5). */
export function speakersOf(
  segments: readonly { speakerKey: string | null; part: number | null }[],
  labels: readonly { speakerKey: string; participantId: string | null; customLabel: string | null; defaultIndex: number | null }[],
): Speaker[] {
  const storedByKey = new Map(labels.map((l) => [l.speakerKey, l]));
  const order = speakerKeysOf(segments);
  return order.map((key) => {
    const parts = [...new Set(segments.filter((s) => s.speakerKey === key && s.part !== null).map((s) => s.part as number))].sort((a, b) => a - b);
    return { key, label: labelOf(key, order, storedByKey.get(key)), parts, joined: parts.length > 1 };
  });
}

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

const separateRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/transcript/speakers/{key}/separate",
  tags: ["Transcript"],
  summary: "Separate a joined speaker by part (each part's speech gets its own label)",
  description:
    "The lowest part keeps the key; each further part, in ascending order, takes the next unused speaker number and a label that copies " +
    "the joined label's name (a participant, a free text, or the unnamed 'Speaker n' it inherited). Changes labels only: no transcript " +
    "version bump. 409 `not_joined` when the key covers at most one part (a second call is refused, not a no-op).",
  middleware: creatorControl,
  request: { params: IdParams.extend({ key: z.string().min(1).max(64) }) },
  responses: {
    200: { description: "The speakers, as the transcript lists them", content: { "application/json": { schema: z.object({ speakers: z.array(SpeakerSchema) }) } } },
    409: { description: "not_ready or not_joined" },
    ...commonErrors,
  },
});

/** Takes the meeting row: renames and separations of one meeting never interleave (a copied name is never stale). */
const lockMeeting = (tx: Pick<typeof db, "$queryRaw">, id: string) => tx.$queryRaw`SELECT "id" FROM "meeting" WHERE "id" = ${id} FOR UPDATE`;

export const transcriptRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

transcriptRouter.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  await openMeeting(id, callerOf(c));

  const [meeting, segments, labels, gaps] = await Promise.all([
    db.meeting.findUniqueOrThrow({ where: { id }, select: { transcriptVersion: true, transcriptPartStartsMs: true, transcriptPartEndsMs: true } }),
    db.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" } }),
    db.speakerLabel.findMany({ where: { meetingId: id } }),
    db.transcriptGap.findMany({ where: { meetingId: id }, orderBy: { startMs: "asc" }, select: { startMs: true, endMs: true } }),
  ]);
  const starts = meeting.transcriptPartStartsMs;
  const lastEnd = segments.reduce((end, s) => Math.max(end, s.endMs ?? 0), 0);
  // Parts stored before the ends existed end where the next starts, the last at its last segment (never before it starts).
  const parts = starts.map((startMs, i) => ({ index: i + 1, startMs, endMs: meeting.transcriptPartEndsMs[i] ?? starts[i + 1] ?? Math.max(startMs, lastEnd) }));
  const speakers = speakersOf(segments, labels);
  return c.json(
    {
      version: meeting.transcriptVersion,
      parts,
      segments: segments.map(toSegment),
      speakers,
      gaps,
      // AC-6.15: more than one part and at least one key whose first part is a later one (derived, never stored)
      separateLabels: parts.length > 1 && speakers.some((sp) => sp.parts.length > 0 && sp.parts[0]! > 1),
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
    await lockMeeting(tx, id);
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
        update: { participantId: participant.id, customLabel: null, defaultIndex: null },
      });
      return labelOf(key, order, { participantId: participant.id, customLabel: null });
    }
    await tx.speakerLabel.upsert({
      where: { meetingId_speakerKey: { meetingId: id, speakerKey: key } },
      create: { meetingId: id, speakerKey: key, customLabel: body.text },
      update: { customLabel: body.text, participantId: null, defaultIndex: null },
    });
    return labelOf(key, order, { participantId: null, customLabel: body.text });
  });

  return c.json({ key, label }, 200);
});

transcriptRouter.openapi(separateRoute, async (c) => {
  const { id, key } = c.req.valid("param");
  await openForControl(id, callerOf(c));

  const speakers = await db.$transaction(async (tx) => {
    // Serialised with renames and with another separation: the second one then finds the key already separated.
    await lockMeeting(tx, id);
    const meeting = await tx.meeting.findUniqueOrThrow({ where: { id }, select: { status: true, noSpeech: true } });
    if (meeting.status !== "ready" || meeting.noSpeech) throw conflict("not_ready", "Speakers can only be separated once the transcript is ready");

    const segments = await tx.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" }, select: { speakerKey: true, part: true } });
    const order = speakerKeysOf(segments);
    if (!order.includes(key)) throw notFound("Speaker not found");
    const parts = [...new Set(segments.filter((s) => s.speakerKey === key && s.part !== null).map((s) => s.part as number))].sort((a, b) => a - b);
    if (parts.length <= 1) throw conflict("not_joined", "That speaker was not matched across parts");

    const labels = await tx.speakerLabel.findMany({ where: { meetingId: id } });
    const stored = labels.find((l) => l.speakerKey === key);
    const named = Boolean(stored?.participantId || stored?.customLabel);
    // An unnamed "Speaker n" keeps reading n on every part until renamed (H-0, H-5).
    const inherited = stored?.defaultIndex ?? speakerIndexOf(key) ?? order.indexOf(key) + 1;
    // The next unused number, over every key the meeting has ever carried (segments and label rows alike).
    let next = 1 + Math.max(0, ...[...order, ...labels.map((l) => l.speakerKey)].map((k) => speakerIndexOf(k) ?? 0));

    for (const part of parts.slice(1)) {
      const created = speakerKeyOf(next);
      next += 1;
      await tx.speakerLabel.create({
        data: {
          meetingId: id,
          speakerKey: created,
          participantId: stored?.participantId ?? null,
          customLabel: stored?.customLabel ?? null,
          defaultIndex: named ? null : inherited,
        },
      });
      // Labels only: the segment's text and `version` are untouched, and so is the transcript's version.
      await tx.transcriptSegment.updateMany({ where: { meetingId: id, speakerKey: key, part }, data: { speakerKey: created } });
    }

    const [after, afterLabels] = await Promise.all([
      tx.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" }, select: { speakerKey: true, part: true } }),
      tx.speakerLabel.findMany({ where: { meetingId: id } }),
    ]);
    return speakersOf(after, afterLabels);
  });

  console.log(`[transcript] separated speaker into ${speakers.length} labels`);
  return c.json({ speakers }, 200);
});

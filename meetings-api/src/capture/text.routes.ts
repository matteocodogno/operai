/**
 * `PUT /meetings/:id/text`: pasted or typed text becomes the transcript
 * (specs/021-meetings AC-3.4, AC-6.1; plan.md § Capture).
 *
 * A `text` meeting has no consent attestation (G1) and no audio, so nothing is
 * queued: the passages are written and the meeting is `ready` in the same
 * transaction. The length limit is 200,000 CHARACTERS (code points), enforced here;
 * the router-level body limit (1 MiB, src/index.ts) is only the transport ceiling.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { conflict, validationHook } from "../lib/problem";
import { loadMeetingView } from "../meetings/view";
import { splitPassages } from "../transcript/passages";
import type { AuthzVariables } from "../auth/authz.middleware";
import { callerOf, creatorControl, openForControl } from "./caller";

export const MAX_TEXT_CHARS = 200_000;

const countCharacters = (text: string): number => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

const putTextRoute = createRoute({
  method: "put",
  path: "/meetings/{id}/text",
  tags: ["Capture"],
  summary: "Set the text of a text meeting",
  middleware: creatorControl,
  request: {
    params: IdParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // 2 units per character is the worst case, so this only bounds work before the exact count.
            text: z
              .string()
              .min(1)
              .max(MAX_TEXT_CHARS * 2)
              .refine((t) => countCharacters(t) <= MAX_TEXT_CHARS, `at most ${MAX_TEXT_CHARS} characters`)
              .refine((t) => t.trim().length > 0, "must not be empty"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "The meeting, ready", content: { "application/json": { schema: z.object({}).passthrough() } } },
    409: { description: "wrong_source or not_editable" },
    ...commonErrors,
  },
});

export const textRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

textRouter.openapi(putTextRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { text } = c.req.valid("json");
  const caller = callerOf(c);
  await openForControl(id, caller);

  const passages = splitPassages(text);
  const now = new Date();

  await db.$transaction(async (tx) => {
    const meeting = await tx.meeting.findUniqueOrThrow({ where: { id }, select: { source: true, status: true } });
    if (meeting.source !== "text") throw conflict("wrong_source", "Only a text meeting takes text");
    // Compare-and-set on the status read: a concurrent replace serialises on the row.
    const flipped = await tx.meeting.updateMany({
      where: { id, status: { in: ["draft", "ready"] } },
      data: {
        status: "ready",
        stage: null,
        failureCode: null,
        noSpeech: false,
        durationMs: null,
        ...(meeting.status === "draft" ? { processingStartedAt: now } : {}),
        processingRequestedBy: caller.userId,
        processedAt: now,
        transcriptVersion: { increment: 1 },
      },
    });
    if (flipped.count === 0) throw conflict("not_editable", "The text of this meeting cannot be changed now");
    await tx.speakerLabel.deleteMany({ where: { meetingId: id } });
    await tx.transcriptSegment.deleteMany({ where: { meetingId: id } });
    await tx.transcriptSegment.createMany({
      data: passages.map((passage, ordinal) => ({ meetingId: id, ordinal, text: passage })),
    });
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 200);
});

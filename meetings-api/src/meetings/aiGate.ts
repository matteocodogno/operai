/**
 * What summaries and questions have in common (specs/021-meetings plan.md § Authorization
 * "Action matrix": generate / regenerate / retry / ask need visibility + `meetings:access` +
 * `ready` + speech + the AI rate limit; AC-6.7, AC-7.1, AC-9.1).
 *
 *   readyForAi      the meeting's state: 409 `not_ready` unless `ready`, 409 `no_speech` when the
 *                   recording held none (checked in that order, a `noSpeech` meeting is `ready`)
 *   takeAiRequest   one slot of the hourly limiter inside the caller's transaction, or the 429
 */

import { consumeAiRequestIn, AiRateLimitedError } from "../ai/rateLimit";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { conflict, notFound } from "../lib/problem";
import { meetingNotFound } from "./visibility";

export interface AiMeeting {
  readonly id: string;
  readonly source: "recorded" | "uploaded" | "text";
  readonly language: "en" | "it";
  readonly transcriptVersion: number;
}

/** The facts an AI request needs, inside `tx` when given (so the check and the write see one state). */
export async function readyForAi(meetingId: string, tx: Pick<Prisma.TransactionClient, "meeting"> = db): Promise<AiMeeting> {
  const row = await tx.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, status: true, noSpeech: true, source: true, language: true, transcriptVersion: true },
  });
  // Deleted between the visibility check and now: the same answer as any other absent meeting.
  if (!row) throw meetingNotFound();
  if (row.status !== "ready") throw conflict("not_ready", "The meeting is not ready yet");
  if (row.noSpeech) throw conflict("no_speech", "No speech was detected in this meeting");
  return { id: row.id, source: row.source, language: row.language, transcriptVersion: row.transcriptVersion };
}

/** Takes a slot or throws 429. A throw rolls the surrounding transaction back, so a refused request writes nothing. */
export async function takeAiRequest(tx: Prisma.TransactionClient, userId: string, kind: string): Promise<void> {
  const result = await consumeAiRequestIn(tx, userId, kind);
  if (!result.allowed) throw new AiRateLimitedError(result.retryAfterSeconds);
}

/** Interactive-transaction options: callers queued behind one user's advisory lock wait for a connection. */
export const AI_TX = { maxWait: 10_000, timeout: 10_000 } as const;

export const summaryNotFound = () => notFound("Summary not found");

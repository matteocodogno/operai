/**
 * The requester's notification when processing ends (specs/021-meetings AC-12.2, AC-12.4;
 * ADR-0065): the meeting TITLE and the OUTCOME, nothing else (the copy catalog takes no
 * other input). Shared by `prepare_audio` and `transcribe`, the two jobs that can end a
 * processing run, so the recipient rule lives once.
 *
 * Best effort and sent AFTER the commit that recorded the outcome (`announce` never throws).
 * The actor is the service, not a user, so the person who asked is still notified.
 */

import type { NotifyEvent } from "../../lib/notify";

/** Not a user: the actor of a job. */
export const JOB_ACTOR = "system:meetings-api";

export type ProcessingOutcome = "transcription_done" | "transcription_failed";

export interface NoticeMeeting {
  readonly id: string;
  readonly title: string;
  readonly processingRequestedBy: string | null;
  readonly creatorUserId: string;
}

/** Whoever asked for the processing (a retry may be a later request than the first); the creator if unrecorded. */
export function announceProcessing(
  announce: (event: NotifyEvent) => void,
  meeting: NoticeMeeting,
  kind: ProcessingOutcome,
): void {
  announce({
    kind,
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    actorId: JOB_ACTOR,
    recipientIds: [meeting.processingRequestedBy ?? meeting.creatorUserId],
  });
}

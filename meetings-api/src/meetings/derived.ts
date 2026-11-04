/**
 * Time-based meeting state, DERIVED on read with an injected clock and never
 * written by a sweep or a queue (specs/021-meetings plan.md § Browser capture
 * "Liveness and `interrupted`", § Retention D-9; ADR-0013 lineage; AC-2.8, AC-2.9,
 * AC-4.4). Pure: no database, no `Date.now()`, no side effect.
 */

import type { MeetingStatus } from "../lib/generated/prisma/enums";

/** A recording that has received neither a chunk nor a keep-alive for this long reads `interrupted` (AC-2.8, amendment A1). */
export const INTERRUPTED_AFTER_MS = 120_000;
/** The bucket lifecycle rule expires audio after this many days (plan D-9). */
export const AUDIO_RETENTION_DAYS = 29;
const DAY_MS = 86_400_000;

export type DerivedStatus = MeetingStatus | "interrupted";

/** The liveness columns of a `recording_session`. */
export interface LiveSession {
  readonly startedAt: Date;
  readonly lastChunkAt: Date | null;
  readonly lastBeatAt: Date;
  readonly paused: boolean;
  readonly endedAt: Date | null;
}

/**
 * The status the API shows. Only `recording` is ever reinterpreted: it reads
 * `interrupted` when the latest session is over, missing, or silent for 2 minutes.
 *
 * `paused` is deliberately not consulted: a paused tab keeps sending heartbeats,
 * so a long pause with beats is not an interruption (A1) and a paused tab whose
 * beats stopped is one, both through the same rule.
 */
export function derivedStatus(status: MeetingStatus, latestSession: LiveSession | null, now: Date): DerivedStatus {
  if (status !== "recording") return status;
  if (!latestSession || latestSession.endedAt !== null) return "interrupted";
  const lastSign = Math.max(latestSession.lastBeatAt.getTime(), latestSession.lastChunkAt?.getTime() ?? 0);
  return now.getTime() - lastSign >= INTERRUPTED_AFTER_MS ? "interrupted" : "recording";
}

/**
 * Audio captured while offline that did not reach storage (AC-2.9, G3): the
 * last `capturedMs` the tab reported minus what is stored, floored at 0. A lower
 * bound, hence `null` (not 0) when the tab never reported.
 */
export function lostMs(capturedMs: number | null, storedMs: number): number | null {
  if (capturedMs === null) return null;
  return Math.max(0, capturedMs - storedMs);
}

export type AudioState =
  | { readonly state: "kept"; readonly until: Date }
  | { readonly state: "deleted" }
  | { readonly state: "none" };

/**
 * `kept` until `audioCreatedAt + 29 d`, `deleted` from that instant or as soon as
 * `audioDeletedAt` is set, `none` when there never was audio (AC-4.4).
 */
export function audioState(
  meeting: { readonly audioCreatedAt: Date | null; readonly audioDeletedAt: Date | null },
  now: Date,
): AudioState {
  if (meeting.audioDeletedAt !== null) return { state: "deleted" };
  if (meeting.audioCreatedAt === null) return { state: "none" };
  const until = new Date(meeting.audioCreatedAt.getTime() + AUDIO_RETENTION_DAYS * DAY_MS);
  return now.getTime() >= until.getTime() ? { state: "deleted" } : { state: "kept", until };
}

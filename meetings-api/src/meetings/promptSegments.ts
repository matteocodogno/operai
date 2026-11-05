/**
 * A meeting's transcript as a prompt sees it, and the names its speakers carry there
 * (specs/021-meetings plan.md § Summaries and ask-the-meeting; AC-7.10, AC-9.2).
 *
 * SPEAKER NAMES. A speaker key (`s1`, `s2`, ...) is shown as, in order: the creator's free-text
 * label, an external participant's name, an Operai participant's display name, else "Speaker n".
 * An Operai participant's name is looked up LIVE from `auth` with the caller's own JWT (ADR-0039,
 * soft: an outage or a deactivated user simply leaves the label as "Speaker n"). Two callers:
 *   - a summary REQUEST (generate / regenerate / retry) has the caller's token, so it resolves the
 *     names once and stores them in the summary's snapshot (`template.speakerNames`); the
 *     `summarize` job, which has no token, uses only that map;
 *   - an ASK is synchronous with the caller's token and resolves them on the spot.
 */

import type { PromptSegment } from "../ai/prompts/transcript";
import { speakerIndexOf } from "../ai/segments";
import type { PrismaClient } from "../lib/generated/prisma/client";
import { resolveIdentities as liveDisplayIdentities } from "../lib/identities";

/** `speakerKey` -> the name to show. Keys with no name are absent. */
export type SpeakerNames = Record<string, string>;

/** A name never needs to be longer than the labels it comes from. */
const MAX_NAME = 120;

export async function speakerNamesFor(
  db: Pick<PrismaClient, "speakerLabel">,
  meetingId: string,
  authorization: string,
  resolve: typeof liveDisplayIdentities = liveDisplayIdentities,
): Promise<SpeakerNames> {
  const labels = await db.speakerLabel.findMany({
    where: { meetingId },
    include: { participant: { select: { externalName: true, userId: true } } },
  });

  const ids = labels.flatMap((l) => (l.customLabel?.trim() || l.participant?.externalName?.trim() || !l.participant?.userId ? [] : [l.participant.userId]));
  const people = ids.length > 0 ? await resolve(authorization, ids) : new Map();

  const names: SpeakerNames = {};
  for (const label of labels) {
    const name =
      label.customLabel?.trim() ||
      label.participant?.externalName?.trim() ||
      (label.participant?.userId ? (people.get(label.participant.userId)?.name?.trim() ?? "") : "");
    if (name) names[label.speakerKey] = name.slice(0, MAX_NAME);
  }
  return names;
}

export interface SegmentRow {
  readonly id: string;
  readonly ordinal: number;
  readonly startMs: number | null;
  readonly speakerKey: string | null;
  readonly text: string;
}

/** Rows to prompt segments. A text meeting's passages carry no time and no speaker. */
export function promptSegmentsOf(rows: readonly SegmentRow[], isText: boolean, names: Readonly<SpeakerNames>): PromptSegment[] {
  return rows.map(
    (row): PromptSegment => ({
      id: row.id,
      ordinal: row.ordinal,
      startMs: isText ? null : row.startMs,
      speakerLabel:
        isText || row.speakerKey === null
          ? null
          : (names[row.speakerKey] ?? `Speaker ${speakerIndexOf(row.speakerKey) ?? row.speakerKey}`),
      text: row.text,
    }),
  );
}

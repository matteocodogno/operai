/**
 * Who can open a meeting, and whether its creator's controls are frozen
 * (specs/021-meetings plan.md § Authorization, ADR-0058; AC-5.2, AC-5.3, AC-5.7,
 * AC-5.11, AC-5.13, AC-4.8).
 *
 * Visibility is exactly three roles and NO capability ever grants reading:
 *
 *   creator       `creatorUserId = sub`
 *   participant   a Operai `meeting_participant` row with `userId = sub`
 *   host_reader   `hostVisible` AND the caller holds `meetings:access` AND the
 *                 host's own live answer for THIS caller is `open` with
 *                 `hostVisible: true`. Asked on every request, never cached, so
 *                 losing the host entity bites on the next request (AC-5.7);
 *                 a host that cannot answer grants nothing (fail closed).
 *
 * Anyone else gets a 404 byte-identical to a nonexistent id (AC-5.3). An admin,
 * a `meeting:erase` holder, a template manager: all outsiders here (AC-4.8).
 *
 * Frozen (AC-5.11) is derived from the creator's LIVE identity, uncached
 * (AC-5.13: reactivation restores control on the next request). Two postures,
 * mirrored from lib/identities.ts:
 *   creatorFrozen          DISPLAY: `true` / `false` / `null` (unknown, outage).
 *   assertCreatorControl   GATE: 403 `frozen`, or 503 when the lookup fails.
 *
 * Both use `requireIdentities` (uncached) on purpose: the display lookup's
 * 60 s cache could show a reactivated creator as frozen for a minute.
 */

import { db } from "../lib/db";
import { notFound, forbidden, ProblemError } from "../lib/problem";
import { requireIdentities as liveIdentities } from "../lib/identities";
import { resolve as resolveAtHost } from "../hosts/client";
import { hostRegistry, type HostRegistry } from "../hosts/registry";

export type MeetingRole = "creator" | "participant" | "host_reader";

/** The caller, as the guards established them. */
export interface Caller {
  readonly userId: string;
  /** The caller's own `Authorization` header, forwarded verbatim to `auth` and to a host. */
  readonly authorization: string;
  /** `holds(c, MEETINGS_ACCESS)`: false when `auth` could not answer (an outage withholds, never grants). */
  readonly holdsAccess: boolean;
}

/** What visibility needs to know about a meeting. */
export interface VisibilityMeeting {
  readonly id: string;
  readonly creatorUserId: string;
  readonly hostApp: string | null;
  readonly hostEntityType: string | null;
  readonly hostEntityId: string | null;
  readonly hostVisible: boolean;
  /** Operai participants only: an external has no account and so no way to open anything. */
  readonly participantUserIds: readonly string[];
}

/** Seams for tests; production passes none. */
export interface VisibilityDeps {
  readonly registry?: Pick<HostRegistry, "get">;
  readonly requireIdentities?: typeof liveIdentities;
  readonly resolveHost?: typeof resolveAtHost;
}

export type Access =
  | { readonly role: MeetingRole }
  /** `hostUnavailable`: the host could not answer, so a host-reader grant was withheld (lists say so, AC-11.2). */
  | { readonly role: null; readonly hostUnavailable: boolean };

/** The ONE 404 for "does not exist" and "not visible": same status, code, message, members. */
export const meetingNotFound = (): ProblemError => notFound("Meeting not found");

/** The role of `caller` on `meeting`, or `null`. Never throws for a missing grant. */
export async function resolveAccess(meeting: VisibilityMeeting, caller: Caller, deps: VisibilityDeps = {}): Promise<Access> {
  if (meeting.creatorUserId === caller.userId) return { role: "creator" };
  if (meeting.participantUserIds.includes(caller.userId)) return { role: "participant" };

  if (!meeting.hostVisible || !caller.holdsAccess) return { role: null, hostUnavailable: false };
  if (meeting.hostApp === null || meeting.hostEntityType === null || meeting.hostEntityId === null) {
    return { role: null, hostUnavailable: false };
  }
  const host = (deps.registry ?? hostRegistry()).get(meeting.hostApp, meeting.hostEntityType);
  // A host that left the registry can no longer vouch for anyone.
  if (!host) return { role: null, hostUnavailable: false };

  const answer = await (deps.resolveHost ?? resolveAtHost)(host, caller.authorization, [meeting.hostEntityId]);
  if (answer.state === "unavailable") return { role: null, hostUnavailable: true };
  const entity = answer.entities.get(meeting.hostEntityId);
  if (entity?.state === "open" && entity.hostVisible === true) return { role: "host_reader" };
  return { role: null, hostUnavailable: false };
}

/** The meeting row visibility works from, or `null` when it does not exist. */
export async function loadMeetingForVisibility(id: string): Promise<VisibilityMeeting | null> {
  const row = await db.meeting.findUnique({
    where: { id },
    select: {
      id: true,
      creatorUserId: true,
      hostApp: true,
      hostEntityType: true,
      hostEntityId: true,
      hostVisible: true,
      participants: { where: { userId: { not: null } }, select: { userId: true } },
    },
  });
  if (!row) return null;
  const { participants, ...rest } = row;
  return { ...rest, participantUserIds: participants.flatMap((p) => (p.userId === null ? [] : [p.userId])) };
}

/** Opens a meeting for `caller`, or throws the identical 404 (AC-5.3). */
export async function openMeeting(
  id: string,
  caller: Caller,
  deps: VisibilityDeps = {},
): Promise<{ readonly meeting: VisibilityMeeting; readonly role: MeetingRole }> {
  const meeting = await loadMeetingForVisibility(id);
  if (!meeting) throw meetingNotFound();
  const access = await resolveAccess(meeting, caller, deps);
  if (access.role === null) throw meetingNotFound();
  return { meeting, role: access.role };
}

/** DISPLAY: is the creator deactivated? `null` = cannot tell right now. */
export async function creatorFrozen(
  authorization: string,
  creatorUserId: string,
  deps: VisibilityDeps = {},
): Promise<boolean | null> {
  try {
    const found = await (deps.requireIdentities ?? liveIdentities)(authorization, [creatorUserId]);
    const status = found.get(creatorUserId)?.status;
    if (status === "deleted") return true;
    if (status === "active") return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * GATE for every creator control (AC-5.8, AC-5.11): the caller is the creator,
 * the creator is not deactivated, and the creator holds `meetings:access`.
 * Order is the plan's: `creator_only`, `frozen`, `meetings_access_required`.
 * An identities outage is a 503 `identity_unavailable`, never a pass.
 */
export async function assertCreatorControl(
  role: MeetingRole,
  caller: Caller,
  creatorUserId: string,
  deps: VisibilityDeps = {},
): Promise<void> {
  if (role !== "creator") throw forbidden("Only the creator of the meeting can do this", "creator_only");
  // Uncached and fail closed: a failure here is the lookup's own 503.
  const found = await (deps.requireIdentities ?? liveIdentities)(caller.authorization, [creatorUserId]);
  const status = found.get(creatorUserId)?.status;
  if (status === "deleted") {
    throw forbidden("The creator's account is deactivated: this meeting is frozen", "frozen");
  }
  if (status !== "active") {
    throw new ProblemError({ status: 503, code: "identity_unavailable", detail: "The creator could not be checked" });
  }
  if (!caller.holdsAccess) {
    throw forbidden("You need access to Meetings to do this", "meetings_access_required");
  }
}

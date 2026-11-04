/**
 * What the capture, transcript and audio routes share (specs/021-meetings
 * plan.md § Authorization "Action matrix", § API contracts).
 *
 * LOCAL to the media lane: the routes lane writes the shared `Caller` builder;
 * these small pieces are reconciled with it when the branches meet.
 *
 *   callerOf           the guards' facts about the caller, in the shape
 *                      `visibility.ts` and `view.ts` want.
 *   creatorControl     the stack of every "creator-control" route: JWT + a LIVE
 *                      resolve that fails CLOSED (503 on an `auth` outage), but no
 *                      capability refusal in the middleware, so the 403 stays the
 *                      plan's precise `creator_only` / `frozen` /
 *                      `meetings_access_required` and an outsider still gets the
 *                      byte-identical 404 (AC-5.3) rather than a bare 403.
 *   openForControl     visibility + the full creator gate (live identity lookup).
 *   openForCapture     the same gate WITHOUT the live identity lookup, for the
 *                      routes a recording calls every few seconds (see below).
 *   storageCall        a storage failure is a 503 `storage_unavailable`, never a 500.
 */

import type { MiddlewareHandler } from "hono";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { MEETING_ERASE, MEETINGS_ACCESS, holds } from "../auth/guards";
import { assertCreatorControl, openMeeting, type MeetingRole, type VisibilityMeeting } from "../meetings/visibility";
import type { ViewCaller } from "../meetings/view";
import { ProblemError, forbidden } from "../lib/problem";

/**
 * Structural, because a handler's context is typed by its route's middleware list
 * (`MiddlewareHandler[]` erases the variables): all that is needed is these reads.
 */
export interface CallerContext {
  get(key: "authz"): AuthzVariables["authz"];
  get(key: "capabilities"): AuthzVariables["capabilities"];
  get(key: "userId"): string;
  readonly req: { header(name: string): string | undefined };
}

export function callerOf(c: CallerContext): ViewCaller {
  return {
    userId: c.get("userId"),
    // jwtMiddleware ran: the header is there and well-formed.
    authorization: c.req.header("Authorization") ?? "",
    holdsAccess: holds(c, MEETINGS_ACCESS),
    holdsErase: holds(c, MEETING_ERASE),
    capabilities: c.get("capabilities"),
  };
}

/** JWT + live resolve, 503 when `auth` cannot answer; the 403s are decided by the handler. */
export const creatorControl: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware];

export interface Opened {
  readonly meeting: VisibilityMeeting;
  readonly role: MeetingRole;
}

/**
 * Visibility (the identical 404), then the creator gate: `creator_only`, `frozen`
 * (live, uncached, 503 `identity_unavailable` on a lookup failure), then
 * `meetings_access_required`.
 */
export async function openForControl(id: string, caller: ViewCaller): Promise<Opened> {
  const opened = await openMeeting(id, caller);
  await assertCreatorControl(opened.role, caller, opened.meeting.creatorUserId);
  return opened;
}

/**
 * Like `openForControl`, but WITHOUT the live "is the creator deactivated?" lookup.
 *
 * For the three routes a recording calls continuously (chunk confirm, chunk
 * re-mint, heartbeat): `auth` rate-limits `POST /authz/users/identities` per caller
 * at 120 requests per 10 minutes, and a recording makes ~8 such calls a minute, so a
 * lookup per call would get a one-hour recording throttled into 503s. The creator
 * was checked live when the recording started and is checked live again at stop,
 * process and discard; a deactivated account has its sessions revoked (ADR-0012),
 * and the only window left is the residual life of the JWT already in the tab.
 */
export async function openForCapture(id: string, caller: ViewCaller): Promise<Opened> {
  const opened = await openMeeting(id, caller);
  if (opened.role !== "creator") throw forbidden("Only the creator of the meeting can do this", "creator_only");
  if (!caller.holdsAccess) throw forbidden("You need access to Meetings to do this", "meetings_access_required");
  return opened;
}

export const storageUnavailable = (): ProblemError =>
  new ProblemError({ status: 503, code: "storage_unavailable", detail: "Audio storage is unavailable; nothing was changed" });

/** Runs a storage call; any failure that is not already a typed problem becomes a 503. */
export async function storageCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    // The error class only: a key carries a meeting id, a message may carry more.
    console.error("[storage] call failed:", error instanceof Error ? error.name : "unknown error");
    throw storageUnavailable();
  }
}

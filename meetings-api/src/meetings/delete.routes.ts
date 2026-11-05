/**
 * `DELETE /meetings/:id` (specs/021-meetings plan.md § API contracts → Meetings; AC-4.6,
 * AC-4.8, AC-5.11, AC-5.12, AC-14.6). Two ways in, both final:
 *
 *   creator   the creator, while their account is active. NEEDS NO CAPABILITY: removing
 *             your own data never depends on a grant (AC-5.8, amendment A4), so this
 *             route is `selfScoped` and works with `meetings:access` withdrawn or `auth` down.
 *   erase     a holder of `meeting:erase` (the erase screen), for ANY meeting, a frozen one
 *             included. The right alone reads nothing: every content route still answers
 *             them 404 (AC-4.8).
 *
 * The order is what keeps the promise "nothing of it remains":
 *   1. the storage prefixes go FIRST: the transient transcription bucket's `transcribe/<id>/`
 *      (a transcript copy and staged audio, ADR-0069, AC-4.12), then `meetings/<id>/`. If either
 *      fails the answer is 503 `storage_unavailable` and nothing at all has been deleted, so the
 *      meeting can be deleted again later; the reverse order would orphan audio no row points to.
 *      The transient one goes first because losing it costs nothing, whereas audio deleted from
 *      the main bucket under a meeting that still exists would be a lie the row tells.
 *   2. one transaction: drop the meeting's titled outbox rows, record the `deleted` host
 *      notice (no title, no date-time) and the content-free `meeting_deletion` entry, then
 *      delete the meeting, whose rows cascade. The notice and its retry job outlive it.
 *   3. after the commit, the one awaited notice attempt (a down host never blocks this),
 *      and a last sweep of the prefix for a chunk that landed while we were deleting.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { selfScoped } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { requireIdentities } from "../lib/identities";
import { ProblemError, forbidden, validationHook } from "../lib/problem";
import { requireTransientStorage, transientKeys } from "../lib/google/transientStorage";
import { objectKeys, requireStorage } from "../lib/storage";
import { deliverNotices, recordNotice } from "../hosts/notices";
import { callerOf } from "./caller";
import { lockMeeting } from "./lock";
import { loadMeetingForVisibility, meetingNotFound, resolveAccess } from "./visibility";

const deleteMeeting = createRoute({
  method: "delete",
  path: "/meetings/{id}",
  tags: ["Meetings"],
  summary: "Delete a meeting for good (its creator, or a holder of meeting:erase)",
  middleware: selfScoped,
  request: { params: IdParams },
  responses: {
    204: { description: "Deleted" },
    401: commonErrors[401],
    403: { description: "creator_only (a participant), or frozen (the creator's account is deactivated)" },
    404: { description: "Not found (identical for a meeting the caller may not open)" },
    503: { description: "storage_unavailable (nothing was deleted), or the creator could not be checked" },
  },
});

export const deleteRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

const storageUnavailable = () =>
  new ProblemError({ status: 503, code: "storage_unavailable", detail: "The recording could not be deleted right now; nothing was deleted, try again" });

deleteRouter.openapi(deleteMeeting, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);

  const meeting = await loadMeetingForVisibility(id);
  if (!meeting) throw meetingNotFound();

  let via: "creator" | "erase";
  if (meeting.creatorUserId === caller.userId) {
    // The creator's own path needs the account active; an erase right is a way round a frozen one.
    let active: boolean;
    try {
      const found = await requireIdentities(caller.authorization, [caller.userId]);
      active = found.get(caller.userId)?.status === "active";
    } catch (error) {
      if (!caller.holdsErase) throw error;
      active = false;
    }
    if (active) via = "creator";
    else if (caller.holdsErase) via = "erase";
    else throw forbidden("The creator's account is deactivated: this meeting is frozen", "frozen");
  } else if (caller.holdsErase) {
    via = "erase";
  } else {
    // Someone who can open it is told they may not delete it; anyone else gets the identical 404.
    const access = await resolveAccess(meeting, caller);
    if (access.role === null) throw meetingNotFound();
    throw forbidden("Only the creator of the meeting can do this", "creator_only");
  }

  // 1. The audio first: a failure here deletes nothing (AC-4.6).
  const storage = requireStorage();
  const prefix = objectKeys.prefix(id);
  const transientPrefix = transientKeys.prefix(id);
  try {
    await (await requireTransientStorage()).deletePrefix(transientPrefix);
    await storage.deletePrefix(prefix);
  } catch {
    console.error("[meetings] storage refused to delete a meeting's objects; nothing was deleted");
    throw storageUnavailable();
  }

  // 2. The rows, the content-free trace and the host's notice, in one transaction.
  const noticeId = await db.$transaction(async (tx) => {
    await lockMeeting(tx, id);
    const row = await tx.meeting.findUniqueOrThrow({
      where: { id },
      select: { creatorUserId: true, hostApp: true, hostEntityType: true, hostEntityId: true },
    });
    // Notices that still hold the title (a failed linked / changed) go with the meeting.
    await tx.hostNotice.deleteMany({ where: { meetingId: id, policy: "manual" } });
    const noticeId =
      row.hostApp !== null && row.hostEntityType !== null && row.hostEntityId !== null
        ? await recordNotice(tx, { id, creatorUserId: row.creatorUserId }, { app: row.hostApp, entityType: row.hostEntityType, entityId: row.hostEntityId }, { event: "deleted" })
        : null;
    await tx.meetingDeletion.create({ data: { meetingId: id, deletedByUserId: caller.userId, via } });
    await tx.meeting.delete({ where: { id } });
    return noticeId;
  });

  // 3. After the commit: tell the host (never blocking), and sweep what landed meanwhile.
  await deliverNotices([noticeId]);
  // The deletion has committed: nothing below may turn it into an error, however the sweep fails (a rejection,
  // a synchronous throw, the storage not being obtainable). Logged without an id or the provider's text.
  try {
    await storage.deletePrefix(prefix);
  } catch {
    // The bucket's own lifecycle rule removes any straggler within 30 days (ADR-0063).
    console.warn("[meetings] late sweep of a deleted meeting's prefix failed");
  }
  // A Speech operation still running at deletion time can write its output after step 1: that is a transcript,
  // swept here if the process is alive, else by the next attempt's start or the bucket's 1-day rule (plan G-2).
  try {
    await (await requireTransientStorage()).deletePrefix(transientPrefix);
  } catch {
    console.warn("[meetings] late sweep of a deleted meeting's transient prefix failed");
  }
  return c.body(null, 204);
});

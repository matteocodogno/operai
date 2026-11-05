/**
 * `PUT /meetings/:id/participants` (specs/021-meetings plan.md § API contracts → Meetings;
 * AC-5.1, AC-5.4, AC-5.9, AC-5.10, AC-12.1). Creator control. A full replace of the list:
 * up to 30 entries, each an active Operai user (checked LIVE and fail closed: an identity
 * outage is a 503, never "assume active") or an external with a name and an optional
 * organisation. Externals are not accounts: they are never notified and can open nothing.
 *
 * A participant who stays keeps their row, so the speaker labels pointing at them survive a
 * re-save. Every Operai user who is NEW to the list (and is not the actor) is told once,
 * after the commit, best effort (AC-5.9).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { requireIdentities } from "../lib/identities";
import { announce } from "../lib/notify";
import { unprocessable, validationHook } from "../lib/problem";
import { callerOf, creatorControl } from "./caller";
import { lockMeeting } from "./lock";
import { MeetingSchema } from "./schemas";
import { loadMeetingView } from "./view";
import { assertCreatorControl, openMeeting } from "./visibility";

/** AC-5.1 */
export const MAX_PARTICIPANTS = 30;

const Entry = z
  .object({
    userId: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    organisation: z.string().trim().max(100).nullish(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // Exactly one kind: an Operai user (`userId`) or an external (`name`, optional `organisation`).
    const isUser = entry.userId !== undefined;
    const isExternal = entry.name !== undefined;
    if (isUser === isExternal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give either a userId or a name" });
    } else if (isUser && entry.organisation != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["organisation"], message: "An Operai user has no organisation here" });
    }
  });

const Body = z.object({ participants: z.array(Entry) });

const putParticipants = createRoute({
  method: "put",
  path: "/meetings/{id}/participants",
  tags: ["Meetings"],
  summary: "Replace the participants (creator control)",
  middleware: creatorControl,
  request: { params: IdParams, body: { content: { "application/json": { schema: Body } }, required: true } },
  responses: {
    200: { description: "The meeting", content: { "application/json": { schema: MeetingSchema } } },
    401: commonErrors[401],
    403: commonErrors[403],
    404: { description: "Not found" },
    422: { description: "An invalid entry, too_many_participants or participant_not_active { index }" },
    503: { description: "identity_unavailable, or auth is unavailable" },
  },
});

export const participantsRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

participantsRouter.openapi(putParticipants, async (c) => {
  const { id } = c.req.valid("param");
  const { participants } = c.req.valid("json");
  const caller = callerOf(c);
  const { meeting, role } = await openMeeting(id, caller);
  await assertCreatorControl(role, caller, meeting.creatorUserId);

  if (participants.length > MAX_PARTICIPANTS) {
    throw unprocessable(`A meeting has at most ${MAX_PARTICIPANTS} participants`, { field: "participants" }, "too_many_participants");
  }

  // Live and fail closed (AC-5.1, ADR-0039): an inactive or unknown user is refused by position.
  const userIds = [...new Set(participants.flatMap((p) => (p.userId !== undefined ? [p.userId] : [])))];
  if (userIds.length > 0) {
    const found = await requireIdentities(caller.authorization, userIds);
    const index = participants.findIndex((p) => p.userId !== undefined && found.get(p.userId)?.status !== "active");
    if (index >= 0) {
      throw unprocessable("This person is not an active Operai user", { field: `participants.${index}`, index }, "participant_not_active");
    }
  }
  const externals = participants.flatMap((p) => (p.name !== undefined ? [{ name: p.name, organisation: p.organisation?.trim() || null }] : []));

  const { title, added } = await db.$transaction(async (tx) => {
    await lockMeeting(tx, id);
    const current = await tx.meetingParticipant.findMany({ where: { meetingId: id }, orderBy: { createdAt: "asc" } });
    const wanted = new Set(userIds);
    const have = new Set(current.flatMap((p) => (p.userId !== null ? [p.userId] : [])));

    // Externals match by name and organisation, one for one, so a re-save keeps their rows.
    const unmatched = [...externals];
    const keep = new Set<string>();
    for (const row of current) {
      if (row.userId !== null) {
        if (wanted.has(row.userId)) keep.add(row.id);
        continue;
      }
      const at = unmatched.findIndex((e) => e.name === row.externalName && e.organisation === row.externalOrganisation);
      if (at >= 0) {
        unmatched.splice(at, 1);
        keep.add(row.id);
      }
    }
    await tx.meetingParticipant.deleteMany({ where: { meetingId: id, id: { notIn: [...keep] } } });

    // In the order given, one at a time: `createdAt` is what the list is shown in.
    for (const userId of userIds) {
      if (!have.has(userId)) await tx.meetingParticipant.create({ data: { meetingId: id, userId, addedBy: caller.userId } });
    }
    for (const e of unmatched) {
      await tx.meetingParticipant.create({ data: { meetingId: id, externalName: e.name, externalOrganisation: e.organisation, addedBy: caller.userId } });
    }

    const row = await tx.meeting.findUniqueOrThrow({ where: { id }, select: { title: true } });
    return { title: row.title, added: userIds.filter((u) => !have.has(u) && u !== caller.userId) };
  });

  // After the commit, best effort, never awaited (AC-12.3).
  if (added.length > 0) {
    announce({ kind: "participant_added", meetingId: id, meetingTitle: title, actorId: caller.userId, recipientIds: added });
  }
  return c.json(await loadMeetingView(id, caller, new Date()), 200);
});

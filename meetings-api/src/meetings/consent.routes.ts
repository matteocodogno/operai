/**
 * `POST /meetings/:id/consent` (specs/021-meetings plan.md § API contracts → Meetings;
 * AC-4.1, AC-4.3). The creator's attestation that everyone present was told and agreed:
 * who gave it, when, and WHICH VERSION of the notice they were shown. Creator control.
 *
 * The server knows the current version (`CONSENT_NOTICE_VERSION`) and refuses an attestation
 * of any other with 409 `notice_outdated`: the page shown to the creator was not the notice
 * in force. A `text` meeting records no one and asks for no attestation (AC-3.4, G1), so it
 * answers 422. Confirming again at the version already attested changes nothing, so the
 * original who and when stand; an older attestation is replaced.
 *
 * Wording belongs to the data-protection lead (spec open question O3); ANY change to the
 * notice's text must bump this constant and meetings-ui's copy together.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { IdParams, commonErrors } from "../lib/http";
import { conflict, unprocessable, validationHook } from "../lib/problem";
import { callerOf, creatorControl } from "./caller";
import { lockMeeting } from "./lock";
import { MeetingSchema } from "./schemas";
import { loadMeetingView } from "./view";
import { assertCreatorControl, openMeeting } from "./visibility";

/** The consent notice in force. Must equal the version meetings-ui renders (strings/consent). */
export const CONSENT_NOTICE_VERSION = "2026-11-05";

const Body = z.object({ noticeVersion: z.string().min(1).max(64) });

const postConsent = createRoute({
  method: "post",
  path: "/meetings/{id}/consent",
  tags: ["Meetings"],
  summary: "Attest consent to record (creator control)",
  middleware: creatorControl,
  request: { params: IdParams, body: { content: { "application/json": { schema: Body } }, required: true } },
  responses: {
    200: { description: "The meeting", content: { "application/json": { schema: MeetingSchema } } },
    401: commonErrors[401],
    403: commonErrors[403],
    404: { description: "Not found" },
    409: { description: "notice_outdated" },
    422: { description: "consent_not_applicable (a text meeting), or an invalid body" },
    503: commonErrors[503],
  },
});

export const consentRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

consentRouter.openapi(postConsent, async (c) => {
  const { id } = c.req.valid("param");
  const { noticeVersion } = c.req.valid("json");
  const caller = callerOf(c);
  const { meeting, role } = await openMeeting(id, caller);
  await assertCreatorControl(role, caller, meeting.creatorUserId);

  await db.$transaction(async (tx) => {
    await lockMeeting(tx, id);
    const row = await tx.meeting.findUniqueOrThrow({ where: { id }, select: { source: true, consentNoticeVersion: true } });
    if (row.source === "text") throw unprocessable("A pasted text needs no consent attestation", { field: "source" }, "consent_not_applicable");
    if (noticeVersion !== CONSENT_NOTICE_VERSION) throw conflict("notice_outdated", "The consent notice has changed; read the new version and confirm again");
    // Already attested at this version: the first who and when stand.
    if (row.consentNoticeVersion === CONSENT_NOTICE_VERSION) return;
    await tx.meeting.update({
      where: { id },
      data: { consentUserId: caller.userId, consentAt: new Date(), consentNoticeVersion: CONSENT_NOTICE_VERSION },
    });
  });

  return c.json(await loadMeetingView(id, caller, new Date()), 200);
});

/**
 * `POST /meetings/:id/host-notice/retry` (specs/021 T20; AC-11.9, AC-14.8, AC-14.10).
 * "Try again" for a `linked` / `changed` notice that could not be delivered. Creator
 * control: a stranger gets the identical 404, anyone else `creator_only`, a frozen meeting
 * `frozen` (no creator-less retry, AC-14.10), a creator without `meetings:access`
 * `meetings_access_required`. Answers the meeting; `hostNotice` is null once it got through.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { IdParams, commonErrors } from "../lib/http";
import { validationHook } from "../lib/problem";
import { callerOf, creatorControl } from "../meetings/caller";
import { loadMeetingView } from "../meetings/view";
import { assertCreatorControl, openMeeting } from "../meetings/visibility";
import { MeetingSchema } from "../meetings/schemas";
import { retryFailedNotices } from "./notices";

const retryRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/host-notice/retry",
  tags: ["Meetings"],
  summary: "Try again to tell the host (creator control)",
  middleware: creatorControl,
  request: { params: IdParams },
  responses: {
    200: { description: "The meeting; `hostNotice` is null once the host has been told", content: { "application/json": { schema: MeetingSchema } } },
    401: commonErrors[401],
    403: commonErrors[403],
    404: { description: "Not found (identical for a meeting the caller may not open)" },
    503: commonErrors[503],
  },
});

export const noticeRetryRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

noticeRetryRouter.openapi(retryRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  const { meeting, role } = await openMeeting(id, caller);
  await assertCreatorControl(role, caller, meeting.creatorUserId);

  await retryFailedNotices(id);
  return c.json(await loadMeetingView(id, caller, new Date()), 200);
});

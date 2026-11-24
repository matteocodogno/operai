/**
 * `POST /system/meeting-hours/v1/notices` — meetings-api tells hours-api what a meeting's hours facts are now
 * (specs/20261112-meeting-hours T7 — AC-1.6, AC-1.7, AC-4.1; plan § API contracts "hours-api —
 * `POST /system/meeting-hours/v1/notices`", § Applying a notice, § Security; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older).
 *
 * hours-api's first route that accepts a SERVICE credential and the only way an automatic entry is ever written. It takes
 * no user JWT: the one credential is a scoped service JWT minted by `auth` (RS256 via the suite JWKS, issuer pinned,
 * `aud` = SERVICE_AUDIENCE, scope `meeting-hours-notices.send`, `sub` `system:meetings-api`), verified by
 * `src/auth/systemAuth.middleware.ts`. Every failure — none, a user JWT, another audience, issuer, key, scope or `sub`
 * (another service client holding the scope included), an expired or malformed token, a non-Bearer scheme — is the same
 * 401, byte for byte. A user, an admin and a holder of `time-entry:read-all` gain no write by any of it (AC-1.7).
 *
 * Order of the answers, as for every route of the suite: the CREDENTIAL first, before the body is read (the guard rides
 * on the route, and `@hono/zod-openapi` runs a route's middleware before its validators), then the body — strict, so a
 * `title`, an external participant or any other key is a 400 `invalid_request` and nothing was written (AC-4.1) — then
 * `apply()`. A database failure inside `apply()` is a 500 and left nothing behind: the sender retries.
 *
 * MOUNT ORDER (plan R8): `src/index.ts` mounts this router BEFORE the user `jwtMiddleware` on `*`. Mounted after it, a
 * service JWT meets the user gate and every notice is a 401 (the estimai-api lesson, ADR
 * 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential). The guard is attached per route
 * (`createRoute({ middleware })`), never `router.use("*")`: Hono copies a sub-app's `use("*")` onto the whole app.
 *
 * The answer is `{ applied }` and nothing else: no counts, no ids (the log line `meeting_hours.applied` has the counts).
 * Nothing here reads the caller's identity beyond the guard, and nothing calls another service (AC-2.6).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createSystemAuthMiddleware, type SystemAuthVariables } from "../auth/systemAuth.middleware";
import { invalidRequestHook } from "../lib/errors";
import { meetingHoursNoticeWire } from "../lib/meetingHoursWire";
import { ProblemSchema } from "../lists/errorDocs";
import { apply } from "./apply";

/** The scope this route requires (`auth/src/system/serviceClients.ts`, specs/20261112-meeting-hours T1). */
export const NOTICES_SCOPE = "meeting-hours-notices.send";

/**
 * The one service principal this route serves. Holding the scope is not enough: a service credential opens only the
 * routes that list its `sub` (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential posture).
 */
export const NOTICES_ALLOWED_SUBS = ["system:meetings-api"] as const;

export const NOTICES_PATH = "/system/meeting-hours/v1/notices";

const problemDoc = (description: string) => ({ description, content: { "application/json": { schema: ProblemSchema } } });

const noticeRoute = createRoute({
  method: "post",
  path: NOTICES_PATH,
  tags: ["System"],
  summary: "Apply a meeting's hours facts (scope meeting-hours-notices.send, service credential only)",
  middleware: createSystemAuthMiddleware({ scope: NOTICES_SCOPE, allowedSubs: NOTICES_ALLOWED_SUBS }),
  description:
    "Authorization: Bearer <service JWT> from auth (aud = SERVICE_AUDIENCE, scope meeting-hours-notices.send, sub system:meetings-api). " +
    "A user JWT is never accepted, and every credential failure is the same 401, decided before the body is read. " +
    "The body is the meeting's facts as meetings-api states them now, with their version: hours-api makes the meeting's untouched " +
    "automatic entries match them, and ignores a version older than the one it already applied (`applied: false`, nothing changed). " +
    "A repeated or equal version is applied again, harmlessly. The body is strict: a title, an external participant or any other " +
    "member is refused, never ignored. No outbound call is made and nobody is notified.",
  request: { body: { content: { "application/json": { schema: meetingHoursNoticeWire } }, required: true } },
  responses: {
    200: {
      description: "Applied, or ignored because the version is older than the one already applied",
      content: { "application/json": { schema: z.object({ applied: z.boolean().describe("False: an older version than the one applied; nothing changed") }) } },
    },
    400: problemDoc("`invalid_request`: a malformed body, a missing member, an unknown member at any level, a value outside its bound (`field` names the first); sending it again cannot help"),
    401: problemDoc("Missing or invalid service credential (one body for every failure)"),
    500: problemDoc("A database failure: nothing was written, send it again"),
  },
});

export const meetingHoursNoticesRouter = new OpenAPIHono<{ Variables: SystemAuthVariables }>({ defaultHook: invalidRequestHook });

meetingHoursNoticesRouter.openapi(noticeRoute, async (c) => {
  const { applied } = await apply(c.req.valid("json"));
  return c.json({ applied }, 200);
});

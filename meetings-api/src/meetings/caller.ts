/**
 * The caller of a meeting route, built ONCE from the Hono context (specs/021-meetings
 * T93's note; plan.md § Authorization). Every route that opens a meeting turns the
 * context into a `ViewCaller` here, so `holdsAccess` / `holdsErase` / `capabilities`
 * can never be derived two different ways.
 *
 * `creatorControl` is the guard stack of the plan's "creator-control" routes:
 * JWT + a FAIL-CLOSED live resolve (an `auth` outage is a 503, never a pass). It
 * deliberately has no `requireCapability`: a creator who lost `meetings:access` must
 * still get the specific 403 (`meetings_access_required`, AC-5.8) and a stranger must
 * still get the identical 404 (AC-5.3). Both are decided by `openMeeting` followed by
 * `assertCreatorControl`, in the plan's order.
 */

import type { MiddlewareHandler } from "hono";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { MEETING_ERASE, MEETINGS_ACCESS, holds } from "../auth/guards";
import { jwtMiddleware } from "../auth/jwt.middleware";
import type { ViewCaller } from "./view";

/** JWT + live resolve that fails closed; the handler then applies visibility and `assertCreatorControl`. */
export const creatorControl: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware];

/** What the guards put on the context, and the request's headers (a Hono `Context` fits). */
export interface CallerSource {
  get(key: "authz"): AuthzVariables["authz"];
  get(key: "capabilities"): AuthzVariables["capabilities"];
  get(key: "userId"): string;
  readonly req: { header(name: string): string | undefined };
}

/** The caller as the guards established them. A `ViewCaller` is also a visibility `Caller`. */
export function callerOf(c: CallerSource): ViewCaller {
  return {
    userId: c.get("userId"),
    // jwtMiddleware has already refused a request without a Bearer header.
    authorization: c.req.header("Authorization") ?? "",
    holdsAccess: holds(c, MEETINGS_ACCESS),
    holdsErase: holds(c, MEETING_ERASE),
    capabilities: c.get("capabilities"),
  };
}

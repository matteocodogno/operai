/**
 * The three guard stacks every meetings-api route uses (specs/20261104-meetings,
 * plan.md § Shape, ADR 20261104-meetings-tool-shape-visibility-by-participation; AC-10.6, AC-1.4, AC-5.10).
 *
 *   selfScoped       JWT only, plus an OPTIONAL authz resolve that never refuses.
 *                    Reading a meeting one created or was invited to must not
 *                    depend on `auth` being up. Record-level visibility is
 *                    checked by the handler afterwards.
 *   capability(...)  JWT + live resolve (an `auth` outage is a 503, fail closed)
 *                    + at least one of the named permissions (else 403).
 *   eraser           capability(`meeting:erase`): the erase search screen.
 *
 * Attach per route through `createRoute({ middleware: ... })`, never with
 * `router.use("*", …)`: every router is mounted at "/" in src/index.ts and Hono
 * copies a sub-app's `use("*")` onto the whole app (crm-api's rule).
 *
 * No role ever grants reading: visibility is creator / participant / host reader
 * (ADR 20261104-meetings-tool-shape-visibility-by-participation) and lives in the handlers, not here.
 */

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { jwtMiddleware } from "./jwt.middleware";
import { authzMiddleware, optionalAuthzMiddleware, type AuthzVariables } from "./authz.middleware";
import { hasCapability } from "../authz/conditions";
import { problem } from "../lib/problem";

/** A `(resource, action)` pair from the `meetings` catalog (auth/src/authz/catalogs/meetings.ts). */
export type Capability = readonly [resource: string, action: string];

/** Create meetings, summarise, ask, edit: the tool itself. */
export const MEETINGS_ACCESS: Capability = ["meetings", "access"];
/** Create, edit and delete shared summary templates. */
export const TEMPLATE_MANAGE: Capability = ["template", "manage"];
/** Delete another person's meeting on request, via the erase screen. Never grants reading. */
export const MEETING_ERASE: Capability = ["meeting", "erase"];

/** What a handler needs from the context to ask "does the caller hold this?". */
export interface CapabilitySource {
  get(key: "authz"): AuthzVariables["authz"];
  get(key: "capabilities"): AuthzVariables["capabilities"];
}

/**
 * Whether the caller holds `capability` according to what `auth` said. On a
 * `selfScoped` route with `auth` down this is `false` for everything: an outage
 * withholds controls and never grants one.
 */
export const holds = (c: CapabilitySource, [resource, action]: Capability): boolean =>
  c.get("capabilities") === "resolved" && hasCapability(c.get("authz").permissions, resource, action);

/**
 * 403 unless the caller holds AT LEAST ONE of `needs`. Must run after the
 * fail-closed `authzMiddleware`.
 */
export const requireCapability = (...needs: readonly Capability[]): MiddlewareHandler =>
  createMiddleware<{ Variables: AuthzVariables }>(async (c, next) => {
    if (!needs.some((need) => holds(c, need))) {
      return problem({ status: 403, detail: "You do not have permission to perform this action" }, c.req.path);
    }
    return next();
  });

/** JWT only plus a never-refusing resolve (AC-10.6). */
export const selfScoped: MiddlewareHandler[] = [jwtMiddleware, optionalAuthzMiddleware];

/**
 * JWT only, and NO permission call at all (specs/20261126-teams R13 b). For a self-scoped read that reads no permission: the meeting list,
 * which another service (hours-api) asks inside its own deadline and whose rows are the caller's own by creator and participant, never by a
 * grant. Nothing is put on the context but the verified identity, so `holds(...)` is false for everything here.
 * Never on a route that renders a control or admits a host reader: those stay `selfScoped`, whose resolve decides what to withhold.
 */
export const jwtOnly: MiddlewareHandler[] = [jwtMiddleware];

/** JWT + live resolve (503 on outage) + one of `needs` (403). */
export const capability = (...needs: readonly Capability[]): MiddlewareHandler[] => [
  jwtMiddleware,
  authzMiddleware,
  requireCapability(...needs),
];

/** The erase screen: `meeting:erase`, live. */
export const eraser: MiddlewareHandler[] = capability(MEETING_ERASE);

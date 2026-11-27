/**
 * What a host resolve (`POST /activity-host/v1/resolve`, `POST /meeting-host/v1/resolve`) spends, in parts, inside the 2 s that
 * activities-api, meetings-api and hours-api give it (specs/20261126-teams R13, ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-...).
 * No imports: `teams.budgets.cross-package.test.ts` relates these figures to the callers' deadlines and to `teams.ts`.
 *
 *   HOST_AUTHZ_WAIT_MS + TEAMS_HOST_WAIT_MS + HOST_PATH_REST_MS  <  every caller's deadline (2 000)
 *   HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS                      <= TEAMS_HOST_MARGIN_MS (D16's margin, itemized)
 *   HOST_AUTHZ_WAIT_MS                                          <  RESOLVE_TIMEOUT_MS (the flight outlives the wait)
 */

/**
 * The longest a host route waits for a permission resolve it has not cached. Past it the request is refused with the
 * 503 `authz_unavailable` (fail closed, inside the caller's deadline); the resolve itself is NOT aborted, it keeps its own
 * `RESOLVE_TIMEOUT_MS`, and its answer fills the 30 s permission cache for the retry. Page routes have no such wait.
 */
export const HOST_AUTHZ_WAIT_MS = 500;

/**
 * What a host path keeps for everything but the permission check and the team read: the JWT check on a warm key set, the
 * project query, building the answer, two in-region hops and event-loop delay (normally well under 100 ms).
 */
export const HOST_PATH_REST_MS = 500;

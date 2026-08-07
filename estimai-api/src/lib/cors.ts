/**
 * Single source of truth for estimai-api's CORS policy (mounted on `*` in
 * index.ts). Kept in its own module — rather than inlined in index.ts — so
 * `cors.preflight.test.ts` can mount this EXACT middleware instance on a
 * throwaway Hono app and issue real `OPTIONS` preflight requests against it,
 * instead of asserting on the shape of a config object (which unit tests
 * mocking the transport would never exercise — the bug this file fixes,
 * specs/013-estimate-sharing T25 e2e defect, was invisible to the pre-existing
 * suite for exactly that reason).
 *
 * Every entry below is required by a real cross-origin call this feature
 * makes — see the comments — and nothing is added beyond that (no wildcards,
 * no blanket allowMethods/allowHeaders).
 */
import { cors } from "hono/cors";
import { env } from "./env";

export const corsMiddleware = cors({
  origin: env.ALLOWED_ORIGINS,
  // "If-Match" — REQUIRED on PUT /estimates/{id} (T7, ADR-0038). Without it
  // in allowHeaders, every cross-origin save — i.e. every save from the
  // shell-hosted editor, since shell and estimai-api are always on different
  // origins — is blocked at the preflight before it ever reaches the
  // handler. estimai-ui/src/lib/estimatesApi.ts sends it on every PUT.
  allowHeaders: ["Content-Type", "Authorization", "If-Match"],
  // "PATCH" — PATCH /estimates/{id}/collaborators/{collaboratorId} (T9,
  // access-level change) is otherwise unreachable from a browser.
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // "Retry-After" — read by estimai-ui's collaboratorsApi.ts
  // (parseRetryAfterSeconds) to populate RateLimitedError.retryAfterSeconds
  // when POST /estimates/{id}/collaborators is rate-limited (T9). "ETag" —
  // the If-Match precondition source, emitted on GET/PUT /estimates/{id}
  // (T7). Neither response header is readable cross-origin by the browser
  // unless explicitly exposed here.
  exposeHeaders: ["Retry-After", "ETag"],
  credentials: true,
});

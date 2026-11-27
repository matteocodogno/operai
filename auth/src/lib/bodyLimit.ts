/**
 * A ceiling on the request body, in front of everything that reads one (security review A04/A05, specs/20261126-teams follow-up).
 *
 * `rejectNul` (nul.ts) decodes the whole JSON body of every request to look for U+0000, before authentication, and Bun's own default
 * ceiling is ~128 MiB: an anonymous caller could make the identity service hold a few copies of that per request. This middleware sits
 * before it (src/index.ts) and answers 413 without reading a byte when the declared length is over the figure, and stops reading a body
 * with no declared length (chunked) as soon as it passes it.
 *
 * The figure, 256 KiB, is above the biggest body any route of this service legitimately takes and well below anything worth holding:
 *   - a role's whole rule set (`PUT /admin/roles/{id}/rules`), the biggest admin body: the suite's ten catalogs declare 42 permissions,
 *     about 7 KiB with a two-attribute condition on each, so 256 KiB is over 35 times that (a test measures it from the catalogs);
 *   - a bulk user delete or a department's member list: about 36 bytes a user id, so a thousand users are 36 KB and 256 KiB holds ~7 000;
 *   - the legal-entity writes, the invitation, access-request and team bodies and better-auth's own sign-in calls are a few KB at most,
 *     and the legal-entity writes keep their own 16 KiB cap and 413 (`request_too_large`), unchanged.
 * Held three times over by `rejectNul`, the worst an unauthenticated request now costs is under 1 MiB.
 */
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";

export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** Same 413 `request_too_large` Problem JSON as the legal-entity writes' own cap; nothing of the request but its path. */
export const requestBodyLimit: MiddlewareHandler = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: (c) =>
    Response.json(
      {
        type: "https://httpstatuses.com/413",
        title: "Payload Too Large",
        status: 413,
        detail: "The request body is too large",
        instance: c.req.path,
        code: "request_too_large",
      },
      { status: 413, headers: { "Content-Type": "application/problem+json" } },
    ),
});

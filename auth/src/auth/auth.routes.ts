import { OpenAPIHono } from "@hono/zod-openapi";
import { auth } from "./auth.config";
import { withInternalClientAddress } from "./clientAddress";

export const authRouter = new OpenAPIHono();

// Delegate all /auth/* traffic (every depth) to Better Auth's built-in handler.
// The wildcard is `/*`, NOT `/**`: `/**` is not Hono syntax. Hono's RegExpRouter happens to read it as a wildcard, but
// its TrieRouter takes `**` as a literal path segment, and the app is on the TrieRouter whenever any route makes
// RegExpRouter throw UnsupportedPathError (SmartRouter falls back for the WHOLE app) - which the legal-entities read
// router does by design (its `/legal-entities/:entity` guard precedes the static `/legal-entities/manageable`).
// Then every /auth/** answered 404 (D1). `auth.mount.test.ts` goes through the assembled app to keep this honest.
// Better Auth resolves: sign-in, sign-up, OAuth callbacks, session
// management, token issuance, and /.well-known/jwks.json (internal).
// A request from the private network (no X-Forwarded-For) gets its own client address, so the rate limiter never
// lumps it with public traffic (clientAddress.ts).
authRouter.on(["GET", "POST", "DELETE"], "/*", (c) => {
  return auth.handler(withInternalClientAddress(c.req.raw));
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { auth } from "./auth.config";

export const authRouter = new OpenAPIHono();

// Delegate all /auth/** traffic to Better Auth's built-in handler.
// Better Auth resolves: sign-in, sign-up, OAuth callbacks, session
// management, token issuance, and /.well-known/jwks.json (internal).
authRouter.on(["GET", "POST", "DELETE"], "/**", (c) => {
  return auth.handler(c.req.raw);
});

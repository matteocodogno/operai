import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { jwtMiddleware, type JwtVariables } from "./jwt.middleware";

/**
 * GET /whoami — minimal identity-echo probe (T4, specs/007-refund-service).
 *
 * This is the bootstrap's only jwtMiddleware-protected route: it exists so
 * `bun run dev` and the health-of-the-service checks have something concrete
 * to hit besides the unauthenticated /health route, proving end-to-end that
 * the RS256/iss/aud verification chain (ADR-0005/0010) is wired correctly
 * before any real domain route exists. It performs NO authorization check
 * (ADR-0014's authzMiddleware, resolving capabilities/conditions via
 * `auth GET /authz/resolve`, is added on top of this in T6) and no database
 * access — identity only, mirroring exactly what jwtMiddleware itself proves.
 * Real domain routes (T7+) supersede this as the day-to-day protected surface;
 * this route is not removed, just no longer the only one.
 */
const WhoAmIResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
});

const whoamiRoute = createRoute({
  method: "get",
  path: "/whoami",
  tags: ["System"],
  summary: "Identity-echo probe (auth verification only, no authorization)",
  description:
    "Returns the caller's identity as resolved by jwtMiddleware (sub, email). " +
    "Proves RS256 + issuer + audience verification (ADR-0005/0010) end-to-end. " +
    "Does not check any refund-specific permission — see ADR-0014 for the " +
    "authorization layer added in T6.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: WhoAmIResponseSchema } },
      description: "Caller identity",
    },
    401: {
      description: "Missing, invalid, expired, or wrong-audience Bearer token",
    },
  },
});

export const whoamiRouter = new OpenAPIHono<{ Variables: JwtVariables }>();

whoamiRouter.use("/whoami", jwtMiddleware);

whoamiRouter.openapi(whoamiRoute, (c) => {
  return c.json(
    {
      userId: c.get("userId"),
      email: c.get("email"),
    },
    200,
  );
});

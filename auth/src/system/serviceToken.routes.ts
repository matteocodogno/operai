/**
 * POST /system/service-token — client-credentials issuance of a short-lived,
 * scoped RS256 service JWT (T4, specs/015-hardware-inventory — refs AC-2.8,
 * AC-2.9; plan.md "Service authentication for the notification push";
 * ADR-0044, which realises ADR-0040's hard stop for a fourth notify caller).
 *
 * The caller (`inventory-api`) presents `{clientId, clientSecret}`; the secret
 * is checked against that client's entry in `SERVICE_CLIENTS`
 * (`serviceClients.ts`, constant-time). On success the response is
 * `{token, expiresInSeconds: 300}`. The token:
 *
 *   sub   system:<clientId>
 *   aud   SERVICE_AUDIENCE — NEVER AUTH_AUDIENCE. The two are forced apart at
 *         startup (`lib/env.ts`) and re-asserted here per mint, so a service
 *         token is useless on every user route (`bearerJwtMiddleware` pins
 *         `aud = AUTH_AUDIENCE`) and a user JWT useless on every system route.
 *   scope the client's own entry, from a code-level allowlist
 *   iss   BETTER_AUTH_URL, as for user tokens
 *   exp   iat + 300 s; jti unique per token
 *
 * WHICH KEY SIGNS (plan risk R-4): better-auth's jwt plugin, through its
 * server-only `signJWT` endpoint — the same rotating RS256 key and `kid` that
 * `/auth/jwks` publishes and every resource server verifies against. NOT
 * `jose` + `JWT_PRIVATE_KEY`: that env pair is a separate static keypair
 * served at `/.well-known/jwks.json` that signs nothing in this service
 * (ADR-0005 correction), so tokens signed with it would fail verification
 * everywhere. `serviceToken.contract.test.ts` pins this end to end.
 *
 * FAILURE SHAPE. Unknown client and wrong secret are the SAME response, byte
 * for byte (one frozen body, one status, no client id echoed), and run the same
 * hash + constant-time compare, so neither the body nor the timing separates
 * them. Malformed bodies are a 400 (they carry no client information). With no
 * clients configured the endpoint authenticates nobody: every call is that same
 * 401.
 *
 * WHY A FACTORY. The router takes its signer as a dependency instead of
 * importing `auth.config` itself. Production wires `signWithAuth(auth)` in
 * `src/index.ts`; tests inject either a throwaway in-memory key (route logic)
 * or the real plugin (`src/auth/service-token.contract.test.ts`). This module
 * must not import `auth.config`: several sibling test files
 * `mock.module("../auth/auth.config", ...)` for the rest of the process, and
 * any module FIRST loaded after that gets the stub (no `signJWT`) — which would
 * make this route's tests pass or fail depending on file order.
 *
 * RATE LIMITING keys on the caller's network address (the rightmost
 * `X-Forwarded-For` entry, which is the one the platform proxy appended, or
 * "direct" off-proxy), counted on EVERY attempt including malformed ones and
 * ahead of body validation. Not keyed by `clientId`: the id of the one real
 * client is guessable, so keying on it would let anyone lock that client out
 * by spamming its name. Per-process, like the suite's other limiter
 * (ADR-0035's named limitation). No secret, token or client id is ever logged.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { env } from "../lib/env";
import { createSlidingWindowRateLimiter } from "../lib/rateLimiter";
import {
  authenticateServiceClient,
  SERVICE_SUB_PREFIX,
  SERVICE_TOKEN_TTL_SECONDS,
} from "./serviceClients";

// ─── Schemas ──────────────────────────────────────────────────────────────────
// Length caps bound the work done on attacker-controlled input before any
// comparison. `.strict()`: an unexpected key is a client bug worth a 400.
const ServiceTokenRequestSchema = z
  .object({
    clientId: z.string().min(1).max(64),
    clientSecret: z.string().min(1).max(256),
  })
  .strict();

const ServiceTokenResponseSchema = z.object({
  token: z.string(),
  expiresInSeconds: z.literal(SERVICE_TOKEN_TTL_SECONDS),
});

const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

const ProblemJsonWithCodeSchema = ProblemJsonSchema.extend({ code: z.string() });

const postServiceTokenRoute = createRoute({
  method: "post",
  path: "/system/service-token",
  tags: ["System"],
  summary: "Mint a short-lived scoped service JWT (client-credentials)",
  description:
    "Service-to-service only. Exchanges a per-client secret for a 5-minute RS256 JWT " +
    "(sub system:<clientId>, aud SERVICE_AUDIENCE, scope from the client entry). The token " +
    "is never accepted on a user route. Unknown client and wrong secret return the same 401.",
  request: {
    body: { content: { "application/json": { schema: ServiceTokenRequestSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ServiceTokenResponseSchema } },
      description: "A service JWT and its lifetime in seconds",
    },
    400: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Malformed body",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Invalid client credentials (identical for unknown client and wrong secret)",
    },
    429: {
      content: { "application/json": { schema: ProblemJsonWithCodeSchema } },
      description: "Rate limit exceeded",
    },
  },
});

// ─── Rate limiter ────────────────────────────────────────────────────────────

/** The platform proxy's view of the caller (rightmost XFF entry), bounded in length. */
function callerAddress(forwardedFor: string | undefined): string {
  const last = forwardedFor?.split(",").at(-1)?.trim();
  return last ? last.slice(0, 64) : "direct";
}

// ─── Signing seam ────────────────────────────────────────────────────────────

/** The claims of a service token. `signJwt` must sign exactly these, with the suite's RS256 key and kid. */
export interface ServiceJwtPayload {
  iss: string;
  sub: string;
  aud: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
}

export type SignServiceJwt = (payload: ServiceJwtPayload) => Promise<string>;

/** The slice of better-auth's `auth` object this needs: the jwt plugin's server-only `signJWT`. */
export interface JwtSigningAuth {
  api: {
    signJWT(input: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }>;
  };
}

/** Production signer: better-auth's jwt plugin — the key and `kid` published at `/auth/jwks`. */
export const signWithAuth =
  (authLike: JwtSigningAuth): SignServiceJwt =>
  async (payload) => (await authLike.api.signJWT({ body: { payload: { ...payload } } })).token;

// ─── Router ──────────────────────────────────────────────────────────────────

export function createServiceTokenRouter(deps: { signJwt: SignServiceJwt }) {
  const limiter = createSlidingWindowRateLimiter({
    limit: env.SERVICE_TOKEN_RATE_LIMIT,
    windowMs: env.SERVICE_TOKEN_RATE_WINDOW_MS,
  });

  const rateLimit = createMiddleware(async (c, next) => {
    const result = limiter.consume(callerAddress(c.req.header("X-Forwarded-For")));
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        {
          type: "https://httpstatuses.com/429",
          title: "Too Many Requests",
          status: 429,
          detail: "Too many token requests. Try again later.",
          instance: c.req.path,
          code: "rate_limited",
        },
        429,
      );
    }
    return next();
  });

  const serviceTokenRouter = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            type: "https://httpstatuses.com/400",
            title: "Bad Request",
            status: 400,
            // Field names and rule text only: never echo the submitted values.
            detail: result.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
            instance: c.req.path,
          },
          400,
        );
      }
      return undefined;
    },
  });

  serviceTokenRouter.use("/system/service-token", rateLimit);

  serviceTokenRouter.openapi(postServiceTokenRoute, async (c) => {
    const { clientId, clientSecret } = c.req.valid("json");

    const client = authenticateServiceClient(env.SERVICE_CLIENTS, clientId, clientSecret);
    if (!client) {
      // The reason (unknown client vs wrong secret) is deliberately not logged
      // either: the log line is the only other place it could be learned from.
      console.warn("[system/service-token] rejected credentials");
      // The one 401: constant status and body for every credential failure
      // (`instance` is the fixed request path, not caller-derived).
      return c.json(
        {
          type: "https://httpstatuses.com/401",
          title: "Unauthorized",
          status: 401,
          detail: "Invalid client credentials",
          instance: c.req.path,
        },
        401,
        { "Cache-Control": "no-store" },
      );
    }

    // Defence in depth behind lib/env.ts's startup check: never mint a token a
    // user route would accept, and never mint without an audience.
    const audience = env.SERVICE_AUDIENCE;
    if (!audience || audience === env.AUTH_AUDIENCE) {
      throw new Error("SERVICE_AUDIENCE is unset or equals AUTH_AUDIENCE; refusing to mint a service token");
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await deps.signJwt({
      iss: env.BETTER_AUTH_URL,
      sub: `${SERVICE_SUB_PREFIX}${clientId}`,
      aud: audience,
      scope: client.scopes.join(" "),
      iat: issuedAt,
      exp: issuedAt + SERVICE_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    });

    c.header("Cache-Control", "no-store");
    return c.json({ token, expiresInSeconds: SERVICE_TOKEN_TTL_SECONDS }, 200);
  });

  return serviceTokenRouter;
}

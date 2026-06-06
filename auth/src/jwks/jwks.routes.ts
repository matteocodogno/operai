import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { exportJWK, importSPKI } from "jose";
import { env } from "../lib/env";

const JwksResponseSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

const jwksRoute = createRoute({
  method: "get",
  path: "/.well-known/jwks.json",
  tags: ["System"],
  summary: "JSON Web Key Set",
  description:
    "RS256 public keys for verifying JWTs issued by this service. " +
    "Downstream services should cache this response (max-age=3600).",
  responses: {
    200: {
      content: { "application/json": { schema: JwksResponseSchema } },
      description: "JWKS document",
    },
  },
});

// Lazily built and cached — the PEM import is async but only runs once.
let jwksCache: { keys: object[] } | null = null;

async function getJwks(): Promise<{ keys: object[] }> {
  if (jwksCache) return jwksCache;

  // PEM values in .env store literal \n; normalise to real newlines.
  const pem = env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n");
  const publicKey = await importSPKI(pem, "RS256");
  const jwk = await exportJWK(publicKey);

  jwksCache = {
    keys: [{ ...jwk, use: "sig", alg: "RS256", kid: "operai-auth-rs256-v1" }],
  };

  return jwksCache;
}

export const jwksRouter = new OpenAPIHono();

jwksRouter.openapi(jwksRoute, async (c) => {
  const jwks = await getJwks();
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(jwks);
});

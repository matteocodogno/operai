import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins";
import { db } from "../lib/db";
import { env } from "../lib/env";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/auth",
  database: prismaAdapter(db, {
    provider: "postgresql",
  }),
  secret: env.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh TTL after 24 h of activity
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5-minute client-side cache
    },
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
  },
  plugins: [
    // Issues RS256-signed JWTs; stores the rotating keypair in the `jwks` table.
    // The env-provided JWT_PUBLIC_KEY is exposed via /.well-known/jwks.json for
    // downstream services that need to verify tokens without a shared secret.
    jwt({
      jwks: {
        keyPairConfig: { alg: "RS256" },
        disablePrivateKeyEncryption: true,
      },
      jwt: {
        issuer: env.BETTER_AUTH_URL,
        expirationTime: "7d",
        fields: ["sub", "email", "name", "image"],
      },
    }),
  ],
});

export type Auth = typeof auth;

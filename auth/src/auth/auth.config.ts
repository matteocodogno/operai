import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins";
import { assignBaselineRolesToNewUser } from "../authz/seed";
import { db } from "../lib/db";
import { env } from "../lib/env";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/auth",
  // Trust the same origins the Hono CORS layer already allows.
  // Without this, better-auth's internal getTrustedOrigins() only trusts
  // BETTER_AUTH_URL itself and rejects state-mutating calls (e.g. /auth/sign-out)
  // that originate from the UI (localhost:5173 in dev, Vercel origin in prod)
  // with 403 INVALID_ORIGIN — so sign-out can never terminate the server session.
  trustedOrigins: env.ALLOWED_ORIGINS,
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
  // Authorization bootstrap (specs/004-auth-roles-permissions, T11 —
  // AC-6.1, AC-6.3). Fires once, after every new user row is created,
  // regardless of which sign-up path created it (Google, GitHub, or the
  // dev-only test-auth mint endpoint). See `authz/seed.ts` for the full
  // rationale — this hook only wires better-auth's lifecycle to that logic:
  //   - every new user is assigned the baseline `employee` role (AC-6.3)
  //   - a user whose (verified) email matches `BOOTSTRAP_ADMIN_EMAIL` is
  //     ALSO assigned `admin` (AC-6.1) — matched against `user.email` as
  //     recorded from the OAuth provider's verified profile, never
  //     anything a client can supply directly
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await assignBaselineRolesToNewUser(user);
        },
      },
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
        // `fields` (the old option here) is a no-op on better-auth 1.6.2 — the
        // plugin spreads the ENTIRE user row into the token regardless of what
        // `fields` lists (node_modules/better-auth/dist/plugins/jwt/sign.mjs:
        // `getJwtToken` falls back to `ctx.context.session.user` verbatim when
        // no `definePayload` is supplied). `definePayload` is the only real
        // claim seam (plan.md "The JWT claim seam"; ADR-0007; risk R2).
        //
        // Deliberately minimal + explicit: identity claims existing consumers
        // already read (estimai-api's jwtMiddleware reads `sub`+`email`) plus
        // `perm_epoch`, a forward-looking staleness marker for future resource
        // servers (ADR-0007 decision 4). Roles/permissions are NEVER embedded
        // here — they are resolved live via `GET /authz/me` (AC-4.3): a 7-day
        // token can't carry fresh authorization.
        //
        // `sub` is intentionally NOT set here — the plugin always overwrites it
        // with `getSubject()` (default: `session.user.id`) after `definePayload`
        // returns (sign.mjs: `{ iat, ...payload, sub: ... }`), so setting it here
        // would be misleading dead code. Do not change `sub` semantics (ADR-0005).
        definePayload: async ({ user }) => {
          // Re-read permissionEpoch directly via the Prisma client rather than
          // trusting `user.permissionEpoch` off the session object: better-auth's
          // session/cookie cache (up to 5 min, see `cookieCache` above) can serve
          // a stale user snapshot, which would defeat the purpose of `perm_epoch`
          // as a staleness signal for future consumers.
          const current = await db.user.findUnique({
            where: { id: user.id },
            select: { permissionEpoch: true },
          });

          return {
            email: user.email,
            name: user.name,
            image: user.image,
            perm_epoch: current?.permissionEpoch ?? user.permissionEpoch ?? 0,
          };
        },
      },
    }),
  ],
});

export type Auth = typeof auth;

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins";
import { assignBaselineRolesToNewUser } from "../authz/seed";
import type { NewUserForBootstrap } from "../authz/seed";
import { withAudit } from "../authz/audit";
import { findLivePendingInvitationByEmail } from "../invitations/invitations.repo";
import { db } from "../lib/db";
import { env } from "../lib/env";

// ─── Invitation activation hooks (specs/006-user-invitations, T8) ──────────
//
// Two distinct better-auth seams — ADR-0012 explains WHY there are two, not
// one: `user.create.after` fires exactly once, when a brand-new user row is
// first persisted; it does NOT fire again for a returning identity (better-
// auth matches the existing `account` row and only creates a session), so a
// SEPARATE seam (`session.create.before`, below) is required to intercept a
// soft-deleted user's return sign-in. Both share the same trust posture:
// the email that gates a privilege grant is ALWAYS the OAuth-**verified**
// email already persisted on the `user` row — never anything from a
// request body/header, and never the invite-link token itself (that token
// is UX/landing-page-only, see `src/invite/`, and grants nothing on its
// own — AC-2.4 falls out of this structurally).
//
// R1 (plan.md Risk R1) — the `session.create.before` abort contract was
// spiked empirically against the pinned better-auth version (1.6.23, see
// bun.lock) before this was wired: a scratch `betterAuth()` instance with a
// `session.create.before` hook returning `false` was used to call
// `ctx.internalAdapter.createSession(userId)` directly. Result: it resolves
// to `null` and NO session row is persisted (confirmed via a `db.session.count`
// of 0 afterward) — matching both `node_modules/better-auth/dist/db/with-
// hooks.mjs` (`if (result === false) return null;`) and the official type
// doc-comment in `@better-auth/core`'s `init-options.d.mts` ("if the hook
// returns false, the session will not be created"). Tracing the OAuth
// callback path (`api/routes/callback.mjs` → `oauth2/link-account.mjs`'s
// `handleOAuthUserInfo`) confirms `createSession` returning `null` becomes
// `{ error: "unable to create session" }`, which the callback handler
// redirects on WITHOUT ever calling `setSessionCookie` — no session
// persists, no cookie is set. Returning `false` is therefore a genuine,
// confirmed deny; the documented `session.create.after` + immediate
// `session.delete` fallback (plan.md) is NOT needed. See
// `auth.config.test.ts`'s "R1 spike" describe block for the permanent,
// shipped version of this empirical check.

/**
 * `user.create.after` — new-user activation (AC-2.3, AC-2.4). Called AFTER
 * `assignBaselineRolesToNewUser` so the baseline `employee` role is already
 * in place. Looks up a LIVE PENDING invitation for the new user's own
 * verified email (`user.emailVerified === true` — the same posture as the
 * bootstrap-admin match in `authz/seed.ts`) and, on a match, applies the
 * invitation's roleIds/departmentIds ADDITIVE to the baseline `employee`
 * role (per plan.md Risk R9 — AC-2.3's "baseline default" framing reads as
 * additive; flagged here for QE to confirm — a one-line flip to
 * replace-not-add if QE reads AC-2.3 strictly), marks the invitation
 * `accepted`, bumps `permissionEpoch`, and writes an audit row. A DIFFERENT
 * verified identity that follows the same invite link looks up ITS OWN
 * email here and finds no live-pending row — the original invitation is
 * untouched — which is exactly AC-2.4's cross-identity isolation, achieved
 * structurally rather than via any invite-link-specific check.
 */
export async function applyLivePendingInvitationOnUserCreate(
  user: NewUserForBootstrap,
): Promise<void> {
  if (user.emailVerified !== true) return;

  const invitation = await findLivePendingInvitationByEmail(db, user.email);
  if (!invitation) return;

  await withAudit({
    affectedUserIds: [user.id],
    mutate: async (tx) => {
      for (const roleId of invitation.roleIds) {
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: user.id, roleId } },
          update: {},
          create: { userId: user.id, roleId, assignedByUserId: invitation.invitedByUserId },
        });
      }
      for (const departmentId of invitation.departmentIds) {
        await tx.userDepartment.upsert({
          where: { userId_departmentId: { userId: user.id, departmentId } },
          update: {},
          create: {
            userId: user.id,
            departmentId,
            assignedByUserId: invitation.invitedByUserId,
          },
        });
      }
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "accepted", acceptedByUserId: user.id },
      });
    },
    entry: {
      actorUserId: user.id,
      action: "invitation.accept",
      targetType: "invitation",
      targetId: invitation.id,
      summary: `Invitation for ${user.email} accepted on sign-up`,
      data: { roleIds: invitation.roleIds, departmentIds: invitation.departmentIds },
    },
  });
}

/**
 * `session.create.before` — soft-delete gate + re-activation (AC-5.2,
 * AC-5.10). Fires on EVERY session creation, including a returning OAuth
 * identity whose `account` row already exists (the seam `user.create.after`
 * cannot reach — see ADR-0012). An ACTIVE user (`deletedAt == null`) is
 * always allowed with NO invitation logic (an active user's verified email
 * can never hold a live-pending invitation, AC-1.3) — this keeps the
 * per-sign-in cost of this hook to a single indexed lookup for the
 * overwhelming common case. A SOFT-DELETED user is gated: a live-pending
 * invitation for their verified email RE-ACTIVATES them — clears
 * `deletedAt`/`deletedByUserId` and REPLACES roles/departments with EXACTLY
 * the new invitation's set (deliberately NOT additive/unioned with
 * whatever they held before deletion — AC-5.10 is explicit that
 * re-activation is a fresh activation, not a resurrection of prior grants)
 * — otherwise the session is DENIED outright (AC-5.2, see the R1 comment
 * above for the confirmed abort mechanism): no resurrection, and no new
 * user row is created because the `account` row still maps to this exact
 * (soft-deleted) user.
 */
export async function gateOrReactivateSoftDeletedSession(
  userId: string,
): Promise<false | void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { deletedAt: true, email: true, emailVerified: true },
  });

  // Defensive fail-closed: a session must always reference a real user row.
  if (!user) return false;
  if (user.deletedAt === null) return; // active user — no gate (AC-1.3)
  if (user.emailVerified !== true) return false;

  const invitation = await findLivePendingInvitationByEmail(db, user.email);
  if (!invitation) return false; // AC-5.2 — refused; no resurrection, no new user row

  await withAudit({
    affectedUserIds: [userId],
    mutate: async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: null, deletedByUserId: null },
      });
      // REPLACE (not merge) — AC-5.10.
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userDepartment.deleteMany({ where: { userId } });
      if (invitation.roleIds.length > 0) {
        await tx.userRole.createMany({
          data: invitation.roleIds.map((roleId) => ({
            userId,
            roleId,
            assignedByUserId: invitation.invitedByUserId,
          })),
        });
      }
      if (invitation.departmentIds.length > 0) {
        await tx.userDepartment.createMany({
          data: invitation.departmentIds.map((departmentId) => ({
            userId,
            departmentId,
            assignedByUserId: invitation.invitedByUserId,
          })),
        });
      }
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "accepted", acceptedByUserId: userId },
      });
    },
    entry: {
      actorUserId: userId,
      action: "user.reactivate",
      targetType: "user",
      targetId: userId,
      summary: `Re-activated ${user.email} via a fresh invitation (was soft-deleted)`,
      data: { invitationId: invitation.id, roleIds: invitation.roleIds, departmentIds: invitation.departmentIds },
    },
  });

  // Falls through to `undefined` — allow the session.
}

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
          // T8, specs/006-user-invitations (AC-2.3/2.4) — see the doc
          // comment on `applyLivePendingInvitationOnUserCreate` above.
          await applyLivePendingInvitationOnUserCreate(user);
        },
      },
    },
    session: {
      create: {
        // T8, specs/006-user-invitations (AC-5.2/5.10; R1) — see the doc
        // comment on `gateOrReactivateSoftDeletedSession` above.
        before: async (session) => gateOrReactivateSoftDeletedSession(session.userId),
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
            // ADR-0010 (specs/005-notification-center T8): the standard `aud`
            // claim, closing the cross-service JWT replay gap now that
            // notify-api is the suite's first real second JWKS resource
            // server. `sign.mjs` reads `payload.aud` and passes it to
            // `SignJWT#setAudience`, so returning it here from
            // `definePayload` is sufficient — no separate `jwt.audience`
            // plugin option needed. v1 is one suite-wide value (not yet
            // per-resource-server scoped, see ADR-0010 "Consequences"); every
            // resource server must verify against the SAME `AUTH_AUDIENCE`
            // value (T9 — not yet enforced here, issuer-side only).
            aud: env.AUTH_AUDIENCE,
          };
        },
      },
    }),
  ],
});

export type Auth = typeof auth;

import { createMiddleware } from "hono/factory";
import type { User, Session } from "better-auth";
import { auth } from "./auth.config";
import { db } from "../lib/db";

type AuthVariables = {
  user: User | null;
  session: Session | null;
};

/**
 * Resolves the current session (cookie or Bearer token) and attaches
 * `user` + `session` to context. Does NOT reject unauthenticated requests —
 * compose with `requireAuth` for protected routes.
 */
export const sessionMiddleware = createMiddleware<{
  Variables: AuthVariables;
}>(async (c, next) => {
  const result = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  c.set("user", result?.user ?? null);
  c.set("session", result?.session ?? null);

  return next();
});

/**
 * Rejects unauthenticated requests with RFC 7807 401.
 * Must be applied after `sessionMiddleware`.
 */
export const requireAuth = createMiddleware<{
  Variables: AuthVariables;
}>(async (c, next) => {
  const user = c.get("user");

  if (!user) {
    return c.json(
      {
        type: "https://httpstatuses.com/401",
        title: "Unauthorized",
        status: 401,
        detail: "A valid session or Bearer token is required",
        instance: c.req.path,
      },
      401,
    );
  }

  return next();
});

/**
 * Rejects requests from an authenticated caller who does not hold the
 * `admin` role with RFC 7807 403 (spec 004, T4 — AC-1.5). This is a role
 * gate, not an ownership check — distinct from ADR-0005's per-record 404
 * (which hides existence of a resource the caller doesn't own). Here the
 * caller's identity is fully known; we are simply denying them the admin
 * surface, so `403 Forbidden` — not `404` — is the correct, non-leaking
 * response (there is nothing about a specific resource's existence to hide;
 * every authenticated user knows `/admin/*` exists).
 *
 * Must be applied after `sessionMiddleware` + `requireAuth` (relies on
 * `c.get("user")` already being populated and non-null).
 *
 * Checks role membership with a direct, minimal query (`UserRole` joined to
 * `Role` where `name: "admin"`) rather than routing through the full
 * effective-permissions resolver (`authz/resolver.ts`) — the resolver unions
 * direct AND department-derived rules and de-dups by (resource, action),
 * which is the right tool for "what can this user do" but unnecessary work
 * for a single yes/no role-membership check on every admin request. Note:
 * this deliberately checks DIRECT `user_role` membership only — the `admin`
 * role is a system role meant to be assigned directly to trusted operators,
 * never conferred transitively via a department (there is no product
 * scenario for "every member of the Finance department is an admin").
 */
export const requireAdmin = createMiddleware<{
  Variables: AuthVariables;
}>(async (c, next) => {
  const user = c.get("user");

  // requireAdmin must run after requireAuth; if `user` is somehow absent
  // (misconfigured middleware order), fail closed with the same 403 rather
  // than assuming admin or throwing — never treat "unknown" as "allowed".
  const membership = user
    ? await db.userRole.findFirst({
        where: { userId: user.id, role: { name: "admin" } },
        select: { userId: true },
      })
    : null;

  if (!membership) {
    return c.json(
      {
        type: "https://httpstatuses.com/403",
        title: "Forbidden",
        status: 403,
        detail: "The admin role is required to access this resource",
        instance: c.req.path,
      },
      403,
    );
  }

  return next();
});

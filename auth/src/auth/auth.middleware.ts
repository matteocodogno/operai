import { createMiddleware } from "hono/factory";
import type { User, Session } from "better-auth";
import { auth } from "./auth.config";

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

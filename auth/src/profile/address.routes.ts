/**
 * Employee self-address API (T4, specs/012-employee-address — refs AC-6.1,
 * AC-6.2, AC-6.3, AC-6.4).
 *
 *   GET /me/address    the caller's OWN current address, or null
 *
 * Three structural guarantees, deliberately baked into the URL/route shape
 * (plan.md "Employee self surface"):
 *
 *   - AC-6.4 — there is NO `:id` parameter anywhere in this router. The
 *     handler resolves `c.get("user")!.id` and nothing else — there is no
 *     request a caller can construct that names another employee. Exactly
 *     the rationale `/authz/me` already documents ("there is no `:id` — a
 *     caller can only ever resolve their OWN").
 *   - AC-6.3 — there is NO write verb registered at `/me/address`.
 *     `PUT`/`POST`/`PATCH`/`DELETE` fall through to the app-level
 *     `app.notFound()` (RFC 7807 404) — see `userAddress.routes.test.ts` /
 *     `address.routes.test.ts` for the assertions.
 *   - `updatedByUserId` is DELIBERATELY OMITTED from this response — a data
 *     subject's transparency right does not extend to learning which admin
 *     edited their record (least exposure).
 *
 * `sessionMiddleware + requireAuth` ONLY — deliberately NO `requireAdmin`,
 * unlike every route in `../admin/userAddress.routes.ts`.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { User } from "better-auth";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { db } from "../lib/db";
import { formatAddress, type FormatLocale } from "./address.format";
import {
  GetSelfAddressResponseSchema,
  ProblemJsonSchema,
} from "./address.schema";

/** `Accept-Language` → `it` or `en` (default) — mirrors `../admin/userAddress.routes.ts`. */
function negotiateLocale(acceptLanguage: string | null): FormatLocale {
  if (!acceptLanguage) return "en";
  const primary =
    acceptLanguage.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return primary.startsWith("it") ? "it" : "en";
}

export const addressRouter = new OpenAPIHono<{
  Variables: { user: User | null };
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          status: 400,
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

addressRouter.use("/me/address", sessionMiddleware, requireAuth);

const getMyAddressRoute = createRoute({
  method: "get",
  path: "/me/address",
  tags: ["Profile"],
  summary: "Get the caller's own stored address",
  description:
    "Strictly self-scoped (AC-6.4) — resolves the caller's id from their " +
    "session; no request can name another employee. Read-only: no write " +
    "verb exists at this path (AC-6.3). `updatedByUserId` is deliberately " +
    "omitted (least exposure) — see `../admin/userAddress.routes.ts` for " +
    "the admin-only view that includes it.",
  responses: {
    200: {
      content: { "application/json": { schema: GetSelfAddressResponseSchema } },
      description: "The caller's own current address, or null if none is on file",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Defensive only — a soft-deleted caller cannot reach this route at all (ADR-0012 revokes their sessions)",
    },
  },
});

addressRouter.openapi(getMyAddressRoute, async (c) => {
  const caller = c.get("user")!;

  // Defensive only: ADR-0012 synchronously revokes every session on
  // soft-delete, so a soft-deleted user's Bearer/cookie session should
  // already be invalid by the time sessionMiddleware runs. This 404 exists
  // purely as a second layer of defence, never expected to be reachable in
  // practice.
  const record = await db.user.findUnique({
    where: { id: caller.id },
    select: { deletedAt: true },
  });
  if (!record || record.deletedAt !== null) {
    return c.json(
      {
        type: "https://httpstatuses.com/404",
        title: "Not Found",
        status: 404,
        detail: "No user with this id",
        instance: c.req.path,
      },
      404,
    );
  }

  const row = await db.employeeAddress.findUnique({
    where: { userId: caller.id },
  });
  const locale = negotiateLocale(c.req.header("Accept-Language") ?? null);

  if (!row) {
    return c.json({ address: null }, 200);
  }

  return c.json(
    {
      address: {
        countryCode: row.countryCode,
        city: row.city,
        street: row.street,
        houseNumber: row.houseNumber,
        postalCode: row.postalCode,
        region: row.region,
        latitude: row.latitude !== null ? Number(row.latitude) : null,
        longitude: row.longitude !== null ? Number(row.longitude) : null,
        formatted: formatAddress(
          {
            countryCode: row.countryCode,
            city: row.city,
            street: row.street,
            houseNumber: row.houseNumber,
            postalCode: row.postalCode,
            region: row.region,
          },
          locale,
        ),
        updatedAt: row.updatedAt.toISOString(),
        // updatedByUserId is DELIBERATELY OMITTED — see module doc comment.
      },
    },
    200,
  );
});

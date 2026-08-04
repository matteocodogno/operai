/**
 * Admin Employee Address API (T3, specs/012-employee-address — refs AC-1.1,
 * AC-1.2, AC-1.3, AC-1.4, AC-2.4, AC-2.5, AC-3.3, AC-3.4, AC-4.1, AC-5.1,
 * AC-5.4, AC-6.3, AC-6.4).
 *
 *   GET /admin/users/:id/address    the employee's current address, or null
 *   PUT /admin/users/:id/address    set/replace/clear (one path for both —
 *                                   `{"address": null}` is AC-1.3's clear)
 *
 * ── THE single highest-consequence line in this file ───────────────────────
 * This is a NEW router, kept out of the already-1168-line `users.routes.ts`
 * for file hygiene (plan.md "API contracts → Admin surface") — which means
 * its `requireAdmin` gate is RE-DECLARED here, not inherited. Forgetting the
 * line below would silently expose every employee's home address to any
 * authenticated user. `userAddress.routes.test.ts` asserts a non-admin gets
 * `403` on BOTH verbs, against a colleague's id AND their own — see ADR-0031
 * "Risks" and plan.md's R12.
 *
 *   userAddressRouter.use("/admin/users/*", sessionMiddleware, requireAuth, requireAdmin);
 *
 * ── Status-code posture (plan.md "API contracts") ───────────────────────────
 * This is a role gate on a surface, NOT ADR-0005/0014's per-record 404 —
 * `requireAdmin` already answers "not an admin" with 403 (there is nothing
 * about a specific resource's existence to hide). A soft-deleted or unknown
 * `:id` still 404s, mirroring every other `/admin/users/:id` route.
 *
 * ── `audit_log` scope guarantee (ADR-0033) ──────────────────────────────────
 * Every write below runs through the EXISTING `withAudit()` (../authz/
 * audit.ts) with NO changes to that module. `affectedUserIds: []` is
 * deliberate (see the PUT handler) — an address change is not a permission
 * change, so no epoch bump.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { User } from "better-auth";
import {
  requireAdmin,
  requireAuth,
  sessionMiddleware,
} from "../auth/auth.middleware";
import { db } from "../lib/db";
import { withAudit } from "../authz/audit";
import { formatAddress, type FormatLocale } from "../profile/address.format";
import {
  AddressIncompleteProblemSchema,
  GetAdminAddressResponseSchema,
  ProblemJsonSchema,
  PutAddressBodySchema,
  type AddressInput,
  type RequiredAddressField,
} from "../profile/address.schema";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const IdParamSchema = z.object({ id: z.string().min(1) });

// ─── Normalization / completeness (plan.md "Admin surface → Handler algorithm") ─

interface NormalizedAddress {
  countryCode: string;
  city: string;
  street: string;
  houseNumber: string;
  postalCode: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Rounds to 6 decimal places — the precision `DECIMAL(9,6)` stores. */
function quantize6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Trims every string, upper-cases `countryCode`, quantizes coordinates, and
 * normalizes an asymmetric lat/lng pair to `(null, null)` — plan.md step 4.
 * Returns the four-field completeness result: `missingFields` is empty iff
 * `normalized` is populated.
 */
function normalizeAndValidate(input: AddressInput): {
  normalized: NormalizedAddress | null;
  missingFields: RequiredAddressField[];
} {
  const countryCode = (input.countryCode ?? "").trim().toUpperCase();
  const city = (input.city ?? "").trim();
  const street = (input.street ?? "").trim();
  const houseNumber = (input.houseNumber ?? "").trim();

  const missingFields: RequiredAddressField[] = [];
  if (!countryCode) missingFields.push("countryCode");
  if (!city) missingFields.push("city");
  if (!street) missingFields.push("street");
  if (!houseNumber) missingFields.push("houseNumber");

  if (missingFields.length > 0) {
    return { normalized: null, missingFields };
  }

  // Optional fields: blank-after-trim is treated as absent (never a reason
  // to reject a save either way, AC-1.4).
  const postalCodeTrimmed = input.postalCode != null ? input.postalCode.trim() : "";
  const regionTrimmed = input.region != null ? input.region.trim() : "";
  const postalCode = postalCodeTrimmed ? postalCodeTrimmed : null;
  const region = regionTrimmed ? regionTrimmed : null;

  // Coordinates: exactly one of lat/lng present → treat both as absent (the
  // DB CHECK is the backstop; the API normalizes rather than 400s).
  const latRaw = input.latitude ?? null;
  const lngRaw = input.longitude ?? null;
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (latRaw !== null && lngRaw !== null) {
    latitude = quantize6(latRaw);
    longitude = quantize6(lngRaw);
  }

  return {
    normalized: {
      countryCode,
      city,
      street,
      houseNumber,
      postalCode,
      region,
      latitude,
      longitude,
    },
    missingFields: [],
  };
}

/** Maps a stored `employee_address` row to the normalized shape (the "before" value). */
function rowToNormalized(row: {
  countryCode: string;
  city: string;
  street: string;
  houseNumber: string;
  postalCode: string | null;
  region: string | null;
  latitude: unknown;
  longitude: unknown;
} | null): NormalizedAddress | null {
  if (!row) return null;
  return {
    countryCode: row.countryCode,
    city: row.city,
    street: row.street,
    houseNumber: row.houseNumber,
    postalCode: row.postalCode,
    region: row.region,
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
  };
}

function numbersEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 1e-9;
}

/**
 * AC-5.4 — semantic before/after comparison across all eight fields. `null`
 * and absent are the same value (both sides are already normalized);
 * coordinates compare numerically, not by Decimal identity.
 */
function normalizedAddressesEqual(
  a: NormalizedAddress | null,
  b: NormalizedAddress | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.countryCode === b.countryCode &&
    a.city === b.city &&
    a.street === b.street &&
    a.houseNumber === b.houseNumber &&
    a.postalCode === b.postalCode &&
    a.region === b.region &&
    numbersEqual(a.latitude, b.latitude) &&
    numbersEqual(a.longitude, b.longitude)
  );
}

/** `Accept-Language` → `it` or `en` (default) — a CORS-safelisted header the browser sends automatically. */
function negotiateLocale(acceptLanguage: string | null): FormatLocale {
  if (!acceptLanguage) return "en";
  const primary =
    acceptLanguage.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return primary.startsWith("it") ? "it" : "en";
}

function toAddressView(
  row: {
    countryCode: string;
    city: string;
    street: string;
    houseNumber: string;
    postalCode: string | null;
    region: string | null;
    latitude: unknown;
    longitude: unknown;
    updatedAt: Date;
    updatedByUserId: string | null;
  },
  locale: FormatLocale,
) {
  const normalized = rowToNormalized(row)!;
  return {
    ...normalized,
    formatted: formatAddress(normalized, locale),
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}

// ─── Problem-JSON helpers ─────────────────────────────────────────────────────

function notFound(instance: string, detail: string) {
  return {
    type: "https://httpstatuses.com/404",
    title: "Not Found",
    status: 404,
    detail,
    instance,
  } as const;
}

function addressIncomplete(
  instance: string,
  missingFields: RequiredAddressField[],
) {
  return {
    type: "https://httpstatuses.com/422",
    title: "Unprocessable Entity",
    status: 422,
    detail: `Address is incomplete: ${missingFields.join(", ")} are required.`,
    instance,
    code: "address_incomplete" as const,
    missingFields,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const userAddressRouter = new OpenAPIHono<{
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

// ── THE gate (see the module doc comment above — do not remove) ────────────
userAddressRouter.use(
  "/admin/users/*",
  sessionMiddleware,
  requireAuth,
  requireAdmin,
);

// ─── GET /admin/users/:id/address ──────────────────────────────────────────────

const getAddressRoute = createRoute({
  method: "get",
  path: "/admin/users/{id}/address",
  tags: ["Admin"],
  summary: "Get an employee's stored address",
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: GetAdminAddressResponseSchema } },
      description: "The employee's current address, or null if none is on file",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id, or the user is soft-deleted",
    },
  },
});

userAddressRouter.openapi(getAddressRoute, async (c) => {
  const { id } = c.req.valid("param");

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!target || target.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  const row = await db.employeeAddress.findUnique({ where: { userId: id } });
  const locale = negotiateLocale(c.req.header("Accept-Language") ?? null);

  return c.json(
    { userId: id, address: row ? toAddressView(row, locale) : null },
    200,
  );
});

// ─── PUT /admin/users/:id/address ──────────────────────────────────────────────

const putAddressRoute = createRoute({
  method: "put",
  path: "/admin/users/{id}/address",
  tags: ["Admin"],
  summary: "Set, replace, or clear an employee's address",
  description:
    "One endpoint for set AND clear (AC-1.3) — `{\"address\": null}` is an " +
    "intentional clear, distinct from a validation failure. A save whose " +
    "value is identical to what's already stored writes nothing (AC-5.4).",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: PutAddressBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: GetAdminAddressResponseSchema } },
      description: "The address as saved (or null if cleared)",
    },
    401: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No valid session",
    },
    403: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "Caller does not hold the admin role",
    },
    404: {
      content: { "application/json": { schema: ProblemJsonSchema } },
      description: "No user with this id, or the user is soft-deleted",
    },
    422: {
      content: { "application/json": { schema: AddressIncompleteProblemSchema } },
      description:
        "AC-1.4 — one or more of the four required components (country, " +
        "city, street, house/building number) is missing",
    },
  },
});

userAddressRouter.openapi(putAddressRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { address: addressInput } = c.req.valid("json");
  const actorUserId = c.get("user")!.id;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, deletedAt: true },
  });
  if (!target || target.deletedAt !== null) {
    return c.json(notFound(c.req.path, `No user with id ${id}`), 404);
  }

  const existingRow = await db.employeeAddress.findUnique({
    where: { userId: id },
  });
  const beforeNormalized = rowToNormalized(existingRow);

  let afterNormalized: NormalizedAddress | null;
  if (addressInput === null) {
    // AC-1.3 — an explicit clear.
    afterNormalized = null;
  } else {
    const { normalized, missingFields } = normalizeAndValidate(addressInput);
    if (missingFields.length > 0) {
      return c.json(addressIncomplete(c.req.path, missingFields), 422);
    }
    afterNormalized = normalized;
  }

  // ── AC-5.4 — semantic no-op guard ─────────────────────────────────────────
  // Identical before/after (including a clear-of-nothing): return 200
  // unchanged, write NOTHING — no DB write, no audit row, no updatedAt bump.
  if (normalizedAddressesEqual(beforeNormalized, afterNormalized)) {
    const locale = negotiateLocale(c.req.header("Accept-Language") ?? null);
    return c.json(
      {
        userId: id,
        address: existingRow ? toAddressView(existingRow, locale) : null,
      },
      200,
    );
  }

  const englishBefore = beforeNormalized
    ? { ...beforeNormalized, formatted: formatAddress(beforeNormalized, "en") }
    : null;
  const englishAfter = afterNormalized
    ? { ...afterNormalized, formatted: formatAddress(afterNormalized, "en") }
    : null;

  const resultRow = await withAudit({
    // An address change is NOT a permission change — deliberately no epoch
    // bump (the one place this feature diverges from every other withAudit
    // caller, plan.md "Admin surface → Handler algorithm" step 6).
    affectedUserIds: [],
    mutate: async (tx) => {
      if (afterNormalized === null) {
        await tx.employeeAddress.deleteMany({ where: { userId: id } });
        return null;
      }
      return tx.employeeAddress.upsert({
        where: { userId: id },
        create: {
          userId: id,
          countryCode: afterNormalized.countryCode,
          city: afterNormalized.city,
          street: afterNormalized.street,
          houseNumber: afterNormalized.houseNumber,
          postalCode: afterNormalized.postalCode,
          region: afterNormalized.region,
          latitude: afterNormalized.latitude,
          longitude: afterNormalized.longitude,
          updatedByUserId: actorUserId,
        },
        update: {
          countryCode: afterNormalized.countryCode,
          city: afterNormalized.city,
          street: afterNormalized.street,
          houseNumber: afterNormalized.houseNumber,
          postalCode: afterNormalized.postalCode,
          region: afterNormalized.region,
          latitude: afterNormalized.latitude,
          longitude: afterNormalized.longitude,
          updatedByUserId: actorUserId,
        },
      });
    },
    entry: {
      actorUserId,
      action: "user.address.set",
      targetType: "user",
      targetId: id,
      summary: `Updated address for ${target.email}`,
      // A stable historical fact — always English, never re-rendered per
      // viewer locale (plan.md "Admin surface → Handler algorithm" step 6).
      data: { before: englishBefore, after: englishAfter },
    },
  });

  const locale = negotiateLocale(c.req.header("Accept-Language") ?? null);
  return c.json(
    {
      userId: id,
      address: resultRow ? toAddressView(resultRow, locale) : null,
    },
    200,
  );
});

/**
 * Shared zod wire shapes for the employee-address feature (T2, specs/012-
 * employee-address — refs AC-1.1, AC-1.4), used by both
 * `../admin/userAddress.routes.ts` and `./address.routes.ts`.
 *
 * ── Validation split — deliberate, and load-bearing for AC-1.4 ─────────────
 * This schema validates SHAPE/TYPE/LENGTH ONLY. All four AC-1.4-required
 * components (`countryCode`/`city`/`street`/`houseNumber`) are declared
 * `.optional()` here — the completeness check ("all four or none") is
 * HANDLER logic (`../admin/userAddress.routes.ts`), applied AFTER trimming.
 *
 * Reason: if this schema declared the four required, an ABSENT field would
 * 400 from the router's `defaultHook` while a BLANK (`""`/`"   "`) field
 * would 422 from the handler — two different errors for the same user
 * mistake. With the split, absent / `""` / `"   "` all reach the handler and
 * produce ONE uniform `422` naming exactly which of the four is missing,
 * which is what AC-1.4 asks for. Trimming itself is also deliberately a
 * HANDLER step (plan.md "Admin surface → Handler algorithm" step 4), not done
 * here, so a whitespace-only value survives this schema unchanged and is
 * caught by the handler's blank check.
 */

import { z } from "zod";

export const AddressInputSchema = z.object({
  // Shape/length only — "required" and "must be exactly 2 uppercase
  // letters" are BOTH handler concerns (upper-casing + the completeness
  // check happen there; the DB CHECK is the final backstop).
  countryCode: z.string().max(10).optional(),
  city: z.string().max(200).optional(),
  street: z.string().max(200).optional(),
  houseNumber: z.string().max(32).optional(),

  // Genuinely optional (never a reason a save is rejected, AC-1.4) — nullable
  // so an explicit `null` (as opposed to absent) can clear a previously-set
  // optional value.
  postalCode: z.string().max(32).nullable().optional(),
  region: z.string().max(200).nullable().optional(),

  // Coordinates (AC-2.5/AC-2.6) — range-checked here (a format/shape
  // invariant, not a "required-ness" one; the DB CHECK mirrors the same
  // range as the final backstop). Independently optional/nullable: the
  // handler normalizes an asymmetric pair (exactly one present) to
  // `(null, null)` rather than rejecting it (plan.md "Admin surface →
  // Handler algorithm" step 4) — a 400 here would pre-empt that
  // normalization.
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

export type AddressInput = z.infer<typeof AddressInputSchema>;

/** `PUT .../address` request body — `null` is AC-1.3's intentional clear. */
export const PutAddressBodySchema = z.object({
  address: AddressInputSchema.nullable(),
});

/** The four AC-1.4-required component keys, in the order AC-1.4 lists them. */
export const REQUIRED_ADDRESS_FIELDS = [
  "countryCode",
  "city",
  "street",
  "houseNumber",
] as const;

export type RequiredAddressField = (typeof REQUIRED_ADDRESS_FIELDS)[number];

// ─── Response shapes ──────────────────────────────────────────────────────────

/** `GET`/`PUT .../address` 200 body — shared by the admin and self surfaces. */
export const AddressViewSchema = z.object({
  countryCode: z.string(),
  city: z.string(),
  street: z.string(),
  houseNumber: z.string(),
  postalCode: z.string().nullable(),
  region: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  formatted: z.string(),
  updatedAt: z.string().datetime(),
});

/** The admin-only view — adds `updatedByUserId` (deliberately absent from `/me/address`). */
export const AdminAddressViewSchema = AddressViewSchema.extend({
  updatedByUserId: z.string().nullable(),
});

export const GetAdminAddressResponseSchema = z.object({
  userId: z.string(),
  address: AdminAddressViewSchema.nullable(),
});

export const GetSelfAddressResponseSchema = z.object({
  address: AddressViewSchema.nullable(),
});

export const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
});

/** The `422` shape for AC-1.4 — extends Problem JSON with a distinguishing `code` + `missingFields`. */
export const AddressIncompleteProblemSchema = ProblemJsonSchema.extend({
  code: z.literal("address_incomplete"),
  missingFields: z.array(z.enum(REQUIRED_ADDRESS_FIELDS)),
});

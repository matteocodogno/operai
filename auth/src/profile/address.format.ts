/**
 * Formatted-address derivation (T2, specs/012-employee-address — refs AC-1.1,
 * plan.md "Data model → `formatted` is derived, never stored").
 *
 * The Domain language defines the formatted address as "derived from its
 * structured components" — it is therefore computed fresh on every read,
 * NEVER persisted (ADR-0031 Decision point 3; ADR-0013/ADR-0019 lineage). This
 * is the ONE implementation; no other module composes this string.
 *
 * `locale` is negotiated from the request's `Accept-Language` header by the
 * caller (a CORS-safelisted header the browser sends automatically) — this
 * module itself has no knowledge of HTTP.
 */

/** The structured components this feature persists (subset needed to format). */
export interface AddressComponents {
  countryCode: string;
  city: string;
  street: string;
  houseNumber: string;
  postalCode?: string | null;
  region?: string | null;
}

export type FormatLocale = "it" | "en";

/**
 * Renders `a` as a single human-readable string, joining non-empty segments
 * with ", ":
 *   1. `${street} ${houseNumber}`
 *   2. `${postalCode} ${city}` (postalCode omitted if absent) — CH/IT order
 *   3. `region`, only if present
 *   4. the country's display name (Intl.DisplayNames), falling back to the
 *      raw `countryCode` if unavailable (R8) — see {@link countryDisplayName}
 *
 * Never throws.
 */
export function formatAddress(
  a: AddressComponents,
  locale: FormatLocale,
): string {
  const segments: string[] = [];

  const line1 = `${a.street} ${a.houseNumber}`.trim();
  if (line1) segments.push(line1);

  const line2 = [a.postalCode, a.city]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  if (line2) segments.push(line2);

  if (a.region && a.region.trim()) segments.push(a.region.trim());

  segments.push(countryDisplayName(a.countryCode, locale));

  return segments.filter(Boolean).join(", ");
}

/**
 * The country's display name for `countryCode` in `locale`, via
 * `Intl.DisplayNames({type:'region'})`. Falls back to the raw `countryCode`
 * when the API is unavailable (older/limited ICU builds — R8), when
 * constructing it throws (e.g. an unrecognized locale), or when `.of()`
 * itself returns `undefined` for an unknown code. Never throws.
 */
function countryDisplayName(countryCode: string, locale: FormatLocale): string {
  if (
    typeof Intl === "undefined" ||
    typeof Intl.DisplayNames !== "function"
  ) {
    return countryCode;
  }

  try {
    const displayNames = new Intl.DisplayNames([locale], { type: "region" });
    return displayNames.of(countryCode) ?? countryCode;
  } catch {
    return countryCode;
  }
}

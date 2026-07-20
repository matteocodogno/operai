/**
 * Pure, DB-free mapping + micros<->decimal-string conversion for the
 * mileage-rate management surface (T4, specs/009-mileage-rate, ADR-0025).
 */

import { ENTITY_CURRENCY, type CurrencyValue, type EntityValue } from "../requests/requests.schemas";
import { resolveEffectiveRate } from "./resolve";
import type { RateEntryRow } from "./repo";
import type {
  EntityRateHistory,
  RateEntryResponse,
  RateHistoryResponse,
} from "./schemas";

// ─── micros <-> decimal string (ADR-0025 — exact, no float multiplication) ──

/**
 * Parses a validated decimal string (`AddRateBodySchema`'s `ratePerKm`,
 * already regex-shaped to <=6 fractional digits) into integer micros.
 * String-based (not `Number(x) * 1e6`) so the conversion is exact — no
 * floating-point representation error can enter (ADR-0025 point 4).
 */
export function decimalToMicros(decimal: string): number {
  const [intPart = "0", fracPart = ""] = decimal.split(".");
  const paddedFrac = (fracPart + "000000").slice(0, 6);
  return Number(intPart) * 1_000_000 + Number(paddedFrac);
}

/**
 * Formats integer micros back to a decimal string for display (`ratePerKm`
 * in every rate-entry response) — the exact inverse of `decimalToMicros`,
 * trimmed of trailing zeros but never shorter than 2 decimal places (the
 * minor-unit granularity every currency in the suite shares).
 */
export function microsToDecimalString(micros: number): string {
  const major = Math.trunc(micros / 1_000_000);
  const fracMicros = micros - major * 1_000_000;
  const rawFrac = String(fracMicros).padStart(6, "0").replace(/0+$/, "");
  const frac = rawFrac.length < 2 ? rawFrac.padEnd(2, "0") : rawFrac;
  return `${major}.${frac}`;
}

// ─── Response mapping (AC-4.1, AC-4.3, AC-5.3) ─────────────────────────────

export function mapRateEntry(entry: RateEntryRow, inEffectToday: boolean): RateEntryResponse {
  return {
    id: entry.id,
    ratePerKmMicros: entry.ratePerKmMicros,
    ratePerKm: microsToDecimalString(entry.ratePerKmMicros),
    validFrom: entry.validFrom,
    createdAt: entry.createdAt.toISOString(),
    createdByEmail: entry.createdByEmail,
    inEffectToday,
  };
}

const ENTITY_ORDER: readonly EntityValue[] = ["welld_ch", "welld_it"];

/**
 * Groups the full, unfiltered rate-entry set into per-entity history
 * (AC-4.1), each chronological (oldest -> newest), each flagging the entry
 * "in effect as of today" (AC-4.3) — computed via the SAME
 * `resolveEffectiveRate` the rest of the feature resolves against, so the
 * admin screen's highlight can never desync from actual resolution
 * behavior. An entity with zero entries still appears, with its designated
 * currency (`ENTITY_CURRENCY`) and an empty history — mirrors plan.md's
 * worked example (`welld_it` with `entries: []`).
 */
export function mapRateHistoryResponse(
  allEntries: readonly RateEntryRow[],
  todayIso: string,
): RateHistoryResponse {
  const entities: EntityRateHistory[] = ENTITY_ORDER.map((entity) => {
    const entriesForEntity = allEntries
      .filter((e) => e.entity === entity)
      .sort((a, b) => (a.createdAt.getTime() === b.createdAt.getTime()
        ? 0
        : a.createdAt.getTime() - b.createdAt.getTime()));
    const current = resolveEffectiveRate(entriesForEntity, entity, todayIso);
    return {
      entity,
      currency: ENTITY_CURRENCY[entity] as CurrencyValue,
      currentEntryId: current?.id ?? null,
      entries: entriesForEntity.map((e) => mapRateEntry(e, e.id === current?.id)),
    };
  });
  return { entities };
}

/**
 * Pure, DB-free normalization + response mapping for the refund-settings
 * surface (T3, specs/011-refund-settings, plan.md § API contracts).
 */

import type { SettingRow } from "./repo";
import type { SettingResponse } from "./schemas";

/**
 * `""` (empty string, the clear action) normalizes to `null` (AC-1.4). Any
 * other string passes through unchanged for the registry's `validate` to
 * inspect (AC-1.3). `null` stays `null`.
 */
export function normalizeSettingValue(value: string | null): string | null {
  if (value === null) return null;
  return value === "" ? null : value;
}

/** Whether `normalized` is a no-op relative to the setting's CURRENT value (AC-5.4) — both `null` counts as equal. */
export function isNoOpValue(normalized: string | null, current: string | null): boolean {
  return normalized === current;
}

/**
 * Maps a setting key's FULL chronological history (oldest -> newest,
 * settings/repo.ts's `listSettingHistory`) to the shared GET/PUT response
 * shape. "Current" is derived as the LAST row (D1/D3, ADR-0013/0024
 * lineage) — an empty history means never configured (`configured: false`,
 * `value: null`, `updatedAt/updatedByEmail: null`, `history: []`).
 */
export function mapSettingResponse(
  key: string,
  history: readonly SettingRow[],
): SettingResponse {
  const latest = history.length > 0 ? history[history.length - 1]! : null;
  return {
    key,
    value: latest?.value ?? null,
    configured: latest !== null && latest.value !== null,
    updatedAt: latest?.createdAt.toISOString() ?? null,
    updatedByEmail: latest?.createdByEmail ?? null,
    history: history.map((row) => ({
      value: row.value,
      changedAt: row.createdAt.toISOString(),
      changedByEmail: row.createdByEmail,
    })),
  };
}

/** The CURRENT value of a key given its full history — the same "latest row" derivation `mapSettingResponse` uses, exposed standalone for the no-op check (PUT) and the batch-email live-resolution read path (T4). */
export function currentValue(history: readonly SettingRow[]): string | null {
  return history.length > 0 ? history[history.length - 1]!.value : null;
}

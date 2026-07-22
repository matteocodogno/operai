/**
 * Prisma data-access layer for the append-only `refund_setting` key/value
 * store (T3, specs/011-refund-settings, plan.md § Data model, ADR-0027).
 *
 * `refund_setting` is append-only (AC-5.2, the DB-level trigger added by
 * T2's migration) — this module intentionally offers no update/delete
 * function; the enforcement backstop lives at the database layer, not here.
 *
 * The CURRENT value of a key is DERIVED ON READ as the latest row for that
 * key (D1/D3, ADR-0013/0024 lineage) — `listSettingHistory` fetches the FULL
 * chronological history and the caller (settings/service.ts) derives
 * "current" as the last element, exactly mirroring `rates/repo.ts` +
 * `rates/service.ts`'s split.
 */

import { Effect } from "effect";
import { db } from "../lib/db";
import { DatabaseError } from "../lib/errors";

const toDbErr = (message: string) => (cause: unknown) =>
  new DatabaseError({ message, cause });

export interface SettingRow {
  readonly id: string;
  readonly key: string;
  readonly value: string | null;
  readonly createdByUserId: string;
  readonly createdByEmail: string;
  readonly createdAt: Date;
}

const settingSelect = {
  id: true,
  key: true,
  value: true,
  createdByUserId: true,
  createdByEmail: true,
  createdAt: true,
} as const;

/**
 * Full chronological history (oldest → newest) for one setting `key` — the
 * empty array means the key has never been set (AC-1.1's "not configured,
 * no history" case). Backs BOTH `GET /settings/:key` (AC-1.1/5.3) and
 * `PUT /settings/:key`'s no-op-detection read (AC-5.4) — a SINGLE query
 * shape so "current value" can never desync between the two routes.
 */
export function listSettingHistory(
  key: string,
): Effect.Effect<SettingRow[], DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundSetting.findMany({
        where: { key },
        orderBy: { createdAt: "asc" },
        select: settingSelect,
      }),
    catch: toDbErr("Failed to list refund setting history"),
  });
}

/**
 * The CURRENT value of one setting `key` — a single query, ordered so the
 * last row IS the current value (avoids fetching the full history when only
 * the live value is needed). Used by `batches/email.ts` (T4) to resolve the
 * `accounting-distribution-email` setting live at EVERY send/resend attempt
 * (D6, ADR-0029) — this is the ONE place that read happens, so "live" can
 * never mean two different things across the send path.
 */
export function fetchCurrentSettingValue(
  key: string,
): Effect.Effect<string | null, DatabaseError> {
  return Effect.tryPromise({
    try: async () => {
      const row = await db.refundSetting.findFirst({
        where: { key },
        orderBy: { createdAt: "desc" },
        select: { value: true },
      });
      return row?.value ?? null;
    },
    catch: toDbErr("Failed to fetch current refund setting value"),
  });
}

export interface AppendSettingInput {
  readonly key: string;
  readonly value: string | null;
  readonly createdByUserId: string;
  readonly createdByEmail: string;
}

/** Appends one immutable settings-change row (AC-1.2/1.4/5.1). */
export function appendSettingEntry(
  input: AppendSettingInput,
): Effect.Effect<SettingRow, DatabaseError> {
  return Effect.tryPromise({
    try: () =>
      db.refundSetting.create({
        data: {
          key: input.key,
          value: input.value,
          createdByUserId: input.createdByUserId,
          createdByEmail: input.createdByEmail,
        },
        select: settingSelect,
      }),
    catch: toDbErr("Failed to append refund setting entry"),
  });
}

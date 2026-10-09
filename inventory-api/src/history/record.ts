/**
 * The asset history recorder (T9, specs/015-hardware-inventory; AC-11.1,
 * AC-11.2, AC-11.3; plan.md "AssetEvent", design G2).
 *
 * Every mutating route calls `recordEvent` INSIDE its own transaction, so the
 * change and its history entry commit or fail together — there is no mutation
 * without an event and no event for a mutation that rolled back. The table is
 * append-only at the database (T2's trigger), so this is the only write path
 * there will ever be.
 *
 * Typed changes. The UI renders `field: from → to` from
 * `changes: {field, from, to}[]` (inventory-ui `HistoryEvent`), and the model
 * stores a pair of JSON columns, `oldValue` and `newValue`. They are reconciled
 * as two objects keyed by field name:
 *
 *     changes [{field:"status", from:"in_stock", to:"assigned"},
 *              {field:"holder", from:null,        to:"user-7"}]
 *   → oldValue {"status":"in_stock","holder":null}
 *     newValue {"status":"assigned","holder":"user-7"}
 *
 * and `eventChanges(oldValue, newValue)` puts them back together for the
 * history route (T22). Values are primitives only — strings (ISO dates, enum
 * names, user ids), integer cents, booleans, null. The `holder` field carries
 * the raw auth user id; T22 swaps those for `Identity` objects at read time, so
 * a renamed or deleted person is never frozen into the history.
 *
 * Field order is not preserved (JSONB sorts its keys); `eventChanges` returns
 * them sorted by field name so the output is deterministic.
 */

import type { Tx } from "../fiscal-years/guard";

/** Mirrors the `AssetEventAction` enum. */
export type AssetEventAction =
  | "registered"
  | "received"
  | "edited"
  | "assignment_created"
  | "assignment_confirmed"
  | "assignment_declined"
  | "assignment_cancelled"
  | "returned"
  | "repair_started"
  | "repair_finished"
  | "marked_lost"
  | "marked_found"
  | "disposed"
  | "invoice_file_linked"
  | "verified"
  | "fiscal_year_closed"
  | "imported";

export type ChangeValue = string | number | boolean | null;

export interface Change {
  readonly field: string;
  readonly from: ChangeValue;
  readonly to: ChangeValue;
}

export interface RecordEventInput {
  /** `null` only for `fiscal_year_closed`, which belongs to an entity, not an asset. */
  readonly assetId: string | null;
  readonly entity: "welld_ch" | "welld_it";
  readonly action: AssetEventAction;
  /** The caller's verified `sub` and `email` (`system:legacy-import` for the import). */
  readonly actor: { readonly userId: string; readonly email: string };
  readonly changes?: readonly Change[];
}

export interface RecordedEvent {
  readonly id: string;
  readonly createdAt: Date;
}

const isPrimitive = (value: unknown): value is ChangeValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/**
 * Appends one `asset_event` row through `tx`. Changes whose `from` equals their
 * `to` are dropped (they changed nothing, and a history line that says
 * "Supplier: Acme → Acme" is noise); the event itself is always written, since
 * the request still happened.
 *
 * Throws on a programming error rather than writing an entry that would
 * mislead later: an asset event with no asset, a repeated field, a field name
 * that is empty, a value that is not a plain primitive.
 */
export async function recordEvent(
  tx: Tx,
  input: RecordEventInput,
): Promise<RecordedEvent> {
  if (input.assetId === null && input.action !== "fiscal_year_closed") {
    throw new Error(
      `recordEvent: "${input.action}" needs an assetId (only fiscal_year_closed has none)`,
    );
  }
  if (input.actor.userId.trim() === "") {
    throw new Error("recordEvent: the actor needs a user id");
  }

  const before: [string, ChangeValue][] = [];
  const after: [string, ChangeValue][] = [];
  const seen = new Set<string>();

  for (const change of input.changes ?? []) {
    if (change.field.trim() === "") {
      throw new Error("recordEvent: a change needs a field name");
    }
    if (seen.has(change.field)) {
      throw new Error(`recordEvent: field "${change.field}" is changed twice in one event`);
    }
    seen.add(change.field);
    if (!isPrimitive(change.from) || !isPrimitive(change.to)) {
      throw new Error(
        `recordEvent: field "${change.field}" must change between plain values (string, number, boolean or null)`,
      );
    }
    if (change.from === change.to) continue;
    before.push([change.field, change.from]);
    after.push([change.field, change.to]);
  }

  const row = await tx.assetEvent.create({
    data: {
      assetId: input.assetId,
      entity: input.entity,
      action: input.action,
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      // Omitted (NULL) when there is nothing to say.
      ...(before.length > 0
        ? {
            oldValue: Object.fromEntries(before),
            newValue: Object.fromEntries(after),
          }
        : {}),
    },
    select: { id: true, createdAt: true },
  });
  return row;
}

/**
 * Reassembles the typed `changes` of a stored event from its `oldValue` and
 * `newValue` columns: every field present in either, sorted by name, a field
 * missing on one side read as `null`. Anything that is not a plain-object
 * column (NULL, or a value this recorder did not write) yields no changes.
 */
export function eventChanges(oldValue: unknown, newValue: unknown): Change[] {
  const before = asRecord(oldValue);
  const after = asRecord(newValue);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields.map((field) => ({
    field,
    from: primitiveOrNull(before[field]),
    to: primitiveOrNull(after[field]),
  }));
}

/**
 * The `changes` of an edit: one entry for each of `fields` whose value differs
 * between `before` and `after`. Values must already be in their stored form
 * (dates as `YYYY-MM-DD`, not `Date`). Callers pass the field list explicitly,
 * so a column that must never reach the history (or that is not part of the
 * edit) cannot leak in by accident.
 */
export function diffChanges<T extends Record<string, ChangeValue | undefined>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): Change[] {
  const changes: Change[] = [];
  for (const field of fields) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function primitiveOrNull(value: unknown): ChangeValue {
  return isPrimitive(value) ? value : null;
}

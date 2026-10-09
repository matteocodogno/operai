/**
 * The history recorder (T9, specs/015-hardware-inventory; AC-11.1, AC-11.2).
 * Real Postgres: the guarantees are "same transaction" and "append-only",
 * which only the database can show.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { db } from "../lib/db";
import { truncateInventoryTables } from "../test-support/dbCleanup";
import { diffChanges, eventChanges, recordEvent, type RecordEventInput } from "./record";

const ACTOR = { userId: "manager-1", email: "manager@welld.ch" };

const base = (over: Partial<RecordEventInput> = {}): RecordEventInput => ({
  assetId: "asset-1",
  entity: "welld_ch",
  action: "edited",
  actor: ACTOR,
  ...over,
});

const record = (input: RecordEventInput) =>
  db.$transaction((tx) => recordEvent(tx, input));

beforeEach(async () => {
  await truncateInventoryTables();
});
afterAll(async () => {
  await truncateInventoryTables();
});

describe("recordEvent", () => {
  it("stores the typed changes as an oldValue/newValue pair keyed by field", async () => {
    const { id } = await record(
      base({
        action: "assignment_confirmed",
        changes: [
          { field: "status", from: "in_stock", to: "assigned" },
          { field: "holder", from: null, to: "user-7" },
        ],
      }),
    );
    const row = await db.assetEvent.findUniqueOrThrow({ where: { id } });
    expect(row.action).toBe("assignment_confirmed");
    expect(row.assetId).toBe("asset-1");
    expect(row.entity).toBe("welld_ch");
    expect(row.actorUserId).toBe("manager-1");
    expect(row.actorEmail).toBe("manager@welld.ch");
    expect(row.oldValue).toEqual({ status: "in_stock", holder: null });
    expect(row.newValue).toEqual({ status: "assigned", holder: "user-7" });
  });

  it("round-trips through eventChanges to exactly the shape the UI renders", async () => {
    const { id } = await record(
      base({
        changes: [
          { field: "purchasePriceCents", from: 99815, to: 120000 },
          { field: "toVerify", from: true, to: false },
          { field: "supplier", from: null, to: "Apple" },
          { field: "purchaseDate", from: "2026-03-01", to: "2026-03-02" },
        ],
      }),
    );
    const row = await db.assetEvent.findUniqueOrThrow({ where: { id } });
    expect(eventChanges(row.oldValue, row.newValue)).toEqual([
      { field: "purchaseDate", from: "2026-03-01", to: "2026-03-02" },
      { field: "purchasePriceCents", from: 99815, to: 120000 },
      { field: "supplier", from: null, to: "Apple" },
      { field: "toVerify", from: true, to: false },
    ]);
  });

  it("an event with no changes stores NULL columns, and reads back as no changes", async () => {
    const { id } = await record(base({ action: "assignment_declined" }));
    const row = await db.assetEvent.findUniqueOrThrow({ where: { id } });
    expect(row.oldValue).toBeNull();
    expect(row.newValue).toBeNull();
    expect(eventChanges(row.oldValue, row.newValue)).toEqual([]);
  });

  it("drops a change whose from equals its to, but still records the event", async () => {
    const { id } = await record(
      base({
        changes: [
          { field: "supplier", from: "Acme", to: "Acme" },
          { field: "description", from: "A", to: "B" },
        ],
      }),
    );
    const row = await db.assetEvent.findUniqueOrThrow({ where: { id } });
    expect(eventChanges(row.oldValue, row.newValue)).toEqual([
      { field: "description", from: "A", to: "B" },
    ]);

    const noop = await record(base({ changes: [{ field: "supplier", from: "Acme", to: "Acme" }] }));
    const noopRow = await db.assetEvent.findUniqueOrThrow({ where: { id: noop.id } });
    expect(noopRow.oldValue).toBeNull();
  });

  it("fiscal_year_closed is the one event allowed no asset", async () => {
    const { id } = await record(
      base({
        assetId: null,
        action: "fiscal_year_closed",
        changes: [{ field: "year", from: null, to: 2025 }],
      }),
    );
    const row = await db.assetEvent.findUniqueOrThrow({ where: { id } });
    expect(row.assetId).toBeNull();
    expect(row.newValue).toEqual({ year: 2025 });
  });

  it("refuses an asset event with no asset, and writes nothing", async () => {
    await expect(record(base({ assetId: null, action: "edited" }))).rejects.toThrow(
      /needs an assetId/,
    );
    expect(await db.assetEvent.count()).toBe(0);
  });

  it("refuses a repeated field, an empty field name and a non-primitive value", async () => {
    await expect(
      record(
        base({
          changes: [
            { field: "status", from: "a", to: "b" },
            { field: "status", from: "b", to: "c" },
          ],
        }),
      ),
    ).rejects.toThrow(/changed twice/);
    await expect(record(base({ changes: [{ field: " ", from: 1, to: 2 }] }))).rejects.toThrow(
      /field name/,
    );
    await expect(
      record(base({ changes: [{ field: "x", from: { a: 1 } as never, to: 2 }] })),
    ).rejects.toThrow(/plain values/);
    await expect(
      record(base({ changes: [{ field: "x", from: 1, to: Number.NaN }] })),
    ).rejects.toThrow(/plain values/);
    expect(await db.assetEvent.count()).toBe(0);
  });

  it("refuses an actor without a user id", async () => {
    await expect(record(base({ actor: { userId: " ", email: "x@welld.ch" } }))).rejects.toThrow(
      /actor/,
    );
  });

  it("is part of the caller's transaction: it rolls back with it (AC-11.1)", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await recordEvent(tx, base({ changes: [{ field: "x", from: 1, to: 2 }] }));
        throw new Error("the mutation failed");
      }),
    ).rejects.toThrow("the mutation failed");
    expect(await db.assetEvent.count()).toBe(0);
  });

  it("and commits with it", async () => {
    await db.$transaction(async (tx) => {
      await recordEvent(tx, base({ action: "registered" }));
      await recordEvent(tx, base({ action: "received" }));
    });
    expect(await db.assetEvent.count()).toBe(2);
  });

  it("what it wrote cannot be changed afterwards (AC-11.2)", async () => {
    const { id } = await record(base({ changes: [{ field: "x", from: 1, to: 2 }] }));
    await expect(
      Promise.resolve(
        db.$executeRawUnsafe(`UPDATE "asset_event" SET "actorEmail" = 'x' WHERE id = $1`, id),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      Promise.resolve(db.$executeRawUnsafe(`DELETE FROM "asset_event" WHERE id = $1`, id)),
    ).rejects.toThrow(/append-only/);
  });

  it("records the system actor of the legacy import", async () => {
    const { id } = await record(
      base({ action: "imported", actor: { userId: "system:legacy-import", email: "system:legacy-import" } }),
    );
    const row = await db.assetEvent.findUniqueOrThrow({ where: { id } });
    expect(row.actorUserId).toBe("system:legacy-import");
  });
});

describe("eventChanges", () => {
  it("reads a field present on only one side as null on the other", () => {
    expect(eventChanges({ a: 1 }, { b: 2 })).toEqual([
      { field: "a", from: 1, to: null },
      { field: "b", from: null, to: 2 },
    ]);
  });

  it("tolerates columns it did not write", () => {
    expect(eventChanges(null, null)).toEqual([]);
    expect(eventChanges([1, 2], "x")).toEqual([]);
    expect(eventChanges({ a: { nested: true } }, { a: 1 })).toEqual([
      { field: "a", from: null, to: 1 },
    ]);
  });
});

describe("diffChanges", () => {
  it("lists only the listed fields whose value differs, null for absent", () => {
    type Row = { description: string; supplier: string | null; locationNote: string; purchasePriceCents: number };
    const before: Row = { description: "A", supplier: null, locationNote: "x", purchasePriceCents: 100 };
    const after: Row = { description: "B", supplier: "Acme", locationNote: "x", purchasePriceCents: 100 };
    expect(
      diffChanges(before, after, ["description", "supplier", "locationNote"]),
    ).toEqual([
      { field: "description", from: "A", to: "B" },
      { field: "supplier", from: null, to: "Acme" },
    ]);
  });

  it("ignores a changed field that was not asked for", () => {
    expect(
      diffChanges({ a: 1, b: 1 }, { a: 2, b: 2 }, ["a"]),
    ).toEqual([{ field: "a", from: 1, to: 2 }]);
  });

  it("treats undefined and null as the same absence", () => {
    expect(
      diffChanges<{ s?: string | null }>({}, { s: null }, ["s"]),
    ).toEqual([]);
  });
});

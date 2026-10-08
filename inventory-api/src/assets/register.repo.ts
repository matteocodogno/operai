/**
 * Registering assets (T11, specs/015; AC-1.1..1.7, AC-10.2).
 *
 * One transaction per request: entity lock, closed-year check, serial check,
 * every asset row and its `registered` event. Any throw rolls the lot back, so a
 * conflict on the last unit leaves nothing behind.
 */

import { db } from "../lib/db";
import { conflict } from "../lib/problem";
import { assertYearOpen, lockEntity, yearOf } from "../fiscal-years/guard";
import { recordEvent } from "../history/record";
import { splitPrice } from "../depreciation/money";
import type { Asset } from "../lib/generated/prisma/client";
import type { RegisterBody } from "./register.schemas";

export interface RegisterInput {
  readonly body: RegisterBody;
  readonly purchaseDate: Date;
  readonly serialNumbers: readonly string[];
  readonly actor: { readonly userId: string; readonly email: string };
}

const CURRENCY = { welld_ch: "CHF", welld_it: "EUR" } as const;

/** The live (non-disposed) asset of `entity` already holding one of `serials`. */
async function findLiveSerial(
  client: Pick<typeof db, "asset">,
  entity: "welld_ch" | "welld_it",
  serials: readonly string[],
): Promise<{ id: string; serialNumber: string } | null> {
  if (serials.length === 0) return null;
  const row = await client.asset.findFirst({
    where: { entity, serialNumber: { in: [...serials] }, status: { not: "disposed" } },
    select: { id: true, serialNumber: true },
    orderBy: { createdAt: "asc" },
  });
  return row && row.serialNumber ? { id: row.id, serialNumber: row.serialNumber } : null;
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

export async function registerAssets(input: RegisterInput): Promise<Asset[]> {
  const { body, purchaseDate, serialNumbers, actor } = input;
  const prices = splitPrice(body.totalPriceCents, body.quantity);
  const status = body.received ? "in_stock" : "ordered";

  // Duplicates inside the request cannot be caught by the database until the
  // second insert, and have no existing asset to point at.
  const seen = new Set<string>();
  for (const serial of serialNumbers) {
    if (seen.has(serial)) {
      throw conflict("serial_conflict", `Serial number ${serial} appears more than once`, {
        serialNumber: serial,
      });
    }
    seen.add(serial);
  }

  try {
    return await db.$transaction(
      async (tx) => {
        await lockEntity(tx, body.entity);
        await assertYearOpen(tx, body.entity, yearOf(purchaseDate));

        const existing = await findLiveSerial(tx, body.entity, serialNumbers);
        if (existing) {
          throw conflict(
            "serial_conflict",
            `Serial number ${existing.serialNumber} is already registered`,
            { serialNumber: existing.serialNumber, assetId: existing.id },
          );
        }

        const created: Asset[] = [];
        for (let i = 0; i < body.quantity; i++) {
          const serialNumber = serialNumbers[i] ?? null;
          const price = prices[i]!;
          const asset = await tx.asset.create({
            data: {
              entity: body.entity,
              currency: CURRENCY[body.entity],
              category: body.category,
              description: body.description,
              serialNumber,
              purchaseDate,
              purchasePriceCents: price,
              status,
              locationNote: body.locationNote ?? null,
              supplier: body.supplier ?? null,
              invoiceRef: body.invoiceRef ?? null,
              createdByUserId: actor.userId,
            },
          });
          await recordEvent(tx, {
            assetId: asset.id,
            entity: body.entity,
            action: "registered",
            actor,
            changes: [
              { field: "status", from: null, to: status },
              { field: "purchaseDate", from: null, to: body.purchaseDate },
              { field: "purchasePriceCents", from: null, to: price },
              { field: "serialNumber", from: null, to: serialNumber },
            ],
          });
          created.push(asset);
        }
        return created;
      },
      { timeout: 20_000 },
    );
  } catch (err) {
    // A writer that did not take the entity lock (an edit) can still win the
    // race for a serial; the partial unique index is the backstop (AC-1.5).
    if (isUniqueViolation(err)) {
      const clash = await findLiveSerial(db, body.entity, serialNumbers);
      throw conflict(
        "serial_conflict",
        clash ? `Serial number ${clash.serialNumber} is already registered` : "A serial number is already registered",
        clash ? { serialNumber: clash.serialNumber, assetId: clash.id } : {},
      );
    }
    throw err;
  }
}

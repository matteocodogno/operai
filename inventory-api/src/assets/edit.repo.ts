/**
 * Editing an asset (T13, specs/015; AC-1.9, AC-3.6, AC-5.9, AC-10.1, AC-11.1).
 *
 * One transaction: [entity lock if price/date], asset row lock, fresh read,
 * guards, update, history. Any throw rolls the lot back.
 */

import { db } from "../lib/db";
import { conflict, notFound } from "../lib/problem";
import { assertYearOpen, lockEntity, yearOf, type Tx } from "../fiscal-years/guard";
import { diffChanges, recordEvent, type AssetEventAction } from "../history/record";
import { formatDate, parseIsoDate } from "../depreciation/rules.schemas";
import { lockAsset } from "./lockAsset";
import { ASSET_INCLUDE } from "./view";
import type { EditBody } from "./edit.schemas";

type Entity = "welld_ch" | "welld_it";

export interface EditInput {
  readonly id: string;
  readonly body: EditBody;
  readonly actor: { readonly userId: string; readonly email: string };
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

/** The live asset OTHER than `exceptId` that holds `serial` in `entity`. */
async function findLiveSerial(
  client: Pick<typeof db, "asset">,
  entity: Entity,
  serial: string,
  exceptId: string,
): Promise<{ id: string } | null> {
  return client.asset.findFirst({
    where: { entity, serialNumber: serial, status: { not: "disposed" }, id: { not: exceptId } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Applies the edit; returns the asset id (the route re-reads the view). */
export async function editAsset(input: EditInput): Promise<string> {
  const { id, body, actor } = input;
  const wantsDated = body.purchaseDate !== undefined || body.purchasePriceCents !== undefined;

  let entity: Entity | null = null;
  try {
    await db.$transaction(
      async (tx: Tx) => {
        const pre = await tx.asset.findUnique({ where: { id }, select: { entity: true } });
        if (!pre) throw notFound("Asset not found");
        entity = pre.entity;

        // Entity lock FIRST (ADR-0046), then the row: a close in flight must
        // commit before this edit reads the closed boundary.
        if (wantsDated) await lockEntity(tx, pre.entity);
        await lockAsset(tx, id);

        const cur = await tx.asset.findUnique({ where: { id }, include: ASSET_INCLUDE });
        if (!cur) throw notFound("Asset not found");
        if (cur.status === "disposed") {
          throw conflict("asset_disposed", "A disposed asset can no longer be edited", { assetId: id });
        }

        const newDate = body.purchaseDate !== undefined ? parseIsoDate(body.purchaseDate)! : cur.purchaseDate;
        const newPrice = body.purchasePriceCents ?? cur.purchasePriceCents;
        const dateChanged = formatDate(newDate) !== formatDate(cur.purchaseDate);
        const priceChanged = newPrice !== cur.purchasePriceCents;
        if (dateChanged || priceChanged) {
          // Closed years are a prefix, so "any year from the purchase year on
          // is closed" is "the purchase year is closed" — for the old date
          // (the schedule being rewritten) and for the new one.
          await assertYearOpen(tx, cur.entity, yearOf(cur.purchaseDate));
          if (dateChanged) await assertYearOpen(tx, cur.entity, yearOf(newDate));
        }

        if (body.serialNumber !== undefined && body.serialNumber !== null && body.serialNumber !== cur.serialNumber) {
          const clash = await findLiveSerial(tx, cur.entity, body.serialNumber, id);
          if (clash) {
            throw conflict("serial_conflict", `Serial number ${body.serialNumber} is already registered`, {
              serialNumber: body.serialNumber,
              assetId: clash.id,
            });
          }
        }

        const next = {
          category: body.category ?? cur.category,
          description: body.description ?? cur.description,
          serialNumber: body.serialNumber !== undefined ? body.serialNumber : cur.serialNumber,
          locationNote: body.locationNote !== undefined ? body.locationNote : cur.locationNote,
          supplier: body.supplier !== undefined ? body.supplier : cur.supplier,
          invoiceRef: body.invoiceRef !== undefined ? body.invoiceRef : cur.invoiceRef,
          toVerify: body.toVerify ?? cur.toVerify,
          purchaseDate: formatDate(newDate),
          purchasePriceCents: newPrice,
        };
        const before = { ...next, ...snapshot(cur) };
        const fields = Object.keys(next) as (keyof typeof next & string)[];
        const changes = diffChanges(before, next, fields);
        if (changes.length === 0) return;

        const invoiceRefChanged = changes.some((c) => c.field === "invoiceRef");
        const unlinking = invoiceRefChanged && cur.invoiceFileId !== null;

        await tx.asset.update({
          where: { id },
          data: {
            category: next.category,
            description: next.description,
            serialNumber: next.serialNumber,
            locationNote: next.locationNote,
            supplier: next.supplier,
            invoiceRef: next.invoiceRef,
            toVerify: next.toVerify,
            purchaseDate: newDate,
            purchasePriceCents: next.purchasePriceCents,
            ...(unlinking ? { invoiceFileId: null } : {}),
          },
        });

        const onlyVerified =
          changes.length === 1 && changes[0]!.field === "toVerify" && changes[0]!.to === false;
        const action: AssetEventAction = onlyVerified ? "verified" : "edited";
        await recordEvent(tx, { assetId: id, entity: cur.entity, action, actor, changes });
        if (unlinking) {
          await recordEvent(tx, {
            assetId: id,
            entity: cur.entity,
            action: "invoice_file_linked",
            actor,
            changes: [{ field: "invoiceFile", from: cur.invoiceFile?.fileName ?? cur.invoiceFileId, to: null }],
          });
        }
      },
      { timeout: 20_000 },
    );
  } catch (err) {
    // The partial unique index is the backstop for a writer that committed the
    // same serial between our check and our update (AC-1.5).
    if (isUniqueViolation(err) && entity !== null && body.serialNumber) {
      const clash = await findLiveSerial(db, entity, body.serialNumber, id);
      throw conflict(
        "serial_conflict",
        `Serial number ${body.serialNumber} is already registered`,
        clash ? { serialNumber: body.serialNumber, assetId: clash.id } : { serialNumber: body.serialNumber },
      );
    }
    throw err;
  }
  return id;
}

/** The editable columns of a row in their history form. */
function snapshot(row: {
  category: string;
  description: string;
  serialNumber: string | null;
  locationNote: string | null;
  supplier: string | null;
  invoiceRef: string | null;
  toVerify: boolean;
  purchaseDate: Date;
  purchasePriceCents: number;
}) {
  return {
    category: row.category,
    description: row.description,
    serialNumber: row.serialNumber,
    locationNote: row.locationNote,
    supplier: row.supplier,
    invoiceRef: row.invoiceRef,
    toVerify: row.toVerify,
    purchaseDate: formatDate(row.purchaseDate),
    purchasePriceCents: row.purchasePriceCents,
  };
}

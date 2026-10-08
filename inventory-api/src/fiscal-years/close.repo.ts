/**
 * Closing a fiscal year (T20, specs/015-hardware-inventory; AC-8.4..AC-8.7,
 * AC-11.1, ADR-0046). The ONE write that materialises figures.
 *
 * One transaction, under the entity advisory lock (`lockEntity`), which every
 * dated write (register, price/date edit, dispose, rule) takes too: a write
 * that got there first has committed and is in the figures computed below; one
 * that gets there second waits, then finds the year closed and is refused.
 * Inside it:
 *
 *   1. verify the sequence - already closed, nothing to close, previous year
 *      still open - against the boundary as it stands UNDER the lock;
 *   2. compute the year with the same builder the open-year view uses, so what
 *      is stored is exactly what the accountant saw before pressing Close;
 *   3. insert one `asset_year_figure` per asset on the books (an asset with
 *      nothing in the year - disposed or written off earlier - has no row, and
 *      "no row" reads as zero), then the `fiscal_year` row (its existence IS the
 *      closed state), then the `fiscal_year_closed` event.
 *
 * Both tables are immutable at the database (Tier 1), and there is no reopen:
 * a wrong closed year is corrected in the open one.
 */

import { db } from "../lib/db";
import { conflict } from "../lib/problem";
import type { Entity } from "../authz/conditions";
import { recordEvent } from "../history/record";
import { lockEntity, type Tx } from "./guard";
import { loadEntityContext } from "./read.repo";
import { statementOf } from "./read.routes";
import { firstYearOf, isClosable } from "./rollForward";

export interface CloseInput {
  readonly entity: Entity;
  readonly year: number;
  readonly actor: { readonly userId: string; readonly email: string };
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

export async function closeYear({ entity, year, actor }: CloseInput): Promise<void> {
  try {
    await db.$transaction(
      async (tx: Tx) => {
        await lockEntity(tx, entity);
        const ctx = await loadEntityContext(tx, entity);

        if (ctx.lastClosedYear !== null && year <= ctx.lastClosedYear) {
          throw conflict("already_closed", `Fiscal year ${year} is already closed`);
        }
        const first = firstYearOf({
          assets: ctx.assets,
          stored: ctx.stored,
          closedYears: ctx.fiscalYears.map((f) => f.year),
          lastClosedYear: ctx.lastClosedYear,
        });
        if (first === null || year < first) {
          throw conflict("nothing_to_close", `There is nothing to close in ${year}: no asset was on the books by then`);
        }
        if (!isClosable(year, ctx.lastClosedYear, first)) {
          throw conflict("previous_year_open", `Close fiscal year ${year - 1} first`);
        }

        const { lines, rows } = statementOf(ctx, year);

        if (rows.length > 0) {
          await tx.assetYearFigure.createMany({
            data: rows.map((r) => ({
              assetId: r.assetId,
              entity,
              year,
              openingCents: r.openingCents,
              purchaseCents: r.purchaseCents,
              depreciationCents: r.depreciationCents,
              disposalCents: r.disposalCents,
              closingCents: r.closingCents,
              source: "closed" as const,
            })),
          });
        }
        await tx.fiscalYear.create({
          data: {
            entity,
            year,
            openingCents: lines.openingCents,
            disposalsCents: lines.disposalsCents,
            purchasesCents: lines.purchasesCents,
            depreciationCents: lines.depreciationCents,
            closingCents: lines.closingCents,
            source: "closed",
            closedByUserId: actor.userId,
          },
        });
        await recordEvent(tx, {
          assetId: null,
          entity,
          action: "fiscal_year_closed",
          actor,
          changes: [{ field: "year", from: null, to: year }],
        });
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    // Backstop for the (entity, year) unique key: a writer that closed it between
    // our read and our insert (the lock makes this unreachable, but never a duplicate).
    if (isUniqueViolation(err)) {
      const exists = await db.fiscalYear.findFirst({ where: { entity, year }, select: { id: true } });
      if (exists) throw conflict("already_closed", `Fiscal year ${year} is already closed`);
    }
    throw err;
  }
}

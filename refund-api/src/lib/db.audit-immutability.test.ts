/**
 * Audit-trail immutability integration tests (T5, specs/007-refund-service,
 * ADR-0018 — refs AC-8.2, AC-8.3).
 *
 * Strategy
 * ────────
 * - Real Postgres (compose, host:5435) — no DB mocking. Exercises the actual
 *   `0001_init` migration's raw-SQL trigger and the `onDelete: Restrict`
 *   foreign key, not application code (there IS no application code for
 *   audit mutation — the whole point is that even a direct-SQL / direct-
 *   Prisma-client write is refused at the database layer).
 * - Cleanup uses `TRUNCATE ... CASCADE`, NOT `DELETE`: TRUNCATE does not fire
 *   row-level `BEFORE DELETE` triggers (only statement-level AFTER TRUNCATE
 *   triggers, which this migration does not define), so it can safely reset
 *   fixture data between test files without being blocked by the very
 *   immutability guarantee under test.
 * - `asPromise()`: Prisma 7's client methods return a lazy `PrismaPromise`
 *   (thenable, but NOT `instanceof Promise`) rather than a native Promise.
 *   `bun:test`'s `expect(...).resolves`/`.rejects` require a real Promise
 *   instance and throw "Expected promise" otherwise — `Promise.resolve()`
 *   normalizes any thenable into a genuine native Promise before assertion.
 *
 * AC coverage
 * ───────────
 * AC-8.2  a raw-SQL UPDATE and a raw-SQL DELETE on "refund_audit_entry" both fail
 * AC-8.3  DELETE on a "refund_request" that has an audit row is refused by the FK
 */

import { describe, it, expect, afterAll } from "bun:test";
import { db } from "./db";
import { Prisma } from "./generated/prisma/client";

const asPromise = <T>(value: PromiseLike<T>): Promise<T> =>
  Promise.resolve(value);

describe("RefundAuditEntry immutability (ADR-0018)", () => {
  afterAll(async () => {
    // TRUNCATE bypasses the row-level BEFORE DELETE trigger (unlike DELETE),
    // so cleanup does not itself get blocked by the guarantee under test.
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "refund_audit_entry", "attachment", "refund_line", "refund_request" RESTART IDENTITY CASCADE',
    );
  });

  it("(AC-8.2) a raw-SQL UPDATE on refund_audit_entry is rejected by the trigger", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "test-owner-audit-update",
        ownerEmail: "owner-update@example.com",
        status: "submitted",
      },
    });

    const entry = await db.refundAuditEntry.create({
      data: {
        requestId: request.id,
        actorUserId: "test-owner-audit-update",
        actorEmail: "owner-update@example.com",
        action: "submitted",
      },
    });

    await expect(
      asPromise(
        db.$executeRawUnsafe(
          `UPDATE "refund_audit_entry" SET "actorEmail" = 'tampered@example.com' WHERE id = $1`,
          entry.id,
        ),
      ),
    ).rejects.toThrow(/append-only/);

    // Prove the row is genuinely untouched, not merely that the promise rejected.
    const reread = await db.refundAuditEntry.findUniqueOrThrow({
      where: { id: entry.id },
    });
    expect(reread.actorEmail).toBe("owner-update@example.com");
  });

  it("(AC-8.2) a raw-SQL DELETE on refund_audit_entry is rejected by the trigger", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "test-owner-audit-delete",
        ownerEmail: "owner-delete@example.com",
        status: "submitted",
      },
    });

    const entry = await db.refundAuditEntry.create({
      data: {
        requestId: request.id,
        actorUserId: "test-owner-audit-delete",
        actorEmail: "owner-delete@example.com",
        action: "submitted",
      },
    });

    await expect(
      asPromise(
        db.$executeRawUnsafe(
          `DELETE FROM "refund_audit_entry" WHERE id = $1`,
          entry.id,
        ),
      ),
    ).rejects.toThrow(/append-only/);

    // Row still exists.
    await expect(
      asPromise(
        db.refundAuditEntry.findUniqueOrThrow({ where: { id: entry.id } }),
      ),
    ).resolves.toBeTruthy();
  });

  it("(AC-8.2) the trigger also blocks the Prisma client's own update()/delete() calls, not just raw SQL", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "test-owner-audit-prisma",
        ownerEmail: "owner-prisma@example.com",
        status: "submitted",
      },
    });

    const entry = await db.refundAuditEntry.create({
      data: {
        requestId: request.id,
        actorUserId: "test-owner-audit-prisma",
        actorEmail: "owner-prisma@example.com",
        action: "submitted",
      },
    });

    // refund-api exposes no update/delete route for audit rows at all (T5+
    // never add one) — this proves that even if a future bug called the
    // Prisma client directly, the database-level trigger still refuses it.
    await expect(
      asPromise(
        db.refundAuditEntry.update({
          where: { id: entry.id },
          data: { actorEmail: "tampered@example.com" },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asPromise(db.refundAuditEntry.delete({ where: { id: entry.id } })),
    ).rejects.toThrow();
  });

  it("(AC-8.3) DELETE on a refund_request that has an audit row is refused by the FK (onDelete: Restrict)", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "test-owner-request-restrict",
        ownerEmail: "owner-restrict@example.com",
        status: "submitted",
      },
    });

    await db.refundAuditEntry.create({
      data: {
        requestId: request.id,
        actorUserId: "test-owner-request-restrict",
        actorEmail: "owner-restrict@example.com",
        action: "submitted",
      },
    });

    let caught: unknown;
    try {
      await db.refundRequest.delete({ where: { id: request.id } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // P2003 = Prisma's foreign-key-constraint-violation code.
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe(
      "P2003",
    );

    // The request must still exist — the delete never happened.
    await expect(
      asPromise(db.refundRequest.findUniqueOrThrow({ where: { id: request.id } })),
    ).resolves.toBeTruthy();
  });

  it("(control) a draft request with NO audit rows CAN be deleted — proves Restrict only blocks requests that actually have audit history", async () => {
    const request = await db.refundRequest.create({
      data: {
        ownerUserId: "test-owner-draft-deletable",
        ownerEmail: "owner-draft@example.com",
        status: "draft",
      },
    });

    await expect(
      asPromise(db.refundRequest.delete({ where: { id: request.id } })),
    ).resolves.toBeTruthy();

    await expect(
      asPromise(db.refundRequest.findUnique({ where: { id: request.id } })),
    ).resolves.toBeNull();
  });
});

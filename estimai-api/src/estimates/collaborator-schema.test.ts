/**
 * Schema/migration tests for EstimateCollaborator + version + lastModifiedByUserId
 * (T4, specs/013-estimate-sharing).
 *
 * Strategy
 * ────────
 * Real Postgres (compose, host:5435, database: estimai) via the same Prisma
 * client the app uses (`@/lib/db`) — no mocking. This is a pure data-layer
 * test: it exercises the migration's shape directly, not the (not-yet-built)
 * HTTP routes.
 *
 * Coverage (plan.md "Data model", T4 done-when)
 * ──────────────────────────────────────────────
 * 1. A row that predates this migration (inserted with only the pre-migration
 *    columns, via raw SQL — simulating one of the table's existing rows) reads
 *    back `version === 1` and `lastModifiedByUserId === null` through the
 *    generated Prisma client. This proves the new columns are additive with
 *    non-volatile defaults (no backfill needed, no table rewrite).
 * 2. Deleting an estimate that has 2 collaborator grants leaves 0 rows in
 *    `estimate_collaborator` (`onDelete: Cascade`, AC-9.1) — this is the
 *    plan's explicit "not Restrict" requirement: cascading must actually
 *    happen at the database level, not merely be un-enforced.
 * 3. The `@@unique([estimateId, userId])` constraint (the "one grant per
 *    person" invariant) is enforced by the database.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { db } from "@/lib/db";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const TEST_OWNER_ID = "test-owner-t4-collab-schema";
const TEST_COLLAB_1_ID = "test-collab-1-t4-schema";
const TEST_COLLAB_2_ID = "test-collab-2-t4-schema";

const makeContent = () => ({
  params: {
    parallelism: 0.7,
    sprintDays: 10,
    workingDaysMonth: 20,
    qaDeployDays: 0,
    qaTestDays: 0,
    pmDays: 0,
    aiCostCoef: 10,
    aiGain: 0.3,
  },
  releases: [],
  acts: [],
});

afterEach(async () => {
  // estimate_collaborator rows cascade-delete with their estimate, so cleaning
  // up the estimate is sufficient — but delete both explicitly in case a test
  // failed mid-way and left the estimate behind without exercising the cascade.
  await db.estimateCollaborator.deleteMany({
    where: { userId: { in: [TEST_COLLAB_1_ID, TEST_COLLAB_2_ID] } },
  });
  await db.estimate.deleteMany({ where: { userId: TEST_OWNER_ID } });
});

// ─── 1. Pre-existing rows read version = 1, lastModifiedByUserId = null ─────

describe("T4 — additive migration: pre-existing rows backfill to version=1", () => {
  it("a row inserted with only the pre-migration columns reads version=1 and lastModifiedByUserId=null", async () => {
    const sizeBytes = new TextEncoder().encode(JSON.stringify(makeContent())).length;

    // Raw SQL, deliberately omitting `version` and `lastModifiedByUserId` —
    // this is exactly what an INSERT written against the OLD schema (before
    // this migration existed) would have looked like. The columns' defaults
    // (Int @default(1), nullable) must supply the values, not application code.
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "estimate" (id, "userId", name, author, "sizeBytes", content, "createdAt", "updatedAt")
      VALUES (
        ${`legacy-row-${TEST_OWNER_ID}`},
        ${TEST_OWNER_ID},
        ${"Pre-migration estimate"},
        ${""},
        ${sizeBytes},
        ${JSON.stringify(makeContent())}::jsonb,
        now(),
        now()
      )
      RETURNING id
    `;
    expect(rows).toHaveLength(1);
    const id = rows[0]!.id;

    const row = await db.estimate.findUniqueOrThrow({ where: { id } });

    expect(row.version).toBe(1);
    expect(row.lastModifiedByUserId).toBeNull();
  });
});

// ─── 2. Deleting an estimate with 2 grants cascades (AC-9.1) ────────────────

describe("T4 — onDelete: Cascade, not Restrict (AC-9.1)", () => {
  it("deleting an estimate with 2 collaborator grants leaves 0 rows in estimate_collaborator", async () => {
    const estimate = await db.estimate.create({
      data: {
        userId: TEST_OWNER_ID,
        name: "Estimate with collaborators",
        author: "",
        sizeBytes: 2,
        content: {},
      },
    });

    await db.estimateCollaborator.createMany({
      data: [
        {
          estimateId: estimate.id,
          userId: TEST_COLLAB_1_ID,
          email: "collab1@example.com",
          accessLevel: "viewer",
          grantedByUserId: TEST_OWNER_ID,
        },
        {
          estimateId: estimate.id,
          userId: TEST_COLLAB_2_ID,
          email: "collab2@example.com",
          accessLevel: "editor",
          grantedByUserId: TEST_OWNER_ID,
        },
      ],
    });

    const beforeCount = await db.estimateCollaborator.count({
      where: { estimateId: estimate.id },
    });
    expect(beforeCount).toBe(2);

    // Deleting the estimate must NOT be blocked by the collaborator rows
    // (a Restrict FK would raise a foreign-key-violation error here).
    await db.estimate.delete({ where: { id: estimate.id } });

    const afterCount = await db.estimateCollaborator.count({
      where: { estimateId: estimate.id },
    });
    expect(afterCount).toBe(0);
  });
});

// ─── 3. @@unique([estimateId, userId]) — one grant per person ──────────────

describe("T4 — unique(estimateId, userId) invariant", () => {
  it("a second grant for the same (estimateId, userId) pair violates the unique constraint", async () => {
    const estimate = await db.estimate.create({
      data: {
        userId: TEST_OWNER_ID,
        name: "Estimate for uniqueness check",
        author: "",
        sizeBytes: 2,
        content: {},
      },
    });

    await db.estimateCollaborator.create({
      data: {
        estimateId: estimate.id,
        userId: TEST_COLLAB_1_ID,
        email: "collab1@example.com",
        accessLevel: "viewer",
        grantedByUserId: TEST_OWNER_ID,
      },
    });

    let threw = false;
    try {
      await db.estimateCollaborator.create({
        data: {
          estimateId: estimate.id,
          userId: TEST_COLLAB_1_ID,
          email: "collab1-alias@example.com",
          accessLevel: "editor",
          grantedByUserId: TEST_OWNER_ID,
        },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Cleanup (afterEach only removes by userId on the estimate, and this
    // estimate is owned by TEST_OWNER_ID, so it is covered — but delete
    // explicitly for clarity/determinism within this test's own scope).
    await db.estimate.delete({ where: { id: estimate.id } });
  });
});

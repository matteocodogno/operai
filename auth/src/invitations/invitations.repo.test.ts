/**
 * Tests for the invitation domain repo (T5, specs/006-user-invitations —
 * ADR-0012/0013). Two groups:
 *
 *   - `effectiveInvitationStatus` / `buildEffectiveStatusWhere` /
 *     `isTerminalStatus` — pure functions, no DB.
 *   - `reconcileExpiredPending` / `findLivePendingInvitationByEmail` /
 *     `listInvitations` — integration tests against the real local Postgres
 *     (DATABASE_URL from `.env`, shared dev DB on localhost:5435), mirroring
 *     `authz/audit.test.ts`'s DB-ISOLATION convention: every fixture row is
 *     suffixed with a per-run random id and removed in `afterAll`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db";
import {
  buildEffectiveStatusWhere,
  createInvitationRow,
  effectiveInvitationStatus,
  findLivePendingInvitationByEmail,
  isTerminalStatus,
  listInvitations,
  normalizeEmail,
  reconcileExpiredPending,
  updateForResend,
  updateForRevoke,
} from "./invitations.repo";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;

// ─── Pure function tests ─────────────────────────────────────────────────────

describe("effectiveInvitationStatus (ADR-0013)", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");

  test("pending, not yet expired → pending", () => {
    expect(
      effectiveInvitationStatus(
        { status: "pending", expiresAt: new Date(now.getTime() + HOUR) },
        now,
      ),
    ).toBe("pending");
  });

  test("pending, past expiresAt → expired (derived, not stored)", () => {
    expect(
      effectiveInvitationStatus(
        { status: "pending", expiresAt: new Date(now.getTime() - HOUR) },
        now,
      ),
    ).toBe("expired");
  });

  test("pending, expiresAt exactly now → expired (<=, not <)", () => {
    expect(
      effectiveInvitationStatus({ status: "pending", expiresAt: now }, now),
    ).toBe("expired");
  });

  test("accepted stays accepted regardless of expiresAt", () => {
    expect(
      effectiveInvitationStatus(
        { status: "accepted", expiresAt: new Date(now.getTime() - HOUR) },
        now,
      ),
    ).toBe("accepted");
  });

  test("revoked stays revoked regardless of expiresAt", () => {
    expect(
      effectiveInvitationStatus(
        { status: "revoked", expiresAt: new Date(now.getTime() + HOUR) },
        now,
      ),
    ).toBe("revoked");
  });

  test("a row already physically 'expired' (post reconcile-on-write) stays expired", () => {
    expect(
      effectiveInvitationStatus(
        { status: "expired", expiresAt: new Date(now.getTime() - HOUR) },
        now,
      ),
    ).toBe("expired");
  });
});

describe("isTerminalStatus", () => {
  test("accepted and revoked are terminal", () => {
    expect(isTerminalStatus("accepted")).toBe(true);
    expect(isTerminalStatus("revoked")).toBe(true);
  });

  test("pending and expired are not terminal (both accept resend/revoke, AC-4.4)", () => {
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("expired")).toBe(false);
  });
});

describe("normalizeEmail", () => {
  test("lower-cases and trims", () => {
    expect(normalizeEmail("  Alice@WellD.ch ")).toBe("alice@welld.ch");
  });
});

describe("buildEffectiveStatusWhere", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");

  test("pending → physically pending AND not yet expired", () => {
    expect(buildEffectiveStatusWhere("pending", now)).toEqual({
      status: "pending",
      expiresAt: { gt: now },
    });
  });

  test("expired → physically expired OR (pending AND past expiry)", () => {
    expect(buildEffectiveStatusWhere("expired", now)).toEqual({
      OR: [{ status: "expired" }, { status: "pending", expiresAt: { lte: now } }],
    });
  });

  test("accepted/revoked → plain physical-status match", () => {
    expect(buildEffectiveStatusWhere("accepted", now)).toEqual({ status: "accepted" });
    expect(buildEffectiveStatusWhere("revoked", now)).toEqual({ status: "revoked" });
  });
});

// ─── DB-backed tests ──────────────────────────────────────────────────────────

describe("invitations.repo — DB integration (ADR-0013 reconcile-on-write)", () => {
  const createdInvitationIds: string[] = [];
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (createdInvitationIds.length > 0) {
      await db.invitation.deleteMany({ where: { id: { in: createdInvitationIds } } });
    }
    if (createdUserIds.length > 0) {
      await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  async function makeInviter(label: string) {
    const user = await db.user.create({
      data: {
        email: `t5-inviter-${label}-${RUN_ID}@operai.test`,
        name: `T5 Fixture Inviter ${label}`,
        emailVerified: true,
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  test("reconcile-on-write flips a past-expiry pending row to physical 'expired' inside the insert's transaction (AC-1.5/AC-1.14)", async () => {
    const inviter = await makeInviter("reconcile");
    const email = `stale-${RUN_ID}@operai.test`;

    const staleRow = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "stale-hash",
        expiresAt: new Date(Date.now() - HOUR), // already past window
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(staleRow.id);

    // The exact sequence invite-create (T6) performs: reconcile, THEN
    // insert — both inside one transaction.
    const freshRow = await db.$transaction(async (tx) => {
      await reconcileExpiredPending(tx, email);
      return createInvitationRow(tx, {
        email,
        roleIds: [],
        departmentIds: [],
        invitedByUserId: inviter.id,
        tokenHash: "fresh-hash",
        expiresAt: new Date(Date.now() + 72 * HOUR),
      });
    });
    createdInvitationIds.push(freshRow.id);

    const reconciledStale = await db.invitation.findUniqueOrThrow({
      where: { id: staleRow.id },
    });
    expect(reconciledStale.status).toBe("expired");

    // The partial-unique index (invitation_pending_email_key) did not block
    // the fresh insert — it succeeded and is genuinely 'pending'.
    expect(freshRow.status).toBe("pending");
    expect(freshRow.email).toBe(email);
  });

  test("reconcile-on-write does NOT touch a live (not-yet-expired) pending row for the same email", async () => {
    const inviter = await makeInviter("reconcile-live");
    const email = `live-${RUN_ID}@operai.test`;

    const liveRow = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "live-hash",
        expiresAt: new Date(Date.now() + 72 * HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(liveRow.id);

    await db.$transaction(async (tx) => {
      await reconcileExpiredPending(tx, email);
    });

    const stillLive = await db.invitation.findUniqueOrThrow({ where: { id: liveRow.id } });
    expect(stillLive.status).toBe("pending");
  });

  test("findLivePendingInvitationByEmail excludes an expired row and matches only a genuinely live one (feeds AC-1.4's 409 + the activation hook's filter)", async () => {
    const inviter = await makeInviter("live-lookup");
    const email = `lookup-${RUN_ID}@operai.test`;

    const expired = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "expired-hash",
        expiresAt: new Date(Date.now() - HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(expired.id);

    expect(await findLivePendingInvitationByEmail(db, email)).toBeNull();

    // Reconcile the stale row first (mirrors what invite-create's
    // transaction does before inserting) — the partial-unique index
    // (`WHERE status='pending'`) would otherwise legitimately reject a
    // second physically-`pending` row for the same email.
    await db.$transaction((tx) => reconcileExpiredPending(tx, email));

    const live = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "live-hash-2",
        expiresAt: new Date(Date.now() + HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(live.id);

    const found = await findLivePendingInvitationByEmail(db, email);
    expect(found?.id).toBe(live.id);
  });

  test("listInvitations filters by effective status='expired' across both a physically-expired row and a lazily-expired pending row", async () => {
    const inviter = await makeInviter("list-expired");
    const email = `list-expired-${RUN_ID}@operai.test`;

    const lazilyExpired = await db.invitation.create({
      data: {
        email,
        status: "pending", // never reconciled
        roleIds: [],
        departmentIds: [],
        tokenHash: "lazy-hash",
        expiresAt: new Date(Date.now() - HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(lazilyExpired.id);

    const physicallyExpired = await db.invitation.create({
      data: {
        email: `${email}-2`,
        status: "expired", // already reconciled by a prior create
        roleIds: [],
        departmentIds: [],
        tokenHash: "physical-hash",
        expiresAt: new Date(Date.now() - 2 * HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(physicallyExpired.id);

    const pendingLive = await db.invitation.create({
      data: {
        email: `${email}-3`,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "pending-hash",
        expiresAt: new Date(Date.now() + HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(pendingLive.id);

    const { items } = await listInvitations({
      page: 1,
      pageSize: 100,
      status: "expired",
      q: `list-expired-${RUN_ID}`,
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(lazilyExpired.id);
    expect(ids).toContain(physicallyExpired.id);
    expect(ids).not.toContain(pendingLive.id);
  });

  test("updateForResend rotates status back to pending, sets a new tokenHash/expiresAt/invitedByUserId", async () => {
    const originalInviter = await makeInviter("resend-original");
    const newInviter = await makeInviter("resend-new");
    const email = `resend-${RUN_ID}@operai.test`;

    const row = await db.invitation.create({
      data: {
        email,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "original-hash",
        expiresAt: new Date(Date.now() - HOUR), // effectively expired
        invitedByUserId: originalInviter.id,
      },
    });
    createdInvitationIds.push(row.id);

    const newExpiresAt = new Date(Date.now() + 72 * HOUR);
    const updated = await db.$transaction((tx) =>
      updateForResend(tx, row.id, {
        tokenHash: "rotated-hash",
        expiresAt: newExpiresAt,
        invitedByUserId: newInviter.id,
      }),
    );

    expect(updated.status).toBe("pending");
    expect(updated.tokenHash).toBe("rotated-hash");
    expect(updated.tokenHash).not.toBe("original-hash");
    expect(updated.invitedByUserId).toBe(newInviter.id);
    expect(updated.expiresAt.getTime()).toBe(newExpiresAt.getTime());
  });

  test("updateForRevoke sets the terminal physical status 'revoked'", async () => {
    const inviter = await makeInviter("revoke");
    const row = await db.invitation.create({
      data: {
        email: `revoke-${RUN_ID}@operai.test`,
        status: "pending",
        roleIds: [],
        departmentIds: [],
        tokenHash: "revoke-hash",
        expiresAt: new Date(Date.now() + HOUR),
        invitedByUserId: inviter.id,
      },
    });
    createdInvitationIds.push(row.id);

    const updated = await db.$transaction((tx) => updateForRevoke(tx, row.id));
    expect(updated.status).toBe("revoked");
  });
});

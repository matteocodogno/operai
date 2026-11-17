/**
 * The notice duty of a protected change (T58; AC-9.7 to AC-9.10, AC-9.12, AC-9.14 to AC-9.17; plan G2 to G4) against
 * REAL Postgres, through the real save and restore routes.
 *
 * Like `write.routes.test.ts`: `legal_entity_version` is append-only, so nearly every test runs in ONE rolled-back
 * transaction (`inRolledBackTx`; the router's `audited` seam runs the mutation and its audit rows in it, and its
 * `client` reads through it). The people who SIGN IN (the actor) are committed rows with a per-run suffix, removed in
 * `afterAll`, because the session middleware and `authorize` read through `db`; every other person is created inside
 * the transaction. The "real transactions" group commits and runs only against a registry with no version at all, as
 * the one in `write.routes.test.ts` does, and wipes what it wrote.
 *
 * Only `auth.config` (the session source) is mocked.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withAudit } from "../../authz/audit";
import { db } from "../../lib/db";
import type { LegalEntity } from "../entities";
import type { CrmSource } from "../import";
import { committedTransactionsSkipReason, committedVersionCount, attempt, inRolledBackTx, insertSql, type Tx, validImportRow } from "../testDb";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession) } },
}));

const { createLegalEntityRateLimits, createLegalEntityWriteRouter: createThrottledWriteRouter } = await import("../write.routes");
const { runImport } = await import("../import");
const { recordNoticeDuty, noRecipientsEntry, OUTSIDE_RECIPIENT } = await import("./duty");
type Audited = typeof withAudit;

const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
let counter = 0;

// ─── Committed fixtures: the people who sign in ──────────────────────────────────────────────────────────────────

async function makeUser(label: string, entity: string | null = null) {
  const user = await db.user.create({
    data: { name: `T58 fixture ${label}`, email: `t58-le-duty-${label}-${RUN_ID}-${++counter}@legalentities.test`, entity },
  });
  createdUserIds.add(user.id);
  return user;
}

async function grantManage(userId: string, conditions: Record<string, unknown> | null) {
  const role = await db.role.create({ data: { name: `t58-le-duty-${RUN_ID}-${++counter}` } });
  createdRoleIds.add(role.id);
  await db.permissionRule.create({
    data: {
      roleId: role.id,
      resource: "legal-entity",
      action: "manage",
      ...(conditions === null ? {} : { conditions: conditions as never }),
    },
  });
  await db.userRole.create({ data: { userId, roleId: role.id } });
}

/** The seed's grant: unconditioned, both entities. */
async function admin(label: string) {
  const user = await makeUser(label, null);
  await grantManage(user.id, null);
  return user;
}

async function chManager(label: string) {
  const user = await makeUser(label, "welld_ch");
  await grantManage(user.id, { attributes: [{ key: "entity", match: "user" }] });
  return user;
}

const signedInAs = (user: { id: string; email: string; name: string } | null) => {
  currentSession = user === null ? null : { user, session: { id: `sess-${user.id}` } };
};

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { actorUserId: { in: Array.from(createdUserIds) } } });
  await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
  await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
});

// ─── Harness (the shape of write.routes.test.ts's) ───────────────────────────────────────────────────────────────

function auditedIn(tx: Tx): Audited {
  return (async ({ mutate, entry }) => {
    await tx.$executeRawUnsafe("SAVEPOINT le_write");
    try {
      const result = await mutate(tx);
      const resolved = typeof entry === "function" ? entry(result) : entry;
      for (const e of Array.isArray(resolved) ? resolved : [resolved]) {
        await tx.auditLog.create({
          data: {
            actorUserId: e.actorUserId,
            action: e.action,
            targetType: e.targetType,
            targetId: e.targetId ?? null,
            summary: e.summary,
            ...(e.data != null ? { data: e.data } : {}),
          },
        });
      }
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT le_write");
      return result;
    } catch (error) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT le_write");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT le_write");
      throw error;
    }
  }) as Audited;
}

type RouterOptions = NonNullable<Parameters<typeof createThrottledWriteRouter>[0]>;
const writeRouter = (tx: Tx, options: RouterOptions = {}) =>
  createThrottledWriteRouter({
    audited: auditedIn(tx),
    client: tx,
    limits: createLegalEntityRateLimits({ writeLimit: 1_000_000, checkLimit: 1_000_000 }),
    ...options,
  });

/** A registry with no version (and no notice) whatever was committed before: removed inside the rolled-back transaction only. */
async function emptyRegistry(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
  await tx.$executeRawUnsafe("DELETE FROM legal_entity_notice");
  await tx.$executeRawUnsafe("DELETE FROM legal_entity_version");
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
}

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  inRolledBackTx(async (tx) => {
    await emptyRegistry(tx);
    return fn(tx);
  });

const GOOD = {
  legalName: "wellD SA",
  address: { it: ["Via Cantonale 1", "6900 Lugano"], en: ["Via Cantonale 1", "6900 Lugano, Switzerland"] },
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
  contacts: { it: "", en: "" },
};
const details = (over: Record<string, unknown> = {}) => ({ ...GOOD, ...over });

/** v1 the system's import (incomplete), v2 a complete save (the base the tests change). */
async function seedTwoVersions(tx: Tx, entity: LegalEntity = "welld_ch") {
  await tx.$executeRawUnsafe(insertSql(validImportRow(entity)));
  await tx.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","restoredFrom","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${entity}, 2, ${GOOD.legalName}, ${GOOD.address.it}::text[], ${GOOD.address.en}::text[],
       ${GOOD.vatNumber}, ${GOOD.iban}, '', '', 'save', NULL,
       ARRAY['legalName','address.it','address.en','vatNumber','iban']::text[], 'u-seeded', 'Sara Seeded',
       ${new Date("2026-11-10T10:00:00.000Z")})`;
}

type Requestable = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const post = (router: Requestable, path: string, body: unknown) =>
  router.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const save = (router: Requestable, entity: string, body: unknown) => post(router, `/legal-entities/${entity}/versions`, body);
const restore = (router: Requestable, entity: string, n: number, body: unknown) =>
  post(router, `/legal-entities/${entity}/versions/${n}/restore`, body);

const notices = (tx: Tx, entity: LegalEntity, version?: number) =>
  tx.legalEntityNotice.findMany({ where: { entity, ...(version === undefined ? {} : { version }) }, orderBy: [{ recipient: "asc" }, { channel: "asc" }] });
const noticeCount = (tx: Tx) => tx.legalEntityNotice.count();
const auditActions = async (tx: Tx, entity: LegalEntity) =>
  (await tx.auditLog.findMany({ where: { targetType: "legal_entity", targetId: entity }, orderBy: { createdAt: "asc" } })).map((a) => a.action);

/** The people created inside the transaction, as fixtures of an assertion. */
async function inTxPerson(tx: Tx, label: string, entity: string | null, deleted = false) {
  return tx.user.create({
    data: {
      name: `T58 ${label}`,
      email: `t58-duty-${label}-${RUN_ID}-${++counter}@legalentities.test`,
      entity,
      ...(deleted ? { deletedAt: new Date("2026-11-01T00:00:00.000Z") } : {}),
    },
  });
}
async function inTxRole(tx: Tx, rule: { conditions?: object } | "none" | "admin") {
  if (rule === "admin") return (await tx.role.findUnique({ where: { name: "admin" } })) ?? (await tx.role.create({ data: { name: "admin" } }));
  const role = await tx.role.create({ data: { name: `t58-duty-${RUN_ID}-${++counter}` } });
  if (rule !== "none") {
    await tx.permissionRule.create({
      data: { roleId: role.id, resource: "legal-entity", action: "manage", ...(rule.conditions ? { conditions: rule.conditions } : {}) },
    });
  }
  return role;
}

const recipientsByChannel = (rows: { recipient: string; channel: string }[], channel: string, within: readonly string[]) =>
  rows.filter((r) => r.channel === channel && within.includes(r.recipient)).map((r) => r.recipient).sort();

// ─── AC-9.7 to AC-9.10: rows, one per recipient and channel, in the version's transaction ───────────────────────────

describe("a protected change writes the notice rows (AC-9.7 to AC-9.10)", () => {
  test("a direct save changing the IBAN: per recipient one in_app and one email row, none outside when unset; rows pending, attempts 0, the version's own time", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await admin("iban-actor");
      const chMgr = await inTxPerson(tx, "ch-manager", "welld_ch");
      const itMgr = await inTxPerson(tx, "it-manager", "welld_it");
      const unconditioned = await inTxPerson(tx, "unconditioned", null);
      const deptAdmin = await inTxPerson(tx, "dept-admin", null);
      const deletedManager = await inTxPerson(tx, "deleted-manager", null, true);
      const deletedAdmin = await inTxPerson(tx, "deleted-admin", null, true);
      const bystander = await inTxPerson(tx, "bystander", "welld_ch");

      const conditioned = await inTxRole(tx, { conditions: { attributes: [{ key: "entity", match: "user" }] } });
      const open = await inTxRole(tx, {});
      const adminRole = await inTxRole(tx, "admin");
      await tx.userRole.createMany({
        data: [
          { userId: chMgr.id, roleId: conditioned.id },
          { userId: itMgr.id, roleId: conditioned.id },
          { userId: unconditioned.id, roleId: open.id },
          { userId: deletedManager.id, roleId: open.id },
          { userId: deletedAdmin.id, roleId: adminRole.id },
        ],
      });
      const dept = await tx.department.create({ data: { name: `t58-duty-dept-${RUN_ID}-${++counter}` } });
      await tx.departmentRole.create({ data: { departmentId: dept.id, roleId: adminRole.id } });
      await tx.userDepartment.create({ data: { userId: deptAdmin.id, departmentId: dept.id } });

      signedInAs(actor);
      const res = await save(writeRouter(tx), "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) });
      expect(res.status).toBe(201);

      const rows = await notices(tx, "welld_ch", 3);
      const fixtures = [actor.id, chMgr.id, itMgr.id, unconditioned.id, deptAdmin.id, deletedManager.id, deletedAdmin.id, bystander.id];
      const expected = [actor.id, chMgr.id, unconditioned.id, deptAdmin.id].sort();
      expect(recipientsByChannel(rows, "in_app", fixtures)).toEqual(expected);
      expect(recipientsByChannel(rows, "email", fixtures)).toEqual(expected);
      // a welld_it-only holder, the deleted, the bystander: nothing at all
      for (const none of [itMgr, deletedManager, deletedAdmin, bystander]) expect(rows.filter((r) => r.recipient === none.id)).toEqual([]);
      // no outside row (LEGAL_ENTITY_NOTICE_EMAIL is unset under test), nobody in the notice of version 2 or the other entity
      expect(rows.filter((r) => r.recipient === OUTSIDE_RECIPIENT)).toEqual([]);
      expect((await notices(tx, "welld_ch", 2)).length).toBe(0);
      expect((await notices(tx, "welld_it")).length).toBe(0);

      const version = await tx.legalEntityVersion.findUniqueOrThrow({ where: { entity_version: { entity: "welld_ch", version: 3 } } });
      for (const row of rows) {
        expect(row.status).toBe("pending");
        expect(row.attempts).toBe(0);
        expect(row.recipientKind).toBe("person");
        expect(row.leaseUntil).toBeNull();
        expect(row.createdAt.getTime()).toBe(version.createdAt.getTime()); // the version's transaction time
        expect(row.nextAttemptAt.getTime()).toBe(version.createdAt.getTime());
      }
    });
  });

  test("a welld_it save: the welld_ch-conditioned manager is not told, the welld_it one is", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx, "welld_it");
      const actor = await admin("it-save-actor");
      const chMgr = await inTxPerson(tx, "ch-manager", "welld_ch");
      const itMgr = await inTxPerson(tx, "it-manager", "welld_it");
      const role = await inTxRole(tx, { conditions: { attributes: [{ key: "entity", match: "user" }] } });
      await tx.userRole.createMany({ data: [{ userId: chMgr.id, roleId: role.id }, { userId: itMgr.id, roleId: role.id }] });
      signedInAs(actor);
      const res = await save(writeRouter(tx), "welld_it", { baseVersion: 2, details: details({ vatNumber: "IT01234567890" }) });
      expect(res.status).toBe(201);
      const rows = await notices(tx, "welld_it", 3);
      expect(recipientsByChannel(rows, "email", [chMgr.id, itMgr.id, actor.id]).sort()).toEqual([actor.id, itMgr.id].sort());
    });
  });

  test("a person who is administrator, manager and the actor gets exactly one row per channel", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await admin("triple-actor");
      const adminRole = await inTxRole(tx, "admin");
      await tx.userRole.create({ data: { userId: actor.id, roleId: adminRole.id } });
      signedInAs(actor);
      expect((await save(writeRouter(tx), "welld_ch", { baseVersion: 2, details: details({ legalName: "wellD Suisse SA" }) })).status).toBe(201);
      const mine = (await notices(tx, "welld_ch", 3)).filter((r) => r.recipient === actor.id);
      expect(mine.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    });
  });

  test("the actor is told as a receipt, though no other person is (AC-9.9)", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await chManager("receipt-actor");
      // every other manager/admin in the database is irrelevant: the actor's own two rows are the point
      signedInAs(actor);
      expect((await save(writeRouter(tx), "welld_ch", { baseVersion: 2, details: details({ legalName: "Receipt SA" }) })).status).toBe(201);
      const mine = (await notices(tx, "welld_ch", 3)).filter((r) => r.recipient === actor.id);
      expect(mine.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    });
  });

  test("the outside mailbox: one email row named 'outside' when set at that moment, none when unset; its address is never stored", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await admin("outside-actor");
      signedInAs(actor);
      const withOutside = await save(writeRouter(tx, { notices: { outsideMailbox: () => true } }), "welld_ch", {
        baseVersion: 2,
        details: details({ iban: "CH5604835012345678009" }),
      });
      expect(withOutside.status).toBe(201);
      const outside = (await notices(tx, "welld_ch", 3)).filter((r) => r.recipientKind === "outside");
      expect(outside.map((r) => [r.recipient, r.channel, r.status])).toEqual([[OUTSIDE_RECIPIENT, "email", "pending"]]);

      const without = await save(writeRouter(tx, { notices: { outsideMailbox: () => false } }), "welld_ch", {
        baseVersion: 3,
        details: details({ iban: "CH9300762011623852957" }),
      });
      expect(without.status).toBe(201);
      expect((await notices(tx, "welld_ch", 4)).filter((r) => r.recipientKind === "outside")).toEqual([]);
      expect((await notices(tx, "welld_ch", 4)).filter((r) => r.recipient === actor.id).length).toBe(2);
    });
  });

  test("a restore that is a protected change writes rows (AC-9.7: whichever way); a restore with equal protected details writes none", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await admin("restore-actor");
      signedInAs(actor);
      const router = writeRouter(tx);
      // v3: IBAN changed (rows); v4: restore v2 -> the IBAN returns (a protected change again: rows)
      expect((await save(router, "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) })).status).toBe(201);
      expect((await restore(router, "welld_ch", 2, { baseVersion: 3 })).status).toBe(201);
      expect((await notices(tx, "welld_ch", 4)).filter((r) => r.recipient === actor.id).map((r) => r.channel).sort()).toEqual(["email", "in_app"]);

      // v5: contacts only; v6: restore v4 (same protected details as v5; only the contacts differ): no rows
      expect((await save(router, "welld_ch", { baseVersion: 4, details: details({ contacts: { it: "Tel. 1", en: "" } }) })).status).toBe(201);
      expect((await restore(router, "welld_ch", 4, { baseVersion: 5 })).status).toBe(201);
      expect(await notices(tx, "welld_ch", 5)).toEqual([]);
      expect(await notices(tx, "welld_ch", 6)).toEqual([]);
    });
  });
});

// ─── AC-9.17, AC-9.16: no notice ─────────────────────────────────────────────────────────────────────────────────

describe("no notice (AC-9.16, AC-9.17)", () => {
  test.each([
    ["address only", (over: Record<string, unknown>) => details({ ...over, address: { ...GOOD.address, it: ["Via Nuova 2", "6900 Lugano"] } })],
    ["contacts only", (over: Record<string, unknown>) => details({ ...over, contacts: { it: "Tel. +41 91 000 00 00", en: "" } })],
    ["IBAN with other spacing and case only", (over: Record<string, unknown>) => details({ ...over, iban: " ch93 0076 2011 6238 5295 7 " })],
    ["nothing changed (no-op)", (over: Record<string, unknown>) => details(over)],
  ])("%s: no row, no notice audit entry", async (_name, build) => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      signedInAs(await admin("no-notice"));
      const res = await save(writeRouter(tx), "welld_ch", { baseVersion: 2, details: build({}) });
      expect([200, 201]).toContain(res.status);
      expect(await noticeCount(tx)).toBe(0);
      expect((await auditActions(tx, "welld_ch")).filter((a) => a.startsWith("legal_entity.notice"))).toEqual([]);
    });
  });

  test("refused: 422 (invalid details and invalid shape), 409 (conflict and not moved), 403, 401: no row", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const router = writeRouter(tx);
      signedInAs(await admin("refused"));
      expect((await save(router, "welld_ch", { baseVersion: 2, details: details({ legalName: "", iban: "CH5604835012345678009" }) })).status).toBe(422);
      expect((await save(router, "welld_ch", { baseVersion: 2, details: { nonsense: true } })).status).toBe(422);
      expect((await save(router, "welld_ch", { baseVersion: 1, details: details({ iban: "CH5604835012345678009" }) })).status).toBe(409);
      expect((await restore(router, "welld_ch", 1, { baseVersion: 2 })).status).toBe(422); // v1 is not restorable (D4)
      expect((await save(router, "welld_it", { baseVersion: 1, details: details({ legalName: "x SA" }) })).status).toBe(409); // not moved

      signedInAs(await makeUser("no-grant", "welld_ch"));
      expect((await save(router, "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) })).status).toBe(403);
      signedInAs(await chManager("other-entity"));
      expect((await save(router, "welld_it", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) })).status).toBe(403);
      signedInAs(null);
      expect((await save(router, "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) })).status).toBe(401);

      expect(await noticeCount(tx)).toBe(0);
    });
  });

  test("the import's first and repeated apply write no notice and no notice audit entry (AC-9.16)", async () => {
    await inTx(async (tx) => {
      const crm: CrmSource = {
        isReadOnly: async () => true,
        legalColumns: async () => ({ table: true, absent: [] }),
        profile: async () => ({
          legalName: "wellD SA",
          addressLines: ["Via Cantonale 1", "6900 Lugano"],
          vatNumber: "CHE-123.456.789 IVA",
          iban: "CH93 0076 2011 6238 5295 7",
          updatedAt: "2026-11-10T09:08:07.123Z",
          updatedBy: "fixture",
        }),
        close: async () => undefined,
      };
      const first = await runImport({ apply: true, crm, transact: (fn) => fn(tx) });
      expect(first.entities.map((e) => e.category)).toEqual(["inserted", "inserted"]);
      const second = await runImport({ apply: true, crm, transact: (fn) => fn(tx) });
      expect(second.entities.map((e) => e.category)).toEqual(["present", "present"]);
      expect(await noticeCount(tx)).toBe(0);
      for (const entity of ["welld_it", "welld_ch"] as const) {
        expect((await auditActions(tx, entity)).filter((a) => a.startsWith("legal_entity.notice"))).toEqual([]);
      }
    });
  });

  test("the import code does not reach the notice code, and the duty refuses an import action", async () => {
    const source = readFileSync(join(import.meta.dir, "../import.ts"), "utf8");
    expect(source).not.toMatch(/notices\/|recordNoticeDuty|legalEntityNotice/);
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const bad = { entity: "welld_ch", version: 1, action: "import", actorUserId: "x", storedAt: new Date(), outsideMailbox: true } as never;
      await expect(recordNoticeDuty(tx, bad)).rejects.toThrow();
      expect(await noticeCount(tx)).toBe(0);
    });
  });
});

// ─── AC-9.15: no recipient ───────────────────────────────────────────────────────────────────────────────────────

describe("a protected change with no recipient (AC-9.15)", () => {
  test("an injected empty set and no outside mailbox: the version is stored, no row, and one legal_entity.notice_no_recipients entry in the same transaction", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await admin("empty-set");
      signedInAs(actor);
      const router = writeRouter(tx, { notices: { recipients: async () => [], outsideMailbox: () => false } });
      const res = await save(router, "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) });
      expect(res.status).toBe(201);
      expect(await noticeCount(tx)).toBe(0);
      expect(await auditActions(tx, "welld_ch")).toEqual(["legal_entity.save", "legal_entity.notice_no_recipients"]);
      const entry = await tx.auditLog.findFirstOrThrow({ where: { action: "legal_entity.notice_no_recipients" } });
      expect(entry.actorUserId).toBeNull();
      expect(entry.targetType).toBe("legal_entity");
      expect(entry.targetId).toBe("welld_ch");
      expect(entry.data).toEqual({ version: 3 });
    });
  });

  test("an empty set with the outside mailbox set: a recipient exists, so no such entry; and a non-protected save writes none either", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      signedInAs(await admin("empty-set-outside"));
      const protectedOnly = writeRouter(tx, { notices: { recipients: async () => [], outsideMailbox: () => true } });
      expect((await save(protectedOnly, "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) })).status).toBe(201);
      expect((await notices(tx, "welld_ch", 3)).map((r) => [r.recipient, r.channel])).toEqual([[OUTSIDE_RECIPIENT, "email"]]);
      expect(await auditActions(tx, "welld_ch")).toEqual(["legal_entity.save"]);

      const addressOnly = writeRouter(tx, { notices: { recipients: async () => [], outsideMailbox: () => false } });
      expect((await save(addressOnly, "welld_ch", { baseVersion: 3, details: details({ iban: "CH5604835012345678009", contacts: { it: "x", en: "" } }) })).status).toBe(201);
      expect((await auditActions(tx, "welld_ch")).filter((a) => a.includes("no_recipients"))).toEqual([]);
    });
  });

  test("noRecipientsEntry names the version and the entity, never a value", () => {
    const entry = noRecipientsEntry({ entity: "welld_it", version: 9 });
    expect(entry).toMatchObject({ actorUserId: null, action: "legal_entity.notice_no_recipients", targetType: "legal_entity", targetId: "welld_it", data: { version: 9 } });
  });
});

// ─── AC-9.12: no value in a row or an entry ──────────────────────────────────────────────────────────────────────

describe("no value of any detail in a notice row or a notice entry (AC-9.12)", () => {
  test("sentinels in the legal name, VAT number and IBAN appear in no notice row and in no notice audit entry", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      const actor = await admin("sentinel");
      signedInAs(actor);
      const secret = { legalName: "SENTINEL-NAME-7d41 SA", vatNumber: "SENTINEL-VAT-93bc", iban: "CH5604835012345678009" };
      const router = writeRouter(tx, { notices: { outsideMailbox: () => true } });
      expect((await save(router, "welld_ch", { baseVersion: 2, details: details(secret) })).status).toBe(201);
      const empty = writeRouter(tx, { notices: { recipients: async () => [], outsideMailbox: () => false } });
      expect((await save(empty, "welld_ch", { baseVersion: 3, details: details({ ...secret, legalName: "SENTINEL-NAME-9e02 SA" }) })).status).toBe(201);

      const rowsText = JSON.stringify(await notices(tx, "welld_ch"));
      const entries = (await tx.auditLog.findMany({ where: { action: { startsWith: "legal_entity.notice" } } })).map((a) => JSON.stringify(a)).join("\n");
      expect(rowsText.length).toBeGreaterThan(10);
      for (const text of [rowsText, entries]) {
        for (const sentinel of ["SENTINEL", "5604835012345678009", "0076 2011", "wellD", "CHE-123"]) expect(text).not.toContain(sentinel);
      }
    });
  });
});

// ─── AC-9.14: the duty is kept together with the version ─────────────────────────────────────────────────────────

describe("the duty is kept with the version (AC-9.14)", () => {
  test("a failure after the notice rows are inserted leaves no version, no audit entry and no notice row", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      signedInAs(await admin("rollback"));
      const base = auditedIn(tx);
      let noticesInsideTransaction = 0;
      const failAfterInsert: Audited = ((params) =>
        base({
          ...params,
          mutate: async (t) => {
            const result = await params.mutate(t);
            noticesInsideTransaction = await t.legalEntityNotice.count();
            return result;
          },
          entry: () => {
            throw new Error("forced failure after the insert");
          },
        })) as Audited;
      const spy = mock(() => undefined);
      const original = console.error;
      console.error = spy as never;
      try {
        const res = await save(writeRouter(tx, { audited: failAfterInsert }), "welld_ch", { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) });
        expect(res.status).toBe(500);
      } finally {
        console.error = original;
      }
      expect(noticesInsideTransaction).toBeGreaterThan(0); // the rows existed inside the transaction: the rollback removed them
      expect(await noticeCount(tx)).toBe(0);
      expect(await tx.legalEntityVersion.count({ where: { entity: "welld_ch", version: 3 } })).toBe(0);
      expect((await auditActions(tx, "welld_ch")).filter((a) => a.startsWith("legal_entity."))).toEqual([]);
    });
  });

  test("a failure to write the duty itself fails the save as a database error would (500, nothing stored)", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      signedInAs(await admin("duty-fails"));
      const original = console.error;
      console.error = (() => undefined) as never;
      try {
        const res = await save(
          writeRouter(tx, {
            notices: {
              recipients: async () => {
                throw new Error("recipients lookup failed");
              },
            },
          }),
          "welld_ch",
          { baseVersion: 2, details: details({ iban: "CH5604835012345678009" }) },
        );
        expect(res.status).toBe(500);
      } finally {
        console.error = original;
      }
      expect(await tx.legalEntityVersion.count({ where: { entity: "welld_ch", version: 3 } })).toBe(0);
      expect(await noticeCount(tx)).toBe(0);
    });
  });
});

// ─── The table's own guards ──────────────────────────────────────────────────────────────────────────────────────

describe("the table refuses what the duty never writes (plan G4)", () => {
  const insert = (over: Partial<Record<string, string | number>> = {}) => {
    const row = { id: `n-${crypto.randomUUID()}`, entity: "welld_ch", version: 2, recipient: "u-1", recipientKind: "person", channel: "email", status: "pending", ...over };
    const quote = (v: string | number) => (typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
    return (
      `INSERT INTO legal_entity_notice ("id","entity","version","recipient","recipientKind","channel","status") VALUES (` +
      `${quote(row.id)},${quote(row.entity)},${quote(row.version)},${quote(row.recipient)},${quote(row.recipientKind)},${quote(row.channel)},${quote(row.status)})`
    );
  };

  test("a valid row goes in; an outside in-app row, an unknown status, channel, kind or entity, a mismatched outside name are refused", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      expect(await attempt(tx, insert())).toBeNull();
      expect(await attempt(tx, insert({ recipient: "outside", recipientKind: "outside", channel: "email" }))).toBeNull();
      expect(await attempt(tx, insert({ recipient: "outside", recipientKind: "outside", channel: "in_app" }))).toContain("legal_entity_notice_outside_is_email_only");
      expect(await attempt(tx, insert({ status: "sent" }))).toContain("legal_entity_notice_status");
      expect(await attempt(tx, insert({ status: "" }))).toContain("legal_entity_notice_status");
      expect(await attempt(tx, insert({ channel: "sms" }))).toContain("legal_entity_notice_channel");
      expect(await attempt(tx, insert({ recipientKind: "group" }))).toContain("legal_entity_notice_recipient_kind");
      expect(await attempt(tx, insert({ recipient: "outside", recipientKind: "person" }))).toContain("legal_entity_notice_outside_is_named_outside");
      expect(await attempt(tx, insert({ recipient: "someone", recipientKind: "outside" }))).toContain("legal_entity_notice_outside_is_named_outside");
      expect(await attempt(tx, insert({ entity: "welld_de" }))).toContain("legal_entity_notice_entity");
    });
  });

  test("a second row for the same version, recipient and channel is refused; so is a version that does not exist; and so is removing a named version", async () => {
    await inTx(async (tx) => {
      await seedTwoVersions(tx);
      expect(await attempt(tx, insert({ recipient: "u-dup" }))).toBeNull();
      expect(await attempt(tx, insert({ recipient: "u-dup" }))).toContain("legal_entity_notice_entity_version_recipient_channel_key");
      expect(await attempt(tx, insert({ recipient: "u-dup", channel: "in_app" }))).toBeNull(); // the other channel is another row
      expect(await attempt(tx, insert({ version: 99 }))).toContain("legal_entity_notice_entity_version_fkey");
      // The version table is Tier 1 and refuses a delete anyway; with its trigger out of the way (replica role) the
      // FK is not enforced either, so the RESTRICT is asserted from the catalog.
      const fk = await tx.$queryRaw<{ confdeltype: string }[]>`
        SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = 'legal_entity_notice_entity_version_fkey'`;
      expect(fk[0]?.confdeltype).toBe("r");
    });
  });
});

// ─── LEGAL_ENTITY_NOTICE_EMAIL ───────────────────────────────────────────────────────────────────────────────────

describe("LEGAL_ENTITY_NOTICE_EMAIL in lib/env.ts", () => {
  const authDir = join(import.meta.dir, "../../..");
  async function loadEnv(value: string | undefined) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env["LEGAL_ENTITY_NOTICE_EMAIL"];
    if (value !== undefined) env["LEGAL_ENTITY_NOTICE_EMAIL"] = value;
    const proc = Bun.spawn(
      [process.execPath, "--preload", "./src/test-setup.ts", "-e", 'const { env } = await import("./src/lib/env"); console.log(JSON.stringify(env.LEGAL_ENTITY_NOTICE_EMAIL ?? null));'],
      { cwd: authDir, env, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: out.trim(), err, code };
  }

  test("unset and blank are 'no outside recipient'; an address is kept; a malformed one stops startup naming the variable, not the value", async () => {
    expect(await loadEnv(undefined)).toMatchObject({ out: "null", code: 0 });
    expect(await loadEnv("")).toMatchObject({ out: "null", code: 0 });
    expect(await loadEnv("   ")).toMatchObject({ out: "null", code: 0 });
    expect(await loadEnv("audit@example.com")).toMatchObject({ out: '"audit@example.com"', code: 0 });
    const bad = await loadEnv("not-an-address-SENTINEL");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("LEGAL_ENTITY_NOTICE_EMAIL");
    expect(bad.err).not.toContain("SENTINEL");
  });
});

// ─── Real commits ────────────────────────────────────────────────────────────────────────────────────────────────

// Host guard first (T53/F4, like write.routes.test.ts and dispatcher.test.ts): the group removes its rows with the
// append-only triggers off, so it runs only on a local database, and the check precedes every query.
const hostSkip = committedTransactionsSkipReason(process.env.DATABASE_URL);
if (hostSkip) console.warn(hostSkip);
const registryIsEmpty = hostSkip === null && (await committedVersionCount()) === 0;
if (hostSkip === null && !registryIsEmpty) {
  console.warn(
    "notices/duty.test.ts: the 'real transactions' group is SKIPPED because legal_entity_version already holds rows " +
      "(it needs a database with no registry, and removes its own rows afterwards). Use a fresh test database to run it.",
  );
}
const realSuite = registryIsEmpty ? describe : describe.skip;

realSuite("real transactions (committed; the registry and the notices are emptied again afterwards)", () => {
  const ENTITY: LegalEntity = "welld_ch";

  async function wipe() {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe("DELETE FROM legal_entity_notice");
      await tx.$executeRawUnsafe("DELETE FROM legal_entity_version");
    });
    await db.auditLog.deleteMany({ where: { targetType: "legal_entity", targetId: ENTITY } });
  }
  // The registry is empty here, so any notice row left in the table names a version that no longer exists (an earlier
  // suite that wiped the registry without its notices): removed first, so the counts below are this test's own.
  beforeAll(wipe);
  afterAll(wipe);

  test("a failure after the notice rows were inserted leaves no version, no audit entry and no notice row; the real path commits all three together", async () => {
    await db.$executeRawUnsafe(insertSql(validImportRow(ENTITY)));
    const actor = await admin("real-actor");
    signedInAs(actor);
    const router = (audited?: Audited) =>
      createThrottledWriteRouter({ ...(audited ? { audited } : {}), limits: createLegalEntityRateLimits({ writeLimit: 1_000_000, checkLimit: 1_000_000 }) });
    const body = { baseVersion: 1, details: details({ legalName: "Rolled Back SA" }) };

    let noticesInside = 0;
    const failAfterInsert: Audited = ((params) =>
      withAudit({
        ...params,
        mutate: async (tx) => {
          const result = await params.mutate(tx);
          noticesInside = await tx.legalEntityNotice.count({ where: { entity: ENTITY } });
          return result;
        },
        entry: () => {
          throw new Error("forced failure after the insert");
        },
      })) as Audited;
    const original = console.error;
    console.error = (() => undefined) as never;
    try {
      expect((await save(router(failAfterInsert), ENTITY, body)).status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(noticesInside).toBeGreaterThan(0);
    expect(await db.legalEntityNotice.count({ where: { entity: ENTITY } })).toBe(0);
    expect(await db.legalEntityVersion.count({ where: { entity: ENTITY } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetType: "legal_entity", targetId: ENTITY } })).toBe(0);

    const ok = await save(router(), ENTITY, { baseVersion: 1, details: details({ legalName: "Committed SA" }) });
    expect(ok.status).toBe(201);
    const rows = await db.legalEntityNotice.findMany({ where: { entity: ENTITY, version: 2 } });
    expect(rows.filter((r) => r.recipient === actor.id).map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    expect(await db.auditLog.count({ where: { action: "legal_entity.save", targetId: ENTITY } })).toBe(1);
  });
});

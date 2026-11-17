/**
 * Who is told about a protected change (T58; AC-9.8, AC-9.9, AC-9.10; plan G3) against REAL Postgres.
 *
 * Everything (users, roles, departments, grants) is created inside ONE rolled-back transaction, so nothing is ever
 * committed; the resolver runs on that same transaction, as it does inside a save. Assertions look at the fixture
 * people only, so a database that holds other administrators does not matter.
 */

import { describe, expect, test } from "bun:test";
import type { LegalEntity } from "../entities";
import { inRolledBackTx, type Tx } from "../testDb";
import { resolveRecipients } from "./recipients";

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;

async function person(tx: Tx, label: string, entity: string | null, deleted = false) {
  counter += 1;
  return tx.user.create({
    data: {
      name: `T58 ${label}`,
      email: `t58-rcp-${label}-${RUN}-${counter}@legalentities.test`,
      entity,
      ...(deleted ? { deletedAt: new Date("2026-11-01T00:00:00.000Z") } : {}),
    },
  });
}

async function roleWith(tx: Tx, rule: { resource: string; action: string; conditions?: object } | null, name?: string) {
  counter += 1;
  const role = await tx.role.create({ data: { name: name ?? `t58-rcp-${RUN}-${counter}` } });
  if (rule !== null) {
    await tx.permissionRule.create({
      data: { roleId: role.id, resource: rule.resource, action: rule.action, ...(rule.conditions ? { conditions: rule.conditions } : {}) },
    });
  }
  return role;
}

const MANAGE = { resource: "legal-entity", action: "manage" };
const ENTITY_ONLY = { attributes: [{ key: "entity", match: "user" }] };

/** The `admin` role (the suite's name for it): the committed one when it exists, else one created here. */
async function adminRole(tx: Tx) {
  return (await tx.role.findUnique({ where: { name: "admin" } })) ?? (await tx.role.create({ data: { name: "admin" } }));
}

const recipientsOf = (tx: Tx, entity: LegalEntity, actorUserId: string) => resolveRecipients(tx, { entity, actorUserId });
const within = (ids: readonly string[], fixtures: readonly { id: string }[]) => ids.filter((id) => fixtures.some((f) => f.id === id));

describe("recipients of a protected change (AC-9.8 to AC-9.10)", () => {
  test("a manager conditioned to welld_ch is told of welld_ch only; one conditioned to welld_it of welld_it only", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor", null);
      const ch = await person(tx, "ch-manager", "welld_ch");
      const it = await person(tx, "it-manager", "welld_it");
      const chRole = await roleWith(tx, { ...MANAGE, conditions: ENTITY_ONLY });
      await tx.userRole.createMany({ data: [{ userId: ch.id, roleId: chRole.id }, { userId: it.id, roleId: chRole.id }] });
      const fixtures = [actor, ch, it];

      expect(within(await recipientsOf(tx, "welld_ch", actor.id), fixtures).sort()).toEqual([actor.id, ch.id].sort());
      expect(within(await recipientsOf(tx, "welld_it", actor.id), fixtures).sort()).toEqual([actor.id, it.id].sort());
    });
  });

  test("a holder with no entity set and an entity-conditioned grant covers nothing (fails closed); an unconditioned holder covers both", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor", null);
      const noEntity = await person(tx, "no-entity", null);
      const open = await person(tx, "unconditioned", null);
      const conditioned = await roleWith(tx, { ...MANAGE, conditions: ENTITY_ONLY });
      const unconditioned = await roleWith(tx, MANAGE);
      await tx.userRole.createMany({ data: [{ userId: noEntity.id, roleId: conditioned.id }, { userId: open.id, roleId: unconditioned.id }] });
      for (const entity of ["welld_ch", "welld_it"] as const) {
        expect(within(await recipientsOf(tx, entity, actor.id), [noEntity])).toEqual([]);
        expect(within(await recipientsOf(tx, entity, actor.id), [open])).toEqual([open.id]);
      }
    });
  });

  test("a manager through a department's role is told", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor", null);
      const member = await person(tx, "dept-manager", "welld_ch");
      const role = await roleWith(tx, { ...MANAGE, conditions: ENTITY_ONLY });
      const dept = await tx.department.create({ data: { name: `t58-dept-${RUN}-${++counter}` } });
      await tx.departmentRole.create({ data: { departmentId: dept.id, roleId: role.id } });
      await tx.userDepartment.create({ data: { userId: member.id, departmentId: dept.id } });
      expect(within(await recipientsOf(tx, "welld_ch", actor.id), [member])).toEqual([member.id]);
      expect(within(await recipientsOf(tx, "welld_it", actor.id), [member])).toEqual([]);
    });
  });

  test("an administrator is told whether or not they hold the permission: directly, or through a department", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor", null);
      const direct = await person(tx, "admin-direct", null);
      const viaDept = await person(tx, "admin-dept", null);
      const role = await adminRole(tx);
      await tx.userRole.create({ data: { userId: direct.id, roleId: role.id } });
      const dept = await tx.department.create({ data: { name: `t58-admin-dept-${RUN}-${++counter}` } });
      await tx.departmentRole.create({ data: { departmentId: dept.id, roleId: role.id } });
      await tx.userDepartment.create({ data: { userId: viaDept.id, departmentId: dept.id } });
      for (const entity of ["welld_ch", "welld_it"] as const) {
        const got = await recipientsOf(tx, entity, actor.id);
        expect(got).toContain(direct.id);
        expect(got).toContain(viaDept.id);
      }
    });
  });

  test("a soft-deleted manager and a soft-deleted administrator get none", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor", null);
      const deletedManager = await person(tx, "deleted-manager", null, true);
      const deletedAdmin = await person(tx, "deleted-admin", null, true);
      const deletedDeptAdmin = await person(tx, "deleted-dept-admin", null, true);
      const manage = await roleWith(tx, MANAGE);
      const admin = await adminRole(tx);
      await tx.userRole.createMany({ data: [{ userId: deletedManager.id, roleId: manage.id }, { userId: deletedAdmin.id, roleId: admin.id }] });
      const dept = await tx.department.create({ data: { name: `t58-del-dept-${RUN}-${++counter}` } });
      await tx.departmentRole.create({ data: { departmentId: dept.id, roleId: admin.id } });
      await tx.userDepartment.create({ data: { userId: deletedDeptAdmin.id, departmentId: dept.id } });
      expect(within(await recipientsOf(tx, "welld_ch", actor.id), [deletedManager, deletedAdmin, deletedDeptAdmin])).toEqual([]);
    });
  });

  test("a role that was removed is not a recipient: the set is read at the moment of the call", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor", null);
      const manager = await person(tx, "was-manager", null);
      const role = await roleWith(tx, MANAGE);
      await tx.userRole.create({ data: { userId: manager.id, roleId: role.id } });
      expect(within(await recipientsOf(tx, "welld_ch", actor.id), [manager])).toEqual([manager.id]);
      await tx.userRole.deleteMany({ where: { userId: manager.id } });
      expect(within(await recipientsOf(tx, "welld_ch", actor.id), [manager])).toEqual([]);
    });
  });

  test("the actor is a recipient (a receipt) even with no grant that covers them; a deleted actor is not", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await person(tx, "actor-no-grant", null);
      const gone = await person(tx, "actor-deleted", null, true);
      expect(within(await recipientsOf(tx, "welld_ch", actor.id), [actor])).toEqual([actor.id]);
      expect(within(await recipientsOf(tx, "welld_ch", gone.id), [gone])).toEqual([]);
    });
  });

  test("one entry per person however many ways they qualify (admin, manager, actor), sorted", async () => {
    await inRolledBackTx(async (tx) => {
      const everything = await person(tx, "everything", null);
      const other = await person(tx, "other", null);
      const manage = await roleWith(tx, MANAGE);
      const admin = await adminRole(tx);
      await tx.userRole.createMany({
        data: [
          { userId: everything.id, roleId: manage.id },
          { userId: everything.id, roleId: admin.id },
          { userId: other.id, roleId: admin.id },
        ],
      });
      const got = await recipientsOf(tx, "welld_ch", everything.id);
      expect(got.filter((id) => id === everything.id)).toHaveLength(1);
      expect(new Set(got).size).toBe(got.length);
      expect([...got]).toEqual([...got].sort());
    });
  });
});

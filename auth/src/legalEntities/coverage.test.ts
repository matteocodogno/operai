import { afterAll, describe, expect, test } from "bun:test";
import type { EffectivePermission } from "../authz/resolver";
import { db } from "../lib/db";
import { activeUserProfile, adminAreaReachable, coveredEntities } from "./coverage";

const unconditioned: EffectivePermission = { resource: "legal-entity", action: "manage", conditions: null };
const entityConditioned: EffectivePermission = {
  resource: "legal-entity",
  action: "manage",
  conditions: { attributes: [{ key: "entity", match: "user" }] },
};

describe("coveredEntities / adminAreaReachable", () => {
  test("an unconditioned grant covers both entities, whatever the user's entity", () => {
    for (const entity of [null, "welld_ch", "welld_it", "elsewhere"]) {
      expect(coveredEntities([unconditioned], { entity })).toEqual(["welld_it", "welld_ch"]);
      expect(adminAreaReachable([unconditioned], { entity })).toBe(true);
    }
  });

  test("a conditioned grant covers only the user's own entity", () => {
    expect(coveredEntities([entityConditioned], { entity: "welld_ch" })).toEqual(["welld_ch"]);
    expect(coveredEntities([entityConditioned], { entity: "welld_it" })).toEqual(["welld_it"]);
    expect(adminAreaReachable([entityConditioned], { entity: "welld_ch" })).toBe(true);
  });

  test("a conditioned grant with no user entity covers none", () => {
    expect(coveredEntities([entityConditioned], { entity: null })).toEqual([]);
    expect(adminAreaReachable([entityConditioned], { entity: null })).toBe(false);
  });

  test("a user entity outside the registry's entities covers none", () => {
    expect(coveredEntities([entityConditioned], { entity: "CH" })).toEqual([]);
    expect(adminAreaReachable([entityConditioned], { entity: "welld_de" })).toBe(false);
  });

  test("an unrecognised condition covers none (fail closed)", () => {
    const unknown: EffectivePermission[] = [
      { resource: "legal-entity", action: "manage", conditions: { ownership: "own" } },
      { resource: "legal-entity", action: "manage", conditions: { attributes: [{ key: "jobTitle", match: "user" }] } },
      { resource: "legal-entity", action: "manage", conditions: { attributes: [{ key: "entity", match: "any" }] } },
      {
        resource: "legal-entity",
        action: "manage",
        conditions: { ownership: "own", attributes: [{ key: "entity", match: "user" }] },
      },
    ];
    for (const grant of unknown) {
      expect(coveredEntities([grant], { entity: "welld_ch" })).toEqual([]);
      expect(adminAreaReachable([grant], { entity: "welld_ch" })).toBe(false);
    }
  });

  test("an unrecognised grant does not mask a recognised one next to it", () => {
    const perms: EffectivePermission[] = [
      { resource: "legal-entity", action: "manage", conditions: { ownership: "own" } },
      entityConditioned,
    ];
    expect(coveredEntities(perms, { entity: "welld_it" })).toEqual(["welld_it"]);
  });

  test("other permissions grant nothing here, including admin:access and legal-entity:read", () => {
    const perms: EffectivePermission[] = [
      { resource: "admin", action: "access", conditions: null },
      { resource: "legal-entity", action: "read", conditions: null },
      { resource: "letterhead", action: "manage", conditions: null },
    ];
    expect(coveredEntities(perms, { entity: "welld_ch" })).toEqual([]);
    expect(adminAreaReachable(perms, { entity: "welld_ch" })).toBe(false);
    expect(adminAreaReachable([], { entity: "welld_ch" })).toBe(false);
  });
});

describe("activeUserProfile (F2)", () => {
  const RUN_ID = crypto.randomUUID().slice(0, 8);
  const ids: string[] = [];
  const make = async (label: string, entity: string | null, deletedAt: Date | null) => {
    const user = await db.user.create({
      data: { name: `T52 fixture ${label}`, email: `t52-le-cov-${label}-${RUN_ID}@legalentities.test`, entity, deletedAt },
    });
    ids.push(user.id);
    return user;
  };
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: ids } } });
  });

  test("an active person answers their entity; none is null", async () => {
    expect(await activeUserProfile((await make("ch", "welld_ch", null)).id)).toEqual({ entity: "welld_ch" });
    expect(await activeUserProfile((await make("none", null, null)).id)).toEqual({ entity: null });
  });

  test("a soft-deleted person, and an id that is no user, are null", async () => {
    expect(await activeUserProfile((await make("deleted", "welld_ch", new Date())).id)).toBeNull();
    expect(await activeUserProfile(`no-such-user-${RUN_ID}`)).toBeNull();
  });
});

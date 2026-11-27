/**
 * T2 of specs/20261126-teams — the name clash (AC-1.2, plan D14 and "The name clash body"): the pure body builder,
 * the case-insensitive lookup that supplies `existingName`, and the re-read after a lost race. The lookup is proved
 * against REAL Postgres inside a rolled-back transaction, so `lower()`, the self exclusion and the absence of any
 * wildcard are the database's own behaviour, not a fake's.
 */

import { describe, expect, test } from "bun:test";
import { inRolledBackTx } from "../legalEntities/testDb";
import { Prisma } from "../lib/generated/prisma/client";
import { clashAfterConflict, findClashingName, isNameUniqueViolation, nameTakenBody } from "./nameTaken";

const RUN = crypto.randomUUID().slice(0, 8);
const name = (s: string) => `${s}-${RUN}`;

describe("nameTakenBody", () => {
  test("is exactly the plan's body: problem members, code, detail built from existingName, instance, existingName", () => {
    expect(nameTakenBody("Backend", "/admin/teams")).toEqual({
      type: "https://httpstatuses.com/409",
      title: "Conflict",
      status: 409,
      code: "team_name_taken",
      detail: 'A team named "Backend" already exists',
      instance: "/admin/teams",
      existingName: "Backend",
    });
  });

  test("instance is the request path of a rename", () => {
    expect(nameTakenBody("Ops", "/admin/teams/abc").instance).toBe("/admin/teams/abc");
  });
});

describe("findClashingName", () => {
  test("returns the stored casing of the other team, whatever the submitted casing, archived teams counted", async () => {
    await inRolledBackTx(async (tx) => {
      const stored = name("Backend");
      const team = await tx.team.create({ data: { name: stored } });
      expect(await findClashingName(tx, stored.toUpperCase())).toBe(stored);
      expect(await findClashingName(tx, stored.toLowerCase())).toBe(stored);
      await tx.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
      expect(await findClashingName(tx, stored.toUpperCase())).toBe(stored);
    });
  });

  test("null when no name is equal", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.team.create({ data: { name: name("Backend") } });
      expect(await findClashingName(tx, name("Frontend"))).toBeNull();
    });
  });

  test("excludes the team itself: a rename to another casing of its own name is no clash", async () => {
    await inRolledBackTx(async (tx) => {
      const team = await tx.team.create({ data: { name: name("Backend") } });
      expect(await findClashingName(tx, name("BACKEND"), team.id)).toBeNull();
      const other = await tx.team.create({ data: { name: name("Ops") } });
      expect(await findClashingName(tx, name("backend"), other.id)).toBe(name("Backend"));
    });
  });

  test("no LIKE wildcard: Back_nd does not clash with Backend, and % matches nothing", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.team.create({ data: { name: name("Backend") } });
      expect(await findClashingName(tx, name("Back_nd"))).toBeNull();
      expect(await findClashingName(tx, "%")).toBeNull();
      await tx.team.create({ data: { name: name("Back_nd") } });
      expect(await findClashingName(tx, name("BACK_ND"))).toBe(name("Back_nd"));
    });
  });
});

describe("clashAfterConflict (the re-read after a unique violation)", () => {
  test("the committed winner's stored name is existingName", async () => {
    const client = { $queryRaw: async () => [{ name: "Ops" }] };
    expect(await clashAfterConflict("ops", undefined, client as never)).toBe("Ops");
  });

  test("the one race left: nothing found, the submitted trimmed name is used", async () => {
    const client = { $queryRaw: async () => [] };
    expect(await clashAfterConflict("ops", undefined, client as never)).toBe("ops");
  });
});

describe("isNameUniqueViolation", () => {
  test("recognises a Prisma P2002 and, under a driver wrapper, the index's own name", () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "test" });
    expect(isNameUniqueViolation(p2002)).toBe(true);
    expect(isNameUniqueViolation(new Error('duplicate key value violates unique constraint "team_name_lower_key"'))).toBe(true);
    expect(isNameUniqueViolation(new Error("wrapped", { cause: new Error('constraint "team_name_lower_key"') }))).toBe(true);
    expect(isNameUniqueViolation(new Error("boom"))).toBe(false);
    expect(isNameUniqueViolation("team_name_lower_key")).toBe(false);
  });
});

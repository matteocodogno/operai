/**
 * T1 of specs/20261126-teams — the `team` / `team_member` tables and the reads both routers share, against REAL
 * Postgres. Every test runs in a transaction that is rolled back (`inRolledBackTx`): nothing is committed, so
 * there is nothing to clean and parallel files never see these rows.
 *
 * A CHECK or index that never fires proves nothing, so each refusal sits beside a valid control insert.
 */

import { describe, expect, test } from "bun:test";
import { attempt, inRolledBackTx, type Tx } from "../legalEntities/testDb";
import { getTeamDetail, listTeamSummaries } from "./repo";

const RUN = crypto.randomUUID().slice(0, 8);

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function teamSql(id: string, name: string, description: string | null = null): string {
  return `INSERT INTO "team" ("id","name","description","updatedAt") VALUES (${q(id)}, ${q(name)}, ${
    description === null ? "NULL" : q(description)
  }, now())`;
}

async function mkUser(tx: Tx, label: string, deletedAt: Date | null = null) {
  return tx.user.create({
    data: { name: label, email: `${label}-${RUN}@example.test`, deletedAt },
  });
}

describe("team — name and description shape (AC-1.1, AC-1.2)", () => {
  test("a valid team is accepted (control for every refusal below)", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, teamSql("t-ok", "Backend", "The platform guild"))).toBeNull();
      const row = await tx.team.findUniqueOrThrow({ where: { id: "t-ok" } });
      expect(row).toMatchObject({ name: "Backend", version: 1, archivedAt: null });
      expect(row.createdAt).toBeInstanceOf(Date);
    });
  });

  test("a name clashing case-insensitively raises a unique violation", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, teamSql("t-a", "Backend"))).toBeNull();
      const clash = await attempt(tx, teamSql("t-b", "bACKEND"));
      expect(clash).toContain("team_name_lower_key");
    });
  });

  test("an archived team still holds its name (AC-1.2: the rule counts archived teams)", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, teamSql("t-a", "Backend"))).toBeNull();
      await tx.team.update({ where: { id: "t-a" }, data: { archivedAt: new Date() } });
      expect(await attempt(tx, teamSql("t-b", "BACKEND"))).toContain("team_name_lower_key");
    });
  });

  test("LIKE wildcards are not wildcards: Back_nd, Back% and Backend coexist", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, teamSql("t-a", "Backend"))).toBeNull();
      expect(await attempt(tx, teamSql("t-b", "Back_nd"))).toBeNull();
      expect(await attempt(tx, teamSql("t-c", "Back%"))).toBeNull();
    });
  });

  test("an untrimmed or empty name is refused by team_name_shape", async () => {
    await inRolledBackTx(async (tx) => {
      for (const bad of [" Backend", "Backend ", "  ", ""]) {
        expect(await attempt(tx, teamSql("t-x", bad))).toContain("team_name_shape");
      }
    });
  });

  test("80 characters are accepted, 81 are refused", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, teamSql("t-80", "n".repeat(80)))).toBeNull();
      expect(await attempt(tx, teamSql("t-81", "m".repeat(81)))).toContain("team_name_shape");
    });
  });

  test("a description of 500 characters is accepted, 501 and the empty string are refused", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await attempt(tx, teamSql("t-d500", "D500", "d".repeat(500)))).toBeNull();
      expect(await attempt(tx, teamSql("t-d501", "D501", "d".repeat(501)))).toContain(
        "team_description_shape",
      );
      expect(await attempt(tx, teamSql("t-d0", "D0", ""))).toContain("team_description_shape");
      expect(await attempt(tx, teamSql("t-dnull", "DNull", null))).toBeNull();
    });
  });
});

describe("team_member — keys and references (AC-1.7, AC-2.3)", () => {
  test("team_member.teamId is ON DELETE RESTRICT: a team with a member cannot be deleted (AC-1.7)", async () => {
    await inRolledBackTx(async (tx) => {
      const u = await mkUser(tx, "restrict");
      expect(await attempt(tx, teamSql("t-r", "Restrict"))).toBeNull();
      await tx.teamMember.create({ data: { teamId: "t-r", userId: u.id } });
      const refused = await attempt(tx, `DELETE FROM "team" WHERE "id" = 't-r'`);
      expect(refused).not.toBeNull();
      expect(refused).toContain("team_member_teamId_fkey");
      // once emptied the same statement succeeds: the refusal above was the member FK's doing
      await tx.teamMember.delete({ where: { teamId_userId: { teamId: "t-r", userId: u.id } } });
      expect(await attempt(tx, `DELETE FROM "team" WHERE "id" = 't-r'`)).toBeNull();
    });
  });

  test("a person is in one team at most once and may be in two teams", async () => {
    await inRolledBackTx(async (tx) => {
      const u = await mkUser(tx, "twice");
      await attempt(tx, teamSql("t-1", "One"));
      await attempt(tx, teamSql("t-2", "Two"));
      await tx.teamMember.create({ data: { teamId: "t-1", userId: u.id } });
      await tx.teamMember.create({ data: { teamId: "t-2", userId: u.id } });
      expect(
        await attempt(tx, `INSERT INTO "team_member" ("teamId","userId") VALUES ('t-1', ${q(u.id)})`),
      ).toContain("team_member_pkey");
    });
  });

  test("a member must be a real user and a real team", async () => {
    await inRolledBackTx(async (tx) => {
      await attempt(tx, teamSql("t-1", "One"));
      expect(
        await attempt(tx, `INSERT INTO "team_member" ("teamId","userId") VALUES ('t-1','nobody')`),
      ).toContain("team_member_userId_fkey");
      const u = await mkUser(tx, "real");
      expect(
        await attempt(tx, `INSERT INTO "team_member" ("teamId","userId") VALUES ('no-team', ${q(u.id)})`),
      ).toContain("team_member_teamId_fkey");
    });
  });
});

describe("the shared reads (AC-2.3, AC-2.5)", () => {
  test("a soft-deleted member is listed deactivated, not counted, and counted again once restored", async () => {
    await inRolledBackTx(async (tx) => {
      const alice = await mkUser(tx, "alice");
      const bob = await mkUser(tx, "bob");
      await attempt(tx, teamSql("t-m", "Members", "About"));
      await tx.teamMember.createMany({
        data: [
          { teamId: "t-m", userId: bob.id },
          { teamId: "t-m", userId: alice.id },
        ],
      });

      let detail = await getTeamDetail("t-m", tx);
      expect(detail).not.toBeNull();
      expect(detail).toMatchObject({
        id: "t-m",
        name: "Members",
        description: "About",
        archived: false,
        activeMemberCount: 2,
        version: 1,
      });
      expect(detail!.members.map((m) => m.name)).toEqual(["alice", "bob"]);
      expect(detail!.members[0]).toMatchObject({
        id: alice.id,
        email: alice.email,
        deactivated: false,
      });
      const added = detail!.members[0]!.addedAt;
      expect(new Date(added).toISOString()).toBe(added);
      expect(new Date(detail!.createdAt).toISOString()).toBe(detail!.createdAt);
      expect(new Date(detail!.updatedAt).toISOString()).toBe(detail!.updatedAt);

      await tx.user.update({ where: { id: alice.id }, data: { deletedAt: new Date() } });
      detail = await getTeamDetail("t-m", tx);
      expect(detail!.activeMemberCount).toBe(1);
      // deactivated members are listed, and last
      expect(detail!.members.map((m) => [m.name, m.deactivated])).toEqual([
        ["bob", false],
        ["alice", true],
      ]);

      await tx.user.update({ where: { id: alice.id }, data: { deletedAt: null } });
      detail = await getTeamDetail("t-m", tx);
      expect(detail!.activeMemberCount).toBe(2);
      expect(detail!.members.every((m) => !m.deactivated)).toBe(true);
    });
  });

  test("an unknown id has no detail", async () => {
    await inRolledBackTx(async (tx) => {
      expect(await getTeamDetail("does-not-exist", tx)).toBeNull();
    });
  });

  test("the summaries list every team, archived included, in name order, with counts", async () => {
    await inRolledBackTx(async (tx) => {
      const u = await mkUser(tx, "listed");
      const gone = await mkUser(tx, "gone", new Date());
      await attempt(tx, teamSql("t-b", `Zeta-${RUN}`));
      await attempt(tx, teamSql("t-a", `alpha-${RUN}`));
      await tx.team.update({ where: { id: "t-b" }, data: { archivedAt: new Date() } });
      await tx.teamMember.createMany({
        data: [
          { teamId: "t-a", userId: u.id },
          { teamId: "t-a", userId: gone.id },
        ],
      });
      const all = (await listTeamSummaries(tx)).filter((t) => t.name.endsWith(RUN));
      expect(all).toEqual([
        { id: "t-a", name: `alpha-${RUN}`, description: null, archived: false, activeMemberCount: 1, version: 1 },
        { id: "t-b", name: `Zeta-${RUN}`, description: null, archived: true, activeMemberCount: 0, version: 1 },
      ]);
    });
  });

  test("a team grants nothing: the permission resolver names no team table (AC-2.5)", async () => {
    const src = await Bun.file(new URL("../authz/resolver.ts", import.meta.url)).text();
    expect(src).not.toMatch(/\bteam(Member)?\b/i);
  });
});

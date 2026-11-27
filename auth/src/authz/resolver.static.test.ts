/**
 * AC-2.5 of specs/20261126-teams (static half): a team grants NOTHING, so the permission path never reads the team
 * tables. `resolver.ts` decides every effective permission; if it ever names a team model or table, a membership
 * could start to confer something, and this test fails before any behaviour does. The behavioural half (permissions
 * and epoch unchanged by every team write) is in `teams/admin.routes.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEAM_WORDS = /team/i;

describe("the resolver never reads a team (AC-2.5)", () => {
  const source = readFileSync(join(import.meta.dir, "resolver.ts"), "utf8");

  test("resolver.ts names neither `team` nor `teamMember` (a model, a table, a relation or a word)", () => {
    expect(source.match(TEAM_WORDS)).toBeNull();
    expect(source).not.toContain("teamMember");
    expect(source).not.toContain("team_member");
  });

  test("the check can fail: a source that reads teamMemberships would be caught", () => {
    expect("tx.teamMember.findMany({ where: { userId } })".match(TEAM_WORDS)).not.toBeNull();
    expect("include: { teamMemberships: true }".match(TEAM_WORDS)).not.toBeNull();
  });
});

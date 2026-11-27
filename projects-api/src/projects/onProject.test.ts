/**
 * The one rule of who is on a project (specs/20261126-teams T11, D4): AC-4.4 (the project manager, the listed members
 * and the counted members of the attached teams, each once, in a fixed order), AC-4.5 (a person who is in two teams, or
 * also listed, appears once; a detached team counts nothing), AC-4.7 (a deactivated member, or one without Projects
 * access, is not counted; an archived team still counts), and "unknown is not nobody" (D3).
 */
import { describe, expect, it } from "bun:test";
import type { TeamFact, TeamMemberFact } from "../lib/teams";
import { countedMembers, onProject, onProjectKnown } from "./onProject";

const member = (id: string, over: Partial<TeamMemberFact> = {}): TeamMemberFact => ({
  id,
  name: `Name of ${id}`,
  active: true,
  appAccess: true,
  ...over,
});
const team = (id: string, members: TeamMemberFact[], over: Partial<TeamFact> = {}): TeamFact => ({
  id,
  name: `Team ${id}`,
  archived: false,
  members,
  ...over,
});
const teamsOf = (...teams: TeamFact[]) => new Map(teams.map((t) => [t.id, t]));
const row = (over: Partial<Parameters<typeof onProject>[0]> = {}) => ({
  projectManagerId: null as string | null,
  memberIds: [] as string[],
  attachedTeamIds: [] as string[],
  ...over,
});

describe("countedMembers (AC-4.7)", () => {
  it("counts the active members with access to Projects, in the order given", () => {
    expect(countedMembers(team("t", [member("b"), member("a")]))).toEqual(["b", "a"]);
  });

  it("leaves out a deactivated member and a member without access to Projects", () => {
    const t = team("t", [
      member("ok"),
      member("gone", { active: false, appAccess: false, name: null }),
      member("noaccess", { appAccess: false }),
      // appAccess is auth's answer for an active user; a contradictory pair is still not counted
      member("odd", { active: false, appAccess: true }),
    ]);
    expect(countedMembers(t)).toEqual(["ok"]);
  });

  it("counts the members of an ARCHIVED team (an archived team is not a detached one, AC-4.7)", () => {
    expect(countedMembers(team("t", [member("a")], { archived: true }))).toEqual(["a"]);
  });
});

describe("onProject (AC-4.4, AC-4.5)", () => {
  it("is the project manager, then the listed members in join order, then each attached team's counted members", () => {
    const ids = onProject(
      row({ projectManagerId: "pm", memberIds: ["m2", "m1"], attachedTeamIds: ["t1", "t2"] }),
      teamsOf(team("t1", [member("a"), member("b")]), team("t2", [member("c")])),
    );
    expect(ids).toEqual(["pm", "m2", "m1", "a", "b", "c"]);
  });

  it("follows the attach order, not the order the teams were read in", () => {
    const teams = teamsOf(team("t1", [member("a")]), team("t2", [member("c")]));
    expect(onProject(row({ attachedTeamIds: ["t2", "t1"] }), teams)).toEqual(["c", "a"]);
  });

  it("lists each person once, keeping the first place: manager, listed, two teams", () => {
    const ids = onProject(
      row({ projectManagerId: "x", memberIds: ["y", "x"], attachedTeamIds: ["t1", "t2"] }),
      teamsOf(team("t1", [member("x"), member("y"), member("z")]), team("t2", [member("z"), member("w")])),
    );
    expect(ids).toEqual(["x", "y", "z", "w"]);
  });

  it("has no manager entry when the project has none yet", () => {
    expect(onProject(row({ memberIds: ["m"] }), "unavailable")).toEqual(["m"]);
  });

  it("a team that is not attached counts nothing, even when its facts are at hand (detach, AC-4.5)", () => {
    const teams = teamsOf(team("t1", [member("a")]), team("t2", [member("b")]));
    expect(onProject(row({ attachedTeamIds: ["t1"] }), teams)).toEqual(["a"]);
    expect(onProject(row({ attachedTeamIds: [] }), teams)).toEqual([]);
  });

  it("leaves out the deactivated and the no-access, and keeps an archived team's members (AC-4.7)", () => {
    const ids = onProject(
      row({ attachedTeamIds: ["t1", "t2"] }),
      teamsOf(
        team("t1", [member("a"), member("gone", { active: false, appAccess: false }), member("no", { appAccess: false })]),
        team("t2", [member("b")], { archived: true }),
      ),
    );
    expect(ids).toEqual(["a", "b"]);
  });

  it("a listed member stays on the project when they have no access or are deactivated in a team: the list is the manager's choice", () => {
    const ids = onProject(
      row({ memberIds: ["no"], attachedTeamIds: ["t1"] }),
      teamsOf(team("t1", [member("no", { appAccess: false })])),
    );
    expect(ids).toEqual(["no"]);
  });

  it("a project with no team never needs the teams: 'unavailable' facts change nothing", () => {
    expect(onProject(row({ projectManagerId: "pm", memberIds: ["m"] }), "unavailable")).toEqual(["pm", "m"]);
  });

  it("is 'unavailable' when a team is attached and the teams could not be read (D3)", () => {
    expect(onProject(row({ projectManagerId: "pm", attachedTeamIds: ["t1"] }), "unavailable")).toBe("unavailable");
  });

  it("is 'unavailable' when ONE attached team is missing from what was read: unknown is never 'nobody'", () => {
    const ids = onProject(row({ attachedTeamIds: ["t1", "t2"] }), teamsOf(team("t1", [member("a")])));
    expect(ids).toBe("unavailable");
  });

  it("does not mutate its inputs", () => {
    const input = row({ memberIds: ["m"], attachedTeamIds: ["t1"] });
    const t1 = team("t1", [member("a"), member("m")]);
    const snapshot = JSON.stringify([input, t1]);
    onProject(input, teamsOf(t1));
    expect(JSON.stringify([input, t1])).toBe(snapshot);
  });
});

describe("onProjectKnown (the part that is known, for the view)", () => {
  it("says what is known and whether it is all: a missing team leaves the others in", () => {
    const known = onProjectKnown(
      row({ projectManagerId: "pm", memberIds: ["m"], attachedTeamIds: ["t1", "t2"] }),
      teamsOf(team("t2", [member("c")])),
    );
    expect(known).toEqual({ ids: ["pm", "m", "c"], complete: false });
  });

  it("is complete when every attached team is known, and with 'unavailable' knows only the listed people", () => {
    expect(onProjectKnown(row({ memberIds: ["m"], attachedTeamIds: ["t1"] }), teamsOf(team("t1", [member("a")])))).toEqual({
      ids: ["m", "a"],
      complete: true,
    });
    expect(onProjectKnown(row({ projectManagerId: "pm", attachedTeamIds: ["t1"] }), "unavailable")).toEqual({
      ids: ["pm"],
      complete: false,
    });
    expect(onProjectKnown(row({ projectManagerId: "pm" }), "unavailable")).toEqual({ ids: ["pm"], complete: true });
  });

  it("agrees with onProject: the same ids when complete, 'unavailable' exactly when not", () => {
    const cases = [
      row({ attachedTeamIds: ["t1"] }),
      row({ projectManagerId: "pm", memberIds: ["m"], attachedTeamIds: ["t1", "t2"] }),
      row({ memberIds: ["m"] }),
    ];
    const teams = teamsOf(team("t1", [member("a")]));
    for (const r of cases) {
      const known = onProjectKnown(r, teams);
      expect(onProject(r, teams)).toEqual(known.complete ? known.ids : "unavailable");
    }
  });
});

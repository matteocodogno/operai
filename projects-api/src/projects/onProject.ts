/**
 * Who is on a project: the one rule, once (specs/20261126-teams, decision D4; AC-4.4, AC-4.5, AC-4.7).
 *
 * Pure: the activity-host (`assignees`), the meeting-host (`hostVisible`) and the project view (`onProject`) all call
 * it with the facts they hold, so the three never disagree and the browser keeps no copy of the rule.
 *
 * The order is the project manager, then the listed members (the order the caller passes, the join order), then the
 * counted members of each attached team (the attach order the caller passes, each team's members in the order auth
 * answered them: by name), each person once at their first place.
 *
 * A team's member counts only when they are ACTIVE and hold access to Projects (AC-4.7): `appAccess` is auth's answer
 * to "does this person hold (projects, access)", and it is false for a deactivated one. An ARCHIVED team still counts
 * (AC-1.5, O4): archiving is a statement about the team's offer, not about the people already on a project. A team
 * that is not in `attachedTeamIds` counts nothing, whatever facts are at hand (detach, AC-4.5).
 *
 * UNKNOWN IS NOT NOBODY (D3). When a team is attached and its members are not known (the read failed, was refused, or
 * auth does not know the id) the answer is `"unavailable"`, never the members known without it: a decision made from
 * the listed people alone would refuse someone who is on the project through the team. The people that ARE known are
 * still available as `onProjectKnown`, for the project view, which shows a page rather than refusing it.
 */

import type { TeamFact } from "../lib/teams";

/** What the rule reads of a project: its manager, its listed members and the ids of its attached teams, in order. */
export interface OnProjectRow {
  readonly projectManagerId: string | null;
  /** Listed members, in join order. */
  readonly memberIds: readonly string[];
  /** Attached team ids, in attach order. */
  readonly attachedTeamIds: readonly string[];
}

/** The members of `team` who count as on a project: active, with access to Projects (AC-4.7); archived teams count. */
export function countedMembers(team: TeamFact): string[] {
  return team.members.filter((member) => member.active && member.appAccess).map((member) => member.id);
}

/**
 * The people known to be on the project, and whether that is everyone. `teams` is `"unavailable"` when no team could be
 * read at all; a team missing from the map is one whose members are unknown. `complete` is false exactly then.
 */
export function onProjectKnown(
  row: OnProjectRow,
  teams: ReadonlyMap<string, TeamFact> | "unavailable",
): { ids: string[]; complete: boolean } {
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string | null) => {
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  add(row.projectManagerId);
  for (const id of row.memberIds) add(id);

  let complete = true;
  for (const teamId of row.attachedTeamIds) {
    const team = teams === "unavailable" ? undefined : teams.get(teamId);
    if (team === undefined) {
      complete = false;
      continue;
    }
    for (const id of countedMembers(team)) add(id);
  }
  return { ids, complete };
}

/** Who is on the project, or `"unavailable"` when an attached team's members are unknown (D3, AC-5.4). */
export function onProject(
  row: OnProjectRow,
  teams: ReadonlyMap<string, TeamFact> | "unavailable",
): string[] | "unavailable" {
  const known = onProjectKnown(row, teams);
  return known.complete ? known.ids : "unavailable";
}

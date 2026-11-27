/**
 * The team half of the `Project` view (specs/20261126-teams T12; D3, D9, D10, D15; AC-1.3, AC-4.3, AC-4.4, AC-4.7,
 * AC-5.4, AC-5.6).
 *
 * Every answer that carries a `Project` sets `teams`, `onProject`, `onProjectComplete`, `teamsStatus` and
 * `teamsRetryAfterSeconds` together, from ONE outcome of the page's team read:
 *
 *   - the project has no attached team: nothing is read, nothing is counted (`teams: []`, complete);
 *   - the read was admitted (`admitTeamRead`, D15) and made fresh, so a rename shows on the next load (AC-1.3); a failed
 *     read uses an entry of at most 60 s, else that team is unavailable (its name from an older entry when one is held);
 *   - the read was NOT admitted: nothing is read, no cache entry is served or refreshed, every team is marked, and the
 *     status says whose window refused (`rate_limited` for the person's own, `unavailable` for the service's).
 *
 * The page always loads. Who is on the project is `onProjectKnown`: the part that is known, flagged incomplete.
 */

import { admitTeamRead } from "../lib/rateLimiter";
import { teamReader, type TeamFact, type TeamsRead } from "../lib/teams";
import type { People, Person } from "../lib/people";
import { onProjectKnown } from "./onProject";
import type { ProjectRow } from "./projects.routes";
import type { TeamsStatus } from "./projects.schemas";

/** What the page's team read came to: its answer, or the refusal of one of the two windows (D15). */
export type TeamsOutcome =
  | { readonly kind: "read"; readonly read: TeamsRead }
  | { readonly kind: "refused"; readonly window: "person" | "service"; readonly retryAfterSeconds: number | null };

/** The view's own read: `null` when no team is attached (nothing to read, nothing counted). */
export async function readTeamsForView(sub: string, teamIds: readonly string[]): Promise<TeamsOutcome | null> {
  if (teamIds.length === 0) return null;
  const admission = admitTeamRead(sub);
  if (!admission.admitted) {
    return { kind: "refused", window: admission.window, retryAfterSeconds: admission.retryAfterSeconds };
  }
  return { kind: "read", read: await teamReader.fresh(teamIds, { fallback: true }) };
}

const teamView = (fact: TeamFact) => ({
  id: fact.id,
  name: fact.name,
  archived: fact.archived,
  members: fact.members.map((member) => ({
    id: member.id,
    name: member.name,
    deleted: !member.active,
    projectsAccess: member.appAccess,
  })),
});

/** The five team fields of the view, from the row, the outcome of the read and the lookup of the people it loaded. */
export function teamFields(row: ProjectRow, outcome: TeamsOutcome | null, person: People) {
  const attachedTeamIds = row.attachedTeams.map((attached) => attached.teamId);
  const listed = new Set([row.projectManagerId, ...row.members.map((member) => member.userId)]);
  const facts: ReadonlyMap<string, TeamFact> = outcome?.kind === "read" ? outcome.read.teams : new Map();
  const known = onProjectKnown(
    { projectManagerId: row.projectManagerId, memberIds: row.members.map((member) => member.userId), attachedTeamIds },
    facts,
  );

  // A person counted through a team is named by the team read, not by the identity lookup (D10).
  const teamNames = new Map<string, string | null>();
  for (const fact of facts.values()) for (const member of fact.members) teamNames.set(member.id, member.name);
  const personOf = (id: string): Person =>
    listed.has(id) ? person(id) : { id, name: teamNames.get(id) ?? null, deleted: false };

  const teams = attachedTeamIds.map((id) => {
    const fact = facts.get(id);
    if (fact !== undefined) return teamView(fact);
    // Not read: the name of an older entry when one is held (D9, AC-5.4), nothing when the person was not admitted.
    const label = outcome?.kind === "read" ? (outcome.read.unavailable.get(id) ?? null) : null;
    return { id, name: label?.name ?? null, archived: label?.archived ?? null, members: null };
  });

  let teamsStatus: TeamsStatus = "complete";
  let teamsRetryAfterSeconds: number | null = null;
  if (!known.complete) {
    if (outcome?.kind === "refused" && outcome.window === "person") {
      teamsStatus = "rate_limited";
      teamsRetryAfterSeconds = outcome.retryAfterSeconds;
    } else {
      teamsStatus = "unavailable";
    }
  }
  return {
    teams,
    onProject: known.ids.map(personOf),
    onProjectComplete: known.complete,
    teamsStatus,
    teamsRetryAfterSeconds,
  };
}

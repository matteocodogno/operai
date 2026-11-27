/**
 * Fixtures of the Teams journeys (specs/20261126-teams, T6; extended by T17's projects-teams journeys).
 *
 * Nothing here is a stub: a team is made the way an administrator makes one, through `auth`'s admin API
 * (`POST /admin/teams`, `POST /admin/teams/{id}/members`, `POST /admin/teams/{id}/archive`), as a session that holds
 * the `admin` role. Teams are never deleted through the API (AC-1.7: no DELETE), so cleanup is the one direct
 * database access the suite already has to `auth`'s database (the `bun -e` bridge of legalEntitiesFixtures.ts):
 * every team whose name carries the run tag goes, with its members and its audit rows.
 *
 * Tag every team name with the run id (`teamName(RUN, 'alpha')`), so a crashed run leaves rows a later
 * `cleanupTeams(tag)` can still find, and two runs never meet on the case-insensitive unique name (AC-1.2).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { authCall, type Call } from '../fixtures/letterheads'
import { seedUserSession, type SeededSession } from './adminSession'
import { PROJECTS_API_URL, apiCall, type ApiResult } from './activitiesFixtures'

export type { SeededSession }

const AUTH_DIR = fileURLToPath(new URL('../../../auth/', import.meta.url))

/** The wire shape of a team in `GET /admin/teams` and of the detail without its members. */
export interface TeamRow {
  id: string
  name: string
  description: string | null
  archived: boolean
  version: number
  activeMemberCount: number
}

export interface TeamMemberRow {
  id: string
  name: string
  email: string
  deactivated: boolean
  addedAt: string
}

export interface TeamDetailRow extends TeamRow {
  members: TeamMemberRow[]
}

/** A team name that carries the run tag: `<label> <tag>` (1 to 80 characters). */
export const teamName = (tag: string, label: string): string => `${label} ${tag}`

async function mustOk<T>(what: string, result: Call<T>, ok: number[] = [200, 201]): Promise<T> {
  if (!ok.includes(result.status)) {
    throw new Error(`[teamsFixtures] ${what} answered ${result.status}: ${JSON.stringify(result.body).slice(0, 600)}`)
  }
  return result.body
}

/** Creates a team as `admin` (the real route: version 1, active, no members). */
export async function createTeam(admin: SeededSession, name: string, description?: string): Promise<TeamDetailRow> {
  return mustOk(
    'POST /admin/teams',
    await authCall<TeamDetailRow>(
      admin,
      'POST',
      '/admin/teams',
      description === undefined ? { name } : { name, description },
    ),
  )
}

/** One team with its members. */
export async function getTeam(admin: SeededSession, teamId: string): Promise<TeamDetailRow> {
  return mustOk(`GET /admin/teams/${teamId}`, await authCall<TeamDetailRow>(admin, 'GET', `/admin/teams/${teamId}`))
}

/** Every team (archived ones included). */
export async function listTeams(admin: SeededSession): Promise<TeamRow[]> {
  const body = await mustOk('GET /admin/teams', await authCall<unknown>(admin, 'GET', '/admin/teams'))
  return (Array.isArray(body) ? body : (body as { items: TeamRow[] }).items) as TeamRow[]
}

/** Adds `userId` to the team (an active user only; adding a member again is a 200 no-op). Returns the team as it is then. */
export async function addMember(admin: SeededSession, teamId: string, userId: string): Promise<TeamDetailRow> {
  return mustOk(
    `POST /admin/teams/${teamId}/members`,
    await authCall<TeamDetailRow>(admin, 'POST', `/admin/teams/${teamId}/members`, { userId }),
  )
}

/** Removes `userId` from the team (a person who is not a member is a 200 no-op). */
export async function removeMember(admin: SeededSession, teamId: string, userId: string): Promise<void> {
  await mustOk(
    `DELETE /admin/teams/${teamId}/members/${userId}`,
    await authCall(admin, 'DELETE', `/admin/teams/${teamId}/members/${userId}`),
  )
}

/** Renames a team as `admin` (the real route, at the team's current version). */
export async function renameTeam(admin: SeededSession, teamId: string, name: string): Promise<TeamDetailRow> {
  const current = await getTeam(admin, teamId)
  return mustOk(
    `PATCH /admin/teams/${teamId}`,
    await authCall<TeamDetailRow>(admin, 'PATCH', `/admin/teams/${teamId}`, { baseVersion: current.version, name }),
  )
}

/** Archives the team at its current version (read first, so the `baseVersion` is the one a fresh page would send). */
export async function archiveTeam(admin: SeededSession, teamId: string): Promise<TeamDetailRow> {
  const current = await getTeam(admin, teamId)
  return mustOk(
    `POST /admin/teams/${teamId}/archive`,
    await authCall<TeamDetailRow>(admin, 'POST', `/admin/teams/${teamId}/archive`, { baseVersion: current.version }),
  )
}

/** Restores an archived team at its current version. */
export async function restoreTeam(admin: SeededSession, teamId: string): Promise<TeamDetailRow> {
  const current = await getTeam(admin, teamId)
  return mustOk(
    `POST /admin/teams/${teamId}/restore`,
    await authCall<TeamDetailRow>(admin, 'POST', `/admin/teams/${teamId}/restore`, { baseVersion: current.version }),
  )
}

// ─── People (T17) ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface RoleRow {
  id: string
  name: string
}

/**
 * A person with the system role `project-manager` (`projects:access` + `project:manage` for the entity of their own
 * `entity` attribute) and that entity, as a fresh session (the role change moves `perm_epoch`, a claim of the token).
 * Made through auth's admin API as `admin`, like every other persona. The e-mail must be a run-tagged @operai.test
 * address (`cleanupPeople` / `cleanupFixtures` remove it).
 */
export async function seedProjectManager(
  admin: SeededSession,
  email: string,
  name: string,
  entity: 'welld_ch' | 'welld_it',
): Promise<SeededSession> {
  const first = await seedUserSession(email, name)
  const roles = await mustOk(
    'GET /admin/roles',
    await authCall<RoleRow[] | { items: RoleRow[] }>(admin, 'GET', '/admin/roles'),
  )
  const list = Array.isArray(roles) ? roles : roles.items
  const role = list.find((r) => r.name === 'project-manager')
  if (!role) throw new Error('[teamsFixtures] the role "project-manager" does not exist (has the auth seed run?)')
  await mustOk(
    'PUT /admin/users/{id}/roles',
    await authCall(admin, 'PUT', `/admin/users/${first.userId}/roles`, { roleIds: [role.id] }),
  )
  await mustOk('PATCH /admin/users/{id}', await authCall(admin, 'PATCH', `/admin/users/${first.userId}`, { entity }))
  return seedUserSession(email, name)
}

// ─── Projects with teams (T17) ─────────────────────────────────────────────────────────────────────────────────────────

/** The part of a project's view the teams journeys read. */
export interface ProjectTeamsView {
  id: string
  version: number
  teams: Array<{
    id: string
    name: string | null
    archived: boolean | null
    members: Array<{ id: string; name: string | null; deleted: boolean; projectsAccess: boolean }> | null
  }>
  onProject: Array<{ id: string }> | null
  onProjectComplete: boolean
  teamsStatus: 'complete' | 'unavailable' | 'rate_limited'
  teamsRetryAfterSeconds: number | null
}

/** One project as `session` reads it (setup and verification; every read of a project with teams counts against D15). */
export const readProject = (session: SeededSession, id: string): Promise<ApiResult<ProjectTeamsView>> =>
  apiCall<ProjectTeamsView>(PROJECTS_API_URL, session, 'GET', `/projects/${id}`)

/** `PUT /projects/{id}/teams` at `version` (the `If-Match` precondition); never throws on a status. */
export const putProjectTeams = (
  session: SeededSession,
  id: string,
  version: number,
  teamIds: string[],
): Promise<ApiResult<ProjectTeamsView & { code?: string }>> =>
  apiCall(PROJECTS_API_URL, session, 'PUT', `/projects/${id}/teams`, { teamIds }, { 'If-Match': `"${version}"` })

/** Detaches every team of a project (best effort: a cleanup never fails a run). */
export async function detachTeamsQuietly(session: SeededSession, id: string): Promise<void> {
  try {
    const current = await readProject(session, id)
    if (current.status === 200 && current.body.teams.length > 0)
      await putProjectTeams(session, id, current.body.version, [])
  } catch {
    // cleanup must never fail a run
  }
}

/**
 * Runs a script on `auth`'s database client: plain `bun` first (the environment `auth` itself loads), then
 * `direnv exec .` (`auth/.envrc`): the same two setups, in the same order, as helpers/inviteFixtures.ts `runFixtureScript`.
 */
function authDb(script: string): string {
  try {
    return execFileSync('bun', ['-e', script], { cwd: AUTH_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return execFileSync('direnv', ['exec', '.', 'bun', '-e', script], {
      cwd: AUTH_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}

function lastJson(output: string): unknown {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{') || l.startsWith('['))
  if (!line) throw new Error(`[teamsFixtures] no JSON from the cleanup script: ${output.slice(0, 400)}`)
  return JSON.parse(line)
}

/**
 * Deletes every team whose name contains `tag`, with its members and the audit rows about it (direct to `auth`'s
 * database: no route deletes a team). Members go first (`team_member.teamId` is RESTRICT). Call it BEFORE
 * `cleanupFixtures(tag)` deletes the users, or after: the member rows cascade with their user either way.
 * Best effort: a cleanup failure never fails the suite; it returns how many teams it removed (or -1 on failure).
 * Refuses a tag too short to be a run id, so a mistake cannot match real teams.
 */
export function cleanupTeams(tag: string): number {
  if (tag.length < 4)
    throw new Error(`[teamsFixtures] refusing to clean up with the tag "${tag}": too short to be a run id`)
  const script = `
    import { db } from ${JSON.stringify(`${AUTH_DIR}src/lib/db`)}
    const teams = await db.team.findMany({ where: { name: { contains: ${JSON.stringify(tag)}, mode: 'insensitive' } }, select: { id: true } })
    const ids = teams.map((t) => t.id)
    if (ids.length > 0) {
      await db.teamMember.deleteMany({ where: { teamId: { in: ids } } })
      await db.auditLog.deleteMany({ where: { targetType: 'team', targetId: { in: ids } } })
      await db.team.deleteMany({ where: { id: { in: ids } } })
    }
    console.log(JSON.stringify({ ok: true, deletedTeams: ids.length }))
    await db.$disconnect()
  `
  try {
    const output = authDb(script)
    return (lastJson(output) as { deletedTeams: number }).deletedTeams
  } catch {
    return -1
  }
}

/** How many teams carry `tag` right now (the database, not the API): what a cleanup check reads. */
export function countTeams(tag: string): number {
  const script = `
    import { db } from ${JSON.stringify(`${AUTH_DIR}src/lib/db`)}
    const n = await db.team.count({ where: { name: { contains: ${JSON.stringify(tag)}, mode: 'insensitive' } } })
    console.log(JSON.stringify({ n }))
    await db.$disconnect()
  `
  const output = authDb(script)
  return (lastJson(output) as { n: number }).n
}

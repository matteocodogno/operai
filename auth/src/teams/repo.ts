/**
 * The team reads both routers share (specs/20261126-teams, plan § auth admin routes): the summary (list, and the
 * head of the detail) and the detail with its members. A team grants nothing: nothing here, and no other module
 * of the permission path, reads these tables for an authorization decision (AC-2.5).
 *
 * `activeMemberCount` counts members whose user is not soft-deleted; a soft-deleted member is still a member and
 * is listed `deactivated: true`, last (AC-2.3). The count is derived on read from `user.deletedAt`, never stored,
 * so clearing `deletedAt` counts the person again.
 *
 * Every function takes the client to read through, defaulting to `db`, so a test reads through the rolled-back
 * transaction it wrote in and a route can read inside its own transaction.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";

/** The most members a team holds, deactivated ones included (AC-2.4, plan D7, O9). */
export const TEAM_MEMBER_LIMIT = 100;

export type Reader = Pick<typeof db, "team">;

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  activeMemberCount: number;
  version: number;
}

export interface TeamMemberAdmin {
  id: string;
  name: string;
  email: string;
  deactivated: boolean;
  /** ISO 8601. */
  addedAt: string;
}

export interface TeamDetail extends TeamSummary {
  createdAt: string;
  updatedAt: string;
  members: TeamMemberAdmin[];
}

const nameCollator = new Intl.Collator("it", { sensitivity: "base" });

/** Name order, then the stored casing, then id: a total order, so two reads of one state agree. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  nameCollator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1);

const SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  archivedAt: true,
  version: true,
  _count: { select: { members: { where: { user: { deletedAt: null } } } } },
} satisfies Prisma.TeamSelect;

type SummaryRow = Prisma.TeamGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(row: SummaryRow): TeamSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archivedAt !== null,
    activeMemberCount: row._count.members,
    version: row.version,
  };
}

/** Every team, archived included, in name order (the admin list filters on the client). */
export async function listTeamSummaries(client: Reader = db): Promise<TeamSummary[]> {
  const rows = await client.team.findMany({ select: SUMMARY_SELECT });
  return rows.map(toSummary).sort(byName);
}

/** One team with its members, or `null` when no team has this id. */
export async function getTeamDetail(id: string, client: Reader = db): Promise<TeamDetail | null> {
  const row = await client.team.findUnique({
    where: { id },
    select: {
      ...SUMMARY_SELECT,
      createdAt: true,
      updatedAt: true,
      members: {
        select: {
          addedAt: true,
          user: { select: { id: true, name: true, email: true, deletedAt: true } },
        },
      },
    },
  });
  if (row === null) return null;

  const members: TeamMemberAdmin[] = row.members.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    deactivated: m.user.deletedAt !== null,
    addedAt: m.addedAt.toISOString(),
  }));
  members.sort(
    (a, b) =>
      Number(a.deactivated) - Number(b.deactivated) ||
      nameCollator.compare(a.name, b.name) ||
      (a.email < b.email ? -1 : a.email > b.email ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );

  return {
    ...toSummary(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    members,
  };
}

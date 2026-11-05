/**
 * `MeetingRow`: the compact meeting every LIST returns (specs/021-meetings plan.md
 * § API contracts; AC-10.2, AC-10.3, AC-11.2). Three lists share it (My meetings, a host
 * entity's meetings, the linkable meetings), so how a row's derived status, summary count,
 * creator and host label are decided lives here once.
 *
 * Everything is batched per page: one query for the summary counts, one for the sessions of
 * the rows still `recording`, one identities lookup, and ONE host resolve per distinct host
 * (the client batches up to 25 ids a call and a page is 25 rows). Every lookup that only
 * labels fails SOFT: a creator reads "unknown", a host label reads `unavailable`.
 */

import { db } from "../lib/db";
import { resolveIdentities as liveDisplayIdentities, toPersonRef, type PersonRef } from "../lib/identities";
import { resolve as resolveAtHost } from "../hosts/client";
import { hostRegistry } from "../hosts/registry";
import { derivedStatus, type DerivedStatus } from "./derived";
import type { HostView, ViewDeps } from "./view";
import type { MeetingFormat, MeetingStatus } from "../lib/generated/prisma/enums";
import type { MeetingRole } from "./visibility";

export interface MeetingRow {
  id: string;
  title: string;
  startsAt: string;
  format: MeetingFormat;
  status: DerivedStatus;
  host: HostView | null;
  /** `host_reader` only appears in a host entity's own list (the viewer opens it through the host). */
  role: MeetingRole;
  summaryCount: number;
  creator: PersonRef;
}

/** The `meeting` columns a row is built from (a Prisma row satisfies it). */
export interface RowSource {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly format: MeetingFormat;
  readonly status: MeetingStatus;
  readonly creatorUserId: string;
  readonly hostApp: string | null;
  readonly hostEntityType: string | null;
  readonly hostEntityId: string | null;
}

export const hostKey = (app: string, entityType: string, entityId: string): string => `${app}\u0000${entityType}\u0000${entityId}`;

export interface RowOptions {
  readonly authorization: string;
  readonly now: Date;
  readonly roleOf: (row: RowSource) => MeetingRole;
  /** Host labels already known (e.g. the entity a host list is about); not asked for again. */
  readonly knownHosts?: ReadonlyMap<string, HostView>;
  readonly deps?: ViewDeps;
}

/** The label of every distinct host entity among `rows`, one resolve call per host. Never throws. */
async function hostViews(rows: readonly RowSource[], options: RowOptions): Promise<Map<string, HostView>> {
  const views = new Map<string, HostView>(options.knownHosts ?? []);
  const wanted = new Map<string, { app: string; entityType: string; ids: Set<string> }>();
  for (const row of rows) {
    if (row.hostApp === null || row.hostEntityType === null || row.hostEntityId === null) continue;
    if (views.has(hostKey(row.hostApp, row.hostEntityType, row.hostEntityId))) continue;
    const group = wanted.get(`${row.hostApp}\u0000${row.hostEntityType}`) ?? { app: row.hostApp, entityType: row.hostEntityType, ids: new Set<string>() };
    group.ids.add(row.hostEntityId);
    wanted.set(`${row.hostApp}\u0000${row.hostEntityType}`, group);
  }

  const registry = options.deps?.registry ?? hostRegistry();
  const resolveHost = options.deps?.resolveHost ?? resolveAtHost;
  await Promise.all(
    [...wanted.values()].map(async (group) => {
      const ids = [...group.ids];
      const unavailable = (id: string): HostView => ({ app: group.app, entityType: group.entityType, entityId: id, state: "unavailable", title: null, href: null });
      const definition = registry.get(group.app, group.entityType);
      // A host that left the registry cannot label anything.
      const answer = definition ? await resolveHost(definition, options.authorization, ids).catch(() => null) : null;
      for (const id of ids) {
        const key = hostKey(group.app, group.entityType, id);
        const entity = answer && answer.state === "ok" ? answer.entities.get(id) : undefined;
        if (!entity) views.set(key, unavailable(id));
        else if (entity.state === "open") {
          views.set(key, { app: group.app, entityType: group.entityType, entityId: id, state: "open", title: entity.title ?? null, href: entity.href ?? null });
        } else {
          views.set(key, { app: group.app, entityType: group.entityType, entityId: id, state: entity.state, title: null, href: null });
        }
      }
    }),
  );
  return views;
}

export async function buildMeetingRows(rows: readonly RowSource[], options: RowOptions): Promise<MeetingRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const recordingIds = rows.filter((r) => r.status === "recording").map((r) => r.id);

  const [counts, sessions, people, hosts] = await Promise.all([
    db.summary.groupBy({ by: ["meetingId"], where: { meetingId: { in: ids } }, _count: { _all: true } }),
    recordingIds.length === 0
      ? Promise.resolve([])
      : db.recordingSession.findMany({ where: { meetingId: { in: recordingIds } }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] }),
    (options.deps?.resolveIdentities ?? liveDisplayIdentities)(options.authorization, [...new Set(rows.map((r) => r.creatorUserId))]),
    hostViews(rows, options),
  ]);

  const summaryCount = new Map(counts.map((c) => [c.meetingId, c._count._all]));
  const latest = new Map<string, (typeof sessions)[number]>();
  for (const session of sessions) if (!latest.has(session.meetingId)) latest.set(session.meetingId, session);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    format: row.format,
    status: derivedStatus(row.status, latest.get(row.id) ?? null, options.now),
    host:
      row.hostApp !== null && row.hostEntityType !== null && row.hostEntityId !== null
        ? (hosts.get(hostKey(row.hostApp, row.hostEntityType, row.hostEntityId)) ?? null)
        : null,
    role: options.roleOf(row),
    summaryCount: summaryCount.get(row.id) ?? 0,
    creator: toPersonRef(people.get(row.creatorUserId) ?? { id: row.creatorUserId, name: null, status: "unknown" }),
  }));
}

/** The columns `buildMeetingRows` needs, for a Prisma `select`. */
export const ROW_SELECT = {
  id: true,
  title: true,
  startsAt: true,
  format: true,
  status: true,
  creatorUserId: true,
  hostApp: true,
  hostEntityType: true,
  hostEntityId: true,
} as const;

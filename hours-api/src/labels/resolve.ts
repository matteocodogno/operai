/**
 * The labels layer (specs/20261112-time-tracking T13; plan § Sequences "List / totals" step 4, § Views, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route;
 * AC-2.6, AC-2.9, AC-4.7, AC-4.8, AC-4.10).
 *
 * The names next to an entry belong to other services, and what a name may be shown to depends on WHO
 * is looking. So every name is read from the owner that holds it, as the VIEWER where an owner can answer as one,
 * and never stored here. Read live, every source but `identities`: people's names are kept in process memory for at most
 * 60 s, one map for every viewer, so a rename shows within that (plan § Sequences "Names", `src/lib/identities.ts`):
 *
 *   identities      auth        people's names                       (the viewer's Authorization)
 *   projects        projects-api  project labels                     (as the viewer)
 *   crm             crm-api     deal labels                          (as the viewer)
 *   activities      activities-api  the activity an entry points at  (as the viewer)
 *   meetings        meetings-api  meeting titles                     (as the viewer: only their own)
 *   meeting-deals   meetings-api system route  a meeting's current deal  (hours-api's OWN credential)
 *   meeting-projects  the same system route    a meeting's current project, from the SAME read as its deal
 *                   (a meeting has one host: specs/20261112-project-hours D78)
 *
 * Every source FAILS SOFT and independently: one that does not answer degrades the part it covers
 * (`visibility: "unavailable"`, `{ state: "unknown" }`, a person of status `unknown`) and is named in
 * `Labels.unavailable`; the entries stay listed and counted (AC-4.7). A source is asked only when
 * something needs it, so `unavailable` names exactly the sources a read needed (a read that groups by deal
 * asks `meetingDealIds` and never projects-api; one that groups by project asks `meetingProjectIds` and never crm-api;
 * an entry view asks both, and makes ONE call to the system route for them).
 */

import { listActivitiesByIds } from "../clients/activities";
import { resolveDeals } from "../clients/crm";
import { listMeetingsByIds, readMeetingHosts, type MeetingHost, type MeetingHosts } from "../clients/meetings";
import { resolveProjects } from "../clients/projects";
import type { ResolveOutcome } from "../clients/owner";
import { resolveIdentities, type Identity } from "../lib/identities";
import { satisfiesIdRule } from "./idRule";
import {
  SOURCE_ORDER,
  type ActivityLabel,
  type EntityLabel,
  type MeetingDeal,
  type MeetingProject,
  type Person,
  type SourceName,
  type UnavailableSources,
} from "./types";

/** What a read needs labelled: ids by kind. A kind with no ids asks no source. */
export interface LabelNeeds {
  /** Entry authors (or the people a totals grouping lists). */
  readonly userIds?: Iterable<string>;
  /** Projects an entry (or a totals group) is on. */
  readonly projectIds?: Iterable<string>;
  /** Deals an entry (or a totals group) is on. */
  readonly dealIds?: Iterable<string>;
  /** Meetings whose TITLE is wanted: read as the viewer, so only meetings the viewer took part in answer. */
  readonly meetingIds?: Iterable<string>;
  /**
   * Meetings whose CURRENT DEAL is wanted (AC-2.6): read from meetings-api's system route with hours-api's own
   * credential, and the deals they name join the same crm-api batch as `dealIds`.
   */
  readonly meetingDealIds?: Iterable<string>;
  /**
   * Meetings whose CURRENT PROJECT is wanted (specs/20261112-project-hours AC-4.7, AC-4.10): read from the SAME system route as `meetingDealIds`,
   * in the same single call when a read wants both, and the projects they name join the same projects-api batch as `projectIds`. Asked
   * apart from `meetingDealIds` so that a read which groups by deal never asks projects-api, and one which groups by project never asks crm-api.
   */
  readonly meetingProjectIds?: Iterable<string>;
  /** Activities entries point at (AC-2.7): read as the viewer, so only an activity they may read answers. */
  readonly activityIds?: Iterable<string>;
}

export interface Labels {
  /** The sources that were asked and did not answer, in the order of the plan's `Unavailable` type. */
  readonly unavailable: UnavailableSources;
  person(userId: string): Person;
  project(projectId: string): EntityLabel;
  /** A deal asked directly, or one a listed meeting is linked to (and whose id is inside the id rule). */
  deal(dealId: string): EntityLabel;
  meeting(meetingId: string): EntityLabel;
  meetingDeal(meetingId: string): MeetingDeal;
  /** The project a listed meeting counts for: the deal's twin, one host read for both. */
  meetingProject(meetingId: string): MeetingProject;
  /**
   * The activity an entry points at, given the label of the project or deal the entry is on (`project()` /
   * `deal()`): what the viewer may be told of it depends on what they may be told of its target.
   * `null`: it is gone (AC-2.9) — only said while the viewer can read the target and activities-api answered.
   */
  activity(activityId: string, target: EntityLabel): ActivityLabel | null;
}

const distinct = (ids: Iterable<string> | undefined): string[] => [...new Set(ids ?? [])];

/** A programmer error, not a runtime condition: a label was asked for that `needs` did not list. */
const notAsked = (kind: string, id: string): never => {
  throw new Error(`labels: ${kind} ${JSON.stringify(id)} was not listed in the needs`);
};

const HIDDEN: EntityLabel = { visibility: "hidden", label: null, href: null };
const UNAVAILABLE: EntityLabel = { visibility: "unavailable", label: null, href: null };

/** What a host resolve says of one entity that hours-api shows: `missing`, or `open` with its name and place. */
type ResolvedEntity = { readonly state: "missing" } | { readonly state: "open"; readonly label: string; readonly href: string };

/**
 * One entity as the viewer reads it, from a host resolve (projects-api, crm-api): a viewer who may not
 * read at all, and an entity the owner does not hold, are the same `hidden` (AC-2.10, AC-4.10); an owner
 * that did not answer is `unavailable` (AC-4.7).
 */
function entityLabel(outcome: ResolveOutcome<ResolvedEntity>, id: string): EntityLabel {
  if (outcome.state === "unavailable") return UNAVAILABLE;
  if (outcome.state === "not_reader") return HIDDEN;
  const item = outcome.items.get(id);
  if (item === undefined || item.state === "missing") return HIDDEN;
  return { visibility: "visible", label: item.label, href: item.href };
}

/** A meeting's page in the suite (`./MyMeetings`, ungated, ADR 20261104-meetings-tool-shape-visibility-by-participation). The id is one path segment whatever it holds. */
const meetingHref = (meetingId: string): string => `/my-meetings/m/${encodeURIComponent(meetingId)}`;

type OkHosts = Extract<MeetingHosts, { readonly state: "ok" }>;

/**
 * The ids `pick` reads from the hosts of the `listed` meetings, that a resolve may be asked. An id read from the system route is stored text
 * this service never saw pass the id rule (plan § Views): outside it the id is NOT sent, because the owner would refuse the whole batch and
 * every record of the page would read `unavailable`; that meeting's link is `{ linked, hidden }` (`meetingLinkOf` below).
 */
const sendableIds = (hosts: OkHosts, listed: ReadonlySet<string>, pick: (host: MeetingHost) => string | null): string[] =>
  [...hosts.items].flatMap(([meetingId, host]) => {
    const id = pick(host);
    return listed.has(meetingId) && id !== null && satisfiesIdRule(id) ? [id] : [];
  });

/**
 * Every deal in ONE crm-api resolve (batches of its cap of 25 only beyond that): the deals a page's deal entries are on and the deals its
 * meetings are linked to go out together, each once, as the viewer. The resolve waits for the meetings' hosts, because it needs their deal
 * ids, but only when a meeting's deal was asked for.
 */
async function resolveDealsAndLinks(
  authorization: string,
  directDealIds: readonly string[],
  hostsRead: Promise<MeetingHosts | undefined>,
  meetingDealSet: ReadonlySet<string>,
) {
  const hosts = meetingDealSet.size > 0 ? await hostsRead : undefined;
  const viaMeetings = hosts?.state === "ok" ? sendableIds(hosts, meetingDealSet, (host) => host.dealId) : [];
  const asked = distinct([...directDealIds, ...viaMeetings]);
  const deals = asked.length > 0 ? await resolveDeals(authorization, asked) : undefined;
  return { deals, asked: new Set(asked) };
}

/**
 * The deals' twin for projects (specs/20261112-project-hours D78): the projects a page's entries are on and the ones its meetings are linked
 * to go to projects-api in ONE resolve, each once, as the viewer.
 */
async function resolveProjectsAndLinks(
  authorization: string,
  directProjectIds: readonly string[],
  hostsRead: Promise<MeetingHosts | undefined>,
  meetingProjectSet: ReadonlySet<string>,
) {
  const hosts = meetingProjectSet.size > 0 ? await hostsRead : undefined;
  const viaMeetings = hosts?.state === "ok" ? sendableIds(hosts, meetingProjectSet, (host) => host.projectId) : [];
  const asked = distinct([...directProjectIds, ...viaMeetings]);
  const projects = asked.length > 0 ? await resolveProjects(authorization, asked) : undefined;
  return { projects, asked: new Set(asked) };
}

/**
 * Reads every needed source, each failing soft. `authorization` is the viewer's own `Authorization` header
 * value, forwarded unchanged to the sources that answer as the viewer.
 */
export async function resolveLabels(authorization: string, needs: LabelNeeds): Promise<Labels> {
  const userIds = distinct(needs.userIds);
  const projectIds = distinct(needs.projectIds);
  const meetingIds = distinct(needs.meetingIds);
  const meetingDealIds = distinct(needs.meetingDealIds);
  const meetingProjectIds = distinct(needs.meetingProjectIds);
  const activityIds = distinct(needs.activityIds);
  const meetingDealSet = new Set(meetingDealIds);
  const meetingProjectSet = new Set(meetingProjectIds);

  // A meeting has one host, so ONE read of the system route answers both its deal and its project; the deals' and the projects' chains below
  // wait for it only when they asked about a meeting. The read never throws (`callOwner`), and when no meeting was asked it is never made.
  const hostIds = distinct([...meetingDealIds, ...meetingProjectIds]);
  const hostsRead: Promise<MeetingHosts | undefined> = hostIds.length > 0 ? readMeetingHosts(hostIds) : Promise.resolve(undefined);

  // At once: no source waits for another, except crm-api and projects-api for the system route (they need the ids that
  // route answers). Each client fails soft and never throws, so one source cannot take the others down.
  const [identities, meetings, activities, { deals, asked: askedDeals }, { projects, asked: askedProjectsAndLinks }] = await Promise.all([
    userIds.length > 0 ? resolveIdentities(authorization, userIds) : new Map<string, Identity>(),
    meetingIds.length > 0 ? listMeetingsByIds(authorization, meetingIds) : undefined,
    activityIds.length > 0 ? listActivitiesByIds(authorization, activityIds) : undefined,
    resolveDealsAndLinks(authorization, distinct(needs.dealIds), hostsRead, meetingDealSet),
    resolveProjectsAndLinks(authorization, projectIds, hostsRead, meetingProjectSet),
  ]);
  const hosts = await hostsRead;
  // What was asked, so that a label for an id nobody listed is a loud error, not a quiet "hidden" or "gone".
  const askedProjects = new Set(projectIds);
  const askedMeetings = new Set(meetingIds);
  const askedActivities = new Set(activityIds);

  const failed = new Set<SourceName>();
  if (projects?.state === "unavailable") failed.add("projects");
  if (activities?.state === "unavailable") failed.add("activities");
  if (deals?.state === "unavailable") failed.add("crm");
  if (meetings?.state === "unavailable") failed.add("meetings");
  // One read, two questions: it is a source of the deal and of the project only for a read that asked about them.
  if (hosts?.state === "unavailable") {
    if (meetingDealSet.size > 0) failed.add("meeting-deals");
    if (meetingProjectSet.size > 0) failed.add("meeting-projects");
  }
  // `auth` answers a person it cannot name `unknown`, as an outage does (`lib/identities.ts`): either way
  // the name is not known, and the read says so.
  if ([...identities.values()].some((identity) => identity.status === "unknown")) failed.add("identities");

  const deal = (dealId: string): EntityLabel => {
    if (deals === undefined || !askedDeals.has(dealId)) return notAsked("deal", dealId);
    return entityLabel(deals, dealId);
  };
  /** A project asked directly, or one a listed meeting is linked to: what `meetingProject` reads. `project()` below answers only the former. */
  const projectOrLinked = (projectId: string): EntityLabel => {
    if (projects === undefined || !askedProjectsAndLinks.has(projectId)) return notAsked("project", projectId);
    return entityLabel(projects, projectId);
  };

  return {
    unavailable: SOURCE_ORDER.filter((source) => failed.has(source)),
    person(userId) {
      const identity = identities.get(userId) ?? notAsked("person", userId);
      return { id: identity.id, name: identity.name, status: identity.status };
    },
    project(projectId) {
      if (!askedProjects.has(projectId)) return notAsked("project", projectId);
      return projectOrLinked(projectId);
    },
    deal,
    meeting(meetingId) {
      if (meetings === undefined || !askedMeetings.has(meetingId)) return notAsked("meeting", meetingId);
      if (meetings.state === "unavailable") return UNAVAILABLE;
      // The list is the viewer's own meetings: a meeting they did not take part in, and one that no longer
      // exists, are both absent, and both read as `hidden` (AC-2.10, AC-4.10).
      const meeting = meetings.items.get(meetingId);
      if (meeting === undefined) return HIDDEN;
      return { visibility: "visible", label: meeting.title, href: meetingHref(meetingId) };
    },
    meetingDeal(meetingId) {
      return meetingLinkOf("deal", hosts, meetingDealSet, meetingId, (host) => host.dealId, deal);
    },
    meetingProject(meetingId) {
      return meetingLinkOf("project", hosts, meetingProjectSet, meetingId, (host) => host.projectId, projectOrLinked);
    },
    activity(activityId, target) {
      if (activities === undefined || !askedActivities.has(activityId)) return notAsked("activity", activityId);
      // The subject is shown only to a viewer who is known to read the entry's project or deal (AC-4.10).
      // A hidden target hides the activity whatever activities-api said and whether or not it still exists
      // (a viewer who cannot read the project must not learn that either); a target that did not answer
      // leaves it unknown whether they may.
      if (target.visibility !== "visible") return { id: activityId, subject: null, visibility: target.visibility };
      // R6: an owner that did not answer says nothing about the activity: kept, never `null`.
      if (activities.state === "unavailable") return { id: activityId, subject: null, visibility: "unavailable" };
      const activity = activities.items.get(activityId);
      // activities-api omits an activity that is gone and one the viewer may not read, alike (AC-2.9).
      if (activity === undefined) return null;
      return { id: activityId, subject: activity.subject, visibility: "visible" };
    },
  };
}

/**
 * The deal or the project a meeting's hours count for (`MeetingDeal` and `MeetingProject` are one shape). Its visibility is the viewer's access
 * to the DEAL or PROJECT, whatever their access to the meeting (AC-4.10, AC-4.7): the id is returned only with `visible`, because the link was
 * read with hours-api's own credential and a viewer who cannot read the record must not learn which record it is. `pick` says which of the
 * host's two links is wanted; the meeting has one host, so the other is `none`.
 */
function meetingLinkOf(
  kind: "deal" | "project",
  hosts: MeetingHosts | undefined,
  listed: ReadonlySet<string>,
  meetingId: string,
  pick: (host: MeetingHost) => string | null,
  label: (id: string) => EntityLabel,
): MeetingDeal & MeetingProject {
  if (hosts === undefined || !listed.has(meetingId)) return notAsked(`meeting ${kind}`, meetingId);
  if (hosts.state === "unavailable") return { state: "unknown" };
  // An id meetings-api does not know: the meeting no longer exists, so it is linked to nothing.
  const host = hosts.items.get(meetingId);
  const id = host === undefined ? null : pick(host);
  if (id === null) return { state: "none" };
  // Stored text outside the id rule is still "linked to a deal" or "to a project"; the owner was never asked, and holds no such record.
  if (!satisfiesIdRule(id)) return { state: "linked", visibility: "hidden" };
  const entity = label(id);
  if (entity.visibility === "visible") {
    return { state: "linked", visibility: "visible", id, label: entity.label, href: entity.href };
  }
  return { state: "linked", visibility: entity.visibility };
}

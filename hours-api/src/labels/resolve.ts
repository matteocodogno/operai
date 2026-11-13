/**
 * The labels layer (specs/029 T13; plan § Sequences "List / totals" step 4, § Views, ADR-0089;
 * AC-2.6, AC-2.9, AC-4.7, AC-4.8, AC-4.10).
 *
 * The names next to an entry belong to other services, and what a name may be shown to depends on WHO
 * is looking. So every name is read live, as the VIEWER where an owner can answer as one, from the
 * owner that holds it, and never stored here:
 *
 *   identities      auth        people's names                       (the viewer's Authorization)
 *   projects        projects-api  project labels                     (as the viewer)
 *   crm             crm-api     deal labels                          (as the viewer)
 *   activities      activities-api  the activity an entry points at  (as the viewer)
 *   meetings        meetings-api  meeting titles                     (as the viewer: only their own)
 *   meeting-deals   meetings-api system route  a meeting's current deal  (hours-api's OWN credential)
 *
 * Every source FAILS SOFT and independently: one that does not answer degrades the part it covers
 * (`visibility: "unavailable"`, `{ state: "unknown" }`, a person of status `unknown`) and is named in
 * `Labels.unavailable`; the entries stay listed and counted (AC-4.7). A source is asked only when
 * something needs it, so `unavailable` names exactly the sources a read needed.
 */

import { listActivitiesByIds } from "../clients/activities";
import { resolveDeals } from "../clients/crm";
import { listMeetingsByIds, readMeetingHosts, type MeetingHosts } from "../clients/meetings";
import { resolveProjects } from "../clients/projects";
import type { ResolveOutcome } from "../clients/owner";
import { resolveIdentities, type Identity } from "../lib/identities";
import { satisfiesIdRule } from "./idRule";
import {
  SOURCE_ORDER,
  type ActivityLabel,
  type EntityLabel,
  type MeetingDeal,
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

/** A meeting's page in the suite (`./MyMeetings`, ungated, ADR-0058). The id is one path segment whatever it holds. */
const meetingHref = (meetingId: string): string => `/my-meetings/m/${encodeURIComponent(meetingId)}`;

/**
 * Meetings' current deals, then every deal in ONE crm-api resolve (batches of its cap of 25 only beyond
 * that): the deals a page's deal entries are on and the deals its meetings are linked to go out together,
 * each once, as the viewer. The second call waits for the first, because it needs its deal ids.
 *
 * A deal id read from the system route is stored text this service never saw pass the id rule (plan § Views):
 * outside it the id is NOT sent, because crm-api would refuse the whole batch and every deal of the page
 * would read `unavailable`; that meeting's deal is `{ linked, hidden }` (`meetingDeal` below).
 */
async function resolveDealsAndLinks(authorization: string, directDealIds: readonly string[], meetingDealIds: readonly string[]) {
  const hosts = meetingDealIds.length > 0 ? await readMeetingHosts(meetingDealIds) : undefined;
  const viaMeetings =
    hosts?.state === "ok" ? [...hosts.items.values()].flatMap((host) => (host.dealId !== null && satisfiesIdRule(host.dealId) ? [host.dealId] : [])) : [];
  const asked = distinct([...directDealIds, ...viaMeetings]);
  const deals = asked.length > 0 ? await resolveDeals(authorization, asked) : undefined;
  return { hosts, deals, asked: new Set(asked) };
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
  const activityIds = distinct(needs.activityIds);

  // At once: no source waits for another, except crm-api for the system route (it needs the deal ids that
  // route answers). Each client fails soft and never throws, so one source cannot take the others down.
  const [identities, projects, meetings, activities, { hosts, deals, asked: askedDeals }] = await Promise.all([
    userIds.length > 0 ? resolveIdentities(authorization, userIds) : new Map<string, Identity>(),
    projectIds.length > 0 ? resolveProjects(authorization, projectIds) : undefined,
    meetingIds.length > 0 ? listMeetingsByIds(authorization, meetingIds) : undefined,
    activityIds.length > 0 ? listActivitiesByIds(authorization, activityIds) : undefined,
    resolveDealsAndLinks(authorization, distinct(needs.dealIds), meetingDealIds),
  ]);
  // What was asked, so that a label for an id nobody listed is a loud error, not a quiet "hidden" or "gone".
  const askedProjects = new Set(projectIds);
  const askedMeetings = new Set(meetingIds);
  const askedActivities = new Set(activityIds);
  const meetingDealSet = new Set(meetingDealIds);

  const failed = new Set<SourceName>();
  if (projects?.state === "unavailable") failed.add("projects");
  if (activities?.state === "unavailable") failed.add("activities");
  if (deals?.state === "unavailable") failed.add("crm");
  if (meetings?.state === "unavailable") failed.add("meetings");
  if (hosts?.state === "unavailable") failed.add("meeting-deals");
  // `auth` answers a person it cannot name `unknown`, as an outage does (`lib/identities.ts`): either way
  // the name is not known, and the read says so.
  if ([...identities.values()].some((identity) => identity.status === "unknown")) failed.add("identities");

  const deal = (dealId: string): EntityLabel => {
    if (deals === undefined || !askedDeals.has(dealId)) return notAsked("deal", dealId);
    return entityLabel(deals, dealId);
  };

  return {
    unavailable: SOURCE_ORDER.filter((source) => failed.has(source)),
    person(userId) {
      const identity = identities.get(userId) ?? notAsked("person", userId);
      return { id: identity.id, name: identity.name, status: identity.status };
    },
    project(projectId) {
      if (projects === undefined || !askedProjects.has(projectId)) return notAsked("project", projectId);
      return entityLabel(projects, projectId);
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
      return meetingDealOf(hosts, meetingDealSet, meetingId, deal);
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
 * The deal a meeting's hours count for. The deal's visibility is the viewer's access to the DEAL, whatever
 * their access to the meeting (AC-4.10): the id is returned only with `visible`, because the link was read
 * with hours-api's own credential and a viewer who cannot read the deal must not learn which deal it is.
 */
function meetingDealOf(
  hosts: MeetingHosts | undefined,
  listed: ReadonlySet<string>,
  meetingId: string,
  deal: (dealId: string) => EntityLabel,
): MeetingDeal {
  if (hosts === undefined || !listed.has(meetingId)) return notAsked("meeting deal", meetingId);
  if (hosts.state === "unavailable") return { state: "unknown" };
  // An id meetings-api does not know: the meeting no longer exists, so it is linked to no deal.
  const host = hosts.items.get(meetingId);
  if (host === undefined || host.dealId === null) return { state: "none" };
  // Stored text outside the id rule is still "linked to a deal"; crm-api was never asked, and holds no such deal.
  if (!satisfiesIdRule(host.dealId)) return { state: "linked", visibility: "hidden" };
  const label = deal(host.dealId);
  if (label.visibility === "visible") {
    return { state: "linked", visibility: "visible", id: host.dealId, label: label.label, href: label.href };
  }
  return { state: "linked", visibility: label.visibility };
}

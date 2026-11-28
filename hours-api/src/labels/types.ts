/**
 * The wire vocabulary of the labels layer (specs/20261112-time-tracking plan § API contracts, "Views"): what a viewer is
 * told about a person, a project, a deal, a meeting or an activity, and which sources did not answer.
 * `src/entries/view.ts` composes these into a `TimeEntryView`; `src/totals/` (T18) groups by them.
 */

/** `hidden`: the viewer may not read it (AC-4.10). `unavailable`: its owner did not answer (AC-4.7). */
export type Visibility = "visible" | "hidden" | "unavailable";

export type PersonStatus = "active" | "deleted" | "unknown";

export interface Person {
  readonly id: string;
  readonly name: string | null;
  readonly status: PersonStatus;
}

/**
 * A source hours-api asked and that did not answer, named in `unavailable[]` of a read:
 * - `projects`, `crm`, `activities`: the owner's answer as the VIEWER (resolve, resolve, `GET /activities?ids=`);
 * - `meetings`: meeting titles, read as the viewer (`GET /meetings?ids=`);
 * - `meeting-deals`: a meeting's current deal, read with hours-api's own credential (`GET /system/meetings/hosts`),
 *   which fails independently of `meetings` (scope, deploy order, R7);
 * - `meeting-projects`: a meeting's current project, from the SAME read as `meeting-deals` (one host, one call), so the two fail together
 *   whenever a read needed both; a read that needed only one names only that one (specs/20261112-project-hours D78, AC-4.10);
 * - `identities`: people's names (`auth POST /authz/users/identities`).
 */
export type SourceName = "projects" | "crm" | "activities" | "meetings" | "meeting-deals" | "meeting-projects" | "identities";

/** The order a read names its unavailable sources in, as the plan's `Unavailable` type lists them. */
export const SOURCE_ORDER: readonly SourceName[] = ["projects", "crm", "activities", "meetings", "meeting-deals", "meeting-projects", "identities"];

export type UnavailableSources = SourceName[];

/** A project, deal or meeting as the viewer reads it: its name and place only when the viewer may read it. */
export type EntityLabel =
  | { readonly visibility: "visible"; readonly label: string; /** A suite path. */ readonly href: string }
  | { readonly visibility: "hidden" | "unavailable"; readonly label: null; readonly href: null };

/** The activity an entry points at, as the viewer reads it. `subject` only while `visibility` is `visible`. */
export interface ActivityLabel {
  readonly id: string;
  readonly subject: string | null;
  readonly visibility: Visibility;
}

/**
 * The deal a meeting entry's hours count for (AC-2.6, AC-4.5). Read live on every request, never stored
 * on the entry. A `linked` deal carries its id only with `visibility: "visible"`: the link was read with
 * hours-api's own credential, and a viewer who cannot read the deal must not learn which deal a meeting
 * is linked to (ADR 20261104-meetings-tool-shape-visibility-by-participation, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route).
 */
export type MeetingDeal =
  | { readonly state: "linked"; readonly visibility: "visible"; readonly id: string; readonly label: string; readonly href: string }
  | { readonly state: "linked"; readonly visibility: "hidden" | "unavailable" }
  /** meetings-api answered: linked to no deal (or to a host that is not a CRM deal), or the meeting no longer exists. */
  | { readonly state: "none" }
  /** The system route did not answer: `meeting-deals` is in `unavailable`. */
  | { readonly state: "unknown" };

/**
 * The project a meeting entry's hours count for (specs/20261112-project-hours AC-4.7, D78): the deal's shape, with a project's id, label and
 * href, and the same rule — `id` only with `visibility: "visible"`, because the link was read with hours-api's own credential and a viewer who
 * cannot read the project must not learn which project a meeting is linked to. A meeting has ONE host, so at most one of its `MeetingDeal` and
 * `MeetingProject` is `linked`.
 */
export type MeetingProject =
  | { readonly state: "linked"; readonly visibility: "visible"; readonly id: string; readonly label: string; readonly href: string }
  | { readonly state: "linked"; readonly visibility: "hidden" | "unavailable" }
  /** meetings-api answered: linked to no project (a deal, another host, no host), or the meeting no longer exists. */
  | { readonly state: "none" }
  /** The system route did not answer: `meeting-projects` is in `unavailable`. */
  | { readonly state: "unknown" };

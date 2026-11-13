/**
 * The wire vocabulary of the labels layer (specs/029 plan § API contracts, "Views"): what a viewer is
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
 * - `identities`: people's names (`auth POST /authz/users/identities`).
 */
export type SourceName = "projects" | "crm" | "activities" | "meetings" | "meeting-deals" | "identities";

/** The order a read names its unavailable sources in, as the plan's `Unavailable` type lists them. */
export const SOURCE_ORDER: readonly SourceName[] = ["projects", "crm", "activities", "meetings", "meeting-deals", "identities"];

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
 * is linked to (ADR-0058, ADR-0089).
 */
export type MeetingDeal =
  | { readonly state: "linked"; readonly visibility: "visible"; readonly id: string; readonly label: string; readonly href: string }
  | { readonly state: "linked"; readonly visibility: "hidden" | "unavailable" }
  /** meetings-api answered: linked to no deal (or to a host that is not a CRM deal), or the meeting no longer exists. */
  | { readonly state: "none" }
  /** The system route did not answer: `meeting-deals` is in `unavailable`. */
  | { readonly state: "unknown" };

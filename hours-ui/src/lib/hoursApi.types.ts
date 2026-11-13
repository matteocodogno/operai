/**
 * The wire shapes of hours-api (specs/029-time-tracking, plan § API contracts): the entry view, the
 * totals groups, the lists, and what a request carries. Dates are `YYYY-MM-DD`, durations are whole
 * minutes (30..1440, multiples of 30), ids are opaque text. No screen shows an id: the names a viewer
 * may not read arrive as `visibility: "hidden"` with no label (AC-4.10).
 */

export type Person = { id: string; name: string | null; status: 'active' | 'deleted' | 'unknown' }

/** `hidden`: the viewer may not read it (AC-4.10); `unavailable`: its owner did not answer (AC-4.7). */
export type Visibility = 'visible' | 'hidden' | 'unavailable'

/**
 * The deal a meeting entry's hours count for (AC-2.6, AC-4.5), read live on every request and never
 * stored. The id and the name come only with `visible`: a viewer who cannot read the deal must not
 * learn which deal a meeting is linked to (ADR-0089 § 6).
 */
export type MeetingDeal =
  | { state: 'linked'; visibility: 'visible'; id: string; label: string; href: string }
  | { state: 'linked'; visibility: 'hidden' | 'unavailable' }
  | { state: 'none' }
  | { state: 'unknown' }

type Named = { id: string; label: string | null; href: string | null; visibility: Visibility }

export type EntryOn =
  | ({ type: 'project' } & Named)
  | ({ type: 'deal' } & Named)
  | ({ type: 'meeting'; deal: MeetingDeal } & Named)
  | { type: 'none'; category: { id: string; name: string; retired: boolean } }

export type EntryTargetType = EntryOn['type']

export type TimeEntryView = {
  id: string
  day: string
  minutes: number
  note: string | null
  person: Person
  on: EntryOn
  workType: { id: string; name: string; retired: boolean } | null
  /** `null`: none, or deleted since (AC-2.9). `visibility: "hidden"` when the entry's project or deal is. */
  activity: { id: string; subject: string | null; visibility: Visibility } | null
  createdAt: string
  updatedAt: string
}

/** The sources a read could not ask; the entries are still listed and counted (AC-4.7). */
export type UnavailableSource = 'projects' | 'crm' | 'activities' | 'meetings' | 'meeting-deals' | 'identities'
export type Unavailable = UnavailableSource[]

export type EntriesPage = { items: TimeEntryView[]; nextCursor: string | null; unavailable: Unavailable }

// ─── Totals ─────────────────────────────────────────────────────────────────

export type GroupBy = 'person' | 'project' | 'deal' | 'category' | 'month' | 'day'

/** Every matching entry is counted in exactly one group; the order is the server's, never re-sorted. */
export type TotalsGroup =
  | {
      kind: 'keyed'
      key: string
      label: string | null
      minutes: number
      /** `groupBy=person` only. */
      status?: Person['status']
      /** `groupBy=category` only. */
      retired?: boolean
    }
  | { kind: 'none'; minutes: number }
  | { kind: 'hidden'; minutes: number }
  | { kind: 'unavailable'; minutes: number }
  | { kind: 'deal-unknown'; minutes: number }

export type TotalsAnswer = { totalMinutes: number; groups: TotalsGroup[]; unavailable: Unavailable }

// ─── Lists ──────────────────────────────────────────────────────────────────

export type CategoryView = { id: string; name: string; requiresNote: boolean; retired: boolean }
export type WorkTypeList = 'project' | 'deal'
export type WorkTypeView = { id: string; list: WorkTypeList; name: string; retired: boolean }
export type TimeListsView = {
  categories: CategoryView[]
  workTypes: { project: WorkTypeView[]; deal: WorkTypeView[] }
}

// ─── Requests ───────────────────────────────────────────────────────────────

/** What a list and a totals request share: whose hours, the span and the narrowing filters. */
export type EntryFilters = {
  /** `mine`: the caller's own; `all`: everyone's, needs `time-entry:read-all` (the server decides). */
  whose: 'mine' | 'all'
  /** Both required, `YYYY-MM-DD`, at most 366 days apart. */
  from: string
  to: string
  /** `whose=all` only. */
  userId?: string
  target?: EntryTargetType
  projectId?: string
  dealId?: string
  meetingId?: string
  categoryId?: string
  workTypeId?: string
}

/** `on` of a request: a project, deal or meeting by id, or no entity with its category. */
export type EntryOnInput = { type: 'project' | 'deal' | 'meeting'; id: string } | { type: 'none'; categoryId: string }

/** `POST /time-entries`: strict, any other key (a `userId`, a start or an end) is a 400 (AC-1.6, AC-1.8). */
export type EntryInput = {
  day: string
  minutes: number
  on: EntryOnInput
  workTypeId?: string | null
  activityId?: string | null
  note?: string | null
}

/** `PATCH /time-entries/{id}`: any subset of the create's members, `on` replaced whole (AC-2.12). */
export type EntryPatch = Partial<EntryInput>

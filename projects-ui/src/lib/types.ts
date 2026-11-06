/**
 * The wire shapes of projects-api (specs/021-projects, specs/022-projects-handoff
 * tasks.md § API contracts "projects-api — shapes (T23)") and of the `auth`
 * directory read. Ids are text (cuids), dates are `YYYY-MM-DD`, and no amount,
 * price or rate exists anywhere (specs/021 AC-2.9).
 *
 * A project has 0..1 **terms** (its dates and the type-specific delivery terms)
 * and 0..1 **purchase order** (born only from a won deal, together with its
 * project; D38). A hand-made project never has a purchase order.
 */

export type Entity = 'welld_ch' | 'welld_it'
export type ProjectType = 't_and_m' | 'fixed_price' | 'maintenance' | 'saas' | 'internal'
export type ProjectState = 'planned' | 'active' | 'on_hold' | 'closed' | 'cancelled'
export type HourPackageKind = 'capacity' | 'yearly'

/** A user as the API reports them: the live name (`null` when unknown), and whether the account is deleted. */
export type Person = { id: string; name: string | null; deleted: boolean }

/** `name` is `null` when crm-api cannot answer (fail soft). */
export type CompanyRef = { id: string; name: string | null }

/** One row of `GET /companies?q=`: what the company picker offers. */
export type CompanyChoice = { id: string; name: string; entity: Entity }

/**
 * One row of `GET /queue/{dealId}/contacts` or `GET /projects/{id}/purchase-order/contacts`: a non-archived
 * CRM contact of the company the server derives, which the referent can be (AC-3.6). Never stored.
 */
export type ContactChoice = { id: string; name: string; jobTitle: string | null }

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number }

/**
 * `GET /scope`: what the caller may do (UX gating only; the server's 403 is the gate, ADR-0014).
 * `take`: the entities whose won deals they may take (`handoff:take`, sales and admins; D37) —
 * the queue exists for them only. `oversees`: `purchase-order:receive` covers every entity (the
 * admin case), which lets them pick a project manager in an ops-manager's place (D47).
 */
export type Scope = { manage: Entity[]; managesAll: boolean; bexio: boolean; take: Entity[]; oversees: boolean }

export type ProjectSummary = {
  id: string
  name: string
  type: ProjectType
  state: ProjectState
  entity: Entity
  /** Every client type, `saas` included, has a company; `internal` has none (D40). */
  company: CompanyRef | null
  /** `null` only while `awaitingProjectManager`. */
  projectManager: Person | null
  /** Made from a deal whose ops-manager has not picked a project manager yet (D42). */
  awaitingProjectManager: boolean
}

/**
 * The deal a purchase order was made from, read live from the CRM on every request: `title` and
 * `won` are `null` when crm-api cannot answer, and `won: false` is the "no longer won" notice (AC-2.3).
 */
export type DealRef = { id: string; title: string | null; won: boolean | null }

/**
 * The referent of a purchase order, read live from the CRM and never stored (D49): `status`
 * `unavailable` (CRM down) carries `null` values; no referent at all (none set, or the contact
 * was erased) is `PurchaseOrder.referent === null`.
 */
export type Referent = {
  id: string
  status: 'ok' | 'unavailable'
  name: string | null
  jobTitle: string | null
  email: string | null
  phone: string | null
}

export type PurchaseOrder = {
  id: string
  deal: DealRef
  /** The deal's EstimAI estimate at creation (AC-3.2); `null` for a deal without one. */
  estimate: { id: string } | null
  bexioOrderId: string | null
  referent: Referent | null
  /** Assigned at creation; the only person (besides an admin) who picks the project manager (D46). */
  opsManager: Person
  version: number
}

// ─── Terms (by project type) ─────────────────────────────────────────────────

/** Take-in-charge times in whole working days, 0–60. The UI prefills 1 / 3 (specs/021 AC-2.5). */
export type Sla = { highDays: number; normalDays: number }

export type HourPackage = {
  hours: number
  kind: HourPackageKind
  startDate: string
  /** Only a `capacity` package expires. */
  expiryDate?: string | null
}

export type Position = { profile: string; plannedManDays: number }

export type FixedPriceTerms = { deadline: string; estimatedManDays?: number | null; maxEffortManDays: number }
export type SlaAndHoursTerms = { sla?: Sla | null; hourPackage?: HourPackage | null }
export type TAndMTerms = { positions: Position[] }

/** The type-specific members a request carries (`internal` has no terms; `{}` is a valid empty `saas` set). */
export type TermsMembers = FixedPriceTerms | SlaAndHoursTerms | TAndMTerms

/**
 * What a request carries as terms — the create of the terms routes, a hand-made create's `terms` and the
 * take's `terms` (strict): the dates, and the type's members **nested** under `terms`, as `Terms` reads back
 * (specs/022 tasks.md § API contracts "projects-api — shapes (T23)"). Built in one place, `lib/termsRequest.ts`.
 */
export type TermsInput = { startDate: string; endDate?: string | null; terms?: TermsMembers }

/**
 * What the terms routes' PATCH takes: any of the dates and the members. `terms`, when sent, replaces the
 * type's members whole (the rule of the old specs/021 contract PATCH); `endDate: null` reopens ended terms.
 */
export type TermsPatch = { startDate?: string; endDate?: string | null; terms?: TermsMembers }

/** The types that have terms: `internal` has none. */
export type TermsType = Exclude<ProjectType, 'internal'>

/** What `Terms.terms` reads back, by type: the members are `null` where the type's set does not use them. */
export type FixedPriceTermsView = { deadline: string; estimatedManDays: number | null; maxEffortManDays: number }
export type SlaAndHoursTermsView = {
  sla: Sla | null
  hourPackage: (HourPackage & { expiryDate: string | null }) | null
}
export type TAndMTermsView = { positions: Position[] }
export type TermsView = FixedPriceTermsView | SlaAndHoursTermsView | TAndMTermsView

/**
 * The terms of a project, as read (`Project.terms`, and the answer of the terms routes, whose `ETag` is
 * `version`): the dates, and the type-specific members nested under `terms` — which view it is says `type`.
 */
type TermsOf<Type extends TermsType, View extends TermsView> = {
  id: string
  type: Type
  startDate: string
  endDate: string | null
  terms: View
  version: number
}
export type Terms =
  | TermsOf<'fixed_price', FixedPriceTermsView>
  | TermsOf<'maintenance' | 'saas', SlaAndHoursTermsView>
  | TermsOf<'t_and_m', TAndMTermsView>

export type Project = {
  id: string
  name: string
  type: ProjectType
  state: ProjectState
  /** The state an `on_hold` project left (and may return to); `null` in every other state. */
  stateBeforeHold: ProjectState | null
  entity: Entity
  company: CompanyRef | null
  /** `null` only while `awaitingProjectManager`; once set it is never cleared (AC-4.9). */
  projectManager: Person | null
  awaitingProjectManager: boolean
  team: Person[]
  /** `null` on a hand-made project, which never has one (AC-5.2). */
  purchaseOrder: PurchaseOrder | null
  /** Always there with a purchase order; optional on a hand-made project (AC-5.3). */
  terms: Terms | null
  /** From the terms; `null` without. */
  startDate: string | null
  endDate: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// ─── The to-start queue and taking a deal (specs/022) ────────────────────────

/** A won deal no project has taken. No amount, currency, owner or notes exist on it (D14). */
export type QueueItem = {
  dealId: string
  title: string
  entity: Entity
  company: CompanyRef
  /** When the deal was won; `null` only if crm-api sends none. */
  wonAt: string | null
  estimate: { id: string; name: string } | null
}

/** `GET /queue`: `truncated` when the CRM has more won deals than the 500 it returns (A26). */
export type QueueList = { items: QueueItem[]; truncated: boolean }

/** The client types a project taken from a deal can have (AC-1.2): `saas` is one (D40), `internal` is not. */
export type DealProjectType = 't_and_m' | 'fixed_price' | 'maintenance' | 'saas'

/**
 * `GET /queue/{dealId}/ops-managers` (AC-4.1): the holders of the ops-manager role for the deal's entity
 * and the admins (`admin`, listed last). `prefillId` is the one role holder when there is exactly one.
 */
export type OpsManagerChoice = { id: string; name: string | null; admin: boolean }
export type OpsManagerList = { items: OpsManagerChoice[]; prefillId: string | null }

/** One row of `auth GET /authz/users/directory` (ADR-0047). */
export type DirectoryUser = { id: string; name: string | null; email: string; entity: string | null }

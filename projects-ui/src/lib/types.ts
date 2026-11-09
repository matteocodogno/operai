/**
 * The wire shapes of projects-api (specs/024-projects, tasks.md § API contracts)
 * and of the `auth` directory read. Ids are text (cuids), dates are `YYYY-MM-DD`,
 * and no amount, price or rate exists anywhere (AC-2.9).
 */

export type Entity = 'welld_ch' | 'welld_it'
export type ProjectType = 't_and_m' | 'fixed_price' | 'maintenance' | 'saas' | 'internal'
export type ProjectState = 'planned' | 'active' | 'on_hold' | 'closed' | 'cancelled'
export type ContractOrigin = 'manual' | 'deal'
export type HourPackageKind = 'capacity' | 'yearly'

/** A user as the API reports them: the live name (`null` when unknown), and whether the account is deleted. */
export type Person = { id: string; name: string | null; deleted: boolean }

/** `name` is `null` when crm-api cannot answer (fail soft). */
export type CompanyRef = { id: string; name: string | null }

/** One row of `GET /companies?q=`: what the company picker offers. */
export type CompanyChoice = { id: string; name: string; entity: Entity }

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number }

/** `GET /scope`: what the caller may manage (UX gating only; the server's 403 is the gate, ADR-0014). */
export type Scope = { manage: Entity[]; managesAll: boolean; bexio: boolean }

export type ProjectSummary = {
  id: string
  name: string
  type: ProjectType
  state: ProjectState
  entity: Entity
  company: CompanyRef | null
  /** Distinct contract companies; what a `saas` row shows. */
  clientCount: number
  projectManager: Person
}

export type ContractSummary = {
  id: string
  type: ProjectType
  company: CompanyRef
  origin: ContractOrigin
  bexioOrderId: string | null
  startDate: string
  endDate: string | null
}

export type Project = {
  id: string
  name: string
  type: ProjectType
  state: ProjectState
  /** The state an `on_hold` project left (and may return to); `null` in every other state. */
  stateBeforeHold: ProjectState | null
  entity: Entity
  company: CompanyRef | null
  projectManager: Person
  team: Person[]
  /** Every contract whole (terms and version), so a contract card needs no request of its own. */
  contracts: Contract[]
  /** Earliest contract start; `null` with no contract. */
  startDate: string | null
  /** Latest contract end; `null` with no contract or when any contract is open-ended. */
  endDate: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// ─── Contract terms (by project type) ────────────────────────────────────────

/** Take-in-charge times in whole working days, 0–60. The UI prefills 1 / 3 (AC-2.5). */
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

/** What a create or update sends: the member set depends on the project's type (`internal` takes none). */
export type ContractTermsInput = FixedPriceTerms | SlaAndHoursTerms | TAndMTerms | Record<string, never>

/** What a read returns: every member present, `null` when absent. */
export type ContractTerms =
  | { deadline: string; estimatedManDays: number | null; maxEffortManDays: number }
  | { sla: Sla | null; hourPackage: (HourPackage & { expiryDate: string | null }) | null }
  | { positions: Position[] }
  | Record<string, never>

export type Contract = ContractSummary & {
  projectId: string
  /** Filled by the CRM hand-off (specs/025); `null` for a contract entered by hand. */
  dealId: string | null
  terms: ContractTerms
  version: number
}

/** One row of `auth GET /authz/users/directory` (ADR-0047). */
export type DirectoryUser = { id: string; name: string | null; email: string; entity: string | null }

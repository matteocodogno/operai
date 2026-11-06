/**
 * Wire types for crm-api and the one `auth` read crm-ui makes — exactly the
 * shapes of specs/017-crm/plan.md § API contract. Money is integer minor units,
 * calendar dates `YYYY-MM-DD`, instants ISO 8601; the UI displays them and
 * never re-derives a figure the API computes (the pipeline's weighted totals).
 */

export type Entity = 'welld_ch' | 'welld_it'
export type Currency = 'CHF' | 'EUR'
export type CompanyStatus = 'prospect' | 'customer' | 'former'
export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
export type ActivityType = 'note' | 'call' | 'meeting' | 'email' | 'task'
/** Where a company or a lead came from (specs/017 US-7). */
export type LeadSource = 'inbound' | 'outbound' | 'event' | 'referral' | 'other'

export const ENTITIES: readonly Entity[] = ['welld_ch', 'welld_it']
export const CURRENCIES: readonly Currency[] = ['CHF', 'EUR']
export const COMPANY_STATUSES: readonly CompanyStatus[] = ['prospect', 'customer', 'former']
export const DEAL_STAGES: readonly DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
export const OPEN_STAGES: readonly DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation']
/** A new deal starts here only: proposal and later need a ready estimate (specs/018 AC-3.4). */
export const NEW_DEAL_STAGES: readonly DealStage[] = ['lead', 'qualified']
export const ACTIVITY_TYPES: readonly ActivityType[] = ['note', 'call', 'meeting', 'email', 'task']
export const LEAD_SOURCES: readonly LeadSource[] = ['inbound', 'outbound', 'event', 'referral', 'other']
/** The sources that take a detail: which event, who referred it, or what else. */
export const hasSourceDetail = (source: LeadSource | null | ''): source is 'event' | 'referral' | 'other' =>
  source === 'event' || source === 'referral' || source === 'other'

export const isOpenStage = (stage: DealStage): boolean => OPEN_STAGES.includes(stage)

export type PersonRef = {
  id: string
  name: string | null
  status: 'active' | 'deleted' | 'unknown' | 'system'
}

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number }

export type Scope = {
  deal: Entity[]
  canErase: boolean
  /** `deal:financials`: the caller sees money (specs/018 US-1). Absent from an older server = false. */
  financials?: boolean
  /** `deal:manage` over every entity: the admin's reach (override, mark ready for anyone). */
  managesAll?: boolean
}

export type CompanySummary = {
  id: string
  name: string
  status: CompanyStatus
  /** `status` is `former` because no deal was won in twelve months and none is open (specs/017 AC-1.9). */
  statusLapsed: boolean
  entity: Entity
  industry: string | null
  city: string | null
  country: string | null
  owner: PersonRef
  archived: boolean
  contactCount: number
  openDealCount: number
  /** specs/017 US-7. Absent from an older server. */
  source?: LeadSource | null
  sourceDetail?: string | null
  updatedAt: string
}

export type Company = CompanySummary & {
  /** Registered name, street and postal code: the offer's client block (specs/020 AC-5.1). */
  legalName: string | null
  street: string | null
  postalCode: string | null
  website: string | null
  notes: string | null
  version: number
  createdAt: string
}

export type CompanyRef = { id: string; name: string }

export type ContactSummary = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  jobTitle: string | null
  company: CompanyRef | null
  archived: boolean
  updatedAt: string
}

export type Contact = ContactSummary & { notes: string | null; version: number; createdAt: string }

export type DealSummary = {
  id: string
  title: string
  company: CompanyRef
  stage: DealStage
  /** Left out by the server for a caller without `deal:financials`; null while not yet known. */
  amountCents?: number | null
  currency?: Currency
  entity: Entity
  /** specs/017 US-7. Absent from an older server. */
  source?: LeadSource | null
  sourceDetail?: string | null
  expectedCloseDate: string | null
  owner: PersonRef
  closedAt: string | null
  updatedAt: string
  version: number
  /** The estimate gate at a glance (specs/018 US-3). */
  estimateState: EstimateState | null
  estimateOverridden: boolean
}

export type EstimateState = 'requested' | 'ready'

export type DealEstimate = {
  estimateId: string
  name: string
  technical: PersonRef
  state: EstimateState
  requestedBy: PersonRef
  requestedAt: string
  readyAt: string | null
}

export type EstimateOverride = { by: PersonRef; reason: string; at: string }

export type Deal = DealSummary & {
  lostReason: string | null
  /** Left out for a caller without `deal:financials`. */
  notes?: string | null
  createdAt: string
  estimate: DealEstimate | null
  estimateOverride: EstimateOverride | null
}

export type OfferLanguage = 'en' | 'it'

export type Offer = {
  id: string
  number: number
  reference: string
  language: OfferLanguage
  priceCents: number
  currency: Currency
  validityDays: number
  validUntil: string
  aiAssisted: boolean
  manDaysTenths: number
  sizeBytes: number
  createdBy: PersonRef
  createdAt: string
  deleted: boolean
  /** Recurring total, shown beside the price (specs/020); absent on an older server. */
  yearlyCents?: number
  templateName?: string | null
  /** When and by whom it was marked sent; null while it can still be edited (specs/020 US-7). */
  sent?: { at: string; by: PersonRef } | null
  /** The If-Match precondition of an edit. */
  version?: number
}

/** The dialog's prefill from an existing offer: to edit it, or to start its next revision. */
export type OfferForm = OfferDraft & { contactIds: string[]; attachmentIds: string[]; version: number; sent: boolean }

export type Attachment = {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedBy: PersonRef
  createdAt: string
  canDownload: boolean
}

export type EntityProfile = {
  entity: Entity
  legalName: string
  addressLines: string[]
  vatNumber: string | null
  iban: string | null
  offerTermsEn: string | null
  offerTermsIt: string | null
  /** Printed beside the date of an offer; null = the server's default. */
  placeOfIssue: string | null
  letterhead: { uploadedBy: PersonRef; uploadedAt: string } | null
  updatedAt: string
}

// ─── Offer templates and the generate draft (specs/020) ─────────────────────

export type CostKind = 'one_off' | 'yearly' | 'discount'
export type OfferSection = { heading: string; body: string; costs: boolean }
export type CostColumns = { position: boolean; unit: boolean }

export type TemplateAmount = 'deal' | 'perRelease' | { cents: number } | { percentBp: number }
export type TemplateCostLine = {
  description: string
  kind: CostKind
  amount: TemplateAmount
  quantity: number | 'manDays'
}

export type OfferTemplateContent = {
  name: string
  language: OfferLanguage
  salutation: string
  opening: string
  sections: OfferSection[]
  costLines: TemplateCostLine[]
  costColumns: CostColumns
  showTotal: boolean
  acceptanceLabel: string | null
  annex: boolean
}

export type OfferTemplate = OfferTemplateContent & {
  id: string
  entity: Entity
  version: number
  archived: boolean
  updatedBy: PersonRef
  updatedAt: string
  createdAt: string
}

export type DraftCostLine = {
  description: string
  kind: CostKind
  unitCents: number | null
  percentBp: number | null
  quantity: number
}

export type OfferDraft = {
  templateId: string
  templateName: string
  language: OfferLanguage
  currency: Currency
  salutation: string
  clientLines: string[]
  opening: string
  sections: OfferSection[]
  costColumns: CostColumns
  showTotal: boolean
  costLines: DraftCostLine[]
  acceptanceLabel: string | null
  annex: boolean
  validityDays: number
  aiAssisted: boolean
  manDays: number
}

export type PipelineTotal = { currency: Currency; amountCents: number; weightedCents: number }
/** `totals` is left out for a caller without `deal:financials`. */
export type PipelineStage = { stage: DealStage; count: number; totals?: PipelineTotal[] }
/** `years`: the years with won or lost deals, newest first (the board's year picker); absent from an older server. */
export type Pipeline = {
  probabilities: Record<DealStage, number>
  year: number
  years?: number[]
  stages: PipelineStage[]
}

export type ActivityTask = {
  dueDate: string | null
  assignee: PersonRef | null
  completedAt: string | null
  completedBy: PersonRef | null
  /** The tasks it waits on (specs/017 US-6); `blocked` while any of them is open. Absent from an older server. */
  blockedBy?: { id: string; subject: string; completed: boolean }[]
  blocked?: boolean
}

export type Activity = {
  id: string
  type: ActivityType
  subject: string
  body: string | null
  occurredAt: string
  company: CompanyRef
  contact: { id: string; name: string } | null
  deal: { id: string; title: string } | null
  author: PersonRef
  /** The wellD colleagues who took part (specs/017 US-8). Absent from an older server. */
  participants?: PersonRef[]
  task: ActivityTask | null
  /**
   * The meeting this activity mirrors (specs/021 US-14): set only on a `meeting`
   * activity that Meetings created. Its body is null — the link is the content.
   * Absent from a server that predates Meetings.
   */
  meeting?: { id: string; href: string } | null
  createdAt: string
  updatedAt: string
}

/** One row of `auth GET /authz/users/directory` (ADR-0047). */
export type DirectoryUser = { id: string; name: string | null; email: string; entity: string | null }

export type PageQuery = { page?: number; pageSize?: number }

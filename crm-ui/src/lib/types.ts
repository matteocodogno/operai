import type { RichTextDoc } from '@operai/ui/rich-text'
import type { WizardAnswers } from './offerEngine/answers'
import type { InvalidIssue, Issue } from './offerEngine/resolve'
import type { Problem } from './offerEngine/syntax'
/**
 * Wire types for crm-api and the one `auth` read crm-ui makes — exactly the
 * shapes of specs/20261101-crm/plan.md § API contract. Money is integer minor units,
 * calendar dates `YYYY-MM-DD`, instants ISO 8601; the UI displays them and
 * never re-derives a figure the API computes (the pipeline's weighted totals).
 */

export type Entity = 'welld_ch' | 'welld_it'
export type Currency = 'CHF' | 'EUR'
export type CompanyStatus = 'prospect' | 'customer' | 'former'
export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
export type ActivityType = 'note' | 'call' | 'meeting' | 'email' | 'task'
/** Where a company or a lead came from (specs/20261101-crm US-7). */
export type LeadSource = 'inbound' | 'outbound' | 'event' | 'referral' | 'other'

export const ENTITIES: readonly Entity[] = ['welld_ch', 'welld_it']
export const CURRENCIES: readonly Currency[] = ['CHF', 'EUR']
export const COMPANY_STATUSES: readonly CompanyStatus[] = ['prospect', 'customer', 'former']
export const DEAL_STAGES: readonly DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
export const OPEN_STAGES: readonly DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation']
/** A new deal starts here only: proposal and later need a ready estimate (specs/20261101-crm-sales-flow AC-3.4). */
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
  /** `deal:financials`: the caller sees money (specs/20261101-crm-sales-flow US-1). Absent from an older server = false. */
  financials?: boolean
  /** `deal:manage` over every entity: the admin's reach (override, mark ready for anyone). */
  managesAll?: boolean
  /**
   * The CRM's offers are laid out by the letterhead service (specs/20261116-letterhead-service G7, AC-10.12). Absent from an
   * older server = false: the browser-drawn preview and the upload card stay.
   */
  letterheadService?: boolean
}

export type CompanySummary = {
  id: string
  name: string
  status: CompanyStatus
  /** `status` is `former` because no deal was won in twelve months and none is open (specs/20261101-crm AC-1.9). */
  statusLapsed: boolean
  entity: Entity
  industry: string | null
  city: string | null
  country: string | null
  owner: PersonRef
  archived: boolean
  contactCount: number
  openDealCount: number
  /** specs/20261101-crm US-7. Absent from an older server. */
  source?: LeadSource | null
  sourceDetail?: string | null
  updatedAt: string
}

export type Company = CompanySummary & {
  /** Registered name, street and postal code: the offer's client block (specs/20261102-crm-offer-document AC-5.1). */
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
  /** specs/20261101-crm US-7. Absent from an older server. */
  source?: LeadSource | null
  sourceDetail?: string | null
  expectedCloseDate: string | null
  owner: PersonRef
  closedAt: string | null
  updatedAt: string
  version: number
  /** The estimate gate at a glance (specs/20261101-crm-sales-flow US-3). */
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

/** The project that carries a deal and its purchase order's Bexio order id (specs/20261103-projects-handoff AC-3.4), read from projects-api. */
export type Delivery = { project: { id: string; name: string }; bexioOrderId: string | null }

export type Deal = DealSummary & {
  lostReason: string | null
  /** Left out for a caller without `deal:financials`. */
  notes?: string | null
  createdAt: string
  estimate: DealEstimate | null
  estimateOverride: EstimateOverride | null
  /**
   * `GET /deals/{id}` only (specs/20261103-projects-handoff AC-3.4) — writes answer a deal without them, so the page carries
   * them over. `deliveryKnown: false` means projects-api is not configured or did not answer: `delivery`
   * is then unknown, not "no project".
   */
  delivery?: Delivery | null
  deliveryKnown?: boolean
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
  /** Recurring total, shown beside the price (specs/20261102-crm-offer-document); absent on an older server. */
  yearlyCents?: number
  templateName?: string | null
  /** When and by whom it was marked sent; null while it can still be edited (specs/20261102-crm-offer-document US-7). */
  sent?: { at: string; by: PersonRef } | null
  /** The If-Match precondition of an edit. */
  version?: number
  /** How it was made (specs/20261115-crm-offer-wizard): the UI picks the edit/revise path from it (AC-7.3). Absent from an older server. */
  origin?: OfferOrigin
  /** The letterhead version the layout service drew this offer with (specs/20261116-letterhead-service); null when crm-api drew it itself, from before the switch. */
  letterheadVersion: number | null
}

export type OfferOrigin = 'summary' | 'sections' | 'wizard'

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
  /**
   * The four legal details left crm-api's answer with specs/20261117-legal-entities T29: the registry holds them now (AC-6.1).
   * Declared only until T31 retires its last reader (TryWizardView); nothing else reads them and a current server never sends them.
   * @deprecated read the legal entity registry instead
   */
  legalName: string
  /** @deprecated see `legalName` */
  addressLines: string[]
  /** @deprecated see `legalName` */
  vatNumber: string | null
  /** @deprecated see `legalName` */
  iban: string | null
  offerTermsEn: string | null
  offerTermsIt: string | null
  /** Printed beside the date of an offer; null = the server's default. */
  placeOfIssue: string | null
  letterhead: { uploadedBy: PersonRef; uploadedAt: string } | null
  updatedAt: string
}

// ─── Offer templates and the generate draft (specs/20261102-crm-offer-document) ─────────────────────

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

/** An image or attachment of a task, stored in activities-api's bucket (ADR 20261113-task-description-files-in-activities-api-bucket). */
export type TaskFile = {
  id: string
  kind: 'image' | 'attachment'
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedBy: PersonRef
  createdAt: string
}

export type ActivityTask = {
  /** The task's rich description (TipTap JSON), or null. Absent from an older server. */
  description?: RichTextDoc | null
  /** Its stored images and attachments, oldest first. Absent from an older server. */
  files?: TaskFile[]
  dueDate: string | null
  assignee: PersonRef | null
  completedAt: string | null
  completedBy: PersonRef | null
  /** The tasks it waits on (specs/20261101-crm US-6); `blocked` while any of them is open. Absent from an older server. */
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
  /** The wellD colleagues who took part (specs/20261101-crm US-8). Absent from an older server. */
  participants?: PersonRef[]
  task: ActivityTask | null
  /**
   * The meeting this activity mirrors (specs/20261104-meetings US-14): set only on a `meeting`
   * activity that Meetings created. Its body is null — the link is the content.
   * Absent from a server that predates Meetings.
   */
  meeting?: { id: string; href: string } | null
  createdAt: string
  updatedAt: string
}

/** One row of `auth GET /authz/users/directory` (ADR 20261006-user-directory-endpoint-capability-gated). */
export type DirectoryUser = { id: string; name: string | null; email: string; entity: string | null }

export type PageQuery = { page?: number; pageSize?: number }

// ─── The offer wizard (specs/20261115-crm-offer-wizard plan.md § API contracts) ─────────────────────────

/** A wizard template as `GET /offer-templates?formats=wizard` returns it: the text is `source`, the legacy members are null. */
export type WizardTemplate = {
  id: string
  entity: Entity
  name: string
  language: OfferLanguage
  format: 'wizard'
  description: string | null
  uses: string[]
  source: string
  seeded: boolean
  showTotal: boolean
  annex: boolean
  version: number
  archived: boolean
  updatedBy: PersonRef
  updatedAt: string
  createdAt: string
}

/** A classic template next to wizard ones in a `formats=sections,wizard` list. */
export type ClassicTemplateRow = OfferTemplate & { format: 'sections' }
export type OfferTemplateRow = ClassicTemplateRow | WizardTemplate

/** The body of a wizard template (create names its entity beside it). */
export type WizardTemplateInput = {
  name: string
  language: OfferLanguage
  description: string
  uses: string[]
  source: string
}

/** The estimate's annex A as the context route previews it (`Scope` of crm-api `offers/scope.ts`). */
export type AnnexScope = {
  aiAssisted: boolean
  releases: { name: string; epics: { epic: string; manDaysTenths: number }[]; manDaysTenths: number }[]
  manDaysTenths: number
}

/** `GET /deals/{id}/offer-wizard/context`: no language (the template's, DD-41); `today` is the server's UTC day. */
export type WizardContextResponse = {
  dealTitle: string
  currency: Currency
  dealAmountCents: number | null
  issuerLegalName: string
  /** The entity profile's address lines (DD-58); may be empty. */
  issuerAddressLines: string[]
  /** The profile has a letterhead (DD-54). Never a link: the bytes come through `getLetterheadDownload`. */
  letterhead: boolean
  placeOfIssue: string
  clientLines: { it: string[]; en: string[] }
  contacts: { id: string; name: string }[]
  attachments: { id: string; fileName: string; sizeBytes: number }[]
  estimate: {
    state: 'ready' | 'override' | 'missing'
    manDays: number
    manDaysAi: number
    epics: string[]
    phases: { release: string; epics: string[] }[]
    timeline: { it: string; en: string }
    releases: { name: string; manDays: number }[]
    annex: { it: AnnexScope; en: AnnexScope; itAi: AnnexScope; enAi: AnnexScope } | null
  }
  latestOffer: { id: string; reference: string; sent: boolean; version: number; origin: OfferOrigin } | null
  today: string
}

export type DraftTarget =
  { kind: 'new' } | { kind: 'edit' | 'revision'; offerId: string; offerVersion: number; reference: string }
/** What a request names: the offer, not its reference or version. */
export type DraftTargetInput = { kind: 'new' } | { kind: 'edit' | 'revision'; offerId: string }

export type DraftTemplateRef = { id: string; name: string; language: OfferLanguage; version: number; archived: boolean }

export type OfferDraftView = {
  dealId: string
  template: DraftTemplateRef
  /** The version the answers were last saved against; ≠ `template.version` ⇒ the template changed (AC-8.4). */
  templateVersion: number
  target: DraftTarget
  answers: WizardAnswers
  /** = the ETag: the next write's `If-Match`. */
  version: number
  updatedBy: PersonRef
  updatedAt: string
  createdAt: string
}

/** What the deal page needs — never `answers` (DD-27). */
export type OfferDraftSummary = {
  dealId: string
  template: Omit<DraftTemplateRef, 'version'>
  templateChanged: boolean
  target: DraftTarget
  version: number
  updatedBy: PersonRef
  updatedAt: string
  createdAt: string
}

/** The 422 `offer_incomplete` body's members: exactly `resolveOffer(…).missing` / `.invalid` of the stored draft (DD-32). */
export type OfferIncomplete = { missing: Issue[]; invalid: InvalidIssue[] }

/** A template's problems as a 422 `template_invalid` lists them (positions and codes only). */
export type TemplateProblem = Problem

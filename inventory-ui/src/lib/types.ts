/**
 * Wire types for inventory-api and the one `auth` read inventory-ui makes —
 * typed exactly as specs/015-hardware-inventory/plan.md § API contracts (as
 * amended 2026-10-06), including the `Ledger`-optional `AssetView`. Money is
 * integer cents, calendar dates are `YYYY-MM-DD`, timestamps ISO 8601; the UI
 * only ever displays these, never computes with them (the shared
 * schedule-vectors rule).
 */

import { ApiError } from './api'

// ---------------------------------------------------------------------------
// Enums (plan.md § Data model)
// ---------------------------------------------------------------------------

export type Entity = 'welld_ch' | 'welld_it'
export type Currency = 'CHF' | 'EUR'
export type AssetCategory = 'laptop' | 'desktop' | 'phone' | 'tablet' | 'monitor' | 'peripheral' | 'other'
export type AssetStatus = 'ordered' | 'in_stock' | 'assigned' | 'in_repair' | 'lost' | 'disposed'
export type DisposalReason = 'ceded_to_employee' | 'sold' | 'scrapped' | 'returned_to_vendor' | 'lost'
export type FirstYearShare = 'full' | 'half'
export type AssetEventAction =
  | 'registered'
  | 'received'
  | 'edited'
  | 'assignment_created'
  | 'assignment_confirmed'
  | 'assignment_declined'
  | 'assignment_cancelled'
  | 'returned'
  | 'repair_started'
  | 'repair_finished'
  | 'marked_lost'
  | 'marked_found'
  | 'disposed'
  | 'invoice_file_linked'
  | 'verified'
  | 'fiscal_year_closed'
  | 'imported'

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** `system` marks actor ids starting with `system:` (launch seed, legacy import); never sent to auth. */
export type Identity = { id: string; name: string | null; status: 'active' | 'deleted' | 'unknown' | 'system' }

export type Rule = {
  id: string
  entity: Entity
  effectiveFrom: string
  usefulLifeYears: number
  firstYearShare: FirstYearShare
  lowValueThresholdCents: number | null
  residualCents: number
  createdBy: Identity
  createdAt: string
}

export type Ledger = {
  bookValueCents: number
  rule: {
    id: string
    effectiveFrom: string
    usefulLifeYears: number
    firstYearShare: FirstYearShare
    lowValueThresholdCents: number | null
    residualCents: number
  }
  schedule: { year: number; depreciationCents: number; closingCents: number; closed: boolean }[]
}

/** Returned to `asset:manage` OR `ledger:manage`; `ledger` is present only for a `ledger:manage` caller. */
export type AssetView = {
  id: string
  entity: Entity
  currency: Currency
  category: AssetCategory
  description: string
  serialNumber: string | null
  purchaseDate: string
  purchasePriceCents: number
  status: AssetStatus
  holder: Identity | null
  pendingAssignment: { id: string; assignee: Identity; createdAt: string } | null
  locationNote: string | null
  supplier: string | null
  invoiceRef: string | null
  invoiceFile: { id: string; fileName: string } | null
  toVerify: boolean
  disposal: { disposedOn: string; reason: DisposalReason; salePriceCents: number | null } | null
  ledger?: Ledger
}

/** A `GET /assets` list item: the lighter payload carries the book value only (design Resolutions G10). */
export type AssetListItem = Omit<AssetView, 'ledger'> & { ledger?: { bookValueCents: number } }

/** `MyDevice` has no price or ledger key at all (AC-4.2). */
export type MyDevice = {
  assetId: string
  description: string
  category: AssetCategory
  serialNumber: string | null
  assignedAt: string
}
export type MyPending = MyDevice & { assignmentId: string }

// ---------------------------------------------------------------------------
// Request / response shapes per route group
// ---------------------------------------------------------------------------

export type Scope = { asset: Entity[]; ledger: Entity[] }

export type AssetListFilters = {
  entity?: Entity
  status?: AssetStatus
  category?: AssetCategory
  holderUserId?: string
  toVerify?: boolean
  invoiceRef?: string
  /** Case-insensitive substring of description or serial number (AC-3.8). */
  q?: string
  cursor?: string
  limit?: number
}
export type AssetListPage = { items: AssetListItem[]; nextCursor: string | null }

export type RegisterAssetsInput = {
  entity: Entity
  category: AssetCategory
  description: string
  purchaseDate: string
  totalPriceCents: number
  /** 1-200, default 1. */
  quantity?: number
  /** Omitted/empty, or exactly `quantity` long, applied in order. */
  serialNumbers?: string[]
  /** Default true; false registers the units as `ordered`. */
  received?: boolean
  supplier?: string
  invoiceRef?: string
  locationNote?: string
}

/** `entity` and `currency` are immutable; the server answers 422 for them. */
export type AssetPatch = Partial<{
  category: AssetCategory
  description: string
  serialNumber: string | null
  locationNote: string | null
  supplier: string | null
  invoiceRef: string | null
  toVerify: boolean
  purchaseDate: string
  purchasePriceCents: number
}>

export type DisposeInput = { disposedOn: string; reason: DisposalReason; salePriceCents?: number }

export type RuleInput = {
  entity: Entity
  effectiveFrom: string
  usefulLifeYears: number
  firstYearShare: FirstYearShare
  lowValueThresholdCents: number | null
  residualCents: number
}
export type RulesList = { rules: Rule[]; inForceId: string }

export type FiscalYearSummary = { year: number; status: 'open' | 'closed'; closedAt: string | null; closable: boolean }

export type FiscalYearView = {
  entity: Entity
  year: number
  currency: Currency
  status: 'open' | 'closed'
  closedAt: string | null
  rollForward: {
    openingCents: number
    disposalsCents: number
    purchasesCents: number
    depreciationCents: number
    closingCents: number
  }
  assets: {
    assetId: string
    purchaseDate: string
    description: string
    serialNumber: string | null
    holder: Identity | null
    purchasePriceCents: number
    openingCents: number
    purchaseCents: number
    depreciationCents: number
    disposalCents: number
    closingCents: number
  }[]
}

export type InvoiceContentType = 'application/pdf' | 'image/jpeg' | 'image/png'
export type InvoiceUploadRequest = {
  entity: Entity
  invoiceRef: string
  fileName: string
  contentType: InvoiceContentType
  sizeBytes: number
}
export type MintedInvoiceUpload = { id: string; upload: { url: string; fields: Record<string, string> } }
export type StoredInvoiceFile = { id: string; fileName: string }

export type HistoryChangeValue = string | number | boolean | null | Identity
export type HistoryEvent = {
  id: string
  action: AssetEventAction
  actor: Identity
  at: string
  changes: { field: string; from: HistoryChangeValue; to: HistoryChangeValue }[]
}

export type MyDevicesResponse = { devices: MyDevice[]; pending: MyPending[] }

/** `auth GET /authz/users/directory` item; `entity` is the user's entity attribute, null when unset. */
export type DirectoryUser = { id: string; name: string | null; email: string; entity: string | null }

// ---------------------------------------------------------------------------
// Error codes (plan.md § API contracts, design.md § Error and conflict catalogue)
// ---------------------------------------------------------------------------

/**
 * Every Problem JSON `code` the plan's API tables document. `strings.errors`
 * holds one message per entry (asserted in T25 from this constant). A response
 * with no code (401/403/404/413/415/429/503, or a 422 carrying only `field`)
 * is told apart by `ApiError.status` alone.
 */
export const INVENTORY_ERROR_CODES = [
  'serial_count_mismatch',
  'serial_conflict',
  'fiscal_year_closed',
  'invalid_transition',
  'assignment_pending',
  'asset_disposed',
  'assignment_not_pending',
  'unknown_user',
  'disposed_before_purchase',
  'sale_price_not_allowed',
  'previous_year_open',
  'already_closed',
  'nothing_to_close',
  'invoice_ref_mismatch',
  'upload_not_found',
] as const

export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number]

/** The typed extension members each code carries; every member is optional because the server may omit it. */
export type InventoryErrorExtras = {
  serial_count_mismatch: Record<never, never>
  serial_conflict: { serialNumber?: string; assetId?: string }
  fiscal_year_closed: { year?: number }
  invalid_transition: { from?: string }
  assignment_pending: { assignmentId?: string }
  asset_disposed: { assetId?: string }
  assignment_not_pending: Record<never, never>
  unknown_user: Record<never, never>
  disposed_before_purchase: Record<never, never>
  sale_price_not_allowed: Record<never, never>
  previous_year_open: Record<never, never>
  already_closed: Record<never, never>
  nothing_to_close: Record<never, never>
  invoice_ref_mismatch: { assetId?: string }
  upload_not_found: Record<never, never>
}

export type InventoryError = {
  [C in InventoryErrorCode]: { code: C; status: number; detail: string | undefined; extras: InventoryErrorExtras[C] }
}[InventoryErrorCode]

const EXTRA_TYPES: { [C in InventoryErrorCode]: Partial<Record<string, 'string' | 'number'>> } = {
  serial_count_mismatch: {},
  serial_conflict: { serialNumber: 'string', assetId: 'string' },
  fiscal_year_closed: { year: 'number' },
  invalid_transition: { from: 'string' },
  assignment_pending: { assignmentId: 'string' },
  asset_disposed: { assetId: 'string' },
  assignment_not_pending: {},
  unknown_user: {},
  disposed_before_purchase: {},
  sale_price_not_allowed: {},
  previous_year_open: {},
  already_closed: {},
  nothing_to_close: {},
  invoice_ref_mismatch: { assetId: 'string' },
  upload_not_found: {},
}

const isKnownCode = (code: string | undefined): code is InventoryErrorCode =>
  code !== undefined && (INVENTORY_ERROR_CODES as readonly string[]).includes(code)

/**
 * Narrows a thrown `ApiError` carrying one of the documented codes to a typed
 * `InventoryError`, keeping only the extension members that code documents and
 * only when they have the documented type (a numeric-looking string `year` is
 * accepted as a number). Anything else — a network error, an unknown or absent
 * code — returns null, so a caller falls back on `ApiError.status`.
 */
export function toInventoryError(error: unknown): InventoryError | null {
  if (!(error instanceof ApiError) || !isKnownCode(error.code)) return null
  const expected = EXTRA_TYPES[error.code]
  const extras: Record<string, string | number> = {}
  for (const [key, type] of Object.entries(expected)) {
    const value = error.extras[key]
    if (type === 'string' && typeof value === 'string') extras[key] = value
    if (type === 'number') {
      if (typeof value === 'number') extras[key] = value
      else if (typeof value === 'string' && /^\d+$/.test(value)) extras[key] = Number(value)
    }
  }
  return { code: error.code, status: error.status, detail: error.detail, extras } as InventoryError
}

/** The `field` a 422 validation problem points at (rules, register, dispose), when the server named one. */
export const validationField = (error: unknown): string | undefined =>
  error instanceof ApiError && error.status === 422 && typeof error.extras.field === 'string'
    ? error.extras.field
    : undefined

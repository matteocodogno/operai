import { getJson, sendJson } from './api'
import type { Entity, FiscalYearSummary, FiscalYearView } from './types'

/** Fiscal years (`ledger:manage`). There is no reopen route (AC-8.7). */

export const listFiscalYears = (entity: Entity, init?: RequestInit): Promise<{ years: FiscalYearSummary[] }> =>
  getJson<{ years: FiscalYearSummary[] }>(`/fiscal-years?entity=${encodeURIComponent(entity)}`, init)

export const getFiscalYear = (entity: Entity, year: number, init?: RequestInit): Promise<FiscalYearView> =>
  getJson<FiscalYearView>(`/fiscal-years/${encodeURIComponent(entity)}/${year}`, init)

/** 409 `previous_year_open` | `already_closed` | `nothing_to_close`. */
export const closeFiscalYear = (entity: Entity, year: number): Promise<FiscalYearView> =>
  sendJson<FiscalYearView>(`/fiscal-years/${encodeURIComponent(entity)}/${year}/close`, 'POST')

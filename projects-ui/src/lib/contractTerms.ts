/**
 * Contract terms as a form holds them (text in every input) and as the API takes
 * them (specs/021-projects, tasks.md § API contracts; AC-2.3 – AC-2.8): the empty
 * form of a type, a stored contract back into the form, and the form into the
 * request's `terms` with the checks the server makes (limits, one decimal, a
 * maintenance contract needs an SLA or an hour package).
 *
 * Errors are keyed with the dotted `field` names projects-api uses
 * (`terms.sla.highDays`, `terms.positions.0.profile`, …), so a refusal from the
 * server and a check made here land on the same input. The server stays the
 * authority; these checks only save a round trip. No amount, price or rate exists
 * here (AC-2.9): man-days and hours are units of work.
 */
import { strings } from '../strings'
import type { Contract, ContractTermsInput, HourPackageKind, ProjectType } from './types'

export type PositionForm = { profile: string; plannedManDays: string }

export type TermsForm = {
  // fixed price
  deadline: string
  estimatedManDays: string
  maxEffortManDays: string
  // maintenance and SaaS: each member optional
  withSla: boolean
  sla: { high: string; normal: string }
  withHours: boolean
  hourPackage: { hours: string; kind: HourPackageKind; startDate: string; expiryDate: string }
  // time and material
  positions: PositionForm[]
}

/** Field name → message; the names are the server's dotted `field`s. */
export type TermsErrors = Record<string, string>

/** The prefilled take-in-charge times (AC-2.5). */
export const DEFAULT_SLA = { high: '1', normal: '3' } as const

export const MAX_POSITIONS = 50
export const MAX_PROFILE_LENGTH = 120

const e = () => strings.contracts.errors
const requiredMessage = () => strings.common.validation.required

export const emptyTermsForm = (type: ProjectType): TermsForm => ({
  deadline: '',
  estimatedManDays: '',
  maxEffortManDays: '',
  withSla: false,
  sla: { ...DEFAULT_SLA },
  withHours: false,
  hourPackage: { hours: '', kind: 'capacity', startDate: '', expiryDate: '' },
  positions: type === 't_and_m' ? [{ profile: '', plannedManDays: '' }] : [],
})

const text = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value))

/** A stored contract's terms as the edit form starts. */
export function termsFormOf(contract: Contract): TermsForm {
  const form = emptyTermsForm(contract.type)
  const terms = contract.terms
  if ('deadline' in terms) {
    return {
      ...form,
      deadline: terms.deadline,
      estimatedManDays: text(terms.estimatedManDays),
      maxEffortManDays: text(terms.maxEffortManDays),
    }
  }
  if ('positions' in terms) {
    return {
      ...form,
      positions: terms.positions.map((position) => ({
        profile: position.profile,
        plannedManDays: text(position.plannedManDays),
      })),
    }
  }
  if ('sla' in terms || 'hourPackage' in terms) {
    return {
      ...form,
      withSla: terms.sla !== null,
      sla: terms.sla ? { high: text(terms.sla.highDays), normal: text(terms.sla.normalDays) } : { ...DEFAULT_SLA },
      withHours: terms.hourPackage !== null,
      hourPackage: terms.hourPackage
        ? {
            hours: text(terms.hourPackage.hours),
            kind: terms.hourPackage.kind,
            startDate: terms.hourPackage.startDate,
            expiryDate: terms.hourPackage.expiryDate ?? '',
          }
        : form.hourPackage,
    }
  }
  return form
}

/** Man-days with at most one decimal (a comma is accepted), 0 to 99,999.9; `null` when it is not one. */
export function parseManDays(raw: string): number | null {
  const match = /^(\d{1,5})(?:[.,](\d))?$/.exec(raw.trim())
  if (match === null) return null
  const value = Number(`${match[1]}.${match[2] ?? '0'}`)
  return value <= 99_999.9 ? value : null
}

/** A whole number from `min` to `max`; `null` when it is not one. */
export function parseWhole(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,7}$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return value >= min && value <= max ? value : null
}

type Result = { input: ContractTermsInput; errors: TermsErrors }

function fixedPrice(form: TermsForm): Result {
  const errors: TermsErrors = {}
  if (form.deadline === '') errors['terms.deadline'] = requiredMessage()
  const effort = parseManDays(form.maxEffortManDays)
  if (form.maxEffortManDays.trim() === '') errors['terms.maxEffortManDays'] = requiredMessage()
  else if (effort === null || effort <= 0) errors['terms.maxEffortManDays'] = e().manDaysAbove0
  const estimated = form.estimatedManDays.trim() === '' ? null : parseManDays(form.estimatedManDays)
  if (form.estimatedManDays.trim() !== '' && estimated === null) errors['terms.estimatedManDays'] = e().manDaysFrom0
  return {
    input: { deadline: form.deadline, estimatedManDays: estimated, maxEffortManDays: effort ?? 0 },
    errors,
  }
}

function slaAndHours(type: ProjectType, form: TermsForm): Result {
  const errors: TermsErrors = {}
  let sla: { highDays: number; normalDays: number } | null = null
  if (form.withSla) {
    const highDays = parseWhole(form.sla.high, 0, 60)
    const normalDays = parseWhole(form.sla.normal, 0, 60)
    if (highDays === null) errors['terms.sla.highDays'] = e().wholeDays
    if (normalDays === null) errors['terms.sla.normalDays'] = e().wholeDays
    if (highDays !== null && normalDays !== null) sla = { highDays, normalDays }
  }

  let hourPackage: {
    hours: number
    kind: HourPackageKind
    startDate: string
    expiryDate: string | null
  } | null = null
  if (form.withHours) {
    const { hours: rawHours, kind, startDate, expiryDate } = form.hourPackage
    const hours = parseWhole(rawHours, 1, 1_000_000)
    if (rawHours.trim() === '') errors['terms.hourPackage.hours'] = requiredMessage()
    else if (hours === null) errors['terms.hourPackage.hours'] = e().wholeHours
    if (startDate === '') errors['terms.hourPackage.startDate'] = requiredMessage()
    // Only a capacity package expires: a yearly one never sends an expiry, whatever the field still holds.
    const expiry = kind === 'capacity' && expiryDate !== '' ? expiryDate : null
    if (expiry !== null && startDate !== '' && expiry < startDate) {
      errors['terms.hourPackage.expiryDate'] = e().expiryBeforeStart
    }
    if (hours !== null && startDate !== '') hourPackage = { hours, kind, startDate, expiryDate: expiry }
  }

  if (type === 'maintenance' && !form.withSla && !form.withHours) errors['terms'] = e().maintenanceNeedsSlaOrHours
  return { input: { sla, hourPackage }, errors }
}

function timeAndMaterial(form: TermsForm): Result {
  const errors: TermsErrors = {}
  if (form.positions.length === 0) errors['terms.positions'] = e().positionsMin
  if (form.positions.length > MAX_POSITIONS) errors['terms.positions'] = e().positionsMax
  const positions = form.positions.map((position, index) => {
    const profile = position.profile.trim()
    const days = parseManDays(position.plannedManDays)
    if (profile === '') errors[`terms.positions.${index}.profile`] = requiredMessage()
    else if (profile.length > MAX_PROFILE_LENGTH) {
      errors[`terms.positions.${index}.profile`] = strings.common.validation.tooLong(MAX_PROFILE_LENGTH)
    }
    if (days === null || days <= 0) errors[`terms.positions.${index}.plannedManDays`] = e().manDaysAbove0
    return { profile, plannedManDays: days ?? 0 }
  })
  return { input: { positions }, errors }
}

/** The request's `terms` for a contract of `type`, and the problems with the form (none = ready to send). */
export function termsInputOf(type: ProjectType, form: TermsForm): Result {
  switch (type) {
    case 'fixed_price':
      return fixedPrice(form)
    case 'maintenance':
    case 'saas':
      return slaAndHours(type, form)
    case 't_and_m':
      return timeAndMaterial(form)
    case 'internal':
      return { input: {}, errors: {} }
  }
}

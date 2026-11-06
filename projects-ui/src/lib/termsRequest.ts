/**
 * The terms of a request (specs/022 AC-1.2, AC-1.8, AC-5.3): the dates and the members of the
 * project's type, as the form holds them, built into the one `TermsInput` that a take
 * (`POST /queue/{dealId}/project`), a hand-made create (`POST /projects`) and the terms routes
 * carry — `{ startDate, endDate?, terms }`, the members nested under `terms`, as `Terms` reads back
 * (tasks.md § API contracts "projects-api — shapes (T23)"). The checks are those of `lib/terms.ts`; the
 * server stays the authority. This is the one place that knows the request's shape.
 */
import { strings } from '../strings'
import { termsInputOf } from './terms'
import type { TermsErrors, TermsForm } from './terms'
import type { ProjectType, TermsInput } from './types'

export type TermsRequestForm = { startDate: string; endDate: string; terms: TermsForm }

/**
 * `estimateBacked`: the project comes from a deal with an estimate, so fixed-price terms take their
 * estimated man-days from it (AC-3.1) and the request must not carry the member at all — the
 * server refuses it sent, even empty (`estimated_man_days_from_estimate`).
 */
export function termsRequestOf(
  type: ProjectType,
  form: TermsRequestForm,
  { estimateBacked }: { estimateBacked: boolean },
): { input: TermsInput; errors: TermsErrors } {
  const errors: TermsErrors = {}
  if (form.startDate === '') errors['startDate'] = strings.common.validation.required
  if (form.endDate !== '' && form.startDate !== '' && form.endDate < form.startDate) {
    errors['endDate'] = strings.terms.errors.endBeforeStart
  }
  const checked = termsInputOf(type, form.terms)
  const members = estimateBacked && type === 'fixed_price' ? withoutEstimatedManDays(checked.input) : checked.input
  return {
    input: {
      startDate: form.startDate,
      ...(form.endDate !== '' ? { endDate: form.endDate } : {}),
      // `internal` has no terms: no member at all rather than an empty object.
      ...(type === 'internal' ? {} : { terms: members }),
    },
    errors: { ...errors, ...checked.errors },
  }
}

/**
 * The members of terms the estimate backs, as a request may carry them: with no
 * `estimatedManDays` member at all. Used when terms are made from a deal and when terms
 * of a project made from a deal are edited (`PATCH`): the server refuses the member either way (AC-3.1).
 */
export function withoutEstimatedManDays<T extends object>(terms: T): Omit<T, 'estimatedManDays'> {
  return Object.fromEntries(Object.entries(terms).filter(([member]) => member !== 'estimatedManDays')) as Omit<
    T,
    'estimatedManDays'
  >
}

/** Where a server `field` is read from: the terms routes, or the `terms` member of a take / a hand-made create. */
export type TermsFieldRoute = 'terms-route' | 'nested'

/**
 * A server `field` as the forms key their errors: `startDate` / `endDate` are the dates, `terms` is the
 * member set as a whole (maintenance needs an SLA or an hour package), and everything else is a member of the
 * terms, keyed `terms.<member>` (`terms.sla.highDays`). The server's paths depend on the route (tasks.md §
 * API contracts): the terms routes name `startDate`, `terms.deadline`; a take or a hand-made create wraps
 * the whole input under `terms`, so it names `terms.startDate`, `terms.terms.deadline`, `terms.terms` — drop
 * that one wrapper first, then both read alike. `null` when the field is not an input of the terms
 * (the body as a whole, or another member of the request).
 */
export function termsFieldKey(serverField: string, route: TermsFieldRoute): string | null {
  let own: string | null = serverField
  if (route === 'nested') own = serverField.startsWith('terms.') ? serverField.slice('terms.'.length) : null
  if (own === null) return null
  if (own === 'startDate' || own === 'endDate' || own === 'terms') return own
  return own.startsWith('terms.') ? own : null
}

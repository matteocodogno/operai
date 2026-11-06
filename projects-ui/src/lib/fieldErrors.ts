/**
 * An error is about the value it was raised on (specs/022 AC-7.1, D53): when that value changes, its message
 * and its invalid mark go — typed, picked or cleared, even if the new value is still wrong — and the next
 * submit checks the whole form again. The forms keep their errors as a field → message record
 * (`TermsErrors`, the server's dotted `field` names for the terms' members); these are the two steps every
 * dialog of the module takes on a change: end the messages the change settles, and say which ones those are.
 */
import type { TermsForm } from './terms'

type Errors = Partial<Record<string, string>>

/**
 * `errors` without the named fields. A name ending in `.*` names every field under that prefix
 * (`terms.positions.*` is `terms.positions.0.profile`, `terms.positions.3.plannedManDays`, …), not the
 * prefix itself. The same object comes back when none of them is set, so a state update with it renders nothing.
 */
export function withoutErrors<E extends Errors>(errors: E, ...fields: string[]): E {
  const named = (key: string) =>
    fields.some((field) => (field.endsWith('.*') ? key.startsWith(field.slice(0, -1)) : key === field))
  const hit = Object.keys(errors).filter((key) => named(key) && errors[key])
  if (hit.length === 0) return errors
  return Object.fromEntries(Object.entries(errors).filter(([key]) => !named(key))) as E
}

/**
 * The error fields a change of the terms' members settles, from the form before to the form after. The
 * keys are the server's (`terms.sla.highDays`, `terms.hourPackage.expiryDate`, `terms.positions.0.profile`);
 * the form-level message of the terms as a whole (`terms`, maintenance needing an SLA or an hour package)
 * is not tied to one of them and stays until the next submit.
 */
export function termsErrorKeysChanged(before: TermsForm, after: TermsForm): string[] {
  const keys: string[] = []
  if (before.deadline !== after.deadline) keys.push('terms.deadline')
  if (before.estimatedManDays !== after.estimatedManDays) keys.push('terms.estimatedManDays')
  if (before.maxEffortManDays !== after.maxEffortManDays) keys.push('terms.maxEffortManDays')

  // Turning a member on or off hides its inputs: what was said of them is not about what comes back.
  if (before.withSla !== after.withSla) keys.push('terms.sla.*')
  if (before.sla.high !== after.sla.high) keys.push('terms.sla.highDays')
  if (before.sla.normal !== after.sla.normal) keys.push('terms.sla.normalDays')

  if (before.withHours !== after.withHours) keys.push('terms.hourPackage.*')
  const was = before.hourPackage
  const now = after.hourPackage
  if (was.hours !== now.hours) keys.push('terms.hourPackage.hours')
  if (was.kind !== now.kind) keys.push('terms.hourPackage.kind')
  if (was.startDate !== now.startDate) keys.push('terms.hourPackage.startDate')
  // The expiry only exists for a capacity package: changing the kind takes it away or brings it back.
  if (was.expiryDate !== now.expiryDate || was.kind !== now.kind) keys.push('terms.hourPackage.expiryDate')

  if (before.positions.length !== after.positions.length) {
    // An added or removed position moves the indexes the messages are keyed by.
    keys.push('terms.positions', 'terms.positions.*')
  } else {
    after.positions.forEach((position, index) => {
      const previous = before.positions[index]
      if (previous?.profile !== position.profile) keys.push(`terms.positions.${index}.profile`)
      if (previous?.plannedManDays !== position.plannedManDays) keys.push(`terms.positions.${index}.plannedManDays`)
    })
  }
  return keys
}

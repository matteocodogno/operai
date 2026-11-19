/**
 * CatalogSelect — the one native `<select>` for a ledger account or a VAT code
 * (specs/20261118-refund-accounting-export, design component #41, UX-4): the same control in the default-account
 * dialog and the line classification panel.
 *
 * specs/20261119-accounting (T35, RS3, RS4): an option's value is the entry's NUMBER or CODE (Accounting keys its
 * entries naturally; there are no ids), and `current` carries Accounting's `state`.
 *
 *   - Labels are number-first (`5905 — Spese rimborsi`), so type-ahead matches the number.
 *   - `noneLabel` adds an explicit "None" option (value `CATALOG_NONE`): a default account may be cleared, and a line's
 *     VAT code is optional (T70, AC-3.3, AC-3.13), so the panel's VAT select passes one. The panel's account select
 *     passes none: a line's account is required and has no "back to default".
 *   - `placeholder` is the "nothing chosen" option (empty value). It is disabled, so once a real value is
 *     picked it cannot be chosen again; it shows while `value` is `''`. A missing value and a
 *     deliberately empty one are different things and never share an option.
 *   - `current` is the value the thing already carries. When it is not among the (active-only) `options`, it is
 *     added so the control tells the truth about what is stored: a `deactivated` one as a disabled option
 *     labelled "(deactivated)", a `not_found` one as "(not in Accounting)", both shown as selected when
 *     `value` is its key and neither can be re-chosen; an `active` or `unverified` one as an ordinary option.
 *     Pass `value=""` instead to make the user pick afresh (the defaults dialog).
 *
 * It renders only the `<select>`: the caller wraps it in a `Field` and spreads the field's control props
 * (`id`, `aria-describedby`, `aria-invalid`, `aria-required`) on it; any other select attribute
 * (`aria-busy`, `disabled`, `data-testid`) passes through.
 */

import type { Ref, SelectHTMLAttributes } from 'react'
import { strings } from '../strings'
import type { EntryState } from '../lib/accountingApi'
import { CATALOG_NONE, accountText, vatCodeText } from '../lib/catalogLabels'

type AccountEntry = { number: string; name: string }
type VatEntry = { code: string; label: string | null; ratePercent: string }

type SelectAttributes = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'>

type CatalogSelectCommon = SelectAttributes & {
  /** An entry's number or code, `CATALOG_NONE`, or `''` for "nothing chosen". */
  value: string
  onChange: (value: string) => void
  noneLabel?: string
  placeholder?: string
  /** For moving focus to the select (the first invalid field after a refused save). */
  ref?: Ref<HTMLSelectElement>
}

export type CatalogSelectProps = CatalogSelectCommon &
  (
    | { kind: 'account'; options: readonly AccountEntry[]; current?: (AccountEntry & { state: EntryState }) | null }
    | { kind: 'vatCode'; options: readonly VatEntry[]; current?: (VatEntry & { state: EntryState }) | null }
  )

export default function CatalogSelect(props: CatalogSelectProps) {
  const { kind, options, current, value, onChange, noneLabel, placeholder, ref, ...selectAttributes } = props
  const t = strings.pages.reviewDetail.classification

  const textOf = (entry: AccountEntry | VatEntry): string =>
    kind === 'account' ? accountText(entry as AccountEntry) : vatCodeText(entry as VatEntry)
  const keyOf = (entry: AccountEntry | VatEntry): string =>
    kind === 'account' ? (entry as AccountEntry).number : (entry as VatEntry).code

  const currentKey = current == null ? null : keyOf(current)
  const currentIsOffered = currentKey !== null && options.some((option) => keyOf(option) === currentKey)

  return (
    <select {...selectAttributes} ref={ref} value={value} onChange={(event) => onChange(event.target.value)}>
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {noneLabel !== undefined && <option value={CATALOG_NONE}>{noneLabel}</option>}
      {current != null && currentKey !== null && !currentIsOffered && (
        <option
          value={currentKey}
          disabled={current.state === 'deactivated' || current.state === 'not_found'}
        >
          {current.state === 'deactivated'
            ? t.inactiveOption(textOf(current))
            : current.state === 'not_found'
              ? t.notFoundOption(textOf(current))
              : textOf(current)}
        </option>
      )}
      {options.map((option) => (
        <option key={keyOf(option)} value={keyOf(option)}>
          {textOf(option)}
        </option>
      ))}
    </select>
  )
}

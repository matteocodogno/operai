/**
 * CatalogSelect — the one native `<select>` for a ledger account or a VAT code
 * (specs/20261118-refund-accounting-export, design component #41, UX-4): the same control in the two defaults
 * dialogs, the foreign-currency VAT dialog and the line classification panel.
 *
 *   - Labels are number-first (`5905 — Spese rimborsi`), so type-ahead matches the number.
 *   - `noneLabel` adds an explicit "None" option (value `CATALOG_NONE`): a default may be cleared. The line
 *     panel passes none: a line has no "back to default".
 *   - `placeholder` is the "nothing chosen" option (empty value). It is disabled, so once a real value is
 *     picked it cannot be chosen again; it shows while `value` is `''`. A missing value and a
 *     deliberately empty one are different things and never share an option.
 *   - `current` is the value the thing already carries. When it is deactivated it is not among the
 *     (active-only) `options`, so it is added as a disabled option labelled "(inactive)" and, with
 *     `value === current.id`, shown as selected: the control tells the truth about what is stored, and
 *     cannot be re-chosen. Pass `value=""` instead to make the user pick afresh (the defaults dialog).
 *
 * It renders only the `<select>`: the caller wraps it in a `Field` and spreads the field's control props
 * (`id`, `aria-describedby`, `aria-invalid`, `aria-required`) on it; any other select attribute
 * (`aria-busy`, `disabled`, `data-testid`) passes through.
 */

import type { SelectHTMLAttributes } from 'react'
import { strings } from '../strings'
import { CATALOG_NONE, accountText, vatCodeText } from '../lib/catalogLabels'

type AccountEntry = { id: string; number: string; name: string }
type VatEntry = { id: string; code: string; label: string; ratePercent: string }

type SelectAttributes = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'>

type CatalogSelectCommon = SelectAttributes & {
  /** An entry id, `CATALOG_NONE`, or `''` for "nothing chosen". */
  value: string
  onChange: (value: string) => void
  noneLabel?: string
  placeholder?: string
}

export type CatalogSelectProps = CatalogSelectCommon &
  (
    | { kind: 'account'; options: readonly AccountEntry[]; current?: (AccountEntry & { active: boolean }) | null }
    | { kind: 'vatCode'; options: readonly VatEntry[]; current?: (VatEntry & { active: boolean }) | null }
  )

export default function CatalogSelect(props: CatalogSelectProps) {
  const { kind, options, current, value, onChange, noneLabel, placeholder, ...selectAttributes } = props
  const t = strings.pages.reviewDetail.classification

  const textOf = (entry: AccountEntry | VatEntry): string =>
    kind === 'account' ? accountText(entry as AccountEntry) : vatCodeText(entry as VatEntry)

  const currentIsInactive = current != null && !current.active && !options.some((option) => option.id === current.id)

  return (
    <select {...selectAttributes} value={value} onChange={(event) => onChange(event.target.value)}>
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {noneLabel !== undefined && <option value={CATALOG_NONE}>{noneLabel}</option>}
      {currentIsInactive && (
        <option value={current.id} disabled>
          {t.inactiveOption(textOf(current))}
        </option>
      )}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {textOf(option)}
        </option>
      ))}
    </select>
  )
}

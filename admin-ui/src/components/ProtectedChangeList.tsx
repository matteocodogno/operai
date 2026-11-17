/**
 * ProtectedChangeList — the "Old / New" rows shared by the save confirmation (S12) and the restore dialog (S7)
 * (T60, specs/20261117-legal-entities, design S12 and the S7 additions; AC-9.1, AC-9.4, AC-9.6).
 *
 * A real list, one `<li>` per protected detail that changes, in the order given (the closed order: legal name, VAT
 * number, IBAN). Each item names the detail and then holds a `<dl>` pairing the visible terms "Old" and "New" with
 * their values: the two are told apart by their words, never by colour, strike-through or position alone. An empty
 * side is the word "None" (never blank). Legal name and VAT number are shown in full and wrap (320 px reflow, no
 * truncation); the IBAN arrives in groups of four and is set in the mono font, wrapping between groups. The values
 * are data, not prose: no `lang` is set on them.
 *
 * Presentational and in the dialog's described content, so a screen reader hears each detail with its Old and New
 * values when the dialog opens.
 */
import type { ProtectedChange } from '../lib/legalEntitiesApi'
import { valueName } from '../lib/legalEntityMappings'
import { strings } from '../strings'

const t = strings.legalEntities.protected

export type ProtectedChangeListProps = {
  changes: readonly ProtectedChange[]
  testId?: string
}

/** The value of one side: the word "None" for an empty value, else the value (VAT number and IBAN in mono). */
function Side({ value, mono }: { value: string; mono: boolean }) {
  if (value.trim() === '') return <dd className="m-0 text-soft">{t.none}</dd>
  return <dd className={`m-0 break-words [overflow-wrap:anywhere]${mono ? ' font-mono text-sm' : ''}`}>{value}</dd>
}

export default function ProtectedChangeList({ changes, testId = 'admin-legal-protected-list' }: ProtectedChangeListProps) {
  return (
    <ul className="m-0 my-3 flex list-none flex-col gap-2 p-0" aria-label={t.listLabel} data-testid={testId}>
      {changes.map((change) => {
        const mono = change.field !== 'legalName'
        return (
          <li
            key={change.field}
            className="rounded-md border border-rule bg-ink px-3 py-2"
            data-testid={`${testId}-${change.field}`}
          >
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-soft">{valueName(change.field)}</div>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="pt-px text-xs font-semibold text-soft">{t.old}</dt>
              <Side value={change.before} mono={mono} />
              <dt className="pt-px text-xs font-semibold text-soft">{t.new}</dt>
              <Side value={change.after} mono={mono} />
            </dl>
          </li>
        )
      })}
    </ul>
  )
}

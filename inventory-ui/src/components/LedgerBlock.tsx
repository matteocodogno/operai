import { useId, useState } from 'react'
import DisposeDialog from './DisposeDialog'
import GuardrailDialog from './GuardrailDialog'
import ScheduleTable from './ScheduleTable'
import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { formatDate } from '../lib/dates'
import { formatMoney } from '../lib/money'
import type { AssetView, Identity } from '../lib/types'
import { strings } from '../strings'

/**
 * LedgerBlock — the accountant's region of the asset detail page (T34, specs/
 * 015-hardware-inventory; design.md § T2 ledger region, F9, F10, § Accessibility
 * "T2 detail"; AC-5.8, AC-7.1, AC-7.3, AC-7.4, AC-7.5). Its props are fixed by
 * T32; the page renders it only for `ledger:manage`, and it renders NOTHING
 * (not an empty block) when the server sent no `ledger`.
 *
 * Shows the book value today, the rule in force with its effective date, the
 * schedule per year (`ScheduleTable`), the disposal once there is one — with the
 * sale price, which is shown nowhere else — and "Dispose..." inside the block,
 * so accounting controls are reached only under this heading. Dispose is absent
 * for a disposed asset and `aria-disabled` (focusable, reason in
 * `aria-describedby`, activation a no-op) while an assignment is pending
 * (AC-7.5). Every figure is the server's; this component formats, never computes.
 *
 * Disposal success hands the disposed asset to the page, announces it and moves
 * focus to the page heading (the button is gone). `asset_disposed` is explained
 * in a guardrail and reloads once acknowledged; a 404 reloads at once.
 */

export type LedgerBlockProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  onChanged: (updated: AssetView | null) => void
  announce: (message: string) => void
  focusHeading: () => void
}

const identityLabel = (identity: Identity): string => {
  if (identity.status === 'system') return strings.assets.holderSystem
  if (identity.status === 'deleted') return strings.assets.holderDeleted
  return identity.name ?? strings.assets.holderUnknown
}

export default function LedgerBlock({ asset, capabilities, onChanged, announce, focusHeading }: LedgerBlockProps) {
  const t = strings.ledger
  const baseId = useId()
  const [disposing, setDisposing] = useState(false)
  const [guardrail, setGuardrail] = useState(false)

  const { ledger } = asset
  if (!capabilities.canManageLedger || ledger === undefined) return null

  const headingId = `${baseId}-heading`
  const reasonId = `${baseId}-dispose-reason`
  const pending = asset.pendingAssignment
  const blocked = pending !== null
  const money = (cents: number) => formatMoney(cents, asset.currency)
  const { rule } = ledger

  const ruleText = t.ruleApplied(
    rule.usefulLifeYears,
    t.firstYearShare[rule.firstYearShare],
    rule.lowValueThresholdCents === null ? t.noThreshold : t.threshold(money(rule.lowValueThresholdCents)),
    money(rule.residualCents),
  )

  const conflict = (kind: 'asset_disposed' | 'not_found' | 'assignment_pending') => {
    if (kind === 'assignment_pending') return onChanged(null)
    setDisposing(false)
    if (kind === 'asset_disposed') setGuardrail(true)
    else onChanged(null)
  }

  const labelStyle = { color: 'var(--soft)' }

  return (
    <section aria-labelledby={headingId} data-testid="ledger-block" className="card">
      <h3
        id={headingId}
        className="card-title"
      >
        {t.heading}
      </h3>

      <p data-testid="ledger-book-value" className="flex flex-col text-sm">
        <span className="text-xs" style={labelStyle}>
          {t.bookValue}
        </span>
        <span className="text-lg font-semibold" style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
          {money(ledger.bookValueCents)}
        </span>
      </p>

      <div data-testid="ledger-rule" className="flex flex-col gap-0.5 text-sm" style={{ color: 'var(--text)' }}>
        <p>{ruleText}</p>
        <p className="text-xs" style={labelStyle}>
          {t.ruleEffective(formatDate(rule.effectiveFrom))}
        </p>
      </div>

      <ScheduleTable ledger={ledger} currency={asset.currency} disposal={asset.disposal} />

      {asset.disposal !== null && (
        <dl data-testid="ledger-disposal" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs" style={labelStyle}>
              {t.disposal.date}
            </dt>
            <dd className="text-sm" style={{ color: 'var(--text)' }}>
              {formatDate(asset.disposal.disposedOn)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs" style={labelStyle}>
              {t.disposal.reason}
            </dt>
            <dd className="text-sm" style={{ color: 'var(--text)' }}>
              {strings.disposalReasons[asset.disposal.reason]}
            </dd>
          </div>
          {asset.disposal.salePriceCents !== null && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs" style={labelStyle}>
                {t.disposal.salePrice}
              </dt>
              <dd className="text-sm" style={{ color: 'var(--text)' }}>
                {money(asset.disposal.salePriceCents)}
              </dd>
            </div>
          )}
        </dl>
      )}

      {asset.status !== 'disposed' && (
        <div className="flex flex-col items-start gap-1">
          <button
            type="button"
            onClick={() => {
              if (!blocked) setDisposing(true)
            }}
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? reasonId : undefined}
            className="btn btn-danger"
          >
            {t.dispose.action}
          </button>
          {blocked && (
            <p id={reasonId} className="text-xs" style={labelStyle}>
              {t.dispose.pendingReason(identityLabel(pending.assignee))}
            </p>
          )}
        </div>
      )}

      {disposing && (
        <DisposeDialog
          asset={asset}
          onDisposed={(updated) => {
            setDisposing(false)
            onChanged(updated)
            announce(t.dispose.done)
            focusHeading()
          }}
          onCancel={() => setDisposing(false)}
          onConflict={conflict}
        />
      )}

      {guardrail && (
        <GuardrailDialog
          title={t.dispose.conflictTitle}
          message={strings.errors.asset_disposed}
          onAcknowledge={() => {
            setGuardrail(false)
            onChanged(null)
          }}
        />
      )}
    </section>
  )
}

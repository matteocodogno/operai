/**
 * VatCodesCard — one entity's VAT codes, each with one fixed rate (moved from refund-ui, where it listed WellD CH's only;
 * specs/20261119-accounting, design AS4, FA4, FA5, FA6, UX-3 to UX-8, UX-15; AC-1.5 to AC-1.8, AC-1.10, AC-8.3, AC-8.4).
 *
 * Same shape as `LedgerAccountsCard`: a table (code first, as the row header, then label and rate), a status badge, no
 * who-added; **Add VAT code**, **Deactivate** (confirmed, neutral words) and **Reactivate** only with `canManage` (`/v1/me`'s,
 * for the displayed entity); a reader gets the table and one quiet sentence. **There is no edit control**: a rate never changes
 * (a new rate is a new code), so the only row actions are Deactivate and Reactivate and the rate is plain text through
 * `formatVatRate` (AC-1.7). The entity is named in the title, the caption and the dialog title; the page keys the card by
 * entity. Exactly one state at a time; denied replaces the view; a 404 from the list and a 403 from a write reach the frame.
 * Dialogs are mounted beside the card (ADR 20261118 dialog-beside-form).
 */

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, ConfirmDialog, DataTable, StatePanel, StatusBadge } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { useCatalogToggle } from '../hooks/useCatalogToggle'
import { useLoadedResource } from '../hooks/useLoadedResource'
import { deactivateVatCode, listVatCodes, reactivateVatCode } from '../lib/catalogApi'
import type { VatCode } from '../lib/catalogApi'
import { statusOf } from '../lib/errors'
import { formatVatRate } from '../lib/formatVatRate'
import type { EntityId } from '../lib/meApi'
import { CATALOG_STATUS_MEANING } from '../lib/statusMeaning'
import { strings } from '../strings'
import AddVatCodeDialog from './AddVatCodeDialog'
import { LoadFailure, Loading } from './LoadState'
import PermissionDenied from './PermissionDenied'
import { Saved } from './Saved'

const t = strings.vatCodes

export type VatCodesCardProps = {
  entity: EntityId
  /** `/v1/me`'s `canManage` for this entity: Add, Deactivate and Reactivate are offered. */
  canManage: boolean
  /** The list answered 404: this entity is not covered any more (UX-12). */
  onEntityGone: () => void
  /** A write answered 403: re-read `/v1/me` (UX-15, AC-3.4). */
  onWriteRefused: () => void
}

export default function VatCodesCard({ entity, canManage, onEntityGone, onWriteRefused }: VatCodesCardProps) {
  const resource = useLoadedResource(() => listVatCodes(entity))
  const [adding, setAdding] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const entityName = strings.entity[entity]

  const items = resource.status === 'loaded' ? resource.data : []

  const toggle = useCatalogToggle<VatCode>({
    keyOf: (vatCode) => vatCode.code,
    deactivate: (code) => deactivateVatCode(entity, code),
    reactivate: (code) => reactivateVatCode(entity, code),
    onChanged: (updated) =>
      resource.replace((current) => current.map((vatCode) => (vatCode.code === updated.code ? updated : vatCode))),
    onStale: resource.reload,
    onForbidden: onWriteRefused,
    messages: {
      deactivated: t.deactivated,
      reactivated: t.reactivated,
      alreadyActive: t.errors.alreadyActive,
      alreadyInactive: t.errors.alreadyInactive,
      forbidden: strings.common.forbidden,
      genericError: strings.common.genericError,
    },
  })

  // A list that answers 404: a grant narrowed during the session. The frame re-reads `/v1/me` and falls back, once per answer
  // (`failure` identifies the answer; the callback is read through a ref, because its identity changes with every re-read).
  const goneRef = useRef(onEntityGone)
  useEffect(() => {
    goneRef.current = onEntityGone
  })
  const failure = resource.status === 'error' ? resource.error : null
  const gone = failure !== null && statusOf(failure) === 404
  useEffect(() => {
    if (gone) goneRef.current()
  }, [gone, failure])

  // Safari does not focus a button on click, so the dialog's own "return to the opener" would land on <body>.
  const handleAddCancel = () => {
    setAdding(false)
    addButtonRef.current?.focus()
  }

  const handleAdded = (vatCode: VatCode) => {
    // Show the row at once, then take the server's order.
    resource.replace((current) => [...current.filter((item) => item.code !== vatCode.code), vatCode])
    resource.reload()
    setAdding(false)
    toggle.announce(t.added(vatCode.code))
    addButtonRef.current?.focus()
  }

  const columns: DataTableColumn<VatCode>[] = [
    {
      id: 'code',
      header: t.columns.code,
      rowHeader: true,
      render: (vatCode) => <span className="font-mono">{vatCode.code}</span>,
    },
    { id: 'label', header: t.columns.label, render: (vatCode) => vatCode.label },
    // Plain text: there is no edit control for a rate anywhere (AC-1.7).
    { id: 'rate', header: t.columns.rate, numeric: true, render: (vatCode) => formatVatRate(vatCode.ratePercent) },
    {
      id: 'status',
      header: t.columns.status,
      render: (vatCode) => (
        <StatusBadge status={CATALOG_STATUS_MEANING[vatCode.active ? 'active' : 'inactive']}>
          {vatCode.active ? strings.status.active : strings.status.inactive}
        </StatusBadge>
      ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: t.columns.actions,
            render: (vatCode: VatCode) =>
              vatCode.active ? (
                <Button
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={t.deactivateLabel(vatCode.code)}
                  disabled={toggle.pendingKey !== null}
                  onClick={() => toggle.openConfirm(vatCode)}
                  data-testid={`accounting-vat-deactivate-${vatCode.code}`}
                >
                  {t.deactivate}
                </Button>
              ) : (
                <Button
                  size="sm"
                  aria-label={t.reactivateLabel(vatCode.code)}
                  disabled={toggle.pendingKey !== null}
                  busy={toggle.pendingKey === vatCode.code}
                  onClick={() => void toggle.reactivate(vatCode)}
                  data-testid={`accounting-vat-reactivate-${vatCode.code}`}
                >
                  {t.reactivate}
                </Button>
              ),
          } satisfies DataTableColumn<VatCode>,
        ]
      : []),
  ]

  // Denied replaces the view: here the card IS the page, so leaving it out would say nothing (AS4).
  if (resource.status === 'forbidden') return <PermissionDenied />

  return (
    <>
      <Card
        title={t.title(entityName)}
        data-testid="accounting-vat-card"
        action={
          canManage && resource.status === 'loaded' ? (
            <Button
              ref={addButtonRef}
              size="sm"
              aria-haspopup="dialog"
              onClick={() => setAdding(true)}
              data-testid="accounting-vat-add"
            >
              {t.add}
            </Button>
          ) : undefined
        }
      >
        <p className="text-sm text-soft mb-4">{t.description(entityName)}</p>
        {!canManage && resource.status === 'loaded' && (
          <p className="text-sm text-soft mb-4" data-testid="accounting-vat-read-only">
            {strings.common.readOnly(strings.common.readOnlyWhat.vatCodes)}
          </p>
        )}

        {resource.status === 'loading' && <Loading label={t.loading} />}

        {resource.status === 'error' && <LoadFailure error={resource.error} onRetry={resource.reload} message={t.loadError} />}

        {resource.status === 'loaded' && (
          <div className="flex flex-col gap-3">
            {toggle.success && <Saved message={toggle.success} onDismiss={toggle.clearSuccess} />}
            {toggle.actionError && (
              <Banner
                tone="danger"
                onDismiss={toggle.clearActionError}
                dismissLabel={strings.common.dismiss}
                data-testid="accounting-vat-action-error"
              >
                {toggle.actionError}
              </Banner>
            )}
            {items.length === 0 ? (
              // A state, never an error (AC-8.3); the card's Add action already covers the call to action.
              <StatePanel title={t.empty.title(entityName)} headingLevel={4} testId="accounting-empty">
                {canManage ? t.empty.bodyManage : t.empty.bodyRead}
              </StatePanel>
            ) : (
              <DataTable
                caption={t.caption(entityName)}
                columns={columns}
                rows={items}
                getRowKey={(vatCode) => vatCode.code}
                focusRowKey={toggle.focusRowKey}
                testId="accounting-vat-table"
                rowTestIdPrefix="accounting-vat-row"
              />
            )}
          </div>
        )}
      </Card>

      {adding && (
        <AddVatCodeDialog
          entity={entity}
          vatCodes={items}
          onCancel={handleAddCancel}
          onAdded={handleAdded}
          onStale={resource.reload}
          onForbidden={onWriteRefused}
          onGone={onEntityGone}
        />
      )}

      {toggle.confirming && (
        <ConfirmDialog
          title={t.deactivateDialog.title(toggle.confirming.code)}
          tone="primary"
          confirmLabel={t.deactivateDialog.confirm}
          busyLabel={t.deactivateDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={toggle.confirmBusy}
          error={toggle.confirmError}
          onConfirm={() => void toggle.confirmDeactivate()}
          onCancel={toggle.cancelConfirm}
          testIdPrefix="accounting-vat-deactivate-dialog"
        >
          <p>{t.deactivateDialog.body}</p>
        </ConfirmDialog>
      )}
    </>
  )
}

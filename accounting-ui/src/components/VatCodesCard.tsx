/**
 * VatCodesCard — the VAT codes refunds may use, each with one fixed rate (specs/20261118-refund-accounting-export,
 * design S3, F2, F3; AC-1.4, AC-1.5, AC-1.7, AC-1.10, AC-1.11).
 *
 * Same shape as `LedgerAccountsCard`: a table (code first, as the row header, then label and rate), a status
 * badge, who added each and when; **Add VAT code**, **Deactivate** (confirmed) and **Reactivate** only with
 * `settings:manage`. **There is no edit control**: a rate never changes (a new rate is a new code), so the only
 * row actions are Deactivate and Reactivate and the card shows no pencil anywhere (AC-1.5). Dialogs are mounted
 * beside the card (ADR 20261118 dialog-beside-form).
 */

import { useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  DataTable,
  SkeletonRows,
  StatePanel,
  StatusBadge,
  VisuallyHidden,
  formatDate,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { strings } from '../../strings'
import { deactivateVatCode, listVatCodes, reactivateVatCode } from '../../lib/accountingApi'
import type { VatCode } from '../../lib/accountingApi'
import { formatVatRate } from '../../lib/catalogLabels'
import { CATALOG_STATUS_MEANING } from '../../lib/statusMeaning'
import { useLoadedResource } from '../../lib/useLoadedResource'
import ConfirmDeleteModal from '../ConfirmDeleteModal'
import ErrorBanner from '../ErrorBanner'
import SuccessBanner from '../SuccessBanner'
import AddVatCodeDialog from './AddVatCodeDialog'
import { useCatalogToggle } from './useCatalogToggle'

const t = strings.settings.vatCodes
const tc = strings.settings.catalog

export type VatCodesCardProps = {
  /** `settings:manage`: Add, Deactivate and Reactivate are offered. */
  canManage: boolean
}

export default function VatCodesCard({ canManage }: VatCodesCardProps) {
  const resource = useLoadedResource(listVatCodes)
  const [adding, setAdding] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  const items = resource.status === 'loaded' ? resource.data : []

  const toggle = useCatalogToggle<VatCode>({
    deactivate: deactivateVatCode,
    reactivate: reactivateVatCode,
    labelOf: (vatCode) => vatCode.code,
    onChanged: (updated) =>
      resource.replace((current) => current.map((vatCode) => (vatCode.id === updated.id ? updated : vatCode))),
    onStale: resource.reload,
    messages: {
      deactivated: t.deactivated,
      reactivated: t.reactivated,
      alreadyActive: t.errors.alreadyActive,
      alreadyInactive: t.errors.alreadyInactive,
      forbidden: tc.forbidden,
      genericError: tc.genericError,
    },
  })

  // A 403 that arrives anyway: the card is left out (UX-9).
  if (resource.status === 'forbidden') return null

  // Safari does not focus a button on click, so the dialog's own "return to the opener" would land on <body>.
  const handleAddCancel = () => {
    setAdding(false)
    addButtonRef.current?.focus()
  }

  const handleAdded = (vatCode: VatCode) => {
    // Show the row at once, then take the server's order.
    resource.replace((current) => [...current, vatCode])
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
    { id: 'rate', header: t.columns.rate, numeric: true, render: (vatCode) => formatVatRate(vatCode.ratePercent) },
    {
      id: 'status',
      header: t.columns.status,
      render: (vatCode) => (
        <StatusBadge status={CATALOG_STATUS_MEANING[vatCode.active ? 'active' : 'inactive']}>
          {vatCode.active ? tc.status.active : tc.status.inactive}
        </StatusBadge>
      ),
    },
    {
      id: 'added',
      header: t.columns.added,
      render: (vatCode) => t.addedBy(vatCode.createdByEmail, formatDate(vatCode.createdAt)),
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
                  disabled={toggle.pendingId !== null}
                  onClick={() => toggle.openConfirm(vatCode)}
                  data-testid={`settings-vat-code-deactivate-${vatCode.id}`}
                >
                  {t.deactivate}
                </Button>
              ) : (
                <Button
                  size="sm"
                  aria-label={t.reactivateLabel(vatCode.code)}
                  disabled={toggle.pendingId !== null}
                  busy={toggle.pendingId === vatCode.id}
                  onClick={() => void toggle.reactivate(vatCode)}
                  data-testid={`settings-vat-code-reactivate-${vatCode.id}`}
                >
                  {t.reactivate}
                </Button>
              ),
          } satisfies DataTableColumn<VatCode>,
        ]
      : []),
  ]

  return (
    <>
      <Card
        title={t.title}
        data-testid="settings-vat-codes-card"
        action={
          canManage && (
            <Button
              ref={addButtonRef}
              size="sm"
              aria-haspopup="dialog"
              onClick={() => setAdding(true)}
              data-testid="settings-vat-codes-add"
            >
              {t.add}
            </Button>
          )
        }
      >
        <p className="text-sm text-soft mb-4">{t.description}</p>

        {resource.status === 'loading' && (
          <>
            <VisuallyHidden live>{t.loading}</VisuallyHidden>
            <SkeletonRows rows={3} testId="skeleton-list-rows" />
          </>
        )}

        {resource.status === 'error' && <ErrorBanner message={t.loadError} onRetry={resource.reload} />}

        {resource.status === 'loaded' && (
          <div className="flex flex-col gap-3">
            <SuccessBanner
              message={toggle.success}
              onDismiss={toggle.clearSuccess}
              testId="settings-vat-codes-success"
            />
            {toggle.actionError && (
              <Banner
                tone="danger"
                onDismiss={toggle.clearActionError}
                dismissLabel={strings.settings.dismiss}
                data-testid="settings-vat-codes-action-error"
              >
                {toggle.actionError}
              </Banner>
            )}
            {items.length === 0 ? (
              <StatePanel title={t.empty.title} headingLevel={4} testId="settings-vat-codes-empty">
                {t.empty.body}
              </StatePanel>
            ) : (
              <DataTable
                caption={t.caption}
                columns={columns}
                rows={items}
                getRowKey={(vatCode) => vatCode.id}
                focusRowKey={toggle.focusRowKey}
                testId="settings-vat-codes-table"
                rowTestIdPrefix="settings-vat-code-row"
              />
            )}
          </div>
        )}
      </Card>

      {adding && <AddVatCodeDialog vatCodes={items} onCancel={handleAddCancel} onAdded={handleAdded} />}

      {toggle.confirming && (
        <ConfirmDeleteModal
          entityLabel={toggle.confirming.code}
          itemName={toggle.confirming.code}
          title={t.deactivateDialog.title(toggle.confirming.code)}
          body={<p>{t.deactivateDialog.body}</p>}
          tone="positive"
          confirmLabel={t.deactivateDialog.confirm}
          confirmingLabel={t.deactivateDialog.busy}
          isDeleting={toggle.confirmBusy}
          errorMessage={toggle.confirmError}
          onConfirm={() => void toggle.confirmDeactivate()}
          onCancel={toggle.cancelConfirm}
          testIdPrefix="deactivate-vat-code"
        />
      )}
    </>
  )
}

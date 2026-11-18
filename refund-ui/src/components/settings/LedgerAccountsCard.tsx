/**
 * LedgerAccountsCard — the WellD CH ledger accounts refunds may be booked to (specs/20261118-refund-accounting-export,
 * design S2, F1, F2; AC-1.1, AC-1.2, AC-1.7, AC-1.9, AC-1.11).
 *
 * A table of accounts (number first, as the row header) with a status badge, who added each and when. People with
 * `settings:manage` also get **Add account** in the card action and, per row, **Deactivate** (after a confirm that
 * says what it changes) or **Reactivate** (at once). There is no edit control anywhere: a number and a name never
 * change (AC-1.1), a deactivation is reversible (A1). Without `settings:manage` the card is read-only.
 *
 * The card loads its own list (`useLoadedResource`); a 403 that arrives anyway hides it, like the email card
 * (UX-9). Dialogs are mounted BESIDE the card, never inside a `<form>` (ADR 20261118 dialog-beside-form).
 * After Deactivate / Reactivate, focus moves to the row's header (the pressed button is gone); after Add it
 * returns to the Add button.
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
import { deactivateLedgerAccount, listLedgerAccounts, reactivateLedgerAccount } from '../../lib/accountingApi'
import type { LedgerAccount } from '../../lib/accountingApi'
import { CATALOG_STATUS_MEANING } from '../../lib/statusMeaning'
import { useLoadedResource } from '../../lib/useLoadedResource'
import ConfirmDeleteModal from '../ConfirmDeleteModal'
import ErrorBanner from '../ErrorBanner'
import SuccessBanner from '../SuccessBanner'
import AddLedgerAccountDialog from './AddLedgerAccountDialog'
import { useCatalogToggle } from './useCatalogToggle'

const t = strings.settings.accounts
const tc = strings.settings.catalog

export type LedgerAccountsCardProps = {
  /** `settings:manage`: Add, Deactivate and Reactivate are offered. */
  canManage: boolean
}

export default function LedgerAccountsCard({ canManage }: LedgerAccountsCardProps) {
  const resource = useLoadedResource(listLedgerAccounts)
  const [adding, setAdding] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  const items = resource.status === 'loaded' ? resource.data : []

  const toggle = useCatalogToggle<LedgerAccount>({
    deactivate: deactivateLedgerAccount,
    reactivate: reactivateLedgerAccount,
    labelOf: (account) => account.number,
    onChanged: (updated) =>
      resource.replace((current) => current.map((account) => (account.id === updated.id ? updated : account))),
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

  // A 403 that arrives anyway: the card is left out, as the email card is (UX-9).
  if (resource.status === 'forbidden') return null

  // Safari does not focus a button on click, so the dialog's own "return to the opener" would land on <body>.
  const handleAddCancel = () => {
    setAdding(false)
    addButtonRef.current?.focus()
  }

  const handleAdded = (account: LedgerAccount) => {
    // Show the row at once, then take the server's order and figures.
    resource.replace((current) => [...current, account])
    resource.reload()
    setAdding(false)
    toggle.announce(t.added(account.number))
    addButtonRef.current?.focus()
  }

  const columns: DataTableColumn<LedgerAccount>[] = [
    {
      id: 'number',
      header: t.columns.number,
      rowHeader: true,
      render: (account) => <span className="font-mono">{account.number}</span>,
    },
    { id: 'name', header: t.columns.name, render: (account) => account.name },
    {
      id: 'status',
      header: t.columns.status,
      render: (account) => (
        <StatusBadge status={CATALOG_STATUS_MEANING[account.active ? 'active' : 'inactive']}>
          {account.active ? tc.status.active : tc.status.inactive}
        </StatusBadge>
      ),
    },
    {
      id: 'added',
      header: t.columns.added,
      render: (account) => t.addedBy(account.createdByEmail, formatDate(account.createdAt)),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: t.columns.actions,
            render: (account: LedgerAccount) =>
              account.active ? (
                <Button
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={t.deactivateLabel(account.number)}
                  disabled={toggle.pendingId !== null}
                  onClick={() => toggle.openConfirm(account)}
                  data-testid={`settings-account-deactivate-${account.id}`}
                >
                  {t.deactivate}
                </Button>
              ) : (
                <Button
                  size="sm"
                  aria-label={t.reactivateLabel(account.number)}
                  disabled={toggle.pendingId !== null}
                  busy={toggle.pendingId === account.id}
                  onClick={() => void toggle.reactivate(account)}
                  data-testid={`settings-account-reactivate-${account.id}`}
                >
                  {t.reactivate}
                </Button>
              ),
          } satisfies DataTableColumn<LedgerAccount>,
        ]
      : []),
  ]

  return (
    <>
      <Card
        title={t.title}
        data-testid="settings-accounts-card"
        action={
          canManage && (
            <Button
              ref={addButtonRef}
              size="sm"
              aria-haspopup="dialog"
              onClick={() => setAdding(true)}
              data-testid="settings-accounts-add"
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
              testId="settings-accounts-success"
            />
            {toggle.actionError && (
              <Banner
                tone="danger"
                onDismiss={toggle.clearActionError}
                dismissLabel={strings.settings.dismiss}
                data-testid="settings-accounts-action-error"
              >
                {toggle.actionError}
              </Banner>
            )}
            {items.length === 0 ? (
              // No CTA here: the card's Add account action already covers it.
              <StatePanel title={t.empty.title} headingLevel={4} testId="settings-accounts-empty">
                {t.empty.body}
              </StatePanel>
            ) : (
              <DataTable
                caption={t.caption}
                columns={columns}
                rows={items}
                getRowKey={(account) => account.id}
                focusRowKey={toggle.focusRowKey}
                testId="settings-accounts-table"
                rowTestIdPrefix="settings-account-row"
              />
            )}
          </div>
        )}
      </Card>

      {adding && <AddLedgerAccountDialog accounts={items} onCancel={handleAddCancel} onAdded={handleAdded} />}

      {toggle.confirming && (
        <ConfirmDeleteModal
          entityLabel={toggle.confirming.number}
          itemName={toggle.confirming.number}
          title={t.deactivateDialog.title(toggle.confirming.number)}
          body={<p>{t.deactivateDialog.body}</p>}
          tone="positive"
          confirmLabel={t.deactivateDialog.confirm}
          confirmingLabel={t.deactivateDialog.busy}
          isDeleting={toggle.confirmBusy}
          errorMessage={toggle.confirmError}
          onConfirm={() => void toggle.confirmDeactivate()}
          onCancel={toggle.cancelConfirm}
          testIdPrefix="deactivate-ledger-account"
        />
      )}
    </>
  )
}

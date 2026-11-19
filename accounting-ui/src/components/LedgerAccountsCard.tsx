/**
 * LedgerAccountsCard — one entity's ledger accounts (moved from refund-ui, where it listed WellD CH's only;
 * specs/20261119-accounting, design AS3, FA3, FA5, FA6, UX-3 to UX-8, UX-15; AC-1.1 to AC-1.4, AC-1.9, AC-1.11, AC-1.12,
 * AC-8.3, AC-8.4).
 *
 * A table of accounts (number first, as the row header) with a status badge. There is no who-added and no "Added" column
 * (the wire has none, D18) and no edit control anywhere: a number and a name never change, a deactivation is reversible
 * (AC-1.12). Write controls come from `canManage`, which is `/v1/me`'s for the DISPLAYED entity (UX-4): **Add account** in the
 * card action and, per row, **Deactivate** (after a confirm that names no consumer, UX-7) or **Reactivate** (at once). A
 * reader gets the table and one quiet sentence. The entity is named in the card title, the table caption and the dialog
 * title (UX-3). The page keys the card by entity, so a row of one entity is never shown under another's title.
 *
 * Exactly one state at a time (AS3): loading, denied (403 replaces the view), failed (the ladder, UX-15), empty
 * ("Nothing entered yet for {entity}", a state and never an error, AC-8.3 — WellD CH too), loaded. A 404 from the list means
 * the grant narrowed during the session: the frame is told (`onEntityGone`). A write answered 403 tells it too
 * (`onWriteRefused`), so the controls that should not be there disappear.
 *
 * Dialogs are mounted BESIDE the card, never inside a `<form>` (ADR 20261118 dialog-beside-form). After Deactivate /
 * Reactivate, focus moves to the row's header (the pressed button is gone); after Add it returns to the Add button.
 */

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, ConfirmDialog, DataTable, StatePanel, StatusBadge } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { useCatalogToggle } from '../hooks/useCatalogToggle'
import { useLoadedResource } from '../hooks/useLoadedResource'
import { deactivateLedgerAccount, listLedgerAccounts, reactivateLedgerAccount } from '../lib/catalogApi'
import type { LedgerAccount } from '../lib/catalogApi'
import { statusOf } from '../lib/errors'
import type { EntityId } from '../lib/meApi'
import { CATALOG_STATUS_MEANING } from '../lib/statusMeaning'
import { strings } from '../strings'
import AddLedgerAccountDialog from './AddLedgerAccountDialog'
import { LoadFailure, Loading } from './LoadState'
import PermissionDenied from './PermissionDenied'
import { Saved } from './Saved'

const t = strings.accounts

export type LedgerAccountsCardProps = {
  entity: EntityId
  /** `/v1/me`'s `canManage` for this entity: Add, Deactivate and Reactivate are offered. */
  canManage: boolean
  /** The list answered 404: this entity is not covered any more (UX-12). */
  onEntityGone: () => void
  /** A write answered 403: re-read `/v1/me` (UX-15, AC-3.4). */
  onWriteRefused: () => void
}

export default function LedgerAccountsCard({ entity, canManage, onEntityGone, onWriteRefused }: LedgerAccountsCardProps) {
  const resource = useLoadedResource(() => listLedgerAccounts(entity))
  const [adding, setAdding] = useState(false)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const entityName = strings.entity[entity]

  const items = resource.status === 'loaded' ? resource.data : []

  const toggle = useCatalogToggle<LedgerAccount>({
    keyOf: (account) => account.number,
    deactivate: (number) => deactivateLedgerAccount(entity, number),
    reactivate: (number) => reactivateLedgerAccount(entity, number),
    onChanged: (updated) =>
      resource.replace((current) => current.map((account) => (account.number === updated.number ? updated : account))),
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

  const handleAdded = (account: LedgerAccount) => {
    // Show the row at once, then take the server's order.
    resource.replace((current) => [...current.filter((item) => item.number !== account.number), account])
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
          {account.active ? strings.status.active : strings.status.inactive}
        </StatusBadge>
      ),
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
                  disabled={toggle.pendingKey !== null}
                  onClick={() => toggle.openConfirm(account)}
                  data-testid={`accounting-ledger-deactivate-${account.number}`}
                >
                  {t.deactivate}
                </Button>
              ) : (
                <Button
                  size="sm"
                  aria-label={t.reactivateLabel(account.number)}
                  disabled={toggle.pendingKey !== null}
                  busy={toggle.pendingKey === account.number}
                  onClick={() => void toggle.reactivate(account)}
                  data-testid={`accounting-ledger-reactivate-${account.number}`}
                >
                  {t.reactivate}
                </Button>
              ),
          } satisfies DataTableColumn<LedgerAccount>,
        ]
      : []),
  ]

  // Denied replaces the view: here the card IS the page, so leaving it out would say nothing (AS3).
  if (resource.status === 'forbidden') return <PermissionDenied />

  return (
    <>
      <Card
        title={t.title(entityName)}
        data-testid="accounting-ledger-card"
        action={
          canManage && resource.status === 'loaded' ? (
            <Button
              ref={addButtonRef}
              size="sm"
              aria-haspopup="dialog"
              onClick={() => setAdding(true)}
              data-testid="accounting-ledger-add"
            >
              {t.add}
            </Button>
          ) : undefined
        }
      >
        <p className="text-sm text-soft mb-4">{t.description(entityName)}</p>
        {!canManage && resource.status === 'loaded' && (
          <p className="text-sm text-soft mb-4" data-testid="accounting-ledger-read-only">
            {strings.common.readOnly(strings.common.readOnlyWhat.accounts)}
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
                data-testid="accounting-ledger-action-error"
              >
                {toggle.actionError}
              </Banner>
            )}
            {items.length === 0 ? (
              // No CTA here: the card's Add account action already covers it. A state, never an error (AC-8.3).
              <StatePanel title={t.empty.title(entityName)} headingLevel={4} testId="accounting-empty">
                {canManage ? t.empty.bodyManage : t.empty.bodyRead}
              </StatePanel>
            ) : (
              <DataTable
                caption={t.caption(entityName)}
                columns={columns}
                rows={items}
                getRowKey={(account) => account.number}
                focusRowKey={toggle.focusRowKey}
                testId="accounting-ledger-table"
                rowTestIdPrefix="accounting-ledger-row"
              />
            )}
          </div>
        )}
      </Card>

      {adding && (
        <AddLedgerAccountDialog
          entity={entity}
          accounts={items}
          onCancel={handleAddCancel}
          onAdded={handleAdded}
          onStale={resource.reload}
          onForbidden={onWriteRefused}
          onGone={onEntityGone}
        />
      )}

      {toggle.confirming && (
        <ConfirmDialog
          title={t.deactivateDialog.title(toggle.confirming.number)}
          tone="primary"
          confirmLabel={t.deactivateDialog.confirm}
          busyLabel={t.deactivateDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={toggle.confirmBusy}
          error={toggle.confirmError}
          onConfirm={() => void toggle.confirmDeactivate()}
          onCancel={toggle.cancelConfirm}
          testIdPrefix="accounting-ledger-deactivate-dialog"
        >
          <p>{t.deactivateDialog.body}</p>
        </ConfirmDialog>
      )}
    </>
  )
}

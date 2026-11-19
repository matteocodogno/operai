/**
 * ExpenseTypeDefaultsCard — the default account of each expense type
 * (specs/20261118-refund-accounting-export, design S4, F4, UX-2; AC-2.1, AC-2.2, AC-2.8).
 *
 * One row per type the API returns (fourteen, in enum order, AC-2.2), each with its default account or "None" (real
 * text, never an empty cell), who changed it last and when, **Change** and **History**.
 *
 * Accounting sign-off (T69, specs/20261119-accounting; specs/20261118 SO-16, 2026-11-19): a default is an account and
 * nothing else. There is no VAT column and no foreign-currency VAT designation block: a VAT code is never pre-set
 * (AC-3.13), so there is nothing to default or designate.
 *
 * specs/20261119-accounting (T35, RS2, UX-18, UX-19, UX-23; AC-4.4, AC-4.5, AC-4.7, AC-6.9, AC-6.10): the entries are
 * Accounting's, shown by number from Refund's recorded copies, with Accounting's current state on top:
 *   - `deactivated` and `not_found` each carry a badge (`voided`, `attention`) and count as no default; one static
 *     note above the table says how many defaults need a new choice.
 *   - Accounting cannot be read (`accounting: "unavailable"`): ONE warning banner with Retry, the entries as recorded
 *     with no badge (`unverified`: unchecked is not wrong), **Change** `aria-disabled` and described by its reason,
 *     **History** still working (it reads Refund's own rows). Retry that recovers puts focus on the card heading and
 *     announces it; one that does not says so, and the banner stays.
 *
 * Change opens a dialog per type, never inline selects: every save is a permanent history row (UX-2). The dialog and
 * the history drawer are mounted BESIDE the card (ADR 20261118 dialog-beside-form); focus returns to the button that
 * opened them. Read-only without `settings:manage`.
 */

import { useEffect, useId, useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  DataTable,
  SkeletonRows,
  StatusBadge,
  VisuallyHidden,
  formatDate,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { strings } from '../../strings'
import { entryIsUnusable, getExpenseTypeDefaults } from '../../lib/accountingApi'
import type {
  EntryState,
  ExpenseTypeDefault,
  ExpenseTypeDefaults,
  ExpenseTypeDefaultHistoryEntry,
} from '../../lib/accountingApi'
import { accountText } from '../../lib/catalogLabels'
import { expenseTypeLabel } from '../../lib/expenseTypes'
import { ENTRY_STATE_MEANING } from '../../lib/statusMeaning'
import { useLoadedResource } from '../../lib/useLoadedResource'
import ChangeHistoryDrawer from '../ChangeHistoryDrawer'
import ErrorBanner from '../ErrorBanner'
import SuccessBanner from '../SuccessBanner'
import DefaultClassificationDialog from './DefaultClassificationDialog'

const t = strings.settings.defaults
const tc = strings.settings.catalog
const th = strings.settings.history
const retryLabel = strings.components.errorBanner.defaultRetryLabel

export type ExpenseTypeDefaultsCardProps = {
  /** `settings:manage`: Change is offered. History is shown to everyone who can read. */
  canManage: boolean
}

type Open = ExpenseTypeDefault['type']

/**
 * An entry shown by what it is, with Accounting's state beside it when that is worth a mark (UX-18): a badge for
 * `deactivated` and for `not_found`, none for `active` and none for `unverified`; "None" when absent. With
 * `checked` false (Accounting cannot be read) no state is claimed at all.
 */
function Reference({ text, state, checked }: { text: string | null; state: EntryState; checked: boolean }) {
  if (text === null) return <span className="text-soft">{tc.none}</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{text}</span>
      {checked && state === 'deactivated' && (
        <StatusBadge status={ENTRY_STATE_MEANING.deactivated}>{t.state.deactivated}</StatusBadge>
      )}
      {checked && state === 'not_found' && (
        <StatusBadge status={ENTRY_STATE_MEANING.not_found}>{t.state.notFound}</StatusBadge>
      )}
    </span>
  )
}

export default function ExpenseTypeDefaultsCard({ canManage }: ExpenseTypeDefaultsCardProps) {
  const resource = useLoadedResource(getExpenseTypeDefaults)
  const [editing, setEditing] = useState<Open | null>(null)
  const [history, setHistory] = useState<Open | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  // A Retry of the unavailable banner: the data it started from, so "settled" is the next answer (UX-23).
  const [retryFrom, setRetryFrom] = useState<{ data: ExpenseTypeDefaults | null } | null>(null)
  const headingRef = useRef<HTMLSpanElement>(null)
  const changeBlockedId = useId()
  // The button that opened the dialog or the drawer: focus goes back to it (as SettingsPage does for its modal).
  const lastOpenerRef = useRef<HTMLButtonElement | null>(null)

  const openEditing = (target: Open, button: HTMLButtonElement) => {
    lastOpenerRef.current = button
    setEditing(target)
  }
  const openHistory = (target: Open, button: HTMLButtonElement) => {
    lastOpenerRef.current = button
    setHistory(target)
  }

  const data = resource.status === 'loaded' ? resource.data : null
  // Accounting cannot be read: everything is as recorded, and nothing can be changed (AC-6.9).
  const unavailable = data !== null && data.accounting === 'unavailable'
  const rowOf = (type: Open) => data?.types.find((row) => row.type === type) ?? null

  const closeEditing = () => {
    setEditing(null)
    lastOpenerRef.current?.focus()
  }

  const handleTypeSaved = (saved: ExpenseTypeDefault) => {
    resource.replace((current) => ({
      ...current,
      types: current.types.map((row) => (row.type === saved.type ? saved : row)),
    }))
    setSuccess(t.saved(expenseTypeLabel(saved.type)))
    closeEditing()
  }

  const closeHistory = () => {
    setHistory(null)
    lastOpenerRef.current?.focus()
  }

  // The result of a Retry, once the next answer is in: said politely, and on recovery focus goes to the heading,
  // because the banner and the button that had it are gone (A-3 of 20261118, UX-23).
  const retrySettled =
    retryFrom !== null &&
    ((resource.status === 'loaded' && resource.data !== retryFrom.data) || resource.status === 'error')
  const recovered = retrySettled && resource.status === 'loaded' && resource.data.accounting === 'available'
  const retryAnnouncement = !retrySettled ? '' : recovered ? t.recovered : t.stillUnavailable
  useEffect(() => {
    if (recovered) headingRef.current?.focus()
  }, [recovered])
  const handleRetry = () => {
    setRetryFrom({ data })
    resource.reload()
  }

  // A 403 that arrives anyway: the card is left out (UX-9). After every hook, so their order never changes.
  if (resource.status === 'forbidden') return null

  // Defaults whose account is deactivated or gone count as none (AC-4.5).
  const needsChoice =
    data === null || unavailable
      ? 0
      : data.types.filter((row) => row.account !== null && entryIsUnusable(row.account.state)).length

  const columns: DataTableColumn<ExpenseTypeDefault>[] = [
    {
      id: 'type',
      header: t.columns.type,
      rowHeader: true,
      render: (row) => expenseTypeLabel(row.type),
    },
    {
      id: 'account',
      header: t.columns.account,
      render: (row) => (
        <Reference
          text={row.account ? accountText(row.account) : null}
          state={row.account?.state ?? 'active'}
          checked={!unavailable}
        />
      ),
    },
    {
      id: 'changed',
      header: t.columns.changed,
      render: (row) =>
        row.updatedAt ? (
          t.changedBy(row.updatedByEmail ?? '', formatDate(row.updatedAt))
        ) : (
          <span className="text-soft">{t.notSet}</span>
        ),
    },
    {
      id: 'actions',
      header: t.columns.actions,
      render: (row) => (
        <span className="inline-flex flex-wrap gap-2">
          {canManage && (
            <Button
              size="sm"
              aria-haspopup="dialog"
              aria-label={t.changeLabel(expenseTypeLabel(row.type))}
              aria-disabled={unavailable || undefined}
              aria-describedby={unavailable ? changeBlockedId : undefined}
              onClick={(event) => {
                if (!unavailable) openEditing(row.type, event.currentTarget)
              }}
              data-testid={`settings-default-change-${row.type}`}
            >
              {t.change}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-haspopup="dialog"
            aria-label={t.historyLabel(expenseTypeLabel(row.type))}
            onClick={(event) => openHistory(row.type, event.currentTarget)}
            data-testid={`settings-default-history-${row.type}`}
          >
            {th.open}
          </Button>
        </span>
      ),
    },
  ]

  const editingRow = editing === null ? null : rowOf(editing)
  const historyRow = history === null ? null : rowOf(history)

  return (
    <>
      <Card
        title={
          <span ref={headingRef} tabIndex={-1} className="outline-none focus-visible:outline-2">
            {t.title}
          </span>
        }
        data-testid="settings-defaults-card"
      >
        <p className="text-sm text-soft mb-4">{t.descriptionAccountOnly}</p>
        <VisuallyHidden live data-testid="settings-defaults-retry-result">
          {retryAnnouncement}
        </VisuallyHidden>
        {unavailable && (
          <VisuallyHidden>
            <span id={changeBlockedId}>{t.changeBlocked}</span>
          </VisuallyHidden>
        )}

        {resource.status === 'loading' && (
          <>
            <VisuallyHidden live>{t.loading}</VisuallyHidden>
            <SkeletonRows rows={4} testId="skeleton-list-rows" />
          </>
        )}

        {resource.status === 'error' && <ErrorBanner message={t.loadError} onRetry={resource.reload} />}

        {data && (
          <div className="flex flex-col gap-4">
            <SuccessBanner message={success} onDismiss={() => setSuccess(null)} testId="settings-defaults-success" />

            {unavailable && (
              <Banner
                tone="warning"
                live="polite"
                title={t.unavailable.title}
                onRetry={handleRetry}
                retryLabel={retryLabel}
                retryTestId="settings-defaults-retry"
                data-testid="settings-defaults-unavailable"
              >
                {t.unavailable.body}
              </Banner>
            )}

            {needsChoice > 0 && (
              <Banner
                tone="warning"
                live="off"
                aria-label={t.needsChoiceLabel}
                data-testid="settings-defaults-needs-choice"
              >
                {t.needsChoice(needsChoice)}
              </Banner>
            )}

            <DataTable
              caption={t.caption}
              columns={columns}
              rows={data.types}
              getRowKey={(row) => row.type}
              testId="settings-defaults-table"
              rowTestIdPrefix="settings-default-row"
            />
          </div>
        )}
      </Card>

      {editingRow && (
        <DefaultClassificationDialog
          row={editingRow}
          typeLabel={expenseTypeLabel(editingRow.type)}
          onCancel={closeEditing}
          onSaved={handleTypeSaved}
        />
      )}

      {historyRow && (
        <ChangeHistoryDrawer<ExpenseTypeDefaultHistoryEntry>
          subject={expenseTypeLabel(historyRow.type)}
          rows={historyRow.history}
          valueColumns={[
            {
              id: 'account',
              header: th.columns.account,
              render: (entry) => (entry.account ? accountText(entry.account) : tc.none),
            },
          ]}
          onClose={closeHistory}
        />
      )}
    </>
  )
}

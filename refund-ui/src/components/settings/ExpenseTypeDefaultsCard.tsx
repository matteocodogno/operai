/**
 * ExpenseTypeDefaultsCard — the default account and VAT code of each of the twelve expense types, and the VAT
 * code that WellD CH lines in a foreign currency get (specs/20261118-refund-accounting-export, design S4, F4, UX-2; AC-2.1,
 * AC-2.2, AC-2.5, AC-2.6, AC-2.7, AC-2.8).
 *
 * Top: the foreign-currency VAT code as one labelled fact with **Change** (settings:manage) and **History**
 * (everyone who can read). When that code has been deactivated the card says foreign-currency lines now get
 * no VAT code (AC-2.7). Below: the twelve rows the API always returns, each with its default account and VAT
 * code or "None" (real text, never an empty cell), who changed it last and when, **Change** and **History**.
 * A default pointing at a deactivated entry shows the entry with an *Inactive* badge.
 *
 * Change opens a dialog per type or for the foreign-currency code, never inline selects: every save is a
 * permanent history row (UX-2). The dialogs and the history drawer are mounted BESIDE the card (ADR 20261118
 * dialog-beside-form); focus returns to the button that opened them. Read-only without `settings:manage`.
 */

import { useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  DataTable,
  FactList,
  SkeletonRows,
  StatusBadge,
  VisuallyHidden,
  formatDate,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { strings } from '../../strings'
import { getExpenseTypeDefaults } from '../../lib/accountingApi'
import type {
  ExpenseTypeDefault,
  ExpenseTypeDefaultHistoryEntry,
  ForeignCurrencyVatCodeState,
  ForeignCurrencyVatHistoryEntry,
} from '../../lib/accountingApi'
import { accountText, vatCodeText } from '../../lib/catalogLabels'
import { expenseTypeLabel } from '../../lib/expenseTypes'
import { CATALOG_STATUS_MEANING } from '../../lib/statusMeaning'
import { useLoadedResource } from '../../lib/useLoadedResource'
import ChangeHistoryDrawer from '../ChangeHistoryDrawer'
import ErrorBanner from '../ErrorBanner'
import SuccessBanner from '../SuccessBanner'
import DefaultClassificationDialog from './DefaultClassificationDialog'
import ForeignCurrencyVatDialog from './ForeignCurrencyVatDialog'

const t = strings.settings.defaults
const tc = strings.settings.catalog
const th = strings.settings.history

const FOREIGN = 'foreign-currency'

export type ExpenseTypeDefaultsCardProps = {
  /** `settings:manage`: Change is offered. History is shown to everyone who can read. */
  canManage: boolean
}

type Open = { kind: 'type'; type: ExpenseTypeDefault['type'] } | { kind: typeof FOREIGN }

/** An entry shown by what it is, with an *Inactive* badge when it has been deactivated; "None" when absent. */
function Reference({ text, active, none = tc.none }: { text: string | null; active: boolean; none?: string }) {
  if (text === null) return <span className="text-soft">{none}</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{text}</span>
      {!active && <StatusBadge status={CATALOG_STATUS_MEANING.inactive}>{tc.inactiveTag}</StatusBadge>}
    </span>
  )
}

export default function ExpenseTypeDefaultsCard({ canManage }: ExpenseTypeDefaultsCardProps) {
  const resource = useLoadedResource(getExpenseTypeDefaults)
  const [editing, setEditing] = useState<Open | null>(null)
  const [history, setHistory] = useState<Open | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
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

  // A 403 that arrives anyway: the card is left out (UX-9).
  if (resource.status === 'forbidden') return null

  const data = resource.status === 'loaded' ? resource.data : null
  const rowOf = (type: ExpenseTypeDefault['type']) => data?.types.find((row) => row.type === type) ?? null

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

  const handleForeignSaved = (saved: ForeignCurrencyVatCodeState) => {
    resource.replace((current) => ({ ...current, ...saved }))
    setSuccess(t.foreign.saved)
    closeEditing()
  }

  const closeHistory = () => {
    setHistory(null)
    lastOpenerRef.current?.focus()
  }

  const foreign = data?.foreignCurrencyVatCode ?? null

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
        <Reference text={row.account ? accountText(row.account) : null} active={row.account?.active ?? true} />
      ),
    },
    {
      id: 'vatCode',
      header: t.columns.vatCode,
      render: (row) => (
        <Reference text={row.vatCode ? vatCodeText(row.vatCode) : null} active={row.vatCode?.active ?? true} />
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
              onClick={(event) => openEditing({ kind: 'type', type: row.type }, event.currentTarget)}
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
            onClick={(event) => openHistory({ kind: 'type', type: row.type }, event.currentTarget)}
            data-testid={`settings-default-history-${row.type}`}
          >
            {th.open}
          </Button>
        </span>
      ),
    },
  ]

  const editingRow = editing?.kind === 'type' ? rowOf(editing.type) : null
  const historyRow = history?.kind === 'type' ? rowOf(history.type) : null

  return (
    <>
      <Card title={t.title} data-testid="settings-defaults-card">
        <p className="text-sm text-soft mb-4">{t.description}</p>

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

            <div className="flex flex-col gap-2" data-testid="settings-foreign-vat">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <FactList
                  items={[
                    {
                      id: 'foreign',
                      term: t.foreign.term,
                      value: (
                        <span data-testid="settings-foreign-vat-value">
                          <Reference
                            text={foreign ? vatCodeText(foreign) : null}
                            active={foreign?.active ?? true}
                            none={t.foreign.none}
                          />
                        </span>
                      ),
                    },
                  ]}
                />
                <span className="inline-flex flex-wrap gap-2">
                  {canManage && (
                    <Button
                      size="sm"
                      aria-haspopup="dialog"
                      aria-label={t.foreign.changeLabel}
                      onClick={(event) => openEditing({ kind: FOREIGN }, event.currentTarget)}
                      data-testid="settings-foreign-vat-change"
                    >
                      {t.change}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-haspopup="dialog"
                    aria-label={th.openLabel(t.foreign.historyLabel)}
                    onClick={(event) => openHistory({ kind: FOREIGN }, event.currentTarget)}
                    data-testid="settings-foreign-vat-history"
                  >
                    {th.open}
                  </Button>
                </span>
              </div>
              <p className="text-sm text-soft">{t.foreign.description}</p>
              {foreign && !data.foreignCurrencyVatCodeUsable && (
                <Banner tone="warning" live="off" data-testid="settings-foreign-vat-inactive-warning">
                  {t.foreign.inactiveWarning(foreign.code)}
                </Banner>
              )}
            </div>

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

      {editing?.kind === 'type' && editingRow && (
        <DefaultClassificationDialog
          row={editingRow}
          typeLabel={expenseTypeLabel(editingRow.type)}
          onCancel={closeEditing}
          onSaved={handleTypeSaved}
        />
      )}

      {editing?.kind === FOREIGN && data && (
        <ForeignCurrencyVatDialog state={data} onCancel={closeEditing} onSaved={handleForeignSaved} />
      )}

      {history?.kind === 'type' && historyRow && (
        <ChangeHistoryDrawer<ExpenseTypeDefaultHistoryEntry>
          subject={expenseTypeLabel(historyRow.type)}
          rows={historyRow.history}
          valueColumns={[
            {
              id: 'account',
              header: th.columns.account,
              render: (entry) => (entry.account ? accountText(entry.account) : tc.none),
            },
            {
              id: 'vatCode',
              header: th.columns.vatCode,
              render: (entry) => (entry.vatCode ? vatCodeText(entry.vatCode) : tc.none),
            },
          ]}
          onClose={closeHistory}
        />
      )}

      {history?.kind === FOREIGN && data && (
        <ChangeHistoryDrawer<ForeignCurrencyVatHistoryEntry>
          subject={t.foreign.historyLabel}
          rows={data.foreignCurrencyVatCodeHistory}
          valueColumns={[
            {
              id: 'vatCode',
              header: th.columns.vatCode,
              render: (entry) => (entry.vatCode ? entry.vatCode.code : tc.none),
            },
          ]}
          onClose={closeHistory}
        />
      )}
    </>
  )
}

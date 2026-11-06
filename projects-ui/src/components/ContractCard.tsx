import { useCallback, useId, useState } from 'react'
import { Button, DataTable, DateInput, Field, FactList, FormDialog, formatDate, formatNumber } from '@operai/ui'
import type { DataTableColumn, Fact } from '@operai/ui'
import { useResource } from '../hooks/useResource'
import { isStaleWrite } from '../lib/api'
import { errorMessage, fieldErrorOf } from '../lib/errors'
import { getContract, updateContract } from '../lib/projectsApi'
import type { Contract, ContractSummary, HourPackage, Position, Project, Sla } from '../lib/types'
import { strings } from '../strings'
import BexioOrderField from './BexioOrderField'
import ContractFormDialog from './ContractFormDialog'
import { LoadFailure, Loading } from './LoadState'

const manDays = (value: number) => strings.contracts.card.manDays(formatNumber(value, { maximumFractionDigits: 1 }))

/** Today as `YYYY-MM-DD` in the person's own calendar (never shifted through UTC). */
const today = (): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function slaText(sla: Sla): string {
  return strings.contracts.card.slaValue(sla.highDays, sla.normalDays)
}

function hourPackageText(pkg: HourPackage): string {
  const t = strings.contracts.card
  const parts = [t.hours(pkg.hours), t.kinds[pkg.kind], `${t.packageStart} ${formatDate(pkg.startDate)}`]
  if (pkg.expiryDate) parts.push(`${t.packageExpiry} ${formatDate(pkg.expiryDate)}`)
  return parts.join(' · ')
}

/** The terms of the contract's type, read-only (AC-2.3 – AC-2.8). No amount, price or rate exists (AC-2.9). */
function Terms({ contract }: { contract: Contract }) {
  const t = strings.contracts.card
  const terms = contract.terms
  if ('deadline' in terms) {
    const items: Fact[] = [
      { id: 'deadline', term: t.deadline, value: formatDate(terms.deadline) },
      {
        id: 'estimated',
        term: t.estimatedManDays,
        value: terms.estimatedManDays === null ? strings.common.none : manDays(terms.estimatedManDays),
      },
      { id: 'max', term: t.maxEffortManDays, value: manDays(terms.maxEffortManDays) },
    ]
    return <FactList items={items} />
  }
  if ('positions' in terms) {
    const columns: DataTableColumn<Position>[] = [
      { id: 'profile', header: t.profile, rowHeader: true, render: (position) => position.profile },
      {
        id: 'days',
        header: t.plannedManDays,
        numeric: true,
        render: (position) => formatNumber(position.plannedManDays, { maximumFractionDigits: 1 }),
      },
    ]
    return (
      <DataTable
        caption={t.termsCaption}
        columns={columns}
        rows={terms.positions}
        getRowKey={(position) => position.profile}
      />
    )
  }
  if ('sla' in terms) {
    const items: Fact[] = [
      { id: 'sla', term: t.sla, value: terms.sla ? slaText(terms.sla) : t.noTerms },
      { id: 'hours', term: t.hourPackage, value: terms.hourPackage ? hourPackageText(terms.hourPackage) : t.noTerms },
    ]
    return <FactList items={items} />
  }
  return null
}

/**
 * EndContractDialog — ending a contract is setting its end date (AC-2.10); the
 * contract stays on the project and is never deleted. Sends only `endDate` with
 * the contract's `version` as If-Match; a stale save closes the dialog and is the
 * page's (`onStale`).
 */
function EndContractDialog({
  projectId,
  contract,
  onEnded,
  onCancel,
  onStale,
}: {
  projectId: string
  contract: Contract
  onEnded: (next: Contract) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.contracts.endDialog
  const [endDate, setEndDate] = useState(() => {
    const now = today()
    return now < contract.startDate ? contract.startDate : now
  })
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const found =
      endDate === ''
        ? strings.common.validation.required
        : endDate < contract.startDate
          ? strings.contracts.errors.endBeforeStart
          : null
    setFieldError(found)
    if (found) return
    setBusy(true)
    setError(null)
    updateContract(projectId, contract.id, contract.version, { endDate }).then(onEnded, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const named = fieldErrorOf(failure)
      if (named?.field === 'endDate') return setFieldError(named.message)
      setError(errorMessage(failure))
    })
  }

  return (
    <FormDialog
      title={t.title}
      description={t.description}
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="contract-end"
    >
      <Field label={t.date} required error={fieldError} testId="contract-end-date">
        {(control) => <DateInput {...control} value={endDate} onChange={(event) => setEndDate(event.target.value)} />}
      </Field>
    </FormDialog>
  )
}

/**
 * ContractCard — one contract of a project (AC-2.1): its client, origin, dates,
 * Bexio order id and the terms of its type. The terms and the version come from
 * `GET /projects/:id/contracts/:contractId`. A holder of manage projects edits it
 * or ends it by setting its end date (AC-2.10); there is no delete. Only a holder
 * of the Bexio-order capability edits the order id (AC-3.1), which bumps the
 * contract's version — the card keeps the one each write returns. A stale write
 * is the page's to handle (`onStale`).
 */
export default function ContractCard({
  project,
  summary,
  canManage,
  onChanged,
  onStale,
}: {
  project: Pick<Project, 'id' | 'type' | 'company'>
  summary: ContractSummary
  canManage: boolean
  /** A write succeeded: the page refreshes what it derives from contracts and confirms. */
  onChanged: (message: string) => void
  onStale: () => void
}) {
  const t = strings.contracts
  const titleId = useId()
  const load = useCallback(
    (signal: AbortSignal) => getContract(project.id, summary.id, { signal }),
    [project.id, summary.id],
  )
  const resource = useResource(load)
  const [dialog, setDialog] = useState<'edit' | 'end' | null>(null)

  const contract = resource.data
  const shown: ContractSummary = contract ?? summary
  const stale = () => {
    setDialog(null)
    onStale()
  }
  const written = (next: Contract, message: string) => {
    setDialog(null)
    resource.replace(next)
    onChanged(message)
  }

  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-3 py-3" data-testid={`contract-${summary.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={titleId} className="text-sm font-semibold text-text">
          {shown.company.name ?? t.card.companyUnavailable}
        </h4>
        {canManage && contract && (
          <div className="flex gap-2">
            <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('edit')}>
              {t.edit}
            </Button>
            {contract.endDate === null && (
              <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('end')}>
                {t.endContract}
              </Button>
            )}
          </div>
        )}
      </div>
      <FactList
        items={[
          { id: 'start', term: t.card.start, value: formatDate(shown.startDate) },
          { id: 'end', term: t.card.end, value: shown.endDate ? formatDate(shown.endDate) : t.card.openEnded },
          { id: 'origin', term: t.card.origin, value: t.card.origins[shown.origin] },
        ]}
      />
      {resource.status === 'loading' && <Loading label={t.loading} rows={2} />}
      {resource.status === 'error' && <LoadFailure error={resource.error} onRetry={resource.retry} />}
      {contract && (
        <div className="flex flex-col gap-3" data-testid="contract-terms">
          <Terms contract={contract} />
          <BexioOrderField
            projectId={project.id}
            contract={contract}
            onSaved={(next) => written(next, t.saved.bexio)}
            onStale={stale}
          />
        </div>
      )}
      {dialog === 'edit' && contract && (
        <ContractFormDialog
          project={project}
          contract={contract}
          onSaved={(next) => written(next, t.saved.updated)}
          onCancel={() => setDialog(null)}
          onStale={stale}
        />
      )}
      {dialog === 'end' && contract && (
        <EndContractDialog
          projectId={project.id}
          contract={contract}
          onEnded={(next) => written(next, t.saved.ended)}
          onCancel={() => setDialog(null)}
          onStale={stale}
        />
      )}
    </article>
  )
}

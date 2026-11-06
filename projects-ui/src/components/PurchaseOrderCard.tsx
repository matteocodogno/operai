import { useCallback, useState } from 'react'
import { Banner, Button, Card, FactList, FormDialog } from '@operai/ui'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { isStaleWrite } from '../lib/api'
import { errorMessage, purchaseOrderRefusalOf } from '../lib/errors'
import { crmDealHref, estimaiEstimateHref, mailtoHref, telHref } from '../lib/links'
import { personName } from '../lib/people'
import { listPurchaseOrderContacts, updatePurchaseOrder } from '../lib/projectsApi'
import type { Project, Referent } from '../lib/types'
import { strings } from '../strings'
import BexioOrderField from './BexioOrderField'
import ReferentPicker from './ReferentPicker'
import TermsBlock from './TermsBlock'

/** A contact's email or phone as a link whose scheme this page fixes (T18 M5, L9); text only when it has no usable value. */
function ContactLink({ value, href }: { value: string | null; href: (value: string) => string | null }) {
  if (value === null) return null
  const target = href(value)
  return target === null ? (
    <>{value}</>
  ) : (
    <a href={target} className="link">
      {value}
    </a>
  )
}

/**
 * The referent as the CRM read it just now (AC-3.8): name, job title, email and phone, text only — a detail
 * the contact lacks is left blank. `unavailable` says so and shows nothing of the contact (AC-3.10); `null`
 * (none set, or the CRM no longer has the contact, AC-3.9) shows no referent.
 */
function ReferentDetails({ referent }: { referent: Referent | null }) {
  const t = strings.purchaseOrder.referent
  if (referent === null) return <p className="text-sm text-soft">{t.none}</p>
  if (referent.status === 'unavailable') {
    return (
      <p className="text-sm text-soft" role="status">
        {t.unavailable}
      </p>
    )
  }
  return (
    <FactList
      items={[
        { id: 'name', term: t.name, value: referent.name },
        { id: 'jobTitle', term: t.jobTitle, value: referent.jobTitle },
        { id: 'email', term: t.email, value: <ContactLink value={referent.email} href={mailtoHref} /> },
        { id: 'phone', term: t.phone, value: <ContactLink value={referent.phone} href={telHref} /> },
      ]}
    />
  )
}

/**
 * ReferentDialog — set, change or clear the referent (AC-3.7): `ReferentPicker` over the project's own
 * contacts (`GET /projects/{id}/purchase-order/contacts`, the company derived by the server, T18 M1),
 * read every time the dialog opens and held in this component's state only (T18 M5). "No referent" clears.
 * Saving sends the purchase order's `version` as If-Match; a stale save closes the dialog and is the page's
 * reload prompt (`onStale`). A refused contact (422 `referent_invalid`) is one fixed message on the field —
 * whatever the reason — and every other refusal has its own words.
 */
function ReferentDialog({
  project,
  onSaved,
  onCancel,
  onStale,
}: {
  project: Project
  onSaved: () => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.purchaseOrder.referent.dialog
  const po = project.purchaseOrder!
  const currentId = po.referent?.id ?? null
  const load = useCallback((signal: AbortSignal) => listPurchaseOrderContacts(project.id, { signal }), [project.id])
  const [value, setValue] = useState<string | null>(currentId)
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    setBusy(true)
    setFieldError(null)
    setError(null)
    updatePurchaseOrder(project.id, po.version, { referentContactId: value }).then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const refusal = purchaseOrderRefusalOf(failure)
      if (refusal === 'referent_invalid') return setFieldError(t.errors.referent_invalid)
      setError(refusal ? t.errors[refusal] : errorMessage(failure))
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
      canSubmit={value !== currentId}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="purchase-order-referent-dialog"
    >
      <ReferentPicker
        load={load}
        value={value}
        onChange={(next) => {
          setValue(next)
          setFieldError(null)
        }}
        error={fieldError}
        hint={t.hint}
        failureText={(failure) => {
          const refusal = purchaseOrderRefusalOf(failure)
          return `${t.loadFailed} ${refusal ? t.errors[refusal] : errorMessage(failure)}`
        }}
        testId="purchase-order-referent-picker"
      />
    </FormDialog>
  )
}

/**
 * PurchaseOrderCard — the purchase order of a project made from a won deal (specs/022; ledger D38). It
 * shows the deal (a link to the CRM), the estimate the offer rested on (a link into EstimAI; a person
 * without access to it sees EstimAI's own unavailable state, AC-3.2), the ops-manager it was assigned to,
 * the referent, the Bexio order id, and — when the deal was reopened in the CRM — the notice "the deal is no
 * longer won": read live on every load, gone once the deal is won again, and the purchase order is never
 * changed by it (AC-2.3, AC-2.4, AC-3.3). Its terms are those of the project (`project.terms`) and change the
 * way a hand-made project's do (`TermsBlock`). Only a holder of the Bexio-order capability edits the order
 * id (specs/021 AC-3.1).
 *
 * There is no control that detaches a purchase order from its deal, moves it to another project or
 * deletes it (AC-1.10, D38, D39). A write tells the page (`onChanged`), which reads the project again; a
 * stale write is the page's (`onStale`).
 */
export default function PurchaseOrderCard({
  project,
  canManage,
  onChanged,
  onStale,
}: {
  project: Project
  canManage: boolean
  onChanged: (message: string) => void
  onStale: () => void
}) {
  const currentUserId = useCurrentUserId()
  const [editingReferent, setEditingReferent] = useState(false)
  const po = project.purchaseOrder
  if (po === null) return null
  const t = strings.purchaseOrder

  return (
    <>
      <Card title={t.title} id="purchase-order" data-testid="project-purchase-order">
        <div className="flex flex-col gap-3">
          {po.deal.won === false && (
            <Banner tone="warning" title={t.card.dealNotWon.title} data-testid="purchase-order-deal-not-won">
              {t.card.dealNotWon.body}
            </Banner>
          )}
          <FactList
            items={[
              {
                id: 'deal',
                term: t.card.deal,
                value: (
                  <a href={crmDealHref(po.deal.id)} className="link">
                    {po.deal.title ?? t.card.dealUnavailable}
                  </a>
                ),
              },
              // A person without access to the estimate in EstimAI sees EstimAI's own unavailable state (AC-3.2).
              ...(po.estimate
                ? [
                    {
                      id: 'estimate',
                      term: t.card.estimate,
                      value: (
                        <a href={estimaiEstimateHref(po.estimate.id)} className="link">
                          {t.card.openEstimate}
                        </a>
                      ),
                    },
                  ]
                : []),
              { id: 'opsManager', term: t.card.opsManager, value: personName(po.opsManager, currentUserId) },
            ]}
          />
          <div className="flex flex-col gap-3" data-testid="purchase-order-referent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-text">{t.referent.title}</h4>
              {canManage && (
                <Button size="sm" aria-haspopup="dialog" onClick={() => setEditingReferent(true)}>
                  {po.referent === null ? t.referent.set : t.referent.change}
                </Button>
              )}
            </div>
            <ReferentDetails referent={po.referent} />
          </div>
          {project.terms && (
            <TermsBlock
              project={project}
              terms={project.terms}
              title={strings.terms.title}
              canManage={canManage}
              onChanged={onChanged}
              onStale={onStale}
            />
          )}
          <BexioOrderField
            projectId={project.id}
            purchaseOrder={po}
            onSaved={() => onChanged(t.saved.bexio)}
            onStale={onStale}
          />
        </div>
      </Card>
      {editingReferent && (
        <ReferentDialog
          project={project}
          onCancel={() => setEditingReferent(false)}
          onSaved={() => {
            setEditingReferent(false)
            onChanged(t.saved.referent)
          }}
          onStale={() => {
            setEditingReferent(false)
            onStale()
          }}
        />
      )}
    </>
  )
}

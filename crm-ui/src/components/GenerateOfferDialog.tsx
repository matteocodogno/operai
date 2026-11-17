import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Banner,
  Button,
  CheckboxGroupField,
  ConfirmDialog,
  Field,
  FormDialog,
  Icon,
  focusFirstInvalid,
  formatMoney,
  formatNumber,
  resolveLocale,
} from '@operai/ui'
import {
  editOffer,
  generateOffer,
  getOfferDraft,
  getOfferForm,
  listAttachments,
  listContacts,
  listOfferTemplates,
} from '../lib/crmApi'
import { isStaleWrite } from '../lib/api'
import type { OfferInput } from '../lib/crmApi'
import { legalEntityIncompleteOf, offerFailure } from '../lib/offerErrors'
import {
  LIMITS,
  checkOfferLines,
  checkSections,
  computeTotals,
  draftLineToState,
  linesValid,
  offerLineToWire,
  sectionsValid,
} from '../lib/offerRules'
import type { OfferLineDraft } from '../lib/offerRules'
import { contactName } from '../lib/people'
import { formatFileSize } from '../lib/attachments'
import type {
  Attachment,
  ContactSummary,
  CostColumns,
  Currency,
  Deal,
  Entity,
  Offer,
  OfferDraft,
  OfferForm,
  OfferSection,
  OfferTemplate,
} from '../lib/types'
import { first, maxLength, optional, required } from '../lib/validate'
import { strings } from '../strings'
import LegalEntityNotice from './offerWizard/LegalEntityNotice'
import { CostColumnSwitches, OfferCostLinesEditor } from './CostLinesEditor'
import MarkupHelp from './MarkupHelp'
import SectionsEditor from './SectionsEditor'

/** What is on screen once a draft is loaded; amounts are the text of the fields. */
type Form = {
  templateId: string
  currency: Currency
  language: OfferDraft['language']
  manDays: number
  salutation: string
  clientLines: string[]
  contactIds: string[]
  opening: string
  sections: OfferSection[]
  columns: CostColumns
  showTotal: boolean
  lines: OfferLineDraft[]
  acceptance: string
  annex: boolean
  attachmentIds: string[]
  validity: string
}

type FieldErrors = Partial<Record<'salutation' | 'clientLines' | 'opening' | 'acceptance' | 'validity', string>>

const fromDraft = (draft: OfferDraft): Form => ({
  templateId: draft.templateId,
  currency: draft.currency,
  language: draft.language,
  manDays: draft.manDays,
  salutation: draft.salutation,
  clientLines: draft.clientLines.length > 0 ? [...draft.clientLines] : [''],
  contactIds: [],
  opening: draft.opening,
  sections: draft.sections.map((section) => ({ ...section })),
  columns: { ...draft.costColumns },
  showTotal: draft.showTotal,
  lines: draft.costLines.map(draftLineToState),
  acceptance: draft.acceptanceLabel ?? '',
  annex: draft.annex,
  attachmentIds: [],
  validity: String(draft.validityDays),
})

/** An offer's own content (specs/20261102-crm-offer-document US-7): its contacts and PDFs come back chosen. */
const fromForm = (offerForm: OfferForm): Form => ({
  ...fromDraft(offerForm),
  contactIds: [...offerForm.contactIds],
  attachmentIds: [...offerForm.attachmentIds],
})

/** `edit`: an offer not sent yet, saved in place; `revise`: a sent offer, the start of its next revision. */
export type OfferSource = { offer: Offer; mode: 'edit' | 'revise' }

const isPdf = (attachment: Attachment) => attachment.contentType === 'application/pdf'

/**
 * GenerateOfferDialog — prepares an offer from a template (specs/20261102-crm-offer-document US-3):
 * pick a template, review the draft the server fills in (placeholders, the deal
 * amount and the estimate's figures), edit every text and cost line, choose the
 * contacts and the deal PDFs to append, then post. The totals shown are the
 * server's rules, computed live; the server stays the authority. The page owns
 * what happens next (the list reload, the "move to proposal?" question).
 *
 * Choosing another template — or flipping the AI setting, which changes the
 * man-days — replaces everything on screen, so once a draft is loaded it asks
 * first.
 */
export default function GenerateOfferDialog({
  deal,
  source,
  onGenerated,
  onCancel,
}: {
  deal: Deal
  /** Start from an existing offer instead of a template (specs/20261102-crm-offer-document US-7). */
  source?: OfferSource
  onGenerated: (offer: Offer) => void
  onCancel: () => void
}) {
  const t = strings.offers.dialog
  // Overridden without an estimate: no man-days to assist and no scope to append.
  const withEstimate = deal.estimate?.state === 'ready'
  const [templates, setTemplates] = useState<OfferTemplate[] | null>(null)
  const [templatesFailed, setTemplatesFailed] = useState(false)
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  const [pdfs, setPdfs] = useState<Attachment[]>([])
  const [templateId, setTemplateId] = useState('')
  const [aiAssisted, setAiAssisted] = useState(false)
  const [form, setForm] = useState<Form | null>(null)
  // An existing offer's content loads as soon as the dialog opens.
  const [loadingDraft, setLoadingDraft] = useState(source !== undefined)
  const [pending, setPending] = useState<{ templateId: string; aiAssisted: boolean } | null>(null)
  const [validated, setValidated] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 409 `legal_entity_incomplete` (AC-6.3, FU-2): the registry's notice, with the link for a manager, replaces the line
  const [incomplete, setIncomplete] = useState<{ entity: Entity; missing: string[] } | null>(null)
  const [pickError, setPickError] = useState<{ contacts?: string; attachments?: string }>({})
  const fieldsRef = useRef<HTMLDivElement>(null)
  /** Shows a refusal: the registry's notice for an incomplete legal entity, the readable line for anything else. */
  const refuse = useCallback((line: string, failure: unknown) => {
    const found = legalEntityIncompleteOf(failure)
    if (found) {
      // a body that names no entity we know is about the deal's own
      setIncomplete({ entity: found.entity ?? deal.entity, missing: found.missing })
      setError(null)
    } else {
      setIncomplete(null)
      setError(line)
    }
  }, [deal.entity])
  const loadToken = useRef(0)
  const [version, setVersion] = useState<number | null>(null)
  const sourceOfferId = source?.offer.id

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    listOfferTemplates(deal.entity, false, { signal }).then(
      (result) => !signal.aborted && setTemplates(result.items),
      () => !signal.aborted && setTemplatesFailed(true),
    )
    // The contacts and the PDFs are optional extras: no list, no choice.
    listContacts({ companyId: deal.company.id, pageSize: 100 }, { signal }).then(
      (result) => !signal.aborted && setContacts(result.items),
      () => undefined,
    )
    listAttachments(deal.id, { signal }).then(
      (result) => !signal.aborted && setPdfs(result.items.filter(isPdf)),
      () => undefined,
    )
    return () => controller.abort()
  }, [deal.entity, deal.company.id, deal.id])

  // Editing or revising: the offer's own content fills the form, as a template's draft would.
  useEffect(() => {
    if (sourceOfferId === undefined) return
    const controller = new AbortController()
    const token = ++loadToken.current
    getOfferForm(deal.id, sourceOfferId, { signal: controller.signal }).then(
      (offerForm) => {
        if (controller.signal.aborted || token !== loadToken.current) return
        setLoadingDraft(false)
        setTemplateId(offerForm.templateId)
        setAiAssisted(offerForm.aiAssisted)
        setVersion(offerForm.version)
        setForm(fromForm(offerForm))
      },
      (failure: unknown) => {
        if (controller.signal.aborted || token !== loadToken.current) return
        setLoadingDraft(false)
        refuse(offerFailure(failure), failure)
      },
    )
    return () => controller.abort()
  }, [deal.id, sourceOfferId, refuse])

  // Active templates, the person's language first.
  const options = useMemo(() => {
    const preferred = resolveLocale()
    return [...(templates ?? [])]
      .filter((template) => !template.archived)
      .sort(
        (a, b) => Number(b.language === preferred) - Number(a.language === preferred) || a.name.localeCompare(b.name),
      )
  }, [templates])

  const loadDraft = (nextTemplate: string, nextAi: boolean) => {
    const token = ++loadToken.current
    setTemplateId(nextTemplate)
    setAiAssisted(nextAi)
    setPending(null)
    setLoadingDraft(true)
    setError(null)
    setIncomplete(null)
    setValidated(false)
    setErrors({})
    setPickError({})
    getOfferDraft(deal.id, nextTemplate, nextAi).then(
      (draft) => {
        if (token !== loadToken.current) return
        setLoadingDraft(false)
        setForm(fromDraft(draft))
      },
      (failure: unknown) => {
        if (token !== loadToken.current) return
        setLoadingDraft(false)
        refuse(offerFailure(failure), failure)
      },
    )
  }

  // Replacing a draft on screen asks first; the first load does not.
  const request = (nextTemplate: string, nextAi: boolean) => {
    if (nextTemplate === '') return
    if (form === null) loadDraft(nextTemplate, nextAi)
    else setPending({ templateId: nextTemplate, aiAssisted: nextAi })
  }

  const patch = (changes: Partial<Form>) =>
    setForm((current) => (current === null ? current : { ...current, ...changes }))

  const setColumns = (columns: CostColumns) => {
    if (form === null) return
    // Without the unit columns every quantity is 1.
    patch({ columns, ...(columns.unit ? {} : { lines: form.lines.map((line) => ({ ...line, quantity: '1' })) }) })
  }

  const toggle =
    (key: 'contactIds' | 'attachmentIds', limit: number, limitError: string) => (id: string, checked: boolean) => {
      if (form === null) return
      const area = key === 'contactIds' ? 'contacts' : 'attachments'
      if (checked && form[key].length >= limit) return setPickError((current) => ({ ...current, [area]: limitError }))
      setPickError((current) => ({ ...current, [area]: undefined }))
      patch({ [key]: checked ? [...form[key], id] : form[key].filter((item) => item !== id) })
    }

  const sectionsCheck = form ? checkSections(form.sections) : undefined
  const linesCheck = form ? checkOfferLines(form.lines, form.columns) : undefined
  const totals = form ? computeTotals(form.lines) : null

  const submit = () => {
    if (form === null || sectionsCheck === undefined || linesCheck === undefined || totals === null) return
    const clientLines = form.clientLines.map((line) => line.trim()).filter((line) => line !== '')
    const days = Number(form.validity)
    const found: FieldErrors = {
      salutation: first(required(form.salutation), maxLength(form.salutation, LIMITS.salutation)) ?? undefined,
      clientLines:
        clientLines.length < LIMITS.clientLines.min ||
        clientLines.length > LIMITS.clientLines.max ||
        clientLines.some((line) => line.length > LIMITS.clientLine)
          ? t.clientLinesInvalid
          : undefined,
      opening: first(required(form.opening), maxLength(form.opening, LIMITS.opening)) ?? undefined,
      acceptance: maxLength(form.acceptance, LIMITS.acceptance) ?? undefined,
      validity:
        /^\d+$/.test(form.validity.trim()) && days >= LIMITS.validity.min && days <= LIMITS.validity.max
          ? undefined
          : t.validityInvalid,
    }
    setErrors(found)
    setValidated(true)
    setError(null)
    setIncomplete(null)
    if (
      Object.values(found).some(Boolean) ||
      !sectionsValid(sectionsCheck) ||
      !linesValid(linesCheck) ||
      totals.discountsExceed
    ) {
      setError(t.fixErrors)
      requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
      return
    }
    const body: OfferInput = {
      templateId: form.templateId,
      salutation: form.salutation.trim(),
      clientLines,
      contactIds: form.contactIds,
      opening: form.opening.trim(),
      sections: form.sections.map((section) => ({ ...section, heading: section.heading.trim() })),
      costColumns: form.columns,
      showTotal: form.showTotal,
      costLines: form.lines.map(offerLineToWire),
      acceptanceLabel: optional(form.acceptance),
      annex: form.annex,
      attachmentIds: form.attachmentIds,
      validityDays: days,
      aiAssisted,
    }
    setBusy(true)
    const request =
      source?.mode === 'edit' && version !== null
        ? editOffer(deal.id, source.offer.id, version, body)
        : generateOffer(deal.id, body)
    request.then(onGenerated, (failure: unknown) => {
      setBusy(false)
      refuse(source?.mode === 'edit' && isStaleWrite(failure) ? strings.offers.errors.offerStale : offerFailure(failure), failure)
    })
  }

  const money = (cents: number) => formatMoney(cents, form?.currency ?? deal.currency ?? 'CHF')

  return (
    <>
      <FormDialog
        title={
          source?.mode === 'edit'
            ? t.editTitle(source.offer.reference)
            : source?.mode === 'revise'
              ? t.reviseTitle(source.offer.reference)
              : t.title
        }
        description={
          source?.mode === 'edit' ? t.editDescription : source?.mode === 'revise' ? t.reviseDescription : t.description
        }
        submitLabel={source?.mode === 'edit' ? t.editSubmit : t.submit}
        busyLabel={t.busy}
        cancelLabel={strings.common.cancel}
        closeLabel={strings.common.close}
        busy={busy}
        canSubmit={form !== null && !loadingDraft}
        error={error}
        onSubmit={submit}
        onCancel={onCancel}
        size="lg"
        testIdPrefix="crm-offer-dialog"
      >
        <div ref={fieldsRef} className="flex flex-col gap-4">
          <Field label={t.template} hint={t.templateHint} testId="crm-offer-template">
            {(control) => (
              <select
                {...control}
                value={templateId}
                disabled={templates === null || options.length === 0}
                onChange={(event) => request(event.target.value, aiAssisted)}
              >
                <option value="">
                  {templates === null && !templatesFailed ? t.templatesLoading : t.templateChoose}
                </option>
                {options.map((template) => (
                  <option key={template.id} value={template.id}>
                    {`${template.name} (${strings.offers.languageName[template.language]})`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {templatesFailed && <Banner tone="warning">{t.templatesFailed}</Banner>}
          {templates !== null && options.length === 0 && (
            <Banner tone="info" data-testid="crm-offer-no-templates">
              {t.templatesEmpty}
            </Banner>
          )}
          {withEstimate ? (
            <label className="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={aiAssisted}
                onChange={(event) =>
                  templateId === '' ? setAiAssisted(event.target.checked) : request(templateId, event.target.checked)
                }
                data-testid="crm-offer-ai"
              />
              <span>
                {t.aiAssisted}
                <span className="block text-xs text-soft">{t.aiAssistedHint}</span>
              </span>
            </label>
          ) : (
            <Banner tone="info" data-testid="crm-offer-no-estimate">
              {t.noEstimate}
            </Banner>
          )}
          {loadingDraft && (
            <p className="text-sm text-soft" role="status" data-testid="crm-offer-draft-loading">
              {source && form === null ? t.formLoading : t.draftLoading}
            </p>
          )}
          {form !== null && !loadingDraft && (
            <fieldset disabled={busy} className="flex flex-col gap-4" data-testid="crm-offer-form">
              <p className="text-xs text-soft">
                {withEstimate
                  ? t.summary(
                      strings.offers.languageName[form.language],
                      formatNumber(form.manDays, { maximumFractionDigits: 1 }),
                    )
                  : t.languageOnly(strings.offers.languageName[form.language])}
              </p>
              <Field label={t.salutation} required error={errors.salutation} testId="crm-offer-salutation">
                {(control) => (
                  <input
                    {...control}
                    value={form.salutation}
                    onChange={(event) => patch({ salutation: event.target.value })}
                  />
                )}
              </Field>
              <fieldset className="flex flex-col gap-2" data-testid="crm-offer-client">
                <legend className="field-label">{t.clientLines}</legend>
                <p className="text-xs text-soft">{t.clientLinesHint}</p>
                {errors.clientLines && (
                  <p className="form-error" role="alert">
                    {errors.clientLines}
                  </p>
                )}
                {form.clientLines.map((line, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <Field label={t.clientLine(index + 1)} className="grow">
                      {(control) => (
                        <input
                          {...control}
                          value={line}
                          onChange={(event) =>
                            patch({
                              clientLines: form.clientLines.map((item, at) =>
                                at === index ? event.target.value : item,
                              ),
                            })
                          }
                        />
                      )}
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={t.removeClientLine(index + 1)}
                      disabled={form.clientLines.length <= LIMITS.clientLines.min}
                      onClick={() => patch({ clientLines: form.clientLines.filter((_, at) => at !== index) })}
                    >
                      <Icon name="trash" />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={form.clientLines.length >= LIMITS.clientLines.max}
                    onClick={() => patch({ clientLines: [...form.clientLines, ''] })}
                    data-testid="crm-offer-client-add"
                  >
                    {t.addClientLine}
                  </Button>
                </div>
              </fieldset>
              <CheckboxGroupField
                label={t.contacts}
                hint={t.contactsHint}
                error={pickError.contacts}
                options={contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
                selected={form.contactIds}
                onToggle={toggle('contactIds', LIMITS.contacts, t.contactsMax)}
                emptyState={t.contactsEmpty}
                scroll
                testId="crm-offer-contacts"
                optionTestIdPrefix="crm-offer-contact"
              />
              <Field label={t.opening} required error={errors.opening} testId="crm-offer-opening">
                {(control) => (
                  <textarea
                    {...control}
                    rows={5}
                    value={form.opening}
                    onChange={(event) => patch({ opening: event.target.value })}
                  />
                )}
              </Field>
              <MarkupHelp />
              <SectionsEditor
                sections={form.sections}
                onChange={(sections) => patch({ sections })}
                check={validated ? sectionsCheck : undefined}
                disabled={busy}
                testIdPrefix="crm-offer"
              />
              <OfferCostLinesEditor
                lines={form.lines}
                onChange={(lines) => patch({ lines })}
                check={validated ? linesCheck : undefined}
                unitColumns={form.columns.unit}
                currency={form.currency}
                disabled={busy}
              />
              <CostColumnSwitches
                columns={form.columns}
                showTotal={form.showTotal}
                onColumns={setColumns}
                onShowTotal={(showTotal) => patch({ showTotal })}
                disabled={busy}
                testIdPrefix="crm-offer-cost"
              />
              {totals !== null && (
                <div className="rounded-md border border-rule p-3" data-testid="crm-offer-totals" aria-live="polite">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-soft">{t.oneOffTotal}</dt>
                    <dd className="text-right font-mono text-text" data-testid="crm-offer-total-oneoff">
                      {money(totals.oneOffCents)}
                    </dd>
                    <dt className="text-soft">{t.yearlyTotal}</dt>
                    <dd className="text-right font-mono text-text" data-testid="crm-offer-total-yearly">
                      {money(totals.yearlyCents)}
                    </dd>
                  </dl>
                  <p className="mt-2 text-xs text-soft">{t.totalsHint}</p>
                  {totals.discountsExceed && (
                    <p className="form-error mt-2" role="alert" data-testid="crm-offer-discounts-exceed">
                      {t.discountsExceed}
                    </p>
                  )}
                </div>
              )}
              <Field
                label={strings.templates.editor.fields.acceptanceLabel}
                hint={strings.templates.editor.fields.acceptanceHint}
                error={errors.acceptance}
                testId="crm-offer-acceptance"
              >
                {(control) => (
                  <input
                    {...control}
                    value={form.acceptance}
                    onChange={(event) => patch({ acceptance: event.target.value })}
                  />
                )}
              </Field>
              {withEstimate && (
                <label className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={form.annex}
                    onChange={(event) => patch({ annex: event.target.checked })}
                    data-testid="crm-offer-annex"
                  />
                  <span>
                    {strings.templates.editor.fields.annex}
                    <span className="block text-xs text-soft">{strings.templates.editor.fields.annexHint}</span>
                  </span>
                </label>
              )}
              <CheckboxGroupField
                label={t.attachments}
                hint={t.attachmentsHint}
                error={pickError.attachments}
                options={pdfs.map((file) => ({
                  id: file.id,
                  label: `${file.fileName} (${formatFileSize(file.sizeBytes)})`,
                }))}
                selected={form.attachmentIds}
                onToggle={toggle('attachmentIds', LIMITS.attachments, t.attachmentsMax)}
                emptyState={t.attachmentsEmpty}
                scroll
                testId="crm-offer-attachments"
                optionTestIdPrefix="crm-offer-attachment"
              />
              <Field label={t.validity} required error={errors.validity} testId="crm-offer-validity">
                {(control) => (
                  <input
                    {...control}
                    inputMode="numeric"
                    className="font-mono"
                    value={form.validity}
                    onChange={(event) => patch({ validity: event.target.value })}
                  />
                )}
              </Field>
            </fieldset>
          )}
          {incomplete !== null && (
            <LegalEntityNotice problem="incomplete" where="generate" entity={incomplete.entity} missing={incomplete.missing} />
          )}
        </div>
      </FormDialog>
      {pending !== null && (
        <ConfirmDialog
          title={t.replace.title}
          tone="primary"
          confirmLabel={t.replace.confirm}
          busyLabel={t.replace.busy}
          cancelLabel={t.replace.cancel}
          closeLabel={strings.common.close}
          busy={false}
          error={null}
          onConfirm={() => loadDraft(pending.templateId, pending.aiAssisted)}
          onCancel={() => setPending(null)}
          testIdPrefix="crm-offer-replace"
        >
          {t.replace.body}
        </ConfirmDialog>
      )}
    </>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Banner, Button, Card, Field, focusFirstInvalid, formatDateTime } from '@operai/ui'
import { saveEntityProfile } from '../lib/crmApi'
import { errorMessage, fieldErrorOf, isNulRefusal } from '../lib/errors'
import type { Entity, EntityProfile } from '../lib/types'
import { maxLength, optional } from '../lib/validate'
import { strings } from '../strings'
import LegalEntitySettingsNote from './LegalEntitySettingsNote'

type FieldName = 'termsEn' | 'termsIt' | 'place'

/** The wire member the server names in a refusal → the form's field (`addressLines.1` is the address's second line). */
const SERVER_FIELDS: Record<string, FieldName> = {
  offerTermsEn: 'termsEn',
  offerTermsIt: 'termsIt',
  placeOfIssue: 'place',
}

/**
 * EntityProfileForm — what the CRM keeps for ONE entity: the standard offer terms and the place of issue
 * (specs/20261101-crm-sales-flow O2), saved whole with `PUT /entity-profiles/:entity`. The legal name, address, VAT
 * number and IBAN live in the legal entity registry (specs/20261117-legal-entities AC-6.1); a note says so. Offers
 * snapshot what they printed, so saving never rewrites an issued offer.
 */
export default function EntityProfileForm({
  entity,
  profile,
  onSaved,
}: {
  entity: Entity
  profile: EntityProfile | null
  onSaved: (profile: EntityProfile) => void
}) {
  const t = strings.settings
  const label = strings.badges.entity[entity]
  const [termsEn, setTermsEn] = useState(profile?.offerTermsEn ?? '')
  const [termsIt, setTermsIt] = useState(profile?.offerTermsIt ?? '')
  const [place, setPlace] = useState(profile?.placeOfIssue ?? '')
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const bannerRef = useRef<HTMLDivElement>(null)
  // After a refusal the person is on Save, far from the top of the card: focus goes to the field the server named, or
  // to the banner (which scrolls into view and is read out) when it named none this form has.
  const [refusedAt, setRefusedAt] = useState(0)
  useEffect(() => {
    if (refusedAt === 0) return
    if (!focusFirstInvalid(formRef.current)) bannerRef.current?.focus()
  }, [refusedAt])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found: Partial<Record<FieldName, string>> = {
      termsEn: maxLength(termsEn, 10_000) ?? undefined,
      termsIt: maxLength(termsIt, 10_000) ?? undefined,
      place: maxLength(place, 100) ?? undefined,
    }
    setErrors(found)
    if (Object.values(found).some(Boolean)) return
    setBusy(true)
    setError(null)
    setSaved(null)
    saveEntityProfile(entity, {
      offerTermsEn: optional(termsEn),
      offerTermsIt: optional(termsIt),
      placeOfIssue: optional(place),
    }).then(
      (next) => {
        setBusy(false)
        setSaved(t.saved(label))
        onSaved(next)
      },
      (failure: unknown) => {
        setBusy(false)
        const refused = isNulRefusal(failure) ? fieldErrorOf(failure) : null
        const mapped = refused ? SERVER_FIELDS[refused.field.split('.')[0] ?? ''] : undefined
        if (refused && mapped) setErrors({ [mapped]: refused.message })
        else setError(errorMessage(failure))
        setRefusedAt((count) => count + 1)
      },
    )
  }

  return (
    <Card title={t.profile(label)} data-testid={`crm-settings-${entity}`}>
      <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-3">
        <LegalEntitySettingsNote entity={entity} />
        {error && (
          <Banner ref={bannerRef} tabIndex={-1} tone="danger" data-testid={`crm-settings-${entity}-error`}>
            {error}
          </Banner>
        )}
        {saved && (
          <Banner tone="success" compact autoDismiss onDismiss={() => setSaved(null)} dismissLabel={strings.common.dismiss}>
            {saved}
          </Banner>
        )}
        <Field label={t.fields.placeOfIssue} hint={t.fields.placeOfIssueHint} error={errors.place} testId={`crm-settings-${entity}-place`}>
          {(control) => <input {...control} value={place} onChange={(event) => setPlace(event.target.value)} />}
        </Field>
        <Field label={t.fields.termsEn} hint={t.fields.termsHint} error={errors.termsEn} testId={`crm-settings-${entity}-terms-en`}>
          {(control) => <textarea {...control} rows={5} value={termsEn} onChange={(event) => setTermsEn(event.target.value)} />}
        </Field>
        <Field label={t.fields.termsIt} error={errors.termsIt} testId={`crm-settings-${entity}-terms-it`}>
          {(control) => <textarea {...control} rows={5} value={termsIt} onChange={(event) => setTermsIt(event.target.value)} />}
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-soft">{profile ? t.updated(formatDateTime(profile.updatedAt)) : ''}</span>
          <Button type="submit" variant="primary" busy={busy} data-testid={`crm-settings-${entity}-save`}>
            {busy ? t.saving : t.save}
          </Button>
        </div>
      </form>
    </Card>
  )
}

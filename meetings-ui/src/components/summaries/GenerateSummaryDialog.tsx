import { Banner, Field, FormDialog, RadioGroupField, resolveLocale } from '@operai/ui'
import { useCallback, useState } from 'react'
import { useResource } from '../../hooks/useResource'
import { generateSummary, listTemplates } from '../../lib/meetingsApi'
import type { HostInfo, Meeting, MeetingLanguage, Summary, Template } from '../../lib/types'
import { strings } from '../../strings'
import { aiErrorMessage } from '../aiError'
import { errorMessage } from '../../lib/errors'

export type GenerateSummaryDialogProps = {
  meeting: Meeting
  hostInfo: HostInfo | null
  onClose: () => void
  onGenerated: (summary: Summary) => void
}

type Group = { label: string; templates: Template[] }

/** The picker's order (AC-8.5): recommended for the host, then personal, shared, built-in. */
function groupTemplates(templates: Template[], hostInfo: HostInfo | null): Group[] {
  const t = strings.summaries.dialog
  const entity = hostInfo?.labels[resolveLocale()].entity
  const recommended = templates.filter((template) => template.recommended)
  const rest = templates.filter((template) => !template.recommended)
  const groups: Group[] = [
    { label: entity === undefined ? t.groupRecommendedGeneric : t.groupRecommended(entity), templates: recommended },
    { label: t.groupPersonal, templates: rest.filter((template) => template.source === 'personal') },
    { label: t.groupShared, templates: rest.filter((template) => template.source === 'shared') },
    { label: t.groupBuiltin, templates: rest.filter((template) => template.source === 'builtin') },
  ]
  return groups.filter((group) => group.templates.length > 0)
}

/** Generate summary (F10): template (grouped), output language (default: the UI language), a section preview. */
export function GenerateSummaryDialog({ meeting, hostInfo, onClose, onGenerated }: GenerateSummaryDialogProps) {
  const t = strings.summaries.dialog
  const fetcher = useCallback(
    (signal: AbortSignal) => listTemplates({ meetingId: meeting.id }, { signal }),
    [meeting.id],
  )
  const templates = useResource(fetcher)
  const [chosen, setChosen] = useState<string | null>(null)
  const [language, setLanguage] = useState<MeetingLanguage>(resolveLocale())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const groups = groupTemplates(templates.data?.items ?? [], hostInfo)
  const all = groups.flatMap((group) => group.templates)
  const selected = all.find((template) => template.id === chosen) ?? all[0]

  const submit = async () => {
    if (selected === undefined) return
    setError(null)
    setBusy(true)
    try {
      onGenerated(await generateSummary(meeting.id, { templateId: selected.id, language }))
    } catch (failure) {
      setBusy(false)
      setError(aiErrorMessage(failure, strings.summaries.rateLimited))
    }
  }

  return (
    <FormDialog
      title={t.title}
      size="md"
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={selected !== undefined}
      error={error}
      onSubmit={() => void submit()}
      onCancel={onClose}
      testIdPrefix="meetings-generate-summary"
    >
      {templates.status === 'loading' && <p className="text-sm text-soft">{t.loading}</p>}
      {templates.status === 'error' && (
        <Banner tone="warning" onRetry={templates.retry} retryLabel={strings.common.retry}>
          {errorMessage(templates.error)}
        </Banner>
      )}
      {templates.status === 'ready' && selected === undefined && <p className="text-sm text-soft">{t.noTemplates}</p>}
      {selected !== undefined && (
        <div className="flex flex-col gap-4">
          <Field label={t.template}>
            {(control) => (
              <select {...control} value={selected.id} onChange={(event) => setChosen(event.target.value)}>
                {groups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
          <RadioGroupField label={t.outputLanguage}>
            {(['en', 'it'] as const).map((code) => (
              <label key={code} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="meetings-summary-language"
                  checked={language === code}
                  onChange={() => setLanguage(code)}
                />
                {strings.summaries.languages[code]}
              </label>
            ))}
          </RadioGroupField>
          <div aria-live="polite">
            <p className="text-xs text-soft">{t.preview}</p>
            <ol className="list-decimal pl-5 text-sm">
              {selected.sections.map((section, index) => (
                <li key={index}>{section.heading}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </FormDialog>
  )
}

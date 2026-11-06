import { useEffect, useId, useState } from 'react'
import { Combobox, Field } from '@operai/ui'
import type { ComboboxOption } from '@operai/ui'
import { codeOf } from '../lib/errors'
import { listCompanies } from '../lib/projectsApi'
import type { CompanyChoice } from '../lib/types'
import { strings } from '../strings'

type Results = { q: string; ok: true; items: CompanyChoice[] } | { q: string; ok: false; error: unknown }

const SEARCH_DELAY_MS = 250

/**
 * CompanyPicker — type to find a CRM company (`GET /companies?q=` on
 * projects-api, which reads the CRM service-to-service; needs `project:manage`).
 * Searches as the person types, debounced; the answer for an older query is
 * ignored, so "loading" is simply "no answer for this text yet". Typing after a
 * choice clears it: a company is always picked from the list, never free text.
 * A CRM that cannot answer (503 `crm_unavailable`) is said so in the list.
 */
export default function CompanyPicker({
  label,
  hint,
  value,
  onChange,
  error,
  required = false,
  testId,
}: {
  label: string
  hint?: string
  value: CompanyChoice | null
  onChange: (value: CompanyChoice | null) => void
  error?: string | null
  required?: boolean
  testId: string
}) {
  const id = useId()
  const [text, setText] = useState(value?.name ?? '')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<Results | null>(null)

  useEffect(() => {
    if (!open) return
    const q = text.trim()
    const controller = new AbortController()
    const timer = setTimeout(() => {
      listCompanies(q, { signal: controller.signal }).then(
        ({ items }) => {
          if (!controller.signal.aborted) setResults({ q, ok: true, items })
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setResults({ q, ok: false, error: failure })
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [text, open])

  const current = results !== null && results.q === text.trim() ? results : null
  const items = current?.ok ? current.items : []
  const options: ComboboxOption[] = items.map((company) => ({
    id: company.id,
    label: company.name,
    secondaryLabel: strings.badges.entity[company.entity],
  }))
  const emptyState =
    current === null
      ? strings.projects.companyPicker.loading
      : current.ok
        ? strings.projects.companyPicker.noMatch
        : codeOf(current.error) === 'crm_unavailable'
          ? strings.projects.companyPicker.crmUnavailable
          : strings.common.networkError

  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} testId={testId}>
      {(control) => (
        <Combobox
          id={control.id}
          ariaInvalid={control['aria-invalid']}
          ariaDescribedBy={control['aria-describedby']}
          ariaRequired={control['aria-required']}
          value={text}
          onValueChange={(next) => {
            setText(next)
            setOpen(true)
            if (value !== null && next !== value.name) onChange(null)
          }}
          options={options}
          onSelect={(option) => {
            const company = items.find((item) => item.id === option.id)
            setText(option.label)
            setOpen(false)
            if (company) onChange(company)
          }}
          isOpen={open}
          onOpenChange={setOpen}
          onFocus={() => setOpen(true)}
          emptyState={emptyState}
          liveRegionText={current?.ok ? strings.projects.companyPicker.results(options.length) : ''}
          testId={`${testId}-input`}
        />
      )}
    </Field>
  )
}

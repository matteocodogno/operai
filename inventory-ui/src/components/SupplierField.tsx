import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import Combobox from './Combobox'
import { listSuppliers } from '../lib/suppliersApi'
import { strings } from '../strings'

/**
 * SupplierField — the supplier text field of the register form and the Edit
 * dialog, with suggestions from the suppliers already in the register, so the
 * same supplier is not typed in three spellings.
 *
 * It stays a FREE-TEXT field: a suggestion fills the input, and a supplier
 * nobody has used yet is typed as before. The list is fetched once per mount
 * and filtered here, by substring, case-insensitively. A failed fetch is
 * silent — the field is then exactly the plain input it replaced (the suite's
 * posture for an optional enrichment, ADR-0032).
 *
 * The popup opens while typing (or on ArrowDown) and only when there is
 * something to offer: no "no matches" row, and nothing when the only match is
 * what is already typed.
 */

export type SupplierFieldProps = {
  id: string
  value: string
  onChange: (value: string) => void
  ariaInvalid?: boolean
  ariaDescribedBy?: string
  inputClassName?: string
  inputStyle?: CSSProperties
}

export default function SupplierField({
  id,
  value,
  onChange,
  ariaInvalid,
  ariaDescribedBy,
  inputClassName,
  inputStyle,
}: SupplierFieldProps) {
  const [suppliers, setSuppliers] = useState<string[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    // `Promise.resolve().then` so a client that throws synchronously degrades the same way as one that rejects.
    Promise.resolve()
      .then(() => listSuppliers({ signal: controller.signal }))
      .then(
        ({ suppliers: found }) => {
          if (!controller.signal.aborted) setSuppliers(found)
        },
        () => undefined,
      )
    return () => controller.abort()
  }, [])

  const needle = value.trim().toLowerCase()
  const matches = suppliers.filter((name) => name.toLowerCase().includes(needle))
  const nothingNew = matches.length === 1 && matches[0] === value.trim()
  // The option id feeds an element id (`aria-activedescendant`), so it is the index, never the name.
  const options = nothingNew ? [] : matches.map((name, index) => ({ id: String(index), label: name }))
  const isOpen = open && options.length > 0

  return (
    <Combobox
      id={id}
      testId={id}
      value={value}
      onValueChange={(next) => {
        onChange(next)
        setOpen(true)
      }}
      options={options}
      onSelect={(option) => onChange(option.label)}
      isOpen={isOpen}
      onOpenChange={setOpen}
      onBlur={() => setOpen(false)}
      ariaInvalid={ariaInvalid}
      ariaDescribedBy={ariaDescribedBy}
      liveRegionText={isOpen ? strings.common.supplierField.suggestions(options.length) : ''}
      inputClassName={inputClassName}
      inputStyle={inputStyle}
    />
  )
}

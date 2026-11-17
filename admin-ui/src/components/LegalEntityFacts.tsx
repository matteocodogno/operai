/**
 * LegalEntityFacts — the values of one entity as facts, no input (T36, design S4; T39's version view reuses it for
 * S6). Three `Card`s (Company, Address, Contacts line) of `FactList`s. A value that is required and empty says
 * "Not filled in" with an alert glyph, an optional empty one "Empty"; an address prints one line per row, in its
 * own language. "Required" is the registry's word (`missing[]`), not a rule of this file (plan decision 10).
 */
import type { ReactNode } from 'react'
import { Card, FactList, Icon } from '@operai/ui'
import type { Fact } from '@operai/ui'
import { valueName } from '../lib/legalEntityMappings'
import { getFieldValue, isAddressField } from '../lib/legalEntityModel'
import type { LegalEntityDetails, LegalEntityField } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type LegalEntityFactsProps = {
  details: LegalEntityDetails
  /** The IBAN in groups of four, as the read answered it; the electronic form is shown when it is not given. */
  ibanPrint?: string
  /** `missing[]` of the answer: the required values that are empty. */
  missing: readonly LegalEntityField[]
  testId?: string
}

const COMPANY: readonly LegalEntityField[] = ['legalName', 'vatNumber', 'iban']
const ADDRESS: readonly LegalEntityField[] = ['address.it', 'address.en']
const CONTACTS: readonly LegalEntityField[] = ['contacts.it', 'contacts.en']

export default function LegalEntityFacts({ details, ibanPrint, missing, testId }: LegalEntityFactsProps) {
  const fact = (field: LegalEntityField): Fact => {
    const raw = getFieldValue(details, field)
    const empty = Array.isArray(raw) ? raw.every((line) => line.trim() === '') : raw.trim() === ''
    let value: ReactNode
    if (empty) {
      value = missing.includes(field) ? (
        <span className="inline-flex items-center gap-1 text-org-text">
          <Icon name="alert" size={14} />
          {t.value.notFilled}
        </span>
      ) : (
        <span className="text-soft">{t.value.empty}</span>
      )
    } else if (isAddressField(field)) {
      value = (
        <>
          {(raw as string[]).map((line, index) => (
            <span key={index} className="block">
              {line}
            </span>
          ))}
        </>
      )
    } else if (field === 'iban') {
      value = <span className="font-mono">{ibanPrint !== undefined && ibanPrint !== '' ? ibanPrint : (raw as string)}</span>
    } else {
      value = raw as string
    }
    // The language of a part (WCAG 3.1.2): the Italian and English values are not in the page's language.
    const lang = field.endsWith('.it') ? 'it' : field.endsWith('.en') ? 'en' : undefined
    return {
      id: field,
      term: valueName(field),
      value: (
        <span lang={empty ? undefined : lang} data-testid={`admin-legal-fact-${field}`}>
          {value}
        </span>
      ),
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <Card title={t.form.group.company} headingLevel={4}>
        <FactList items={COMPANY.map(fact)} />
      </Card>
      <Card title={t.form.group.address} headingLevel={4}>
        <FactList items={ADDRESS.map(fact)} />
      </Card>
      <Card title={t.form.group.contacts} headingLevel={4}>
        <FactList items={CONTACTS.map(fact)} />
      </Card>
    </div>
  )
}

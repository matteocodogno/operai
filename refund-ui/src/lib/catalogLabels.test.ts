/**
 * @vitest-environment jsdom
 *
 * catalogLabels (T22, specs/20261118-refund-accounting-export): number-first labels and the VAT rate in the viewer's
 * number convention; plus the status meanings the catalog adds to the one map.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { STATUS } from '@operai/ui'
import { accountText, formatVatRate, vatCodeText } from './catalogLabels'
import { CATALOG_STATUS_MEANING, RATE_MISSING_MEANING } from './statusMeaning'
import { catalogs } from '../strings'

afterEach(() => document.documentElement.removeAttribute('lang'))

describe('catalogLabels', () => {
  it('writes an account number first', () => {
    expect(accountText({ number: '5905', name: 'Spese rimborsi' })).toBe('5905 — Spese rimborsi')
  })

  it('writes a VAT code first, with its rate', () => {
    expect(vatCodeText({ code: 'IMP81', label: 'Imposta 8.1%', ratePercent: '8.1' })).toBe(
      'IMP81 — Imposta 8.1% (8.1%)',
    )
    expect(vatCodeText({ code: 'NOVAT', label: 'Senza IVA', ratePercent: '0' })).toBe('NOVAT — Senza IVA (0%)')
  })

  it('formats the rate with the viewer’s decimal mark', () => {
    expect(formatVatRate('8.1')).toBe('8.1%')
    expect(formatVatRate('7.70')).toBe('7.7%')
    expect(formatVatRate('100')).toBe('100%')
    document.documentElement.setAttribute('lang', 'it')
    expect(formatVatRate('8.1')).toBe('8,1%')
  })

  it('shows a rate that is not a number as it was sent, never NaN', () => {
    expect(formatVatRate('n/a')).toBe('n/a%')
  })
})

describe('status meanings of the catalog', () => {
  it('maps Active to active and Inactive to voided, and a missing rate to attention', () => {
    expect(CATALOG_STATUS_MEANING).toEqual({ active: 'active', inactive: 'voided' })
    expect(RATE_MISSING_MEANING).toBe('attention')
    for (const meaning of [...Object.values(CATALOG_STATUS_MEANING), RATE_MISSING_MEANING]) {
      expect(Object.keys(STATUS)).toContain(meaning)
    }
  })
})

describe('the accounting copy catalog (design § Copy keys)', () => {
  const it_ = catalogs.it
  const en = catalogs.en

  it('has the keys of every design section, in both languages', () => {
    for (const catalog of [en, it_]) {
      expect(catalog.settings.sections.accounting).toBeTruthy()
      expect(catalog.settings.accounts.errors.duplicateInactive('5905')).toContain('5905')
      expect(catalog.settings.vatCodes.deactivateDialog.body).toBeTruthy()
      expect(catalog.settings.defaults.foreign.inactiveWarning('IMP81')).toContain('IMP81')
      expect(catalog.settings.fx.correction.title('EUR', 'March 2026')).toContain('EUR')
      expect(catalog.pages.reviewDetail.classification.missingSummary.hint).toBeTruthy()
      expect(catalog.pages.batchDetail.accountingExport.blocked.checkAgain).toBeTruthy()
      expect(catalog.pages.requestDetail.lines.receiptNumberLabel).toBeTruthy()
    }
  })

  it('writes the plurals inside the function (n === 1)', () => {
    expect(en.settings.fx.fetchedOk(1)).toBe('Recorded the rates for 1 month.')
    expect(en.settings.fx.fetchedOk(2)).toBe('Recorded the rates for 2 months.')
    expect(it_.settings.fx.fetchedOk(1)).toBe('Registrati i tassi di 1 mese.')
    expect(en.pages.reviewDetail.classification.missingSummary.title(1)).toBe(
      'Nothing was approved. 1 value needs your attention.',
    )
    expect(it_.pages.reviewDetail.classification.missingSummary.title(2)).toBe(
      'Non è stato approvato nulla. 2 valori richiedono attenzione.',
    )
    expect(en.pages.batchDetail.accountingExport.rows(1)).toBe('1 row will be exported.')
    expect(it_.pages.batchDetail.accountingExport.rows(12)).toBe('Verranno esportate 12 righe.')
    expect(en.pages.batchDetail.accountingExport.excluded(3)).toContain('3 WellD Italia lines')
    expect(it_.pages.batchDetail.accountingExport.excluded(1)).toContain('1 riga WellD Italia è esclusa')
  })

  it('extends the batch request link label with receipts only when there are some', () => {
    const label = en.components.batchEmployeeGroupList.openRequestLabel
    expect(label('Ada', 'approved', 'EUR 10.00')).toBe('Open Ada’s request, approved, EUR 10.00')
    expect(label('Ada', 'approved', 'EUR 10.00', 'MC26/014, MC26/015')).toBe(
      'Open Ada’s request, approved, EUR 10.00, receipts MC26/014, MC26/015',
    )
    expect(
      it_.components.batchEmployeeGroupList.openRequestLabel('Ada', 'approvata', '10,00 EUR', 'MC26/014'),
    ).toContain(', ricevute MC26/014')
  })
})

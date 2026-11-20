/**
 * @vitest-environment jsdom
 *
 * catalogLabels (T22, specs/20261118-refund-accounting-export): number-first labels and the VAT rate in the viewer's
 * number convention.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { accountText, formatVatRate, vatCodeText } from './catalogLabels'
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

describe('the accounting copy catalog (design § Copy keys)', () => {
  const it_ = catalogs.it
  const en = catalogs.en

  it('has the keys of every design section, in both languages', () => {
    for (const catalog of [en, it_]) {
      expect(catalog.settings.sections.defaults).toBeTruthy()
      expect(catalog.settings.defaults.needsChoice(1)).toBeTruthy()
      expect(catalog.pages.reviewDetail.classification.missingSummary.hintAccounts).toBeTruthy()
      expect(catalog.pages.batchDetail.accountingExport.blocked.checkAgain).toBeTruthy()
      expect(catalog.pages.requestDetail.lines.receiptNumberLabel).toBeTruthy()
    }
  })

  it('writes the plurals inside the function (n === 1)', () => {
    expect(en.pages.reviewDetail.classification.missingSummary.titleAccounts(1)).toBe(
      'Nothing was approved. 1 line needs an account.',
    )
    expect(it_.pages.reviewDetail.classification.missingSummary.titleAccounts(2)).toBe(
      'Non è stato approvato nulla. 2 righe richiedono un conto.',
    )
    expect(en.pages.batchDetail.accountingExport.rows(1)).toBe('1 row will be exported.')
    expect(it_.pages.batchDetail.accountingExport.rows(12)).toBe('Verranno esportate 12 righe.')
    expect(en.pages.batchDetail.accountingExport.excluded(3)).toContain('3 WellD Italia lines')
    expect(it_.pages.batchDetail.accountingExport.excluded(1)).toContain('1 riga WellD Italia è esclusa')
  })

  it('starts the batch request link with the employee, in both languages', () => {
    expect(en.components.batchEmployeeGroupList.openRequestPrefix('Ada')).toBe('Open Ada’s request: ')
    expect(it_.components.batchEmployeeGroupList.openRequestPrefix('Ada')).toBe('Apri la richiesta di Ada: ')
  })
})

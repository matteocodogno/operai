/**
 * specs/20261119-accounting T33: every copy key that design.md § Copy keys ("refund-ui: added, changed,
 * removed") adds exists in both catalogs, with the same kind (a sentence with a value is a function) and a
 * non-empty text; and (T38) every removed key is gone from both. The reworded keys of existing components are
 * checked by the task that changes their component.
 */

import { describe, expect, it } from 'vitest'
import { catalogs } from './strings'

const ADDED_KEYS: ReadonlyArray<{ path: string; args?: readonly unknown[] }> = [
  { path: 'accountingUnavailable.cause' },
  // Added by the tasks that changed the component, once the need showed (T35 to T37).
  { path: 'settings.defaults.needsChoiceLabel' },
  { path: 'pages.reviewDetail.classification.defaultWhat.account' },
  { path: 'pages.reviewDetail.classification.defaultWhat.vatCode' },
  { path: 'pages.reviewDetail.classification.vatOptionNoLabel', args: ['OLD', '7.7%'] },
  { path: 'pages.batchDetail.accountingExport.blocked.rateItemReason', args: ['EUR', 'March 2026', 'x'] },
  { path: 'accountingUnavailable.approve' },
  { path: 'accountingUnavailable.classify' },
  { path: 'accountingUnavailable.save' },
  { path: 'accountingUnavailable.options' },
  { path: 'settings.sections.defaults' },
  { path: 'settings.accountingLink.withAccess' },
  { path: 'settings.accountingLink.linkText' },
  { path: 'settings.accountingLink.linkLabel' },
  { path: 'settings.accountingLink.withoutAccess' },
  { path: 'settings.defaults.state.deactivated' },
  { path: 'settings.defaults.state.notFound' },
  { path: 'settings.defaults.needsChoice', args: [1] },
  { path: 'settings.defaults.needsChoice', args: [3] },
  { path: 'settings.defaults.unavailable.title' },
  { path: 'settings.defaults.unavailable.body' },
  { path: 'settings.defaults.changeBlocked' },
  { path: 'settings.defaults.recovered' },
  { path: 'settings.defaults.stillUnavailable' },
  { path: 'settings.defaults.dialog.notFoundCurrent', args: ['account'] },
  { path: 'settings.defaults.dialog.tryAgain' },
  { path: 'settings.defaults.errors.accountNotFound' },
  { path: 'pages.reviewDetail.classification.accountingUnavailablePage.title' },
  { path: 'pages.reviewDetail.classification.accountingUnavailablePage.body' },
  { path: 'pages.reviewDetail.classification.accountingUnavailableLine' },
  { path: 'pages.reviewDetail.classification.defaultRecorded' },
  { path: 'pages.reviewDetail.classification.notFoundOption', args: ['5905 — Travel'] },
  { path: 'pages.reviewDetail.classification.notFoundCurrentAccount' },
  { path: 'pages.reviewDetail.classification.notFoundCurrentVat' },
  { path: 'pages.reviewDetail.classification.defaultDeactivated', args: ['account'] },
  { path: 'pages.reviewDetail.classification.defaultNotFound', args: ['VAT code'] },
  { path: 'pages.reviewDetail.classification.rateNotYet' },
  { path: 'pages.reviewDetail.classification.rateNotYetHelp', args: ['EUR', 'March 2026'] },
  { path: 'pages.reviewDetail.classification.ratePending' },
  { path: 'pages.reviewDetail.classification.ratePendingHelp', args: ['EUR', 'March 2026'] },
  { path: 'pages.reviewDetail.classification.frozen' },
  { path: 'pages.reviewDetail.classification.askManager' },
  { path: 'pages.reviewDetail.classification.accountUnknown' },
  { path: 'pages.reviewDetail.classification.vatUnknown' },
  { path: 'pages.batchDetail.accountingExport.pending', args: [1] },
  { path: 'pages.batchDetail.accountingExport.pending', args: [4] },
  { path: 'pages.batchDetail.accountingExport.blocked.unavailableTitle' },
  { path: 'pages.batchDetail.accountingExport.blocked.unavailableBody' },
  { path: 'pages.batchDetail.accountingExport.blocked.rateReason.notPublished' },
  { path: 'pages.batchDetail.accountingExport.blocked.rateReason.fetchFailed' },
  { path: 'pages.batchDetail.accountingExport.blocked.rateReason.noSource' },
  // The accounting sign-off round (T67, specs/20261119-accounting): copy for T68 to T71, which switch the components over.
  { path: 'settings.defaults.descriptionAccountOnly' },
  { path: 'pages.requestDetail.composer.splitReceiptHint' },
  { path: 'pages.reviewDetail.classification.vatNone' },
  { path: 'pages.reviewDetail.classification.savedVatNone' },
  { path: 'pages.reviewDetail.classification.vatAmountNone' },
  { path: 'pages.reviewDetail.classification.missingSummary.titleAccounts', args: [1] },
  { path: 'pages.reviewDetail.classification.missingSummary.titleAccounts', args: [3] },
  { path: 'pages.reviewDetail.classification.missingSummary.hintAccounts' },
  { path: 'pages.batchDetail.accountingExport.descriptionExcel' },
  { path: 'pages.batchDetail.accountingExport.downloadExcel' },
  { path: 'pages.batchDetail.accountingExport.blocked.unclassifiedAccounts' },
]

const resolve = (catalog: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], catalog)

const text = (value: unknown, args: readonly unknown[] = []): string =>
  typeof value === 'function' ? (value as (...a: unknown[]) => string)(...args) : (value as string)

describe('T33 copy additions (specs/20261119-accounting design § Copy keys)', () => {
  for (const { path, args } of ADDED_KEYS) {
    it(`${path}${args ? `(${args.join(', ')})` : ''} exists in en and it, as the same kind, with text`, () => {
      const en = resolve(catalogs.en, path)
      const it_ = resolve(catalogs.it, path)
      expect(typeof en).toBe(typeof it_)
      expect(['string', 'function']).toContain(typeof en)
      expect(text(en, args).trim().length).toBeGreaterThan(0)
      expect(text(it_, args).trim().length).toBeGreaterThan(0)
    })
  }

  it('T38: the keys of the components that moved to accounting-ui are gone from both catalogs', () => {
    const REMOVED = [
      'settings.accounts',
      'settings.vatCodes',
      'settings.fx',
      'settings.sections.accounting',
      'settings.sections.exchangeRates',
      'settings.catalog.status',
      'settings.catalog.inactiveTag',
      'settings.catalog.close',
      'pages.batchDetail.accountingExport.blocked.askAdmin',
    ]
    for (const lang of [catalogs.en, catalogs.it]) {
      for (const path of REMOVED) expect(resolve(lang, path), path).toBeUndefined()
    }
  })

  it('T69: the VAT-default and foreign-currency designation keys of Settings are gone from both catalogs (AC-2.1, SO-16)', () => {
    const REMOVED = [
      'settings.defaults.description',
      'settings.defaults.columns.vatCode',
      'settings.defaults.dialog.vatCode',
      'settings.defaults.errors.vatInactive',
      'settings.defaults.errors.vatNotFound',
      'settings.defaults.foreign',
      'settings.history.columns.vatCode',
    ]
    for (const lang of [catalogs.en, catalogs.it]) {
      for (const path of REMOVED) expect(resolve(lang, path), path).toBeUndefined()
    }
  })

  it('every refusal sentence names the cause and the remedy and carries no address or identifier (AC-6.10)', () => {
    for (const lang of [catalogs.en, catalogs.it]) {
      for (const sentence of Object.values(lang.accountingUnavailable)) {
        expect(sentence).not.toMatch(/https?:|\/|@|\bid\b|\d{3,}/i)
      }
    }
  })

  it('English and Italian plurals are written inside the function, singular and plural differ', () => {
    for (const lang of [catalogs.en, catalogs.it]) {
      expect(lang.settings.defaults.needsChoice(1)).not.toBe(lang.settings.defaults.needsChoice(2))
      expect(lang.pages.batchDetail.accountingExport.pending(1)).not.toBe(
        lang.pages.batchDetail.accountingExport.pending(2),
      )
      expect(lang.pages.batchDetail.accountingExport.pending(3)).toContain('3')
    }
  })

  it('the sign-off copy says what the owner approved (SO-15, AC-3.12, AC-3.3, AC-6.1)', () => {
    const { en, it: itCatalog } = catalogs
    expect(en.pages.requestDetail.composer.splitReceiptHint).toBe(
      'One VAT rate per line: if a receipt has items at different VAT rates (for example 8.1 % and 2.6 % at a supermarket), enter one line per rate.',
    )
    expect(itCatalog.pages.requestDetail.composer.splitReceiptHint).toBe(
      'Una sola aliquota IVA per riga: se uno scontrino contiene articoli con aliquote diverse (per esempio 8,1 % e 2,6 % al supermercato), inserisci una riga per aliquota.',
    )
    expect(en.pages.reviewDetail.classification.vatNone).toBe('None')
    expect(itCatalog.pages.reviewDetail.classification.vatNone).toBe('Nessuno')
    expect(en.pages.batchDetail.accountingExport.downloadExcel).toBe('Download Excel file')
    expect(itCatalog.pages.batchDetail.accountingExport.downloadExcel).toBe('Scarica file Excel')
  })

  it('the account-only summary and copy never mention a VAT code (AC-3.4, AC-3.11)', () => {
    for (const lang of [catalogs.en, catalogs.it]) {
      const summary = lang.pages.reviewDetail.classification.missingSummary
      for (const sentence of [summary.titleAccounts(1), summary.titleAccounts(3), summary.hintAccounts]) {
        expect(sentence).not.toMatch(/\bVAT\b|\bIVA\b/)
      }
      expect(summary.titleAccounts(1)).not.toBe(summary.titleAccounts(3))
      expect(summary.titleAccounts(3)).toContain('3')
      expect(lang.settings.defaults.descriptionAccountOnly).not.toMatch(/\bVAT\b|\bIVA\b/)
      expect(lang.pages.batchDetail.accountingExport.blocked.unclassifiedAccounts).not.toMatch(/\bVAT\b|\bIVA\b/)
      expect(lang.pages.batchDetail.accountingExport.downloadExcel).not.toMatch(/CSV/)
      expect(lang.pages.batchDetail.accountingExport.descriptionExcel).not.toMatch(/CSV/)
    }
  })
})

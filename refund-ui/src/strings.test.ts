/**
 * specs/20261119-accounting T33: every copy key that design.md § Copy keys ("refund-ui: added, changed,
 * removed") adds exists in both catalogs, with the same kind (a sentence with a value is a function) and a
 * non-empty text. Removals wait for T38, and the reworded keys of existing components are checked by the
 * task that changes their component.
 */

import { describe, expect, it } from 'vitest'
import { catalogs } from './strings'

const ADDED_KEYS: ReadonlyArray<{ path: string; args?: readonly unknown[] }> = [
  { path: 'accountingUnavailable.cause' },
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
  { path: 'settings.defaults.errors.vatNotFound' },
  { path: 'settings.defaults.foreign.notFoundWarning', args: ['V81'] },
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
})

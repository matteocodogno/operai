import { catalogGaps } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian, strings } from './strings'

type Leaf = string | ((...args: never[]) => string)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every leaf (a string or a sentence function) of a catalog, as a dotted path. */
function leaves(node: unknown, prefix = ''): Record<string, Leaf> {
  if (!isRecord(node)) return prefix === '' ? {} : { [prefix]: node as Leaf }
  return Object.assign(
    {},
    ...Object.entries(node).map(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key)),
  )
}

/**
 * Every accounting-ui key of design.md § Copy keys, expanded from the table's shorthand ("a / b / c" and "As accounts,
 * with VAT code"), each with the arguments its sentence function takes (none: a plain string). A sentence function must
 * put every argument in its answer, in both languages.
 */
type Args = readonly (string | number)[]
const DESIGN_KEYS: ReadonlyArray<readonly [string] | readonly [string, Args]> = [
  ['appTitle'],
  ['nav.landmarkLabel'],
  ['nav.ledgerAccounts'],
  ['nav.vatCodes'],
  ['nav.exchangeRates'],
  ['nav.loading'],
  ['entity.welld_ch'],
  ['entity.welld_it'],
  ['entity.label'],
  ['entity.showing', ['«entity»']],
  ['entity.lost', ['«was»', '«now»']],
  ['common.dismiss'],
  ['common.retry'],
  ['common.cancel'],
  ['common.close'],
  ['common.permissionDenied.heading'],
  ['common.permissionDenied.body'],
  ['common.authUnavailable.heading'],
  ['common.authUnavailable.body'],
  ['common.forbidden'],
  ['common.genericError'],
  ['common.accessChanged'],
  ['common.readOnly', ['«what»']],
  ['common.notFound.heading'],
  ['common.notFound.body'],
  ['common.notFound.back'],
  ['status.active'],
  ['status.inactive'],
  ['accounts.title', ['«entity»']],
  ['accounts.description', ['«entity»']],
  ['accounts.caption', ['«entity»']],
  ['accounts.loading'],
  ['accounts.loadError'],
  ['accounts.empty.title', ['«entity»']],
  ['accounts.empty.bodyManage'],
  ['accounts.empty.bodyRead'],
  ['accounts.columns.number'],
  ['accounts.columns.name'],
  ['accounts.columns.status'],
  ['accounts.columns.actions'],
  ['accounts.add'],
  ['accounts.addDialog.title', ['«entity»']],
  ['accounts.addDialog.description'],
  ['accounts.addDialog.number'],
  ['accounts.addDialog.numberHint'],
  ['accounts.addDialog.name'],
  ['accounts.addDialog.busy'],
  ['accounts.errors.numberEmpty'],
  ['accounts.errors.numberFormat'],
  ['accounts.errors.numberTooLong'],
  ['accounts.errors.nameEmpty'],
  ['accounts.errors.nameTooLong'],
  ['accounts.errors.duplicate', ['«number»', '«entity»']],
  ['accounts.errors.duplicateInactive', ['«number»']],
  ['accounts.errors.alreadyActive', ['«number»']],
  ['accounts.errors.alreadyInactive', ['«number»']],
  ['accounts.added', ['«number»']],
  ['accounts.deactivated', ['«number»']],
  ['accounts.reactivated', ['«number»']],
  ['accounts.deactivate'],
  ['accounts.reactivate'],
  ['accounts.deactivateLabel', ['«number»']],
  ['accounts.reactivateLabel', ['«number»']],
  ['accounts.deactivateDialog.title', ['«number»']],
  ['accounts.deactivateDialog.body'],
  ['accounts.deactivateDialog.confirm'],
  ['accounts.deactivateDialog.busy'],
  ['vatCodes.title', ['«entity»']],
  ['vatCodes.description', ['«entity»']],
  ['vatCodes.caption', ['«entity»']],
  ['vatCodes.loading'],
  ['vatCodes.loadError'],
  ['vatCodes.empty.title', ['«entity»']],
  ['vatCodes.empty.bodyManage'],
  ['vatCodes.empty.bodyRead'],
  ['vatCodes.columns.code'],
  ['vatCodes.columns.label'],
  ['vatCodes.columns.rate'],
  ['vatCodes.add'],
  ['vatCodes.addDialog.title', ['«entity»']],
  ['vatCodes.addDialog.description'],
  ['vatCodes.addDialog.code'],
  ['vatCodes.addDialog.codeHint'],
  ['vatCodes.addDialog.label'],
  ['vatCodes.addDialog.rate'],
  ['vatCodes.addDialog.rateHint'],
  ['vatCodes.addDialog.busy'],
  ['vatCodes.errors.codeEmpty'],
  ['vatCodes.errors.codeFormat'],
  ['vatCodes.errors.codeTooLong'],
  ['vatCodes.errors.labelEmpty'],
  ['vatCodes.errors.labelTooLong'],
  ['vatCodes.errors.rateInvalid'],
  ['vatCodes.errors.duplicate', ['«code»', '«entity»']],
  ['vatCodes.errors.duplicateInactive', ['«code»']],
  ['vatCodes.errors.alreadyActive', ['«code»']],
  ['vatCodes.errors.alreadyInactive', ['«code»']],
  ['vatCodes.added', ['«code»']],
  ['vatCodes.deactivated', ['«code»']],
  ['vatCodes.reactivated', ['«code»']],
  ['vatCodes.deactivate'],
  ['vatCodes.reactivate'],
  ['vatCodes.deactivateLabel', ['«code»']],
  ['vatCodes.reactivateLabel', ['«code»']],
  ['vatCodes.deactivateDialog.title', ['«code»']],
  ['vatCodes.deactivateDialog.body'],
  ['vatCodes.deactivateDialog.confirm'],
  ['vatCodes.deactivateDialog.busy'],
  ['fx.title', ['«entity»']],
  ['fx.caption', ['«entity»']],
  ['fx.description', ['«own»']],
  ['fx.noSource.title', ['«entity»']],
  ['fx.noSource.body'],
  ['fx.source.term'],
  ['fx.source.bazg'],
  ['fx.loading'],
  ['fx.loadError'],
  ['fx.empty.title'],
  ['fx.empty.body'],
  ['fx.columns.month'],
  ['fx.origin.fetched'],
  ['fx.origin.corrected'],
  ['fx.origin.missing'],
  ['fx.correct'],
  ['fx.correctLabel', ['«currency»', '«month»']],
  ['fx.cellLabel', ['«currency»', '«month»', '«rate»', '«origin»']],
  ['fx.cellMissingLabel', ['«currency»', '«month»']],
  ['fx.fetchNow'],
  ['fx.fetching'],
  ['fx.checking'],
  ['fx.fetchedOk', [7]],
  ['fx.nothingNew'],
  ['fx.notFetchable', ['«month»']],
  ['fx.throttled'],
  ['fx.deferred', [7]],
  ['fx.disabled'],
  ['fx.disabledReader'],
  ['fx.fetchError'],
  ['fx.lastFetch.term'],
  ['fx.lastFetch.never'],
  ['fx.lastFetch.ok', ['«at»']],
  ['fx.lastFetch.failed', ['«at»']],
  ['fx.lastFetch.disabled', ['«at»']],
  ['fx.lastFetch.throttled', ['«at»']],
  ['fx.lastFetch.notFetchable', ['«at»']],
  ['fx.lastFetch.failedTitle'],
  ['fx.lastFetch.failedBody', ['«at»', '«reason»']],
  ['fx.reason.timeout'],
  ['fx.reason.http'],
  ['fx.reason.parse'],
  ['fx.reason.monthMismatch'],
  ['fx.reason.currencyMissing'],
  ['fx.reason.unknown'],
  ['fx.deepLink.notListed', ['«month»']],
  ['fx.correction.title', ['«currency»', '«month»']],
  ['fx.correction.description'],
  ['fx.correction.rate', ['«currency»', '«own»']],
  ['fx.correction.hint'],
  ['fx.correction.inEffect', ['«rate»', '«origin»']],
  ['fx.correction.rateInvalid'],
  ['fx.correction.monthNotCompleted'],
  ['fx.correction.notConvertible'],
  ['fx.correction.save'],
  ['fx.correction.busy'],
  ['fx.correction.saved', ['«currency»', '«month»']],
]

/** Keys the design table does not name, each with the reason it exists. Nothing else may be added without being listed. */
const EXTRA_KEYS: Readonly<Record<string, string>> = {
  'common.readOnlyWhat.accounts': 'the `what` of `common.readOnly`, which the table gives as prose',
  'common.readOnlyWhat.vatCodes': 'the `what` of `common.readOnly`, which the table gives as prose',
  'common.readOnlyWhat.rates': 'the `what` of `common.readOnly`, which the table gives as prose',
  'common.loadErrorTitle': 'the title of the failure ladder’s third rung (AS1, UX-15)',
  'common.networkError': 'the failure ladder’s sentence for a failure with no Problem body',
  'common.unknownError': 'the failure ladder’s sentence for a Problem with no detail',
  'vatCodes.columns.status': 'the VAT list has the same Status column as the accounts list',
  'vatCodes.columns.actions': 'the VAT list has the same Actions column as the accounts list',
}

/**
 * Identical in both languages on purpose (design § Copy keys): the entities are proper names, and a rate cell's group
 * name is the same pattern in both (its currency, month, rate and origin are the translated parts).
 */
const SAME_IN_BOTH = new Set(['entity.welld_ch', 'entity.welld_it', 'fx.cellLabel'])

const enLeaves = leaves(en)
const itLeaves = leaves(italian)

const call = (leaf: Leaf, args: Args): string =>
  typeof leaf === 'function' ? (leaf as (...a: (string | number)[]) => string)(...args) : leaf

describe('strings (AC-8.4)', () => {
  it('the Italian catalog has every English key, with the same shape', () => {
    expect(catalogGaps(en, italian)).toEqual([])
  })

  it('every key named in design § Copy keys for accounting-ui exists, in both languages', () => {
    for (const [path] of DESIGN_KEYS) {
      expect(enLeaves, `en.${path}`).toHaveProperty([path])
      expect(itLeaves, `it.${path}`).toHaveProperty([path])
    }
  })

  it('has no key that is neither in the design table nor a listed extra', () => {
    const known = new Set([...DESIGN_KEYS.map(([path]) => path), ...Object.keys(EXTRA_KEYS)])
    expect(Object.keys(enLeaves).filter((path) => !known.has(path))).toEqual([])
    expect(Object.keys(enLeaves).length).toBe(known.size)
    expect(DESIGN_KEYS.length).toBe(new Set(DESIGN_KEYS.map(([path]) => path)).size)
  })

  it('a sentence with a value is a function, and puts every value in the sentence, in both languages', () => {
    for (const key of DESIGN_KEYS) {
      const [path] = key
      const args: Args = key[1] ?? []
      for (const [name, catalog] of [
        ['en', enLeaves],
        ['it', itLeaves],
      ] as const) {
        const leaf = catalog[path]
        expect(typeof leaf, `${name}.${path}`).toBe(args.length > 0 ? 'function' : 'string')
        const text = call(leaf, args)
        expect(text.length, `${name}.${path}`).toBeGreaterThan(0)
        for (const arg of args) expect(text, `${name}.${path}`).toContain(String(arg))
      }
    }
  })

  it('every leaf is non-empty text (a function answers non-empty text for its arguments)', () => {
    for (const [name, catalog] of [
      ['en', enLeaves],
      ['it', itLeaves],
    ] as const) {
      for (const [path, leaf] of Object.entries(catalog)) {
        const args: Args = DESIGN_KEYS.find(([key]) => key === path)?.[1] ?? []
        expect(call(leaf, args).trim().length, `${name}.${path}`).toBeGreaterThan(0)
      }
    }
  })

  it('the Italian catalog is a translation, not a copy of the English (but for the proper names)', () => {
    for (const [path, leaf] of Object.entries(enLeaves)) {
      if (SAME_IN_BOTH.has(path)) continue
      const args: Args = DESIGN_KEYS.find(([key]) => key === path)?.[1] ?? ['«x»', '«y»', '«z»', '«w»']
      expect(call(itLeaves[path]!, args), path).not.toBe(call(leaf, args))
    }
  })

  it('names the tool and the entities as the design fixes them', () => {
    expect(en.appTitle).toBe('Accounting')
    expect(italian.appTitle).toBe('Contabilità')
    expect(en.nav.exchangeRates).toBe('Exchange rates')
    expect(italian.nav.exchangeRates).toBe('Tassi di cambio')
    expect([en.entity.welld_ch, en.entity.welld_it]).toEqual(['WellD CH', 'WellD Italia'])
    expect([italian.entity.welld_ch, italian.entity.welld_it]).toEqual(['WellD CH', 'WellD Italia'])
  })

  it('writes the plurals inside the function: 1 is singular, anything else is plural', () => {
    expect(en.fx.fetchedOk(1)).toBe('Recorded the rates for 1 month.')
    expect(en.fx.fetchedOk(3)).toBe('Recorded the rates for 3 months.')
    expect(italian.fx.fetchedOk(1)).toBe('Registrati i tassi di 1 mese.')
    expect(italian.fx.fetchedOk(3)).toBe('Registrati i tassi di 3 mesi.')
    expect(en.fx.deferred(1)).toBe('1 more month is still to fetch. Fetch again to continue.')
    expect(en.fx.deferred(5)).toBe('5 more months are still to fetch. Fetch again to continue.')
    expect(italian.fx.deferred(1)).toBe('Resta ancora 1 mese da recuperare. Recuperare di nuovo per continuare.')
    expect(italian.fx.deferred(5)).toBe('Restano ancora 5 mesi da recuperare. Recuperare di nuovo per continuare.')
  })

  it('carries the design’s load-bearing sentences word for word (UX-3, UX-4, UX-7, UX-10, UX-11, UX-13)', () => {
    expect(en.accounts.title('WellD CH')).toBe('Ledger accounts — WellD CH')
    expect(italian.accounts.title('WellD Italia')).toBe('Conti contabili — WellD Italia')
    expect(en.accounts.addDialog.title('WellD CH')).toBe('Add ledger account — WellD CH')
    expect(en.common.readOnly(en.common.readOnlyWhat.accounts)).toBe(
      'You can view this list. Accounting managers add and deactivate accounts.',
    )
    expect(italian.common.readOnly(italian.common.readOnlyWhat.vatCodes)).toBe(
      'È possibile vedere questo elenco. Spetta ai responsabili della contabilità aggiungere e disattivare i codici IVA.',
    )
    expect(en.accounts.deactivateDialog.body).toBe(
      'No module can choose it any more. What was already booked with it keeps it. A module that uses it as a default needs another one. You can reactivate it at any time.',
    )
    expect(en.vatCodes.deactivateDialog.body).toContain('Its rate never changes.')
    expect(en.fx.correction.description).toBe(
      'Anything booked from now on uses this rate. What was already booked with the previous rate keeps it. The previous value is kept in the audit trail.',
    )
    expect(en.fx.correction.hint).toBe('Greater than 0 and below 1000, up to 6 decimals.')
    expect(en.fx.deepLink.notListed('2026-11')).toBe(
      '2026-11 is not in the list. A month is listed once it has ended; its rate is published a few days later.',
    )
    // UX-13: two different "nothing" states.
    expect(en.accounts.empty.title('WellD Italia')).toBe('Nothing entered yet for WellD Italia')
    expect(en.fx.noSource.title('WellD Italia')).toBe('No official source for WellD Italia yet')
    expect(en.fx.noSource.title('WellD Italia')).not.toBe(en.fx.empty.title)
    // UX-10: the 20261118 sentence about re-exporting is gone.
    expect(JSON.stringify(leaves(en))).not.toContain('exported again')
  })

  it('tests run with an English browser, so the selected catalog is English', () => {
    expect(strings).toBe(en)
  })
})

/**
 * @vitest-environment jsdom
 *
 * The accessibility sweep of the Legal entities page (T40, specs/20261117-legal-entities, design "Accessibility" and
 * "Targets for the suite's automated check"; AC-8.1, AC-8.2, AC-9.6): the REAL page, panel, form, table, version view
 * and dialogs, driven to every state the design lists for S1 to S8 and S12, each swept by axe-core with the WCAG 2.1
 * A and AA rule tags, once in the light and once in the dark theme (`<html data-theme>`), plus the checks axe
 * cannot make: every form control has a visible label, every button, link and tab a name that holds its visible
 * words (WCAG 2.5.3), and Italian once (`<html lang="it">`, no English left over).
 *
 * What jsdom cannot judge, and where it is judged instead:
 *   - Colour contrast. jsdom computes no layout or cascade from `tokens.css`, so axe's `color-contrast` rule is off
 *     (as in every admin-ui test). Both themes' text tokens are measured here straight from `tokens.css`
 *     ("the tokens the page uses"); the rendered page's contrast is left to a real browser (T45 QE, T68).
 *   - Reflow at 320 px (FU-3). No layout either: the classes that make the entity strip and the section nav wrap are
 *     asserted, together with the rules of `tokens.css` behind them. That the page really has no horizontal scroll
 *     at 320 px is a real-browser check left to T45 and T68 (e2e), and is NOT claimed here.
 * Dark and light therefore differ in this suite by the attribute only, which is what `tokens.css` keys on.
 */
import axe from 'axe-core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import * as sectionNav from '../components/SectionNav'
import type { SectionNavProps } from '../components/SectionNav'
import * as adminApi from '../lib/adminApi'
import * as legalEntitiesApi from '../lib/legalEntitiesApi'
import type { ProtectedChange, VersionPage } from '../lib/legalEntitiesApi'
import type { LegalEntity, LegalEntityId, LegalEntityVersion, VersionListItem } from '../lib/legalEntityModel'
import * as fixtures from './LegalEntitiesPage.fixtures'

vi.mock('../lib/legalEntitiesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/legalEntitiesApi')>()
  return {
    ...original,
    getManageable: vi.fn(),
    listLegalEntities: vi.fn(),
    getLegalEntity: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    saveLegalEntity: vi.fn(),
    checkLegalEntity: vi.fn(),
    restoreVersion: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// The modules a scenario runs against: this file's own (English), or a fresh set loaded after `<html lang="it">`
// (the language is read when the catalog module loads, hence the late imports for Italian).
// ---------------------------------------------------------------------------

type Ctx = {
  api: typeof legalEntitiesApi
  admin: typeof adminApi
  fx: typeof fixtures
  nav: typeof import('../components/SectionNav')
  catalogs: { en: Record<string, unknown>; it: Record<string, unknown> }
  italian: boolean
}

const english: Ctx = {
  api: legalEntitiesApi,
  admin: adminApi,
  fx: fixtures,
  nav: sectionNav,
  catalogs: { en: {}, it: {} },
  italian: false,
}
let ctx: Ctx = english

const API_FUNCTIONS = [
  'getManageable',
  'listLegalEntities',
  'getLegalEntity',
  'listVersions',
  'getVersion',
  'saveLegalEntity',
  'checkLegalEntity',
  'restoreVersion',
] as const

const mocked = <K extends (typeof API_FUNCTIONS)[number]>(name: K) => vi.mocked(ctx.api[name])

beforeEach(() => {
  for (const name of API_FUNCTIONS) mocked(name).mockReset()
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const listItem = (over: Partial<VersionListItem> & Pick<VersionListItem, 'version'>): VersionListItem => ({
  action: 'save',
  restoredFrom: null,
  createdBy: { id: 'u1', name: 'Anna Rossi' },
  createdAt: '2026-11-14T10:12:00.000Z',
  changedFields: [],
  restorable: true,
  ...over,
})

/** WellD CH's history: 5 is current; 4 differs from it in the contacts only; 3 in the VAT number and IBAN; 2 is incomplete. */
const LIST: VersionListItem[] = [
  listItem({ version: 5, changedFields: ['address.en'] }),
  listItem({ version: 4, createdAt: '2026-11-12T09:30:00.000Z', changedFields: ['contacts.it'] }),
  listItem({
    version: 3,
    action: 'restore',
    restoredFrom: 1,
    createdAt: '2026-11-10T09:01:00.000Z',
    changedFields: ['iban', 'vatNumber'],
  }),
  listItem({
    version: 2,
    createdBy: { id: 'u2', name: 'Marco Bianchi' },
    createdAt: '2026-11-02T15:20:00.000Z',
    changedFields: ['vatNumber'],
    restorable: false,
  }),
  listItem({
    version: 1,
    action: 'import',
    createdBy: null,
    createdAt: '2026-10-17T08:00:00.000Z',
    changedFields: ['legalName', 'address.it', 'address.en', 'vatNumber', 'iban'],
  }),
]

const page = (items: VersionListItem[], nextBefore: number | null = null): VersionPage => ({ items, nextBefore })

const chCurrent = (c: Ctx) =>
  c.fx.entityFixture('welld_ch', {
    version: 5,
    vatNumber: 'CHE-123.456.789',
    iban: 'CH9300762011623852957',
    ibanPrint: 'CH93 0076 2011 6238 5295 7',
  })

const versionAnswer = (c: Ctx, entity: LegalEntityId, n: number): LegalEntityVersion => {
  const meta = LIST.find((item) => item.version === n) ?? LIST[0]!
  const base = entity === 'welld_ch' ? chCurrent(c) : c.fx.entityFixture(entity)
  const own: Partial<LegalEntity> =
    entity !== 'welld_ch' || n === 5
      ? {}
      : n === 4
        ? { contacts: { it: 'Tel. +41 91 000 00 00', en: '' } }
        : n === 2
          ? { vatNumber: '', complete: false, missing: ['vatNumber'] }
          : { vatNumber: 'CHE-000.000.000', iban: 'CH5604835012345678009', ibanPrint: 'CH56 0483 5012 3456 7800 9' }
  return {
    ...base,
    ...own,
    version: entity === 'welld_ch' ? n : base.version,
    action: meta.action,
    restoredFrom: meta.restoredFrom,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
  }
}

type Arrange = {
  manageable?: LegalEntityId[]
  it?: LegalEntity
  ch?: LegalEntity
  list?: VersionPage
}

/** What the API answers by default; a scenario overrides what it is about after this. */
function arrange(c: Ctx, o: Arrange = {}) {
  const it = o.it ?? c.fx.entityFixture('welld_it')
  const ch = o.ch ?? chCurrent(c)
  mocked('getManageable').mockResolvedValue(o.manageable ?? ['welld_it', 'welld_ch'])
  mocked('listLegalEntities').mockResolvedValue([it, ch])
  mocked('getLegalEntity').mockImplementation(async (id) => (id === 'welld_it' ? it : ch))
  mocked('getVersion').mockImplementation(async (entity, n) => versionAnswer(c, entity, n))
  mocked('listVersions').mockResolvedValue(o.list ?? page(LIST))
  mocked('checkLegalEntity').mockResolvedValue({
    baseVersion: ch.version,
    outcome: 'change',
    changedFields: [],
    protectedChanges: [],
  })
}

const problemError = (
  c: Ctx,
  status: number,
  code: string,
  extras: ConstructorParameters<typeof legalEntitiesApi.LegalEntityApiError>[1] = {},
) => new c.api.LegalEntityApiError({ type: 'about:blank', title: code, status, code }, extras)

const IBAN_CHANGE: ProtectedChange = {
  field: 'iban',
  before: 'CH93 0076 2011 6238 5295 7',
  after: 'CH56 0483 5012 3456 7800 9',
}
const VAT_CHANGE: ProtectedChange = { field: 'vatNumber', before: 'CHE-123.456.789', after: '' }

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const THEMES = ['light', 'dark'] as const

const RULE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/** The accessible name of an element, as far as the page's own markup gives one (jsdom has no `computeAccessibleName`). */
const visibleText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll('[aria-hidden="true"], svg, [hidden]').forEach((node) => node.remove())
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const isHidden = (el: Element) => el.closest('[hidden], [aria-hidden="true"]') !== null

/**
 * "Every control has a visible label" (WCAG 1.3.1, 2.4.6, 3.3.2), which axe's `label` rule only half checks:
 *  - every input, select and textarea has a `<label>` with words you can see (not a placeholder, not `aria-label`);
 *  - every button, tab and link has a name; when it shows words, its name starts with or holds them (2.5.3, label in
 *    name). An icon-only control (the dialog's close) must carry an `aria-label`.
 */
function labelProblems(root: ParentNode): string[] {
  const problems: string[] = []
  root.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]), select, textarea').forEach((el) => {
    if (isHidden(el)) return
    const labels = Array.from(el.labels ?? [])
    const words = labels.map((label) => visibleText(label).replace(/[*]/g, '').trim()).filter(Boolean)
    if (words.length === 0) problems.push(`no visible label: ${el.outerHTML.slice(0, 90)}`)
  })
  root.querySelectorAll('button, [role="tab"], a[href]').forEach((el) => {
    if (isHidden(el)) return
    const shown = visibleText(el)
    const label = el.getAttribute('aria-label')
    const labelledBy = el.getAttribute('aria-labelledby')
    const named = label ?? (labelledBy ? visibleText(document.getElementById(labelledBy) ?? el) : shown)
    if (!named.trim()) problems.push(`no name: ${el.outerHTML.slice(0, 90)}`)
    else if (shown !== '' && label !== null && !label.toLowerCase().includes(shown.toLowerCase())) {
      problems.push(`name "${label}" does not hold the visible "${shown}"`)
    }
  })
  return problems
}

const flatten = (value: unknown, path = ''): [string, unknown][] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, child]) => flatten(child, path === '' ? key : `${path}.${key}`))
    : [[path, value]]

/** Sentinels a catalog function is called with: what stays around them is the catalog's own wording. */
const SENTINEL_NUMBER = 7777777
const SENTINEL_TEXT = '§§'

/** The English words of the catalog that the Italian one says differently, as fragments of at least five characters. */
function englishFragments(c: Ctx): string[] {
  const en = new Map(flatten(c.catalogs.en))
  const it = new Map(flatten(c.catalogs.it))
  const fragments = (value: unknown): string[] => {
    const text =
      typeof value === 'function'
        ? String((value as (...args: unknown[]) => unknown)(SENTINEL_NUMBER, SENTINEL_TEXT, SENTINEL_TEXT, SENTINEL_NUMBER))
        : typeof value === 'string'
          ? value
          : ''
    return text
      .split(new RegExp(`${SENTINEL_NUMBER}|${SENTINEL_TEXT}`))
      .map((part) => part.trim())
      .filter((part) => part.length >= 5)
  }
  const found = new Set<string>()
  for (const [path, value] of en) {
    const italian = new Set(fragments(it.get(path)))
    for (const fragment of fragments(value)) if (!italian.has(fragment)) found.add(fragment)
  }
  return [...found]
}

/** What the page shows and says: its text and its accessible-name attributes. */
const spoken = (root: Element): string => {
  // The test harness's own "Roles" link (a stand-in for the shell) is not the page.
  const copy = root.cloneNode(true) as Element
  copy.querySelectorAll('[data-testid="to-roles"]').forEach((node) => node.remove())
  const attributes = Array.from(copy.querySelectorAll('[aria-label], [title]')).flatMap((el) => [
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
  ])
  return `${copy.textContent ?? ''} ${attributes.join(' ')}`
}

/** Does `text` hold `phrase` as whole words ("Version" is not in "Versione")? */
const holds = (text: string, phrase: string): boolean =>
  new RegExp(`(^|[^\\p{L}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(text)

const ENGLISH_WORDS = [
  'Close',
  'Dismiss',
  'Cancel',
  'Loading',
  'Retry',
  'Save',
  'Restore',
  'Back',
  'Version',
  'Details',
  'History',
  'Complete',
  'Incomplete',
  'Address',
  'Contacts',
  'Nothing',
]

/** axe on the page in both themes, then the label checks, then (in Italian) what English is left. */
async function sweep(label: string) {
  const found: string[] = []
  for (const theme of THEMES) {
    document.documentElement.setAttribute('data-theme', theme)
    const results = await axe.run(document.body, {
      runOnly: { type: 'tag', values: RULE_TAGS },
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    for (const v of results.violations) found.push(`[${theme}] ${v.id}: ${v.nodes[0]?.target.join(' ')} (${v.help})`)
  }
  expect(found, `axe on ${label}`).toEqual([])
  expect(labelProblems(document.body), `labels on ${label}`).toEqual([])
  if (ctx.italian) {
    expect(document.documentElement.getAttribute('lang'), 'lang').toBe('it')
    const text = spoken(document.body)
    const leaks = englishFragments(ctx).filter((fragment) => holds(text, fragment))
    expect(leaks, `English left on ${label}`).toEqual([])
    const words = ENGLISH_WORDS.filter((word) => holds(text, word))
    expect(words, `English words left on ${label}`).toEqual([])
  }
}

// ---------------------------------------------------------------------------
// Driving the page
// ---------------------------------------------------------------------------

const CH = '/legal-entities?entity=welld_ch'
const HISTORY = `${CH}&view=history`

const show = (path: string) => {
  const view = ctx.fx.renderPage(path)
  return { user: userEvent.setup(), ...view }
}
const byId = (id: string) => screen.getByTestId(id) as HTMLElement
const typeInto = async (user: ReturnType<typeof userEvent.setup>, id: string, text: string) => {
  await user.click(byId(id))
  await user.type(byId(id), text)
}
const dirty = async (user: ReturnType<typeof userEvent.setup>) => typeInto(user, 'admin-legal-input-contacts.en', ' x')
const form = () => screen.findByTestId('admin-legal-form')
const table = () => screen.findByTestId('admin-legal-history-table')
/** A control a press cannot reach the handler of: `disabled` (the library's busy Confirm) or `aria-disabled`. */
const inert = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
const never = <T,>() => new Promise<T>(() => undefined)

/** A 5-line Italian address, a 121-character English line and a missing VAT number: what the move leaves (S3, D3). */
const movedIncomplete = (c: Ctx) =>
  c.fx.entityFixture('welld_ch', {
    version: 1,
    vatNumber: '',
    complete: false,
    missing: ['vatNumber'],
    address: {
      it: ['Via Esempio 12', 'Palazzo', 'Interno 4', '6900 Lugano', 'Svizzera'],
      en: ['Via Esempio 12', 'x'.repeat(121)],
    },
    invalid: [
      { field: 'address.it', reason: 'too_many_lines', limit: 4 },
      { field: 'address.en', line: 1, reason: 'too_long', limit: 120 },
    ],
  })

const conflictedSave = async (c: Ctx, user: ReturnType<typeof userEvent.setup>, newer: Partial<LegalEntity> = {}) => {
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 409, 'version_conflict', { currentVersion: 6 }))
  mocked('getVersion').mockImplementation(async (entity, n) =>
    n === 6
      ? { ...versionAnswer(c, entity, 5), ...newer, version: 6, createdBy: { id: 'u9', name: 'Marco Bianchi' } }
      : versionAnswer(c, entity, n),
  )
  await dirty(user)
  await user.click(byId('admin-legal-save'))
}

type Scenario = (c: Ctx) => Promise<void>
const scenarios: Record<string, Scenario> = {}
const add = (name: string, run: Scenario) => {
  scenarios[name] = run
}

// S1 — the entity strip --------------------------------------------------------------------------------------------

add('S1 loaded, WellD IT selected, Details', async (c) => {
  arrange(c)
  show('/legal-entities?entity=welld_it')
  await form()
  await sweep('S1 IT')
})

add('S1 loaded, WellD CH selected, Details', async (c) => {
  arrange(c)
  show(CH)
  await form()
  await sweep('S1 CH')
})

add('S1 the strip with Incomplete, Needs correction and Unsaved changes', async (c) => {
  arrange(c, {
    it: c.fx.entityFixture('welld_it', { complete: false, missing: ['vatNumber'], vatNumber: '' }),
    ch: c.fx.entityFixture('welld_ch', { invalid: [{ field: 'legalName', reason: 'too_long', limit: 200 }] }),
  })
  const { user } = show('/legal-entities?entity=welld_it')
  await form()
  await dirty(user)
  const tabs = within(screen.getByRole('tablist', { name: c.italian ? 'Società del gruppo' : 'Legal entities' }))
  expect(tabs.getAllByRole('tab')).toHaveLength(2)
  await sweep('S1 badges A')
})

add('S1 the strip with Complete, Read-only and Not moved yet', async (c) => {
  arrange(c, { manageable: ['welld_ch'], ch: c.fx.notMoved('welld_ch') })
  show('/legal-entities?entity=welld_ch')
  await screen.findByTestId('admin-legal-entity-not-moved')
  await sweep('S1 badges B (not moved)')
})

add('S1 loading', async () => {
  mocked('getManageable').mockResolvedValue(['welld_it', 'welld_ch'])
  mocked('listLegalEntities').mockReturnValue(never())
  show('/legal-entities')
  await screen.findByTestId('skeleton-list-rows')
  await sweep('S1 loading')
})

add('S1 failed to load', async () => {
  mocked('getManageable').mockResolvedValue(['welld_it', 'welld_ch'])
  mocked('listLegalEntities').mockRejectedValue(new Error('down'))
  show('/legal-entities')
  await screen.findByTestId('error-banner')
  await sweep('S1 failed')
})

add('S1 permission denied', async (c) => {
  mocked('getManageable').mockResolvedValue([])
  mocked('listLegalEntities').mockRejectedValue(
    new c.admin.ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
  )
  show('/legal-entities')
  await screen.findByTestId('permission-denied')
  await sweep('S1 denied')
})

// S2 / S3 — the form -------------------------------------------------------------------------------------------------

add('S2 clean', async (c) => {
  arrange(c)
  show(CH)
  await form()
  await sweep('S2 clean')
})

add('S2 dirty', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  await dirty(user)
  await sweep('S2 dirty')
})

add('S2 refused, with the summary and a refused address line', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockRejectedValue(
    problemError(c, 422, 'invalid_legal_entity', {
      problems: [
        { field: 'iban', reason: 'iban_check_digits' },
        { field: 'address.en', line: 1, reason: 'too_long', limit: 120 },
        { field: 'legalName', reason: 'required' },
      ],
    }),
  )
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-summary')
  await sweep('S2 refused')
})

add('S2 saved', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockResolvedValue({
    version: 6,
    created: true,
    entity: c.fx.entityFixture('welld_ch', { version: 6 }),
  })
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-saved')
  await sweep('S2 saved')
})

add('S2 nothing changed', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockResolvedValue({ version: 5, created: false, entity: chCurrent(c) })
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-noop')
  await sweep('S2 no-op')
})

add('S2 the 429 banner', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 429, 'too_many_requests', { retryAfterSeconds: 150 }))
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-too-many')
  await sweep('S2 429')
})

add('S2 the 429 banner without a wait', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 429, 'too_many_requests'))
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-too-many')
  await sweep('S2 429 no wait')
})

add('S2 could not save', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 500, 'internal'))
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-save-failed')
  await sweep('S2 failed')
})

add('S2 the grant lost (403)', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 403, 'forbidden'))
  const { user } = show(CH)
  await form()
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-entity-lost')
  await sweep('S2 lost')
})

add('S2 conflict: the banner', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  await conflictedSave(c, user, { legalName: 'wellD AG (renamed)' })
  await screen.findByTestId('admin-legal-reapply')
  await sweep('S2 conflict')
})

add('S2 conflict: the banner without a list of changed values', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  await conflictedSave(c, user)
  await screen.findByTestId('admin-legal-reapply')
  await sweep('S2 conflict, no list')
})

add('S2 conflict: reading the newer version', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 409, 'version_conflict', { currentVersion: 6 }))
  mocked('getVersion').mockImplementation((entity, n) =>
    n === 6 ? never() : Promise.resolve(versionAnswer(c, entity, n)),
  )
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-conflict')
  await sweep('S2 conflict reading')
})

add('S2 conflict: the newer version could not be read', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 409, 'version_conflict', { currentVersion: 6 }))
  mocked('getVersion').mockImplementation(async (entity, n) => {
    if (n === 6) throw new Error('down')
    return versionAnswer(c, entity, n)
  })
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-conflict')
  await waitFor(() => expect(within(byId('admin-legal-conflict')).getByRole('button')).toBeTruthy())
  await sweep('S2 conflict failed read')
})

add('S2 after Reapply: a flagged address and a taken value', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 409, 'version_conflict', { currentVersion: 6 }))
  mocked('getVersion').mockImplementation(async (entity, n) =>
    n === 6
      ? {
          ...versionAnswer(c, entity, 5),
          version: 6,
          createdBy: { id: 'u9', name: 'Marco Bianchi' },
          address: { it: ['Via Esempio 12', '6900 Lugano', 'Svizzera'], en: ['Via Esempio 14', '6900 Lugano', 'Italy'] },
          iban: 'CH5604835012345678009',
          ibanPrint: 'CH56 0483 5012 3456 7800 9',
        }
      : versionAnswer(c, entity, n),
  )
  await typeInto(user, 'admin-legal-address-en-0', ' bis')
  await user.click(byId('admin-legal-save'))
  await user.click(await screen.findByTestId('admin-legal-reapply'))
  await screen.findByTestId('admin-legal-applied')
  await sweep('S2 reapplied')
})

add('S2 after Reapply with nothing to review', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  mocked('saveLegalEntity').mockRejectedValue(problemError(c, 409, 'version_conflict', { currentVersion: 6 }))
  mocked('getVersion').mockImplementation(async (entity, n) =>
    n === 6
      ? {
          ...versionAnswer(c, entity, 5),
          version: 6,
          createdBy: { id: 'u9', name: 'Marco Bianchi' },
          iban: 'CH5604835012345678009',
          ibanPrint: 'CH56 0483 5012 3456 7800 9',
        }
      : versionAnswer(c, entity, n),
  )
  await dirty(user)
  await user.click(byId('admin-legal-save'))
  await user.click(await screen.findByTestId('admin-legal-reapply'))
  await screen.findByTestId('admin-legal-applied')
  await sweep('S2 reapplied clean')
})

add('S3 an entity moved incomplete, with a 5-line address and a line over 120', async (c) => {
  arrange(c, { ch: movedIncomplete(c) })
  show(CH)
  await form()
  expect(screen.getByTestId('admin-legal-address-it-note')).toBeTruthy()
  expect(screen.getByTestId('admin-legal-entity-incomplete')).toBeTruthy()
  await sweep('S3 moved')
})

add('S3 an entity that only needs correcting', async (c) => {
  arrange(c, { ch: c.fx.entityFixture('welld_ch', { invalid: [{ field: 'iban', reason: 'iban_check_digits' }] }) })
  show(CH)
  await form()
  await screen.findByTestId('admin-legal-entity-to-correct')
  await sweep('S3 to correct')
})

// S4 — read-only -----------------------------------------------------------------------------------------------------

add('S4 read-only details', async (c) => {
  arrange(c, { manageable: ['welld_it'] })
  show(CH)
  await screen.findByTestId('admin-legal-entity-facts')
  await sweep('S4 read-only')
})

add('S4 read-only details of an incomplete entity', async (c) => {
  arrange(c, { manageable: ['welld_it'], ch: movedIncomplete(c) })
  show(CH)
  await screen.findByTestId('admin-legal-entity-facts')
  await sweep('S4 read-only, incomplete')
})

// S5 — the history ----------------------------------------------------------------------------------------------------

add('S5 history of a manager, with a version that cannot be restored', async (c) => {
  arrange(c)
  show(HISTORY)
  await table()
  await sweep('S5 manager')
})

add('S5 history of a read-only entity (Open only)', async (c) => {
  arrange(c, { manageable: ['welld_it'] })
  show(HISTORY)
  await table()
  await sweep('S5 read-only')
})

add('S5 empty history', async (c) => {
  arrange(c, { list: page([]) })
  show(HISTORY)
  await screen.findByTestId('admin-legal-entity-history-empty')
  await sweep('S5 empty')
})

add('S5 loading the history', async (c) => {
  arrange(c)
  mocked('listVersions').mockReturnValue(never())
  show(HISTORY)
  await screen.findByTestId('skeleton-list-rows')
  await sweep('S5 loading')
})

add('S5 the history could not be loaded', async (c) => {
  arrange(c)
  mocked('listVersions').mockRejectedValue(new Error('down'))
  show(HISTORY)
  await screen.findByTestId('error-banner')
  await sweep('S5 failed')
})

const firstPage = () => page(LIST.slice(0, 3), 2)
const secondPage = () => page(LIST.slice(3))
const paged = (c: Ctx, second: () => Promise<VersionPage>) => {
  arrange(c)
  mocked('listVersions').mockImplementation(async (_entity, query) => (query?.before === undefined ? firstPage() : second()))
}

add('S5 paging: older versions available', async (c) => {
  paged(c, async () => secondPage())
  show(HISTORY)
  await table()
  await screen.findByTestId('admin-legal-history-more')
  await sweep('S5 more')
})

add('S5 paging: loading older versions', async (c) => {
  paged(c, () => never())
  const { user } = show(HISTORY)
  await user.click(await screen.findByTestId('admin-legal-history-more'))
  await waitFor(() => expect(byId('admin-legal-history-more').getAttribute('aria-disabled')).toBe('true'))
  await sweep('S5 loading more')
})

add('S5 paging: older versions could not be loaded', async (c) => {
  paged(c, async () => {
    throw new Error('down')
  })
  const { user } = show(HISTORY)
  await user.click(await screen.findByTestId('admin-legal-history-more'))
  await waitFor(() => expect(within(byId('admin-legal-history-paging')).getByTestId('error-banner-retry')).toBeTruthy())
  await sweep('S5 more failed')
})

add('S5 paging: the last page', async (c) => {
  paged(c, async () => secondPage())
  const { user } = show(HISTORY)
  await user.click(await screen.findByTestId('admin-legal-history-more'))
  await waitFor(() => expect(screen.queryByTestId('admin-legal-history-more')).toBeNull())
  await sweep('S5 last page')
})

// S6 — one version ----------------------------------------------------------------------------------------------------

add('S6 a version that can be restored', async (c) => {
  arrange(c)
  show(`${HISTORY}&version=3`)
  await screen.findByTestId('admin-legal-version-banner')
  await sweep('S6 restorable')
})

add('S6 a version that cannot be restored', async (c) => {
  arrange(c)
  show(`${HISTORY}&version=2`)
  await screen.findByTestId('admin-legal-version-banner')
  await sweep('S6 blocked')
})

add('S6 the version in effect', async (c) => {
  arrange(c)
  show(`${HISTORY}&version=5`)
  await screen.findByTestId('admin-legal-version-banner')
  await sweep('S6 current')
})

add('S6 a version of a read-only entity', async (c) => {
  arrange(c, { manageable: ['welld_it'] })
  show(`${HISTORY}&version=3`)
  await screen.findByTestId('admin-legal-version-banner')
  await sweep('S6 read-only')
})

add('S6 a version that does not exist', async (c) => {
  arrange(c)
  mocked('getVersion').mockImplementation(async (entity, n) => {
    if (n === 9) throw problemError(c, 404, 'version_not_found')
    return versionAnswer(c, entity, n)
  })
  show(`${HISTORY}&version=9`)
  await screen.findByTestId('admin-legal-version-not-found')
  await sweep('S6 not found')
})

add('S6 a version that could not be loaded', async (c) => {
  arrange(c)
  mocked('getVersion').mockImplementation(async (entity, n) => {
    if (n === 3) throw new Error('down')
    return versionAnswer(c, entity, n)
  })
  show(`${HISTORY}&version=3`)
  await screen.findByTestId('error-banner')
  await sweep('S6 failed')
})

// S7 — the restore dialog ---------------------------------------------------------------------------------------------

const restoreOf = async (user: ReturnType<typeof userEvent.setup>, n: number) => {
  await table()
  await user.click(byId(`admin-legal-version-row-${n}-restore`))
  return screen.findByRole('alertdialog')
}

add('S7 restore without a protected detail', async (c) => {
  arrange(c)
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 4)
  await waitFor(() => expect(within(box).queryByTestId('admin-legal-restore-reading')).toBeNull())
  expect(within(box).queryByTestId('admin-legal-restore-protected')).toBeNull()
  await sweep('S7 plain')
})

add('S7 restore with the protected block', async (c) => {
  arrange(c)
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 3)
  await within(box).findByTestId('admin-legal-restore-protected')
  await sweep('S7 protected')
})

add('S7 restore from the version view', async (c) => {
  arrange(c)
  const { user } = show(`${HISTORY}&version=3`)
  await screen.findByTestId('admin-legal-version-banner')
  await user.click(screen.getByTestId('admin-legal-version-banner-restore'))
  const box = await screen.findByRole('alertdialog')
  await within(box).findByTestId('admin-legal-restore-protected')
  await sweep('S7 from S6')
})

add('S7 restore: loading the details', async (c) => {
  arrange(c)
  const { user } = show(HISTORY)
  await table()
  mocked('getVersion').mockImplementation((entity, n) =>
    n === 3 ? never() : Promise.resolve(versionAnswer(c, entity, n)),
  )
  await user.click(byId('admin-legal-version-row-3-restore'))
  const box = await screen.findByRole('alertdialog')
  expect(within(box).getByTestId('admin-legal-restore-confirm').getAttribute('aria-disabled')).toBe('true')
  await sweep('S7 loading details')
})

add('S7 restore: the details could not be read', async (c) => {
  arrange(c)
  const { user } = show(HISTORY)
  await table()
  mocked('getVersion').mockImplementation(async (entity, n) => {
    if (n === 3) throw new Error('down')
    return versionAnswer(c, entity, n)
  })
  await user.click(byId('admin-legal-version-row-3-restore'))
  await screen.findByTestId('admin-legal-restore-details-failed')
  await sweep('S7 details failed')
})

add('S7 restore: busy', async (c) => {
  arrange(c)
  mocked('restoreVersion').mockReturnValue(never())
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 3)
  await within(box).findByTestId('admin-legal-restore-protected')
  await user.click(within(box).getByTestId('admin-legal-restore-confirm'))
  await waitFor(() => expect(inert(within(box).getByTestId('admin-legal-restore-confirm'))).toBe(true))
  await sweep('S7 busy')
})

add('S7 restore: too many changes (429)', async (c) => {
  arrange(c)
  mocked('restoreVersion').mockRejectedValue(problemError(c, 429, 'too_many_requests', { retryAfterSeconds: 90 }))
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 4)
  await waitFor(() => expect(within(box).queryByTestId('admin-legal-restore-reading')).toBeNull())
  await user.click(within(box).getByTestId('admin-legal-restore-confirm'))
  await within(box).findByTestId('admin-legal-restore-too-many')
  await sweep('S7 429')
})

add('S7 restore: refused by today’s rules (422)', async (c) => {
  arrange(c)
  mocked('restoreVersion').mockRejectedValue(
    problemError(c, 422, 'invalid_legal_entity', { problems: [{ field: 'vatNumber', reason: 'required' }] }),
  )
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 4)
  await waitFor(() => expect(within(box).queryByTestId('admin-legal-restore-reading')).toBeNull())
  await user.click(within(box).getByTestId('admin-legal-restore-confirm'))
  await waitFor(() => expect(within(box).getAllByRole('alert').length).toBeGreaterThan(0))
  await sweep('S7 refused')
})

add('S7 restore: a newer version was saved meanwhile (409)', async (c) => {
  arrange(c)
  mocked('restoreVersion').mockRejectedValue(problemError(c, 409, 'version_conflict', { currentVersion: 6 }))
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 4)
  await waitFor(() => expect(within(box).queryByTestId('admin-legal-restore-reading')).toBeNull())
  await user.click(within(box).getByTestId('admin-legal-restore-confirm'))
  await waitFor(() => expect(within(box).getAllByRole('alert').length).toBeGreaterThan(0))
  await sweep('S7 conflict')
})

add('S7 restore: could not restore (5xx)', async (c) => {
  arrange(c)
  mocked('restoreVersion').mockRejectedValue(problemError(c, 500, 'internal'))
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 4)
  await waitFor(() => expect(within(box).queryByTestId('admin-legal-restore-reading')).toBeNull())
  await user.click(within(box).getByTestId('admin-legal-restore-confirm'))
  await waitFor(() => expect(within(box).getAllByRole('alert').length).toBeGreaterThan(0))
  await sweep('S7 failed')
})

add('S7 a restore that succeeded', async (c) => {
  arrange(c)
  mocked('restoreVersion').mockResolvedValue({
    version: 6,
    created: true,
    entity: c.fx.entityFixture('welld_ch', { version: 6 }),
  })
  const { user } = show(HISTORY)
  const box = await restoreOf(user, 4)
  await waitFor(() => expect(within(box).queryByTestId('admin-legal-restore-reading')).toBeNull())
  await user.click(within(box).getByTestId('admin-legal-restore-confirm'))
  await screen.findByTestId('admin-legal-restored')
  await sweep('S7 restored')
})

// S12 — the protected-change confirmation -----------------------------------------------------------------------------

const protectedSave = async (user: ReturnType<typeof userEvent.setup>, changes = [IBAN_CHANGE]) => {
  mocked('checkLegalEntity').mockResolvedValue({
    baseVersion: 5,
    outcome: 'change',
    changedFields: ['iban'],
    protectedChanges: changes,
  })
  await user.click(byId('admin-legal-input-iban'))
  await user.clear(byId('admin-legal-input-iban'))
  await user.type(byId('admin-legal-input-iban'), 'CH56 0483 5012 3456 7800 9')
  await user.click(byId('admin-legal-save'))
}

add('S12 checking', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  mocked('checkLegalEntity').mockReturnValue(never())
  await user.type(byId('admin-legal-input-iban'), 'x')
  await user.click(byId('admin-legal-save'))
  await waitFor(() => expect(byId('admin-legal-save').getAttribute('aria-busy')).toBe('true'))
  await sweep('S12 checking')
})

add('S12 open, with the old and the new value', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  await protectedSave(user, [IBAN_CHANGE, VAT_CHANGE])
  await screen.findByRole('alertdialog')
  await sweep('S12 open')
})

add('S12 busy', async (c) => {
  arrange(c)
  mocked('saveLegalEntity').mockReturnValue(never())
  const { user } = show(CH)
  await form()
  await protectedSave(user)
  await user.click(await screen.findByTestId('admin-legal-protected-confirm'))
  await waitFor(() => expect(inert(byId('admin-legal-protected-confirm'))).toBe(true))
  await sweep('S12 busy')
})

add('S12 the changes could not be checked', async (c) => {
  arrange(c)
  const { user } = show(CH)
  await form()
  mocked('checkLegalEntity').mockRejectedValue(new Error('down'))
  await user.type(byId('admin-legal-input-iban'), 'x')
  await user.click(byId('admin-legal-save'))
  await screen.findByTestId('admin-legal-check-failed')
  await sweep('S12 check failed')
})

// S8 — the section links (own harness: the page's harness has no section nav) ----------------------------------

const renderNav = async (c: Ctx, path: string, props: SectionNavProps) => {
  const SectionNav = c.nav.default
  const root = createRootRoute({
    component: () => (
      <>
        <SectionNav {...props} />
        <Outlet />
      </>
    ),
  })
  const routes = ['/roles', '/departments', '/users', '/audit', '/legal-entities'].map((to) =>
    createRoute({
      getParentRoute: () => root,
      path: to,
      validateSearch: (raw: Record<string, unknown>) => raw,
      component: () => <p>{to}</p>,
    }),
  )
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole('navigation')
}

const NAV_VARIANTS: [string, string, SectionNavProps][] = [
  ['an administrator without the section', '/roles', { showAdmin: true, legalEntities: 'hidden' }],
  ['an administrator with the section, on it', '/legal-entities?entity=welld_ch', { showAdmin: true, legalEntities: 'shown' }],
  ['a manager only', '/legal-entities', { showAdmin: false, legalEntities: 'shown' }],
  ['the section still resolving', '/roles', { showAdmin: true, legalEntities: 'resolving' }],
]
for (const [name, path, props] of NAV_VARIANTS) {
  add(`S8 section links: ${name}`, async (c) => {
    await renderNav(c, path, props)
    await sweep(`S8 ${name}`)
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The English run: every state, both themes
// ---------------------------------------------------------------------------------------------------------------------

describe('every state of S1 to S8 and S12, axe WCAG 2.1 A/AA in the light and the dark theme', () => {
  for (const [name, run] of Object.entries(scenarios)) {
    it(name, async () => {
      await run(english)
    }, 30_000)
  }
})

describe('the sweep itself', () => {
  it('fails on what it is there to catch: an input with a placeholder only, a nameless button, a skipped heading level', async () => {
    render(
      <main>
        <h1>Page</h1>
        <h3>Skipped</h3>
        <input placeholder="Legal name" />
        <button type="button">
          <svg aria-hidden="true" />
        </button>
      </main>,
    )
    await expect(sweep('broken page')).rejects.toThrow()
    const problems = labelProblems(document.body)
    expect(problems.some((p) => p.startsWith('no visible label'))).toBe(true)
    expect(problems.some((p) => p.startsWith('no name'))).toBe(true)
  })

  it('passes a small page that is right, so the failure above is the page and not the harness', async () => {
    render(
      <main>
        <h1>Page</h1>
        <label htmlFor="n">Legal name</label>
        <input id="n" />
        <button type="button">Save</button>
      </main>,
    )
    await sweep('right page')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Italian, once
// ---------------------------------------------------------------------------------------------------------------------

/** One pass in Italian over the screens that carry most of the copy: the late-loaded modules read `<html lang="it">`. */
const ITALIAN = [
  'S1 the strip with Incomplete, Needs correction and Unsaved changes',
  'S1 the strip with Complete, Read-only and Not moved yet',
  'S1 failed to load',
  'S2 refused, with the summary and a refused address line',
  'S2 the 429 banner',
  'S2 conflict: the banner without a list of changed values',
  'S2 after Reapply: a flagged address and a taken value',
  'S2 after Reapply with nothing to review',
  'S3 an entity moved incomplete, with a 5-line address and a line over 120',
  'S3 an entity that only needs correcting',
  'S4 read-only details',
  'S5 history of a manager, with a version that cannot be restored',
  'S5 paging: older versions available',
  'S5 paging: older versions could not be loaded',
  'S5 the history could not be loaded',
  'S6 a version that can be restored',
  'S6 a version that could not be loaded',
  'S7 restore with the protected block',
  'S7 restore: the details could not be read',
  'S7 restore: too many changes (429)',
  'S12 open, with the old and the new value',
  'S12 the changes could not be checked',
  ...NAV_VARIANTS.slice(1, 3).map(([name]) => `S8 section links: ${name}`),
]

describe('the page in Italian (AC-8.2): lang="it", no English left, every control labelled, axe clean', () => {
  beforeAll(async () => {
    document.documentElement.setAttribute('lang', 'it')
    vi.resetModules()
    const strings = await import('../strings')
    ctx = {
      api: await import('../lib/legalEntitiesApi'),
      admin: await import('../lib/adminApi'),
      fx: await import('./LegalEntitiesPage.fixtures'),
      nav: await import('../components/SectionNav'),
      catalogs: strings as unknown as Ctx['catalogs'],
      italian: true,
    }
    // The catalogs are `{ en, it }` modules: flatten their two exports.
    ctx.catalogs = { en: strings.en as never, it: strings.it as never }
  })
  afterAll(() => {
    document.documentElement.removeAttribute('lang')
    vi.resetModules()
    ctx = english
  })

  for (const name of ITALIAN) {
    it(name, async () => {
      const run = scenarios[name]
      expect(run, `scenario "${name}" exists`).toBeDefined()
      await run!(ctx)
    }, 30_000)
  }

  it('the English check catches an English sentence of the catalog left on an Italian page', async () => {
    render(<p>Restore version 3</p>)
    await expect(sweep('leaky page')).rejects.toThrow(/English/)
  })

  it('says its words in Italian: the heading, the tabs and the form', async () => {
    arrange(ctx)
    show('/legal-entities?entity=welld_ch')
    await form()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Società del gruppo')
    expect(screen.getByRole('tablist', { name: 'Società del gruppo' })).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'Viste di WellD CH' })).toBeTruthy()
    expect(byId('admin-legal-save').textContent).toBe('Salva come versione 6')
    expect(document.documentElement.getAttribute('lang')).toBe('it')
    // The language of the typed text stays on each control, whatever the page's own.
    expect(byId('admin-legal-address-en-0').getAttribute('lang')).toBe('en')
    expect(byId('admin-legal-address-it-0').getAttribute('lang')).toBe('it')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// FU-3: reflow at 320 px (what jsdom can say), and the tokens' contrast in both themes
// ---------------------------------------------------------------------------------------------------------------------

// The suite runs from admin-ui/ (as operai-ui's own stylesheet tests run from their package).
const tokensCss = readFileSync(resolve(process.cwd(), '../operai-ui/src/styles/tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

/** The declarations of the first rule whose selector list holds exactly this selector (a rule holds no nested braces). */
const rule = (selector: string): string => {
  for (const [, selectors, body] of tokensCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((selectors ?? '').split(',').some((one) => one.trim() === selector)) return body ?? ''
  }
  throw new Error(`no rule for ${selector}`)
}

describe('reflow at 320 px (FU-3, WCAG 1.4.10): the classes and the rules behind them', () => {
  it('wraps the entity strip and the section nav: `tab-list-wrap` on both lists, the page and the form single-column first', async () => {
    arrange(english)
    show(CH)
    await form()
    const strip = screen.getByRole('tablist', { name: 'Legal entities' })
    expect(strip.className).toContain('tab-list-wrap')
    // Each tab is a `.tab-link` direct child, the element the wrap rules shrink.
    for (const tab of within(strip).getAllByRole('tab')) {
      expect(tab.className).toContain('tab-link')
      expect(tab.parentElement).toBe(strip)
    }
    // Two columns only from the `md` breakpoint up: a phone gets one.
    const columns = Array.from(byId('admin-legal-form').querySelectorAll('[class*="grid-cols-2"]'))
    expect(columns.length).toBeGreaterThan(0)
    for (const grid of columns) expect(grid.className).toMatch(/md:grid-cols-2/)
    expect(byId('admin-legal-form').querySelector('[class*="grid-cols-2"]:not([class*="md:grid-cols-2"])')).toBeNull()
    // The sticky bar and its status wrap rather than overflow.
    expect(byId('admin-legal-bar').querySelector('.flex-wrap')).not.toBeNull()
    cleanup()

    await renderNav(english, '/roles', { showAdmin: true, legalEntities: 'shown' })
    expect(screen.getByRole('list').className).toContain('tab-list-wrap')
  })

  it('no element of the strip or the nav asks for a sideways scroll', async () => {
    arrange(english)
    show(CH)
    await form()
    const strip = screen.getByRole('tablist', { name: 'Legal entities' })
    for (const el of [strip, ...Array.from(strip.querySelectorAll('*')), ...Array.from(byId('admin-legal-form').querySelectorAll('*'))]) {
      expect(el.getAttribute('class') ?? '', el.tagName).not.toMatch(/\boverflow-x-(auto|scroll)\b|\boverflow-(auto|scroll)\b|\bwhitespace-nowrap\b/)
    }
  })

  it('tokens.css lets the list wrap and a long tab break its own label, and never scrolls it sideways', () => {
    expect(rule('.tab-list')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.tab-list-wrap > .tab-link')).toMatch(/min-width:\s*0/)
    expect(rule('.tab-list-wrap > .tab-link')).toMatch(/max-width:\s*100%/)
    expect(rule('.tab-list-wrap > li')).toMatch(/min-width:\s*0/)
    expect(rule('.tab-list-wrap .tab-link')).toMatch(/overflow-wrap:\s*anywhere/)
    for (const selector of ['.tab-list', '.tab-list-wrap > li', '.tab-list-wrap .tab-link', '.tab-link']) {
      expect(rule(selector), selector).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/)
      expect(rule(selector), selector).not.toMatch(/white-space:\s*nowrap/)
    }
  })
})

describe('the text tokens the page uses, measured in both themes (what jsdom cannot do for the rendered page)', () => {
  const block = (open: string, from = 0): string => {
    const start = tokensCss.indexOf(`${open} {`, from)
    expect(start, open).toBeGreaterThanOrEqual(0)
    const at = tokensCss.indexOf('{', start)
    return tokensCss.slice(at + 1, tokensCss.indexOf('}', at))
  }
  const dark = block(':root')
  const light = block("[data-theme='light']")
  const token = (scope: string, name: string): string => {
    const found = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(scope)?.[1]
    expect(found, `--${name}`).toBeDefined()
    return found!
  }
  const channel = (n: number) => {
    const s = n / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }

  // The page's text: body text, secondary text (hints, status), tone text (badges, banner titles, errors); on the
  // surfaces it sits on: the page, a card or the sticky bar, a tinted panel.
  const TEXT = ['text', 'soft', 'acc-text', 'grn-text', 'org-text', 'red-text'] as const
  const SURFACES = ['ink', 'ink-soft', 'ink-mid'] as const

  for (const [theme, scope] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        // The library measured the tone texts on `--ink-soft` and on their own tint (tokens.css); body and secondary
        // text on every surface. A pair outside that is not one the design lets the page use.
        const measured = text === 'text' || text === 'soft' || surface !== 'ink-mid'
        if (!measured) continue
        it(`--${text} on --${surface} is at least 4.5:1 (${theme})`, () => {
          expect(ratio(token(scope, text), token(scope, surface))).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
    it(`the focus ring is at least 3:1 on every surface (${theme})`, () => {
      const [, ringToken] = /--focus-ring:\s*var\(--([a-z-]+)\)/.exec(tokensCss) ?? []
      expect(ringToken).toBe('acc-hi')
      for (const surface of SURFACES) {
        expect(ratio(token(scope, 'acc-hi'), token(scope, surface))).toBeGreaterThanOrEqual(3)
      }
    })
  }
})

/**
 * specs/20261117-legal-entities T68 — protected details (US-9), end to end, through the REAL shell, admin-ui, `auth` (the registry and
 * its notice dispatcher) and notify-api (the notification centre and the email channel). Nothing is stubbed: what each person may do is
 * written the way an administrator writes it (helpers/legalEntitiesFixtures.ts), and the notices are read where a person reads them
 * (their notification centre) and where the services record them (auth's delivery outbox; notify-api's email deliveries when its database is named).
 *
 *   AC-9.1  a protected change (legal name, VAT number, IBAN) is confirmed before it is stored: one dialog that names the entity, lists each
 *           changing protected detail and only those, Old and New under separate labels, the IBAN in groups of four, an empty side as
 *           the word for "none", two actions and the focus on Cancel
 *   AC-9.2  Cancel, Escape and the close control store nothing (no version, no audit entry, no notice) and keep the form as typed
 *   AC-9.3  Confirm saves what the dialog showed; a refusal (422) comes BEFORE the confirmation (never a dialog for a refused save); a conflict after
 *           it stores nothing and saving again asks again
 *   AC-9.4  the restore dialog lists the protected differences with the current version as Old and the restored one as New, and none when
 *           none differs
 *   AC-9.5  an address-only or contacts-only change, or an IBAN typed with other spacing or case, is saved with no dialog
 *   AC-9.6  keyboard only, focus in and back, announced, axe-clean, every word in Italian too
 *   AC-9.7  a stored protected change is handed over for sending within 60 s, whichever way it was made (the page, a direct call, a restore)
 *   AC-9.13 two channels: the notification centre, in the language of the person, and email (attempted: the delivery recorded; the email's
 *           address outside the suite is configuration, none here)
 *   AC-9.17 no notice for an address-only / contacts-only / respaced-IBAN change, for a restore whose protected details are the same, nor for a
 *           refused, cancelled or conflicting save
 *   AC-9.9, AC-9.11, AC-9.12 are observed on the way: the person who saved gets the receipt; the notice says what changed by name and the
 *           last four characters of each IBAN and carries no legal value at all
 *   AC-9.11, AC-9.12 (amendment D9, T84; security re-review N1): the author is named by the EMAIL OF THEIR ACCOUNT and by nothing else. The
 *           notice of every journey below states the author's email, in English and in Italian, and no display name; a dedicated persona
 *           renames itself (Better Auth's `POST /auth/update-user`) to a sentinel BEFORE a protected save and is still named by its email;
 *           the email is the one the account had when the version was stored: the account's email and name are changed after the save and
 *           before the email's retry, and the retry says what the first attempt would have; an account whose email is not an address is
 *           "an account with no email address on record", never its name. The email's own words are read from a fake Resend (below).
 *
 * NOT covered here, and why: the push channel (PUSH_ENABLED is off in the local stack: no subscription can exist), AC-9.10 (the outside
 * mailbox is `LEGAL_ENTITY_NOTICE_EMAIL`, unset locally), and the failure paths of AC-9.14/9.15 (notify-api down, retries: QE T45's rehearsal).
 *
 * ═══ PREREQUISITES ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The stack of legal-entities.spec.ts (shell, admin-ui, notify-ui, `auth` with ENABLE_TEST_AUTH=true, migrated and seeded) PLUS
 *   - notify-api (:8081) with `SERVICE_AUDIENCE`, its own `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` (the `auth` `SERVICE_CLIENTS` entry for it
 *     holds `users.contact`: notify-api resolves a person's address through `auth`), `EMAIL_ENABLED=false` (the local default: the send is
 *     stubbed and a `sent` row is recorded; never a real email) and its notify-ui remote served for the shell;
 *   - `auth` started with NODE_ENV other than `test` (the notice dispatcher starts: it logs "notice dispatcher started"), NOTIFY_INTERNAL_URL
 *     at notify-api, and `auth`'s environment exported to the Playwright process (the outbox is read with `auth`'s own client, as `grantRole` is);
 *   - optional: `E2E_NOTIFY_DATABASE_URL` (notify-api's database) to also assert the email deliveries notify-api recorded;
 *   - optional, for the words of the EMAIL (D9): `E2E_FAKE_RESEND_PORT=<port>`, with notify-api started with `EMAIL_ENABLED=true`, a placeholder
 *     `RESEND_API_KEY` and `RESEND_FROM`, and `RESEND_BASE_URL=http://127.0.0.1:<port>`. The spec then runs a fake Resend on that port (a local
 *     server: no provider is ever reached) and reads the subject and body of each email, and makes the first email of the renamed persona
 *     fail so that a RETRY happens after the account's email changed. Without it (`EMAIL_ENABLED=false`, the local default, which stubs the
 *     send and records a `sent` row with no content) the journeys cannot read the email's words, and say so in an annotation (the author's email
 *     is held on an outbox row only while it is pending: T88 clears it at the terminal status).
 *
 * What a run leaves behind: versions of welld_ch (never deleted: AC-4.3), the last one with this run's values, and the notices they made.
 *
 *  run:  cd shell && pnpm exec playwright test e2e/protected-legal-details.spec.ts --trace off
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { authCall, contextFor, tabTo } from './fixtures/letterheads'
import { axeViolations } from './helpers/meetingsFixtures'
import {
  FAKE_RESEND_PORT,
  LEGAL_PERSONAS,
  NOTICE_WITHIN_MS,
  RENAMER,
  auditCount,
  emailDeliveriesSince,
  forbiddenValues,
  freshIban,
  getRegistryEntity,
  groupIban,
  hasNotice,
  isNoticeOf,
  ibanLast4,
  noticeRows,
  notificationsOf,
  readAccount,
  rearmEmailNotice,
  renameAccount,
  rowsOf,
  setAccountEmail,
  setUpLegalEntityPeople,
  setUpRenamerPersona,
  startFakeResend,
  typedIban,
  waitForEmail,
  waitForNotice,
  waitForOutbox,
  type FakeResend,
  type LegalDetails,
  type LegalEntityPeople,
  type NoticeItem,
  type OutboxRow,
  type RegistryEntity,
  type SeededSession,
} from './helpers/legalEntitiesFixtures'

// Not serial: each journey reads the registry as it finds it and sets up what it needs, so one red journey never hides the next.

const ENTITY = 'welld_ch' as const
const ENTITY_NAME = 'WellD CH'
const RUN = Date.now().toString(36)
let tag = 0
/** A value no earlier run and no earlier call has used: a save that carries it always changes something. */
const unique = (): string => `${RUN}${(tag += 1)}`

let people: LegalEntityPeople
/** The fake Resend notify-api is pointed at (only when `E2E_FAKE_RESEND_PORT` is set), up for the whole file: every email of every journey reaches it. */
let fake: FakeResend | null = null

test.beforeAll(async () => {
  test.setTimeout(180_000)
  people = await setUpLegalEntityPeople()
  if (FAKE_RESEND_PORT !== null) fake = await startFakeResend(FAKE_RESEND_PORT)
})

test.afterAll(async () => {
  await fake?.close()
})

// ─── The registry, as an API client ──────────────────────────────────────────────────────────────────────────────────

const detailsOf = (read: RegistryEntity): LegalDetails => ({
  legalName: read.legalName,
  address: { it: [...read.address.it], en: [...read.address.en] },
  vatNumber: read.vatNumber,
  iban: read.iban,
  contacts: { ...read.contacts },
})

/** A save by API as `session`: the next version with `edit` applied to what is current (the door a direct call uses: AC-9.7). */
async function saveViaApi(session: SeededSession, edit: (details: LegalDetails) => void): Promise<number> {
  const read = await getRegistryEntity(session, ENTITY)
  const details = detailsOf(read)
  edit(details)
  const saved = await authCall<{ version: number; created: boolean }>(session, 'POST', `/legal-entities/${ENTITY}/versions`, {
    baseVersion: read.version,
    details,
  })
  expect(saved.status, JSON.stringify(saved.body)).toBe(201)
  expect(saved.body.version).toBe(read.version + 1)
  return saved.body.version
}

/** Brings the IBAN to `iban` ('' for none) by API when it is not there already; returns the entity as it then is. */
async function ensureIban(iban: string): Promise<RegistryEntity> {
  const read = await getRegistryEntity(people.admin, ENTITY)
  if (read.iban === iban) return read
  await saveViaApi(people.admin, (details) => {
    details.iban = iban
  })
  return getRegistryEntity(people.admin, ENTITY)
}

interface HistoryItem {
  version: number
  action: string
  changedFields: string[]
  createdBy: { id: string; name: string } | null
}

async function newestVersions(session: SeededSession, limit = 3): Promise<HistoryItem[]> {
  const result = await authCall<{ items: HistoryItem[] }>(session, 'GET', `/legal-entities/${ENTITY}/versions?limit=${limit}`)
  expect(result.status).toBe(200)
  return result.body.items
}

/** The state a cancelled or refused save must leave exactly as it was: the version, the details, the audit entries. */
async function snapshot(): Promise<{ read: RegistryEntity; audit: number }> {
  return { read: await getRegistryEntity(people.admin, ENTITY), audit: await auditCount(people.admin, ENTITY) }
}

// ─── The page ────────────────────────────────────────────────────────────────────────────────────────────────────────

const input = (page: Page, field: 'legalName' | 'vatNumber' | 'iban' | 'contacts.it' | 'contacts.en') =>
  page.getByTestId(`admin-legal-input-${field}`)
const line = (page: Page, language: 'it' | 'en', index: number) => page.getByTestId(`admin-legal-address-${language}-${index}`)
const saveButton = (page: Page) => page.getByTestId('admin-legal-save')
const savedNote = (page: Page) => page.getByTestId('admin-legal-saved')
const confirmDialog = (page: Page, locale: 'en' | 'it' = 'en') =>
  page.getByRole('alertdialog', { name: locale === 'en' ? `Save these changes to ${ENTITY_NAME}?` : `Salvare queste modifiche a ${ENTITY_NAME}?` })
const protectedList = (page: Page) => page.getByTestId('admin-legal-protected-list')
const protectedItem = (page: Page, field: 'legalName' | 'vatNumber' | 'iban') => page.getByTestId(`admin-legal-protected-list-${field}`)

async function openEntity(page: Page, query = ''): Promise<void> {
  await page.goto(`/admin/legal-entities?entity=${ENTITY}${query}`)
  await expect(page.getByRole('heading', { name: /^(Legal entities|Società del gruppo)$/, level: 2 })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(`admin-legal-entity-panel-${ENTITY}`)).toBeVisible({ timeout: 30_000 })
}

async function signedIn(browser: Browser, session: SeededSession, locale = 'en-US'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await contextFor(browser, session, locale)
  return { context, page: await context.newPage() }
}

async function expectNoAxeViolations(page: Page, label: string, include: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
  const violations = await axeViolations(page, include)
  expect(
    violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`).join(' | ')}`),
    `axe violations on ${label}`,
  ).toEqual([])
}

/** What a list item of the dialog says under "Old" and "New": the text of the `dd` that follows each `dt`. */
async function oldAndNew(item: Locator): Promise<{ old: string; new: string; terms: string[] }> {
  return item.evaluate((element) => {
    const read: Record<string, string> = {}
    const terms: string[] = []
    for (const term of Array.from(element.querySelectorAll('dt'))) {
      const label = term.textContent?.trim() ?? ''
      terms.push(label)
      read[label] = (term.nextElementSibling?.textContent ?? '').trim()
    }
    return { old: read['Old'] ?? read['Precedente'] ?? '<missing>', new: read['New'] ?? read['Nuovo'] ?? '<missing>', terms }
  })
}

/** Types the values of a protected change into the open form (the IBAN as a person types one: lower case, odd spacing). */
async function typeProtectedChange(page: Page, values: { legalName?: string; vatNumber?: string; iban?: string; contactsIt?: string }): Promise<void> {
  if (values.legalName !== undefined) await input(page, 'legalName').fill(values.legalName)
  if (values.vatNumber !== undefined) await input(page, 'vatNumber').fill(values.vatNumber)
  if (values.iban !== undefined) {
    await input(page, 'iban').fill(values.iban === '' ? '' : typedIban(values.iban))
    await input(page, 'iban').blur()
  }
  if (values.contactsIt !== undefined) await input(page, 'contacts.it').fill(values.contactsIt)
}

/** A Swiss VAT number in the registry's shape, different every call. */
function freshVat(): string {
  const digits = String(Date.now() % 1_000_000_000).padStart(9, '0')
  return `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)} MWST`
}

/** Annotates a latency without printing a value: seconds only. */
function noteLatency(what: string, elapsedMs: number): void {
  const seconds = (elapsedMs / 1000).toFixed(1)
  test.info().annotations.push({ type: 'notice-latency', description: `${what}: ${seconds} s (limit ${NOTICE_WITHIN_MS / 1000} s)` })
  console.log(`[protected-legal-details] ${what}: notice in the notification centre ${seconds} s after the save`)
}

/** No part of a notice (title, body, both languages, link) carries a value of either version (AC-9.12). */
function expectValueFree(notice: NoticeItem, reads: readonly RegistryEntity[]): void {
  const everything = [notice.title, notice.body, notice.it?.title ?? '', notice.it?.body ?? '', notice.link?.href ?? '', notice.link?.label ?? ''].join('\n')
  for (const value of forbiddenValues(...reads)) {
    expect(everything.includes(value), 'a legal value is in the notice').toBe(false)
  }
}

/** Every display name of the personas of these journeys: none may be in any notice, whoever the author is (D9). */
const PERSONA_NAMES: readonly string[] = [...Object.values(LEGAL_PERSONAS).map((persona) => persona.name), RENAMER.name]

/** The whole text of a notice, both languages, link included. */
const textOf = (notice: NoticeItem): string =>
  [notice.title, notice.body, notice.it?.title ?? '', notice.it?.body ?? '', notice.link?.href ?? '', notice.link?.label ?? ''].join('\n')

/**
 * AC-9.11 and AC-9.12 as amended by D9: the notice states the author by the email of their account, in the sentence of the language
 * (English body, Italian body), and no display name in any part of it. `names` are the display names that must be nowhere in it.
 */
function expectAuthorByEmail(notice: NoticeItem, email: string, action: 'save' | { restoredFrom: number }, names: readonly string[]): void {
  const english = action === 'save' ? `Change saved by the account ${email}.` : `Version ${action.restoredFrom} restored by the account ${email}.`
  const italian = action === 'save' ? `Modifica salvata dall'account ${email}.` : `Versione ${action.restoredFrom} ripristinata dall'account ${email}.`
  expect(notice.body).toContain(english)
  expect(notice.it?.body).toContain(italian)
  const everything = textOf(notice)
  for (const name of names) expect(everything.includes(name), 'a display name is in the notice').toBe(false)
  expect(everything).not.toContain('no email address on record')
  expect(everything).not.toContain('senza indirizzo email registrato')
}

/**
 * What a notice row holds of the author's email (D9 as tightened by T88, security review D9-1): the address captured at the save while the
 * row is `pending` (the email is built from it), and NOTHING once the row is terminal (`delivered`, `given_up`): the dispatcher clears it in
 * the same update as the status. A row read after its delivery therefore holds null, never the address.
 */
function expectAuthorEmailHeldWhilePending(rows: readonly { status: string; authorEmail: string | null }[], email: string, what: string): void {
  for (const row of rows) {
    const terminal = row.status === 'delivered' || row.status === 'given_up'
    expect(row.authorEmail, `${what}: a ${row.status} row ${terminal ? 'holds no address (T88)' : 'holds the address of the save'}`).toBe(terminal ? null : email)
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T68: the confirmation on save (AC-9.1, 9.2, 9.3, 9.6)', () => {
  test('the dialog lists exactly the protected details that change, Old and New, grouped; Cancel is focused; Escape, Cancel and the close control store nothing (AC-9.1, AC-9.2, AC-9.6)', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const start = await ensureIban(freshIban())
    const before = await snapshot()
    expect(before.read.version).toBeGreaterThanOrEqual(start.version)
    const next = before.read.version + 1
    const outboxBefore = noticeRows(ENTITY, next)
    expect(outboxBefore).toEqual([])

    const newIban = freshIban()
    const newName = `wellD SA T68 ${unique()}`
    const newVat = freshVat()
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page)
    // A protected change of three details, and one that is not protected (the contacts line): the dialog lists the three and only them.
    await typeProtectedChange(page, { legalName: newName, vatNumber: newVat, iban: newIban, contactsIt: `Cancel ${unique()}` })
    // Typed in lower case and in groups of five: the field shows it in groups of four, upper case, on leaving it.
    await expect(input(page, 'iban')).toHaveValue(groupIban(newIban))

    const save = saveButton(page)
    await expect(save).toHaveText(`Save as version ${next}`)
    await save.click()
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible()

    // One confirmation: the entity, the three details in the closed order, none of the others.
    await expect(protectedList(page).locator('> li')).toHaveCount(3)
    await expect(protectedList(page).locator('> li').nth(0)).toHaveAttribute('data-testid', 'admin-legal-protected-list-legalName')
    await expect(protectedList(page).locator('> li').nth(1)).toHaveAttribute('data-testid', 'admin-legal-protected-list-vatNumber')
    await expect(protectedList(page).locator('> li').nth(2)).toHaveAttribute('data-testid', 'admin-legal-protected-list-iban')
    await expect(dialog).not.toContainText('Contacts line')
    await expect(dialog).not.toContainText('Address')
    // Old and New are words, under each detail, so the two cannot be mixed up (never colour or position alone).
    const iban = await oldAndNew(protectedItem(page, 'iban'))
    expect(iban.terms).toEqual(['Old', 'New'])
    expect(iban.old).toBe(groupIban(start.iban))
    expect(iban.new).toBe(groupIban(newIban))
    expect(iban.old).toMatch(/^[A-Z]{2}\d{2}( [A-Z0-9]{1,4})+$/)
    const name = await oldAndNew(protectedItem(page, 'legalName'))
    expect(name).toMatchObject({ old: start.legalName, new: newName })
    const vat = await oldAndNew(protectedItem(page, 'vatNumber'))
    expect(vat).toMatchObject({ old: start.vatNumber, new: newVat })
    // The dialog says who will be told, and its content is the dialog's description (read when it opens).
    await expect(dialog).toContainText(`the other people who manage ${ENTITY_NAME} and the administrators are told of this change`)
    // Two actions, and the keyboard focus is on Cancel.
    await expect(page.getByTestId('admin-legal-protected-cancel')).toBeFocused()
    await expect(page.getByTestId('admin-legal-protected-confirm')).toHaveText(`Save as version ${next}`)
    await expectNoAxeViolations(page, 'the confirmation on save (S12)', '[role="alertdialog"]')

    // Escape: nothing is stored, the form stays open with everything typed, focus is back on Save.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(save).toBeFocused()
    await expect(input(page, 'iban')).toHaveValue(groupIban(newIban))
    await expect(input(page, 'legalName')).toHaveValue(newName)
    await expect(input(page, 'vatNumber')).toHaveValue(newVat)
    await expect(savedNote(page)).toHaveCount(0)

    // Save again: it asks again (nothing was remembered). Cancel with the action.
    await save.click()
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('admin-legal-protected-cancel')).toBeFocused()
    await page.getByTestId('admin-legal-protected-cancel').click()
    await expect(dialog).toHaveCount(0)
    await expect(save).toBeFocused()
    await expect(input(page, 'legalName')).toHaveValue(newName)

    // And once more, closing it with its close control.
    await save.click()
    await expect(dialog).toBeVisible()
    await page.getByTestId('admin-legal-protected-close').click()
    await expect(dialog).toHaveCount(0)
    await expect(save).toBeFocused()
    await expect(input(page, 'contacts.it')).toHaveValue(/^Cancel /)

    // Nothing was stored by any of the three: no version, no audit entry, no notice (the registry as it was, to the last field).
    const after = await snapshot()
    expect(after.read).toEqual(before.read)
    expect(after.audit).toBe(before.audit)
    expect(noticeRows(ENTITY, next)).toEqual([])
    expect(await newestVersions(people.admin, 1)).toMatchObject([{ version: before.read.version }])
    // Give the dispatcher its sweeps: still no notice for the version that was never made.
    await page.waitForTimeout(5_000)
    expect(await hasNotice(people.chManager, ENTITY, next)).toBe(false)
    await context.close()
  })

  test('a refusal comes before the confirmation: no dialog for a refused save; fixed, the page asks (AC-9.3)', async ({ browser }) => {
    test.setTimeout(150_000)
    const before = await snapshot()
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page)

    // A protected change (the legal name) with an IBAN whose check digits are wrong: the registry refuses (422) and the page says so.
    const newName = `wellD SA T68 ${unique()}`
    await input(page, 'legalName').fill(newName)
    await input(page, 'iban').fill(`${before.read.iban.slice(0, -1)}${before.read.iban.endsWith('0') ? '1' : '0'}`)
    await saveButton(page).click()
    await expect(page.getByTestId('admin-legal-summary-title')).toHaveText('Nothing was saved. 1 value needs your attention.')
    await expect(input(page, 'iban')).toBeFocused()
    await expect(input(page, 'iban')).toHaveAttribute('aria-invalid', 'true')
    // Never a confirmation of a change the registry would refuse.
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    expect((await snapshot()).read).toEqual(before.read)

    // The IBAN as it was: now the change is valid, and the page asks, listing the legal name only.
    await input(page, 'iban').fill(before.read.ibanPrint)
    await saveButton(page).click()
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible()
    await expect(protectedList(page).locator('> li')).toHaveCount(1)
    expect(await oldAndNew(protectedItem(page, 'legalName'))).toMatchObject({ old: before.read.legalName, new: newName })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    const after = await snapshot()
    expect(after.read).toEqual(before.read)
    expect(after.audit).toBe(before.audit)
    await context.close()
  })

  test('a newer version saved while the dialog is open: Confirm stores nothing, the conflict is shown, and saving again asks again (AC-9.3, AC-9.17)', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const start = await getRegistryEntity(people.admin, ENTITY)
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page)

    const newIban = freshIban()
    await typeProtectedChange(page, { iban: newIban })
    await saveButton(page).click()
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible()

    // Meanwhile somebody else saves a version that is not a protected change (the contacts line): the page's base is stale now.
    const theirs = await saveViaApi(people.chManager, (details) => {
      details.contacts.en = `Theirs ${unique()}`
    })
    expect(theirs).toBe(start.version + 1)

    await page.getByTestId('admin-legal-protected-confirm').click()
    await expect(page.getByTestId('admin-legal-conflict')).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toHaveCount(0)
    await expect(savedNote(page)).toHaveCount(0)
    // Nothing of ours reached the registry: it holds their version, the IBAN untouched.
    const mid = await getRegistryEntity(people.admin, ENTITY)
    expect(mid.version).toBe(theirs)
    expect(mid.iban).toBe(start.iban)
    // Neither version made a notice: theirs is not protected, ours was refused.
    expect(noticeRows(ENTITY, theirs)).toEqual([])
    expect(noticeRows(ENTITY, theirs + 1)).toEqual([])

    // Reapply onto their version and save again: it asks again, with the IBAN of their version as Old; cancelled, nothing is stored.
    await page.getByTestId('admin-legal-reapply').click()
    await expect(input(page, 'iban')).toHaveValue(groupIban(newIban))
    await saveButton(page).click()
    await expect(dialog).toBeVisible()
    expect((await oldAndNew(protectedItem(page, 'iban'))).old).toBe(groupIban(start.iban))
    await expect(page.getByTestId('admin-legal-protected-confirm')).toHaveText(`Save as version ${theirs + 1}`)
    await page.getByTestId('admin-legal-protected-cancel').click()
    await expect(dialog).toHaveCount(0)
    expect((await getRegistryEntity(people.admin, ENTITY)).version).toBe(theirs)
    await context.close()
  })

  test('an empty side is the word "None", in English and in Italian; the whole confirmation exists in Italian (AC-9.1, AC-9.6)', async ({ browser }) => {
    test.setTimeout(180_000)
    // From no IBAN to one (Old: None), then from one to none (New: None).
    await ensureIban('')
    const first = await getRegistryEntity(people.admin, ENTITY)
    expect(first.iban).toBe('')
    const added = freshIban()
    const english = await signedIn(browser, people.admin)
    await openEntity(english.page)
    await typeProtectedChange(english.page, { iban: added })
    await saveButton(english.page).click()
    await expect(confirmDialog(english.page)).toBeVisible()
    const empty = await oldAndNew(protectedItem(english.page, 'iban'))
    expect(empty).toEqual({ old: 'None', new: groupIban(added), terms: ['Old', 'New'] })
    await english.page.keyboard.press('Escape')
    await expect(confirmDialog(english.page)).toHaveCount(0)
    await english.context.close()

    const current = await ensureIban(added)
    expect(current.iban).toBe(added)
    const italian = await signedIn(browser, people.admin, 'it-IT')
    await openEntity(italian.page)
    await typeProtectedChange(italian.page, { iban: '', legalName: `wellD SA T68 ${unique()}` })
    await saveButton(italian.page).click()
    const dialog = confirmDialog(italian.page, 'it')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Stai modificando dati che vengono stampati su ogni offerta e contratto')
    await expect(dialog).toContainText(`le altre persone che gestiscono ${ENTITY_NAME} e gli amministratori vengono informati della modifica`)
    expect(await oldAndNew(protectedItem(italian.page, 'iban'))).toEqual({ old: groupIban(added), new: 'Nessun valore', terms: ['Precedente', 'Nuovo'] })
    await expect(italian.page.getByTestId('admin-legal-protected-cancel')).toHaveText('Annulla')
    await expect(italian.page.getByTestId('admin-legal-protected-cancel')).toBeFocused()
    await expect(italian.page.getByTestId('admin-legal-protected-confirm')).toHaveText(/^Salva come versione \d+$/)
    await expectNoAxeViolations(italian.page, 'the confirmation in Italian (S12)', '[role="alertdialog"]')
    await italian.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await italian.context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T68: the dialogs are announced when they open (AC-9.6, AC-8.1)', () => {
  test('the save confirmation: its accessible description holds the intro, the details that change with Old and New, and who is told', async ({ browser }) => {
    test.setTimeout(120_000)
    const start = await ensureIban(freshIban())
    const newIban = freshIban()
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page)
    await typeProtectedChange(page, { iban: newIban })
    await saveButton(page).click()
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible()
    // A screen reader reads the title and then the description when the dialog opens: the values must be in it, not only the heading of the list.
    const words = [groupIban(start.iban), groupIban(newIban), 'Old', 'New', `told of this change`]
    for (const word of words) {
      await expect(dialog, `the description of the dialog holds "${word}"`).toHaveAccessibleDescription(new RegExp(word.replace(/ /g, '\\s')))
    }
    await page.keyboard.press('Escape')
    await context.close()
  })

  test('the restore dialog: its accessible description holds the details that change with Old and New', async ({ browser }) => {
    test.setTimeout(150_000)
    const ibanA = freshIban()
    const ibanB = freshIban()
    const versionA = await saveViaApi(people.admin, (details) => {
      details.iban = ibanA
    })
    await saveViaApi(people.admin, (details) => {
      details.iban = ibanB
    })
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page, `&view=history&version=${versionA}`)
    await page.getByTestId('admin-legal-version-banner-restore').click()
    const dialog = page.getByRole('alertdialog', { name: `Restore version ${versionA}?` })
    await expect(dialog).toBeVisible()
    for (const word of [groupIban(ibanA), groupIban(ibanB), 'Old', 'New']) {
      await expect(dialog, `the description of the dialog holds "${word}"`).toHaveAccessibleDescription(new RegExp(word.replace(/ /g, '\\s')))
    }
    await page.keyboard.press('Escape')
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T68: no confirmation, no notice (AC-9.5, AC-9.17)', () => {
  test('an address-only change, and a contacts change with the IBAN typed with other spacing and case, are saved with no dialog and no notice', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const start = await ensureIban(freshIban())
    const noticesBefore = (await notificationsOf(people.chManager)).length
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page)
    const next = start.version + 1

    // 1. Only an address line changes.
    await line(page, 'en', 1).fill(`6900 Lugano T68 ${unique()}`)
    await saveButton(page).click()
    await expect(savedNote(page)).toHaveText(`Version ${next} saved. Every tool uses it within a minute.`)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    let [newest] = await newestVersions(people.admin, 1)
    expect(newest).toMatchObject({ version: next, action: 'save', changedFields: ['address.en'] })
    // The notice duty is written with the version, in its transaction: nothing was ever written for this one.
    expect(noticeRows(ENTITY, next)).toEqual([])

    // 2. The contacts line changes, and the IBAN is typed with other spacing and case only (same IBAN: lower case, no spaces, then groups of five).
    await input(page, 'contacts.it').fill(`Tel. T68 ${unique()}`)
    await input(page, 'iban').fill(start.iban.toLowerCase())
    await input(page, 'iban').blur()
    await expect(input(page, 'iban')).toHaveValue(start.ibanPrint)
    await input(page, 'iban').fill(typedIban(start.iban))
    await saveButton(page).click()
    await expect(savedNote(page)).toHaveText(`Version ${next + 1} saved. Every tool uses it within a minute.`)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    ;[newest] = await newestVersions(people.admin, 1)
    expect(newest).toMatchObject({ version: next + 1, changedFields: ['contacts.it'] })
    expect((await getRegistryEntity(people.admin, ENTITY)).iban).toBe(start.iban)
    expect(noticeRows(ENTITY, next + 1)).toEqual([])

    // No notice reaches anybody: neither the manager nor the person who saved gets one for these versions, however long the dispatcher sweeps.
    await page.waitForTimeout(6_000)
    for (const person of [people.chManager, people.admin]) {
      expect(await hasNotice(person, ENTITY, next)).toBe(false)
      expect(await hasNotice(person, ENTITY, next + 1)).toBe(false)
    }
    expect((await notificationsOf(people.chManager)).length).toBe(noticesBefore)
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T68: Confirm, and the notice (AC-9.3, 9.7, 9.9, 9.11, 9.12, 9.13)', () => {
  test('keyboard only: Confirm saves what the dialog showed, and within 60 s the manager and the person who saved have the notice (AC-9.3, AC-9.6, AC-9.7, AC-9.9)', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const start = await ensureIban(freshIban())
    const next = start.version + 1
    const newIban = freshIban()
    const newName = `wellD SA T68 ${unique()}`
    const newVat = freshVat()

    const actor = await signedIn(browser, people.admin)
    const page = actor.page
    await openEntity(page)
    await typeProtectedChange(page, { legalName: newName, vatNumber: newVat, iban: newIban })

    // From the IBAN field to Save by the keyboard alone (the address lines and the contacts are in between), then Enter.
    await input(page, 'iban').focus()
    await tabTo(page, saveButton(page))
    await page.keyboard.press('Enter')
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('admin-legal-protected-cancel')).toBeFocused()
    // Tab never leaves the dialog (a focus trap), and Confirm is reachable.
    for (let presses = 0; presses < 5; presses += 1) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${presses + 1} stays in the dialog`).toBe(true)
    }
    await tabTo(page, page.getByTestId('admin-legal-protected-confirm'), { max: 10 })
    const sentAt = Date.now()
    await page.keyboard.press('Enter')

    // Saved exactly as the dialog showed it, and focus is back on Save, the control that opened it.
    await expect(savedNote(page)).toHaveText(`Version ${next} saved. Every tool uses it within a minute.`)
    await expect(dialog).toHaveCount(0)
    await expect(saveButton(page)).toBeFocused()
    const after = await getRegistryEntity(people.admin, ENTITY)
    expect(after).toMatchObject({ version: next, legalName: newName, vatNumber: newVat, iban: newIban })
    const [newest] = await newestVersions(people.admin, 1)
    expect(newest).toMatchObject({ version: next, action: 'save' })
    expect(newest!.changedFields).toEqual(expect.arrayContaining(['legalName', 'vatNumber', 'iban']))

    // The notice: within 60 s of the save, in the notification centre of the manager and of the person who saved (the receipt).
    const [forManager, forActor] = await Promise.all([
      waitForNotice(people.chManager, ENTITY, next, sentAt),
      waitForNotice(people.admin, ENTITY, next, sentAt),
    ])
    noteLatency('confirmed save, manager', forManager.elapsedMs)
    noteLatency('confirmed save, actor (receipt)', forActor.elapsedMs)
    expect(forManager.elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
    expect(forActor.elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
    expectValueFree(forManager.notice, [start, after])
    // D9: made through the page by the admin, the notice names the admin's account email (the manager's and the receipt), not the name.
    for (const { notice } of [forManager, forActor]) expectAuthorByEmail(notice, people.admin.email, 'save', PERSONA_NAMES)
    await actor.context.close()
  })

  test('the notice, whichever way the change was made: what it says, value-free, in the person\'s language, with a link that opens the history; the email path is attempted (AC-9.7, 9.9, 9.11, 9.12, 9.13)', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const start = await ensureIban(freshIban())
    const next = start.version + 1
    const newIban = freshIban()
    const newName = `wellD SA T68 ${unique()}`
    const newVat = freshVat()

    // A direct call to the registry, as a person with the permission: no confirmation in front of it (the notice is the registry's duty, not the page's).
    const sentAt = Date.now()
    const sentIso = new Date(sentAt - 2_000).toISOString()
    expect(
      await saveViaApi(people.admin, (details) => {
        details.legalName = newName
        details.vatNumber = newVat
        details.iban = newIban
      }),
    ).toBe(next)
    const after = await getRegistryEntity(people.admin, ENTITY)

    const [forManager, forActor] = await Promise.all([
      waitForNotice(people.chManager, ENTITY, next, sentAt),
      waitForNotice(people.admin, ENTITY, next, sentAt),
    ])
    noteLatency('direct save, manager', forManager.elapsedMs)
    noteLatency('direct save, actor (receipt)', forActor.elapsedMs)
    expect(forManager.elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
    expect(forActor.elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)

    // What it says (AC-9.11): the entity, who, the version, which details by NAME, the last four of each IBAN, a link to the history.
    for (const { notice } of [forManager, forActor]) {
      expect(notice.title).toBe(`Legal details of ${ENTITY_NAME} changed: legal name, VAT number and IBAN`)
      // D9: the author is the account's email, in both languages, and no display name is in any part of the notice.
      expectAuthorByEmail(notice, people.admin.email, 'save', PERSONA_NAMES)
      expect(notice.body).toContain(`New version: ${next}.`)
      expect(notice.body).toContain('Details changed: legal name, VAT number and IBAN.')
      expect(notice.body).toContain(`Old IBAN: …${ibanLast4(start.iban)}.`)
      expect(notice.body).toContain(`New IBAN: …${ibanLast4(newIban)}.`)
      expect(notice.body).toMatch(/When: \d{1,2} \w+ \d{4}, \d{2}:\d{2} CES?T \(Europe\/Zurich\)\./)
      expect(notice.link?.href).toBe(`/admin/legal-entities?entity=${ENTITY}&view=history`)
      expect(notice.it?.title).toBe(`Dati legali di ${ENTITY_NAME} modificati: ragione sociale, partita IVA e IBAN`)
      expect(notice.it?.body).toContain(`IBAN precedente: …${ibanLast4(start.iban)}.`)
      expect(notice.it?.body).toContain(`Nuovo IBAN: …${ibanLast4(newIban)}.`)
      // AC-9.12: no value of either version, anywhere in it; the last four characters are all of an IBAN that is shown.
      expectValueFree(notice, [start, after])
      expect(notice.severity).toBe('warning')
    }
    // One notice per person for the version, never two (the centre of each holds exactly one).
    for (const person of [people.chManager, people.admin]) {
      expect((await notificationsOf(person)).filter((item) => isNoticeOf(item, ENTITY, next)).length).toBe(1)
    }

    // The delivery outbox: both channels for both people, handed over within the same 60 s; the email attempted.
    const rows = await waitForOutbox(ENTITY, next, sentAt)
    expect(Date.now() - sentAt).toBeLessThanOrEqual(NOTICE_WITHIN_MS + 5_000)
    for (const person of [people.chManager, people.admin]) {
      const own = rowsOf(rows, person.userId)
      expect(own.map((row) => row.channel).sort(), `one notice per channel for ${person.email}`).toEqual(['email', 'in_app'])
      expect(own.find((row) => row.channel === 'in_app')).toMatchObject({ status: 'delivered', recipientKind: 'person' })
      const email = own.find((row) => row.channel === 'email')!
      expect(email.attempts, 'the email path was attempted').toBeGreaterThanOrEqual(1)
      // D9: every row of the version holds the author's account email as it was when the version was stored: what the email is written from.
      expectAuthorEmailHeldWhilePending(own, people.admin.email, 'the rows of the version')
      // With the local stack (EMAIL_ENABLED=false) notify-api stubs the send and says "sent"; one that is not configured says so and the row waits.
      expect(email.status === 'delivered' || email.lastReason === 'email_not_configured', `email row: ${email.status} ${email.lastReason}`).toBe(true)
    }
    expect(rows.filter((row) => row.recipientKind === 'outside').every((row) => row.channel === 'email')).toBe(true)
    expect(rows.every((row) => row.status !== 'given_up')).toBe(true)
    // No record carries a value (AC-9.12): the rows are ids, channels and a closed reason.
    for (const value of forbiddenValues(start, after)) expect(JSON.stringify(rows).includes(value), 'a legal value is in the outbox').toBe(false)
    for (const name of PERSONA_NAMES) expect(JSON.stringify(rows).includes(name), 'a display name is in the outbox').toBe(false)
    const deliveries = emailDeliveriesSince(sentIso)
    if (deliveries === null) {
      test.info().annotations.push({ type: 'email-deliveries', description: "E2E_NOTIFY_DATABASE_URL is not set: notify-api's own email_delivery rows were not read; the outbox row is the evidence" })
    } else {
      for (const person of [people.chManager, people.admin]) {
        const sent = deliveries.filter((row) => row.to === person.email)
        expect(sent.length, `notify-api recorded the email to ${person.email}`).toBeGreaterThanOrEqual(1)
        expect(sent.every((row) => row.callerSub === 'system:auth')).toBe(true)
        expect(sent.every((row) => row.status === 'sent' || row.error !== null)).toBe(true)
      }
      for (const value of forbiddenValues(start, after)) expect(JSON.stringify(deliveries).includes(value), 'a legal value is in a delivery record').toBe(false)
    }

    // The notification centre, as the manager reads it: Italian when the shell is Italian, the same notice, and its link opens the history.
    const manager = await signedIn(browser, people.chManager, 'it-IT')
    await manager.page.goto('/notify')
    const item = manager.page.getByTestId(`notification-item-${forManager.notice.id}`)
    await expect(item).toBeVisible({ timeout: 30_000 })
    await expect(manager.page.getByTestId(`notification-title-${forManager.notice.id}`)).toHaveText(forManager.notice.it!.title)
    await expect(item).toContainText(`IBAN precedente: …${ibanLast4(start.iban)}`)
    await expect(item).toContainText(`Nuovo IBAN: …${ibanLast4(newIban)}`)
    await expect(item).toContainText(`Modifica salvata dall'account ${people.admin.email}.`)
    for (const name of PERSONA_NAMES) await expect(item, 'a display name is on the notification centre').not.toContainText(name)
    await expect(item).not.toContainText('Legal details of')
    const shown = await item.innerText()
    for (const value of forbiddenValues(start, after)) expect(shown.includes(value), 'a legal value is on the notification centre').toBe(false)
    await expect(item).toHaveAttribute('href', `/admin/legal-entities?entity=${ENTITY}&view=history`)
    await item.click()
    await expect(manager.page).toHaveURL(new RegExp(`/admin/legal-entities\\?entity=${ENTITY}&view=history$`), { timeout: 30_000 })
    await expect(manager.page.getByRole('table', { name: `Versioni di ${ENTITY_NAME}` })).toBeVisible({ timeout: 30_000 })
    await expect(manager.page.getByRole('tablist', { name: `Viste di ${ENTITY_NAME}` }).getByRole('tab', { name: 'Cronologia', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(manager.page.getByTestId(`admin-legal-version-row-${next}-open`)).toBeVisible()
    await manager.context.close()

    // And the person who saved, in English: the receipt.
    const receipt = await signedIn(browser, people.admin, 'en-US')
    await receipt.page.goto('/notify')
    const own = receipt.page.getByTestId(`notification-item-${forActor.notice.id}`)
    await expect(own).toBeVisible({ timeout: 30_000 })
    await expect(receipt.page.getByTestId(`notification-title-${forActor.notice.id}`)).toHaveText(forActor.notice.title)
    await expect(own).toContainText(`New IBAN: …${ibanLast4(newIban)}`)
    await expect(own).toContainText(`Change saved by the account ${people.admin.email}.`)
    for (const name of PERSONA_NAMES) await expect(own, 'a display name is on the notification centre').not.toContainText(name)
    await receipt.context.close()
  })

  test('clearing the IBAN is told too, and the notice says "none" for the new one (AC-9.7, AC-9.11)', async () => {
    test.setTimeout(150_000)
    const start = await ensureIban(freshIban())
    const sentAt = Date.now()
    const next = await saveViaApi(people.admin, (details) => {
      details.iban = ''
    })
    const after = await getRegistryEntity(people.admin, ENTITY)
    expect(after.iban).toBe('')
    const { notice, elapsedMs } = await waitForNotice(people.chManager, ENTITY, next, sentAt)
    noteLatency('direct call, manager', elapsedMs)
    expect(elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
    expect(notice.title).toBe(`Legal details of ${ENTITY_NAME} changed: IBAN`)
    expect(notice.body).toContain(`Old IBAN: …${ibanLast4(start.iban)}.`)
    expect(notice.body).toContain('New IBAN: none.')
    expect(notice.it?.body).toContain('Nuovo IBAN: nessuno.')
    expectValueFree(notice, [start, after])
    const rows = await waitForOutbox(ENTITY, next, sentAt)
    expect(rowsOf(rows, people.chManager.userId).map((row) => row.channel).sort()).toEqual(['email', 'in_app'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T68: the restore dialog (AC-9.4, 9.6, 9.7, 9.17)', () => {
  test('a restore that changes a protected detail lists it, Old the current and New the restored; Cancel stores nothing; Confirm is told too (AC-9.4, AC-9.7)', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    // Two versions that differ in a protected detail: the one to go back to (IBAN A), and the current one (IBAN B).
    const ibanA = freshIban()
    const ibanB = freshIban()
    const versionA = await saveViaApi(people.admin, (details) => {
      details.iban = ibanA
    })
    const versionB = await saveViaApi(people.admin, (details) => {
      details.iban = ibanB
    })
    const target = await getRegistryEntity(people.admin, ENTITY) // version B, the one in effect
    expect(target.version).toBe(versionB)
    const before = await snapshot()

    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page, `&view=history&version=${versionA}`)
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toHaveText(`Viewing version ${versionA} (read-only)`)
    await page.getByTestId('admin-legal-version-banner-restore').click()
    const dialog = page.getByRole('alertdialog', { name: `Restore version ${versionA}?` })
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('admin-legal-restore-cancel')).toBeFocused()
    const block = page.getByTestId('admin-legal-restore-protected')
    await expect(block).toBeVisible()
    await expect(block).toContainText(`the other people who manage ${ENTITY_NAME} and the administrators are told of it`)
    await expect(block).toContainText(`Old is the current version (${versionB}). New is version ${versionA}.`)
    const list = page.getByTestId('admin-legal-restore-protected-list')
    await expect(list.locator('> li')).toHaveCount(1)
    const pair = await oldAndNew(page.getByTestId('admin-legal-restore-protected-list-iban'))
    expect(pair).toEqual({ old: groupIban(ibanB), new: groupIban(ibanA), terms: ['Old', 'New'] })
    await expectNoAxeViolations(page, 'the restore dialog with a protected change (S7)', '[role="alertdialog"]')

    // Escape restores nothing; focus is back on the button that opened it.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('admin-legal-version-banner-restore')).toBeFocused()
    const cancelled = await snapshot()
    expect(cancelled.read).toEqual(before.read)
    expect(cancelled.audit).toBe(before.audit)
    expect(noticeRows(ENTITY, versionB + 1)).toEqual([])

    // Confirm: a new version equal to version A; the others are told, "restored", with the last four of each IBAN.
    await page.getByTestId('admin-legal-version-banner-restore').click()
    await expect(dialog).toBeVisible()
    const sentAt = Date.now()
    await page.getByTestId('admin-legal-restore-confirm').click()
    await expect(page.getByTestId('admin-legal-restored')).toHaveText(`Version ${versionB + 1} created from version ${versionA}`)
    const restored = await getRegistryEntity(people.admin, ENTITY)
    expect(restored).toMatchObject({ version: versionB + 1, iban: ibanA })
    const { notice, elapsedMs } = await waitForNotice(people.chManager, ENTITY, versionB + 1, sentAt)
    noteLatency('restore, manager', elapsedMs)
    expect(elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
    expectAuthorByEmail(notice, people.admin.email, { restoredFrom: versionA }, PERSONA_NAMES)
    expect(notice.body).toContain(`Old IBAN: …${ibanLast4(ibanB)}.`)
    expect(notice.body).toContain(`New IBAN: …${ibanLast4(ibanA)}.`)
    expectValueFree(notice, [target, restored])
    await waitForNotice(people.admin, ENTITY, versionB + 1, sentAt)
    await context.close()
  })

  test('a restore whose protected details are the same lists none and makes no notice; the dialog is as it was (AC-9.4, AC-9.17)', async ({ browser }) => {
    test.setTimeout(240_000)
    // The current version differs from the one to restore in the contacts line only.
    const ibanC = freshIban()
    const base = await saveViaApi(people.admin, (details) => {
      details.iban = ibanC
      details.contacts.it = `Base ${unique()}`
    })
    const current = await saveViaApi(people.admin, (details) => {
      details.contacts.it = `Current ${unique()}`
    })
    expect(current).toBe(base + 1)
    // Both saves above are told (the first is a protected change), the second is not: settle the first before looking for the quiet one.
    await waitForNotice(people.chManager, ENTITY, base, Date.now() - 1_000)
    const before = await snapshot()

    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page, `&view=history&version=${base}`)
    await page.getByTestId('admin-legal-version-banner-restore').click()
    const dialog = page.getByRole('alertdialog', { name: `Restore version ${base}?` })
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('admin-legal-restore-cancel')).toBeFocused()
    // The change line names the contacts line; no protected block, no Old and New.
    await expect(page.getByTestId('admin-legal-restore-changes')).toContainText('Contacts line (Italian)')
    await expect(page.getByTestId('admin-legal-restore-protected')).toHaveCount(0)
    await expect(dialog.locator('dt')).toHaveCount(0)
    await expect(dialog).not.toContainText('are told of it')
    await expectNoAxeViolations(page, 'the restore dialog with no protected change (S7)', '[role="alertdialog"]')

    const sentAt = Date.now()
    await page.getByTestId('admin-legal-restore-confirm').click()
    await expect(page.getByTestId('admin-legal-restored')).toHaveText(`Version ${current + 1} created from version ${base}`)
    const restored = await getRegistryEntity(people.admin, ENTITY)
    expect(restored.version).toBe(current + 1)
    expect(restored.iban).toBe(ibanC)
    expect(restored.contacts.it).toMatch(/^Base /)
    const [newest] = await newestVersions(people.admin, 1)
    expect(newest).toMatchObject({ version: current + 1, action: 'restore', changedFields: ['contacts.it'] })

    // No notice: none written with the version, none in anybody's centre after the dispatcher has swept more than once.
    expect(noticeRows(ENTITY, current + 1)).toEqual([])
    expect(noticeRows(ENTITY, current)).toEqual([])
    await page.waitForTimeout(Math.max(0, 20_000 - (Date.now() - sentAt)))
    for (const person of [people.chManager, people.admin]) {
      expect(await hasNotice(person, ENTITY, current)).toBe(false)
      expect(await hasNotice(person, ENTITY, current + 1)).toBe(false)
    }
    expect((await snapshot()).audit).toBeGreaterThan(before.audit) // the restore itself is audited (AC-2.5)
    await context.close()
  })
})

// A closing check on the people the notices went to: the outbox of the keyboard journey held the person with no grant for no row.
test.describe('specs/20261117-legal-entities T68: who is not told (AC-9.8)', () => {
  test('a person with no grant over the entity gets no notice of a protected change', async () => {
    test.setTimeout(150_000)
    await ensureIban(freshIban())
    const sentAt = Date.now()
    const next = await saveViaApi(people.admin, (details) => {
      details.iban = freshIban()
    })
    await waitForNotice(people.chManager, ENTITY, next, sentAt)
    const rows: OutboxRow[] = await waitForOutbox(ENTITY, next, sentAt)
    expect(rowsOf(rows, people.nobody.userId)).toEqual([])
    expect(await hasNotice(people.nobody, ENTITY, next)).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// T84, amendment D9 (security re-review N1): the author is the account's EMAIL, never the display name, which any signed-in person can
// change (`POST /auth/update-user`). A dedicated persona (its own account, the `welld_ch` manager grant) does exactly that.
test.describe('specs/20261117-legal-entities T84: the notice names the author by the account email, never by the display name (AC-9.11, AC-9.12, AC-9.13)', () => {
  test.describe.configure({ mode: 'serial' })

  const SENTINEL = `Sentinel Mallory ${RUN}`
  let renamer: SeededSession

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    renamer = await setUpRenamerPersona(people.admin)
  })

  test.afterAll(async () => {
    // Whatever a journey left behind: the account as it was made, so the next run finds the same person.
    if (readAccount(renamer.userId).email !== RENAMER.email) setAccountEmail(renamer.userId, RENAMER.email)
    if (readAccount(renamer.userId).name !== RENAMER.name) await renameAccount(renamer, RENAMER.name)
  })

  test('a person renamed to a sentinel before a protected save is named by their email, in both languages and both channels; the email stays the one of the save when the account changes before the retry (AC-9.11, AC-9.12, AC-9.13)', async () => {
    test.setTimeout(300_000)
    const start = await ensureIban(freshIban())
    const next = start.version + 1
    const newIban = freshIban()

    // The person renames themself the way anybody signed in can, then makes a protected change by a direct call (the page would do the same).
    await renameAccount(renamer, SENTINEL)
    expect(readAccount(renamer.userId)).toEqual({ name: SENTINEL, email: RENAMER.email })
    // The renamed person's own email is made to fail at first (a provider failure), so that the email RETRIES, after the account has changed.
    fake?.failFor(RENAMER.email)
    const sentAt = Date.now()
    expect(
      await saveViaApi(renamer, (details) => {
        details.iban = newIban
      }),
    ).toBe(next)
    const after = await getRegistryEntity(people.admin, ENTITY)
    // The sentinel IS in the system: the history (OQ-16) shows the author by the name they had at the save. Only the notice leaves it out.
    const [newest] = await newestVersions(people.admin, 1)
    expect(newest).toMatchObject({ version: next, action: 'save', createdBy: { id: renamer.userId, name: SENTINEL } })

    // In the centre of the manager, of the administrator and of the renamed person (the receipt), within 60 s: the email, not the names.
    const names = [...PERSONA_NAMES, SENTINEL]
    const [forManager, forAdmin, forRenamer] = await Promise.all([
      waitForNotice(people.chManager, ENTITY, next, sentAt),
      waitForNotice(people.admin, ENTITY, next, sentAt),
      waitForNotice(renamer, ENTITY, next, sentAt),
    ])
    for (const found of [forManager, forAdmin, forRenamer]) {
      expect(found.elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
      expectAuthorByEmail(found.notice, RENAMER.email, 'save', names)
      expect(found.notice.title).toBe(`Legal details of ${ENTITY_NAME} changed: IBAN`)
      expect(found.notice.link?.href).toBe(`/admin/legal-entities?entity=${ENTITY}&view=history`)
      expectValueFree(found.notice, [start, after])
    }
    noteLatency('renamed persona, manager', forManager.elapsedMs)

    // The records: every row of the version holds the email the account had at the save, and no name.
    const rows = await waitForOutbox(ENTITY, next, sentAt)
    expect(rows.length).toBeGreaterThanOrEqual(6) // three people, two channels each
    expectAuthorEmailHeldWhilePending(rows, RENAMER.email, 'every row of the version')
    for (const name of names) expect(JSON.stringify(rows).includes(name), 'a display name is in the outbox').toBe(false)

    // The EMAIL, as it is sent (the words are built from that stored email): read at the fake Resend when there is one.
    if (fake === null) {
      test.info().annotations.push({
        type: 'fake-resend',
        description: 'E2E_FAKE_RESEND_PORT is not set: the rendered email was not read: only a row still pending holds the author email (T88 clears it at the terminal status), so without the fake Resend the words of the email are not proved here',
      })
    } else {
      for (const person of [people.admin, people.chManager]) {
        const email = await waitForEmail(fake, (candidate) => candidate.to.includes(person.email) && candidate.html.includes(`New version: ${next}.`), `the email of version ${next} to ${person.email}`)
        expect(email.subject).toBe(`Legal details of WellD CH changed: IBAN`)
        expect(email.html).toContain(`Change saved by the account ${RENAMER.email}.`)
        for (const name of names) expect(`${email.subject}\n${email.html}`.includes(name), 'a display name is in the email').toBe(false)
        // Never in the subject, never as a link (design N1): the address is text.
        expect(email.subject).not.toContain(RENAMER.email)
        expect(email.html).not.toContain(`mailto:`)
        for (const value of forbiddenValues(start, after)) expect(`${email.subject}\n${email.html}`.includes(value), 'a legal value is in the email').toBe(false)
      }
      // The renamed person's own email was attempted and refused by the provider; the row waits for its retry, with the reason, not given up.
      await expect.poll(() => noticeRows(ENTITY, next).find((row) => row.recipient === renamer.userId && row.channel === 'email')?.attempts ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
      const waiting = noticeRows(ENTITY, next).find((row) => row.recipient === renamer.userId && row.channel === 'email')!
      expect(waiting).toMatchObject({ status: 'pending', authorEmail: RENAMER.email })
      expect(waiting.lastReason).not.toBeNull()
      expect(fake.emails.some((email) => email.status === 500 && email.to.includes(RENAMER.email) && email.html.includes(`New version: ${next}.`))).toBe(true)
    }

    // ── After the save and before the retry: the account's email changes and the person is renamed again. Nothing the notice says follows. ──
    const moved = `le-e2e-renamer-moved-${RUN}@operai.test`
    const secondName = `${SENTINEL} Second`
    setAccountEmail(renamer.userId, moved)
    await renameAccount(renamer, secondName)
    expect(readAccount(renamer.userId)).toEqual({ name: secondName, email: moved })
    const stillStored = noticeRows(ENTITY, next)
    expectAuthorEmailHeldWhilePending(stillStored, RENAMER.email, 'the stored email did not follow the account')

    if (fake !== null) {
      fake.failFor(null)
      expect(rearmEmailNotice(ENTITY, next, renamer.userId), 'one email row was waiting for its retry').toBe(1)
      // notify-api resolves the ADDRESS TO SEND TO when it sends (the account's address now); the words are the ones of the save.
      const retried = await waitForEmail(fake, (candidate) => candidate.to.includes(moved) && candidate.html.includes(`New version: ${next}.`), `the retried email of version ${next}`, 90_000)
      expect(retried.html).toContain(`Change saved by the account ${RENAMER.email}.`)
      const sent = `${retried.subject}\n${retried.html}`
      for (const text of [moved, SENTINEL, secondName, RENAMER.name]) expect(sent.includes(text), 'the account as it is now is in the retried email').toBe(false)
      const delivered = await waitForOutbox(ENTITY, next, sentAt)
      expect(rowsOf(delivered, renamer.userId).find((row) => row.channel === 'email')).toMatchObject({ status: 'delivered', authorEmail: null })
      expect(delivered.every((row) => row.status === 'delivered')).toBe(true)
      // T88 (D9-1): once delivered, no row of the version holds the address any more.
      expect(delivered.every((row) => row.authorEmail === null), 'a delivered row still holds the author email').toBe(true)
    }

    // The notice already in the centre is the one that was stored: the same words, whoever the person is now.
    const again = (await notificationsOf(people.chManager)).find((item) => isNoticeOf(item, ENTITY, next))!
    expect(again.id).toBe(forManager.notice.id)
    expect(again.body).toBe(forManager.notice.body)
    expect(again.it?.body).toBe(forManager.notice.it?.body)

    // The e-mail deliveries notify-api recorded: addresses, a template and a status; never the name.
    const deliveries = emailDeliveriesSince(new Date(sentAt - 2_000).toISOString())
    if (deliveries !== null) {
      for (const name of names) expect(JSON.stringify(deliveries).includes(name), 'a display name is in a delivery record').toBe(false)
    }
  })

  test('an account whose email is not an address is "an account with no email address on record", never its display name (AC-9.11, R-D9a)', async () => {
    test.setTimeout(240_000)
    await ensureIban(freshIban())
    // The person is renamed, and their account holds something that is not an email address when the version is stored.
    const name = `${SENTINEL} Third`
    await renameAccount(renamer, name)
    const unusable = `not-an-address-${RUN}`
    fake?.failFor(null)
    setAccountEmail(renamer.userId, unusable)
    let next: number
    const sentAt = Date.now()
    try {
      next = await saveViaApi(renamer, (details) => {
        details.iban = freshIban()
      })
    } finally {
      setAccountEmail(renamer.userId, RENAMER.email)
    }
    const names = [...PERSONA_NAMES, SENTINEL, name]
    for (const person of [people.chManager, people.admin]) {
      const { notice, elapsedMs } = await waitForNotice(person, ENTITY, next, sentAt)
      expect(elapsedMs).toBeLessThanOrEqual(NOTICE_WITHIN_MS)
      expect(notice.body).toContain('Change saved by an account with no email address on record.')
      expect(notice.it?.body).toContain('Modifica salvata da un account senza indirizzo email registrato.')
      const everything = textOf(notice)
      for (const text of [...names, unusable]) expect(everything.includes(text), 'a name or the malformed value is in the notice').toBe(false)
      // The rest of the notice is as ever: the version, the details, the IBAN tails, the link.
      expect(notice.body).toContain(`New version: ${next}.`)
      expect(notice.body).toContain('Details changed: IBAN.')
      expect(notice.link?.href).toBe(`/admin/legal-entities?entity=${ENTITY}&view=history`)
    }
    if (fake !== null) {
      const email = await waitForEmail(fake, (candidate) => candidate.to.includes(people.chManager.email) && candidate.html.includes(`New version: ${next}.`), `the email of version ${next}`)
      expect(email.html).toContain('Change saved by an account with no email address on record.')
      for (const text of [...names, unusable]) expect(`${email.subject}\n${email.html}`.includes(text), 'a name or the malformed value is in the email').toBe(false)
    }
  })
})

/**
 * specs/20261117-legal-entities T43 — the CRM uses the registry, through the REAL assembled shell and crm-ui against the REAL
 * crm-api, `auth` (the registry), activities-api and, on the service path, letterhead-api. Nothing is stubbed or intercepted.
 *
 *   AC-6.1  the Settings page has no legal field any more: a note takes their place, with the link to Legal entities for a person
 *           who may manage the entity and the sentence "an administrator keeps it" for anyone else (also per entity)
 *   AC-6.2  after a registry save the NEXT offer prints the registry's legal name, the address in the OFFER'S language (the English
 *           address for an English offer) and the IBAN in groups of four, on the classic path (the plain letterhead's header and
 *           footer, the PDF's author) and on the service path (the wizard offers: the letterhead's footer and the body's issuer
 *           line); an offer made BEFORE the save keeps what it printed (AC-6.4)
 *   AC-6.3  an entity whose required details are not all filled in is refused: 409 `legal_entity_incomplete` naming what is
 *           missing, no offer, no number used; the wizard's Generate and the classic Generate dialog (FU-2) show the notice, with
 *           the link to Legal entities for a manager and the sentence for anyone else
 *   FU-1    on the service path a legal name too long for the letterhead's frame is refused (409 `letterhead_overflow`) and the
 *           notice points at Legal entities (link for a manager, sentence for anyone else), not at CRM Settings
 *
 * The configurator preview with the registry's details (AC-5.4) and the sample's reworded intro (FU-9) are in letterheads.spec.ts.
 *
 * ═══ ONE SPEC, TWO STACKS ═══════════════════════════════════════════════════════════════════════════════════════════
 * crm-api answers `GET /scope` with `letterheadService`: the switch. The journeys that are the CLASSIC path (welld_it's English
 * classic offers, drawn by crm-api itself) run with the switch OFF; the journeys that are the SERVICE path (the letterhead's own
 * header and footer, the overflow refusal) run with it ON (`LETTERHEAD_SERVICE_ENABLED=true`, LETTERHEAD_API_URL, and the stack of
 * crm-offer-wizard-service.spec.ts). Each skips, naming why, on the other stack: run this spec on both. The wizard's own journeys
 * (the issuer line of the body, the refusal) run on both.
 *
 * ═══ WHY THE SPEC WAITS (once per change) ═══════════════════════════════════════════════════════════════════════════════
 * crm-api reads the registry through a cache of 30 s (AC-3.3 lets a document use details up to 60 s old), so the first offer after
 * a save may still print the old details: the spec waits it out (`settle`, 31 s) before it generates. On the service path crm-api
 * also PINS the version it read and the service refuses a different one (409, one retry), which is why one offer never holds two
 * versions (asserted below: nothing of the other stage is in any PDF); it is NOT what makes a save visible sooner than the cache.
 *
 * ═══ PREREQUISITES ═════════════════════════════════════════════════════════════════════════════════════════════════════
 * The stack of crm-offer-wizard.spec.ts (switch off) or of crm-offer-wizard-service.spec.ts (switch on), plus `auth`'s
 * SERVICE_CLIENTS holding `crm-api` with `legal-entities:read` (and, on the service path, `letterhead:render`) and a
 * `letterhead-api` client with `legal-entities:read`. The global setup (T41) leaves both entities complete.
 *
 * What a run leaves behind: registry versions of both entities (they are never deleted: AC-4.3), the last one complete, with this
 * run's values; offers of welld_ch and welld_it; on the service path ONE letterhead version of welld_ch when its active one has no
 * `{iban}` line (and, while the overflow journey runs, two more: the long-header one and the restoring one). The templates and
 * drafts the run made are archived and discarded.
 *
 * The incomplete entity needs a version the registry refuses to SAVE (AC-1.2: a save without a required value is a 422, and a
 * restore of such a version too): such a version exists only as the move's import makes it, and only as version 1. So a journey
 * on an entity that already has versions cannot reach "incomplete" through the API at all (a finding for the spec, see the QE
 * report). This spec appends one straight to the database `auth` uses (the one direct access the whole suite has: `grantRole`),
 * and ends by saving the entity complete again through the API.
 *
 *  run:  cd shell && pnpm exec playwright test crm-legal-entities --trace off
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { seedUserSession } from './helpers/adminSession'
import {
  ISSUER_TEMPLATE_SOURCE,
  archiveTemplateViaApi,
  createDraftViaApi,
  crmCall,
  generateClassicOfferViaApi,
  generateWizardOfferViaApi,
  getDraftViaApi,
  listOffersViaApi,
  newRunId,
  offerAdmin,
  setFieldViaApi,
  signInContext,
  tryGenerateDraftViaApi,
  type OfferRow,
  type SeededSession,
  type TemplateRow,
} from './helpers/crmOfferFixtures'
import {
  ENTITIES,
  ensureRegistryComplete,
  getRegistryEntity,
  setUpLegalEntityPeople,
  type EntityId,
  type LegalDetails,
  type LegalEntityPeople,
} from './helpers/legalEntitiesFixtures'
import {
  createDealOf,
  createTemplateOf,
  ensureProfileOf,
  ensureServiceLetterhead,
  offerPdfPages,
  squash,
  type EntityDeal,
} from './fixtures/crmOfferService'
import {
  activeVersion,
  authCall,
  groupIban,
  ibanWithCheckDigits,
  readOptionalDetails,
  restoreOptionalDetails,
  saveVersion,
  versionConfig,
  type OptionalDetails,
} from './fixtures/letterheads'

const runId = newRunId()

test.describe.configure({ mode: 'serial' })

const WIDE = { width: 1440, height: 900 }

/** crm-api's registry cache is 30 s (`REGISTRY_FRESH_MS`); one second more, so the next offer reads the registry again. */
const REGISTRY_CACHE_MS = 31_000

/** Waits out the cache of crm-api (and, behind its pinned version, the service's) after a registry change (AC-3.3: at most 60 s). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, REGISTRY_CACHE_MS))

// ─── Registry values of this run ─────────────────────────────────────────────────────────────────────────────────────

/** A number of this run, six digits, so a value of one run cannot be mistaken for another's. */
const tail = runId.replace(/\D/g, '').slice(-6).padStart(6, '0')

/** The details of `entity` in stage `A` (before the change) or `B` (after it): every printed value differs between the two. */
function stageDetails(entity: EntityId, stage: 'A' | 'B'): LegalDetails {
  const ch = entity === 'welld_ch'
  const n = stage === 'A' ? 1 : 2
  const iban = ch
    ? ibanWithCheckDigits('CH', `00762${stage === 'A' ? '0201162' : '0201163'}${tail.slice(0, 5)}`)
    : ibanWithCheckDigits('IT', `X0542811101${'00000'}${stage === 'A' ? '0' : '1'}${tail}`)
  return {
    legalName: `${ch ? 'wellD SA' : 'wellD Italia Srl'} QE ${stage}${tail}`,
    address: {
      it: [`Via Prova ${n}${stage}`, ch ? '6900 Lugano' : '20100 Milano'],
      en: [`Test Street ${n}${stage}`, ch ? '6900 Lugano (CH)' : '20100 Milan (IT)'],
    },
    vatNumber: ch ? `CHE-${stage === 'A' ? '111' : '222'}.${tail.slice(0, 3)}.${tail.slice(3)} MWST` : `IT${stage === 'A' ? '1' : '2'}${tail}00000`.slice(0, 13),
    iban,
    contacts: { it: '', en: '' },
  }
}

/** Saves `details` as the next version of `entity` (the API a manager's page calls), retrying once on a stale base. */
async function saveDetails(admin: SeededSession, entity: EntityId, details: LegalDetails): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await getRegistryEntity(admin, entity)
    const saved = await authCall<{ version: number }>(admin, 'POST', `/legal-entities/${entity}/versions`, {
      baseVersion: read.version,
      details,
    })
    if (saved.status === 409 && attempt === 0) continue
    if (saved.status !== 200 && saved.status !== 201) {
      throw new Error(`[crm-legal-entities] saving ${entity} answered ${saved.status}: ${JSON.stringify(saved.body).slice(0, 500)}`)
    }
    return saved.body.version
  }
  throw new Error(`[crm-legal-entities] ${entity}: the registry changed under two saves in a row`)
}

const AUTH_DIR = fileURLToPath(new URL('../../auth/', import.meta.url))

/**
 * Appends to `entity` a version with no VAT number: the current details, VAT emptied, as a `save` by `author`. (The registry's
 * own CHECK reserves `import` for version 1 by the system, so a later incomplete version can only be written like this: no route
 * of `auth` writes it, which is the point of the refusal being tested.) Direct to auth's database (see the header), in one
 * transaction, as the next contiguous version. Returns the version it made.
 */
function appendIncompleteVersion(entity: EntityId, author: { id: string; name: string }): number {
  const script = `
    import { db } from ${JSON.stringify(`${AUTH_DIR}src/lib/db`)}
    const entity = ${JSON.stringify(entity)}
    const version = await db.$transaction(async (tx) => {
      const last = await tx.legalEntityVersion.findFirstOrThrow({ where: { entity }, orderBy: { version: 'desc' } })
      const row = await tx.legalEntityVersion.create({
        data: {
          entity,
          version: last.version + 1,
          legalName: last.legalName,
          addressIt: last.addressIt,
          addressEn: last.addressEn,
          vatNumber: '',
          iban: last.iban,
          contactsIt: last.contactsIt,
          contactsEn: last.contactsEn,
          action: 'save',
          changedFields: ['vatNumber'],
          createdByUserId: ${JSON.stringify(author.id)},
          createdByName: ${JSON.stringify(author.name)},
        },
      })
      return row.version
    })
    console.log(JSON.stringify({ version }))
    await db.$disconnect()
  `
  const output = execFileSync('bun', ['-e', script], { cwd: AUTH_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'))
  if (!line) throw new Error(`[crm-legal-entities] no version from the incomplete-version script: ${output.slice(0, 400)}`)
  return (JSON.parse(line) as { version: number }).version
}

/**
 * The service path prints the VAT number and the IBAN only where the letterhead has them: the default footer holds the name and
 * the address. The active letterhead of welld_ch gets two more footer lines in its centre zone, `{vat}` and `{iban}`, when it has no `{iban}` yet (a new
 * version; none when it is there already). The letterhead of welld_it is left alone (its absence is another spec's journey).
 */
async function ensureIssuerFooter(admin: SeededSession): Promise<void> {
  await ensureServiceLetterhead(admin, 'welld_ch')
  const active = (await activeVersion(admin, 'welld_ch'))!
  const config = (await versionConfig(admin, 'welld_ch', active)) as Record<string, unknown>
  if (JSON.stringify(config).includes('{iban}')) return
  const next = JSON.parse(JSON.stringify(config)) as {
    margins: { bottom: number }
    variants: { default: { footer: { center: unknown[] } } }
  }
  // room for the extra lines: the service refuses a footer taller than the bottom margin (422 `footer_overflow`)
  next.margins.bottom = Math.max(next.margins.bottom, 45)
  for (const placeholder of ['{vat}', '{iban}']) {
    next.variants.default.footer.center.push({ bold: false, color: '595c69', size: 8, text: { en: placeholder, it: placeholder } })
  }
  await saveVersion(admin, 'welld_ch', next as unknown as Record<string, unknown>)
}

// ─── People ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const OWN_ENTITY = { attributes: [{ key: 'entity', match: 'user' }] }

interface RoleRule {
  resource: string
  action: string
  conditions?: object
}

/** A person made the way an administrator makes one (admin API), with a role of this spec's own; idempotent by e-mail. */
async function makePerson(
  admin: SeededSession,
  who: { email: string; name: string; role: string; rules: RoleRule[]; entity: EntityId },
): Promise<SeededSession> {
  const first = await seedUserSession(who.email, who.name)
  const roles = await authCall<Array<{ id: string; name: string }>>(admin, 'GET', '/admin/roles')
  if (roles.status !== 200) throw new Error(`[crm-legal-entities] GET /admin/roles -> ${roles.status}`)
  let role = roles.body.find((row) => row.name === who.role)
  if (!role) {
    const created = await authCall<{ id: string; name: string }>(admin, 'POST', '/admin/roles', {
      name: who.role,
      description: 'Created by the CRM legal entities e2e (specs/20261117-legal-entities T43)',
    })
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`[crm-legal-entities] POST /admin/roles -> ${created.status}: ${JSON.stringify(created.body)}`)
    }
    role = created.body
  }
  const rules = await authCall(admin, 'PUT', `/admin/roles/${role.id}/rules`, { rules: who.rules })
  if (rules.status !== 200 && rules.status !== 204) throw new Error(`[crm-legal-entities] PUT rules -> ${rules.status}`)
  const detail = await authCall<{ entity: string | null; roles: Array<{ id: string }> }>(admin, 'GET', `/admin/users/${first.userId}`)
  const ids = new Set(detail.body.roles.map((row) => row.id))
  if (!ids.has(role.id)) {
    ids.add(role.id)
    const put = await authCall(admin, 'PUT', `/admin/users/${first.userId}/roles`, { roleIds: [...ids] })
    if (put.status !== 200 && put.status !== 204) throw new Error(`[crm-legal-entities] PUT user roles -> ${put.status}`)
  }
  if (detail.body.entity !== who.entity) {
    const patch = await authCall(admin, 'PATCH', `/admin/users/${first.userId}`, { entity: who.entity })
    if (patch.status !== 200) throw new Error(`[crm-legal-entities] PATCH user entity -> ${patch.status}`)
  }
  // minted again: the first token predates the grants and does not carry their `perm_epoch`
  return seedUserSession(who.email, who.name)
}

const CRM_BASE: RoleRule[] = [
  { resource: 'crm', action: 'access' },
  { resource: 'deal', action: 'financials' },
]

// ─── Driving the pages ───────────────────────────────────────────────────────────────────────────────────────────────

async function contextFor(browser: Browser, session: SeededSession): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: WIDE })
  await signInContext(context, session)
  return context
}

const settingsNote = (page: Page, entity: EntityId) => page.getByTestId(`crm-settings-${entity}-legal-note`)
const settingsLink = (page: Page, entity: EntityId) => page.getByTestId(`crm-settings-${entity}-legal-link`)

/** The refusal of Generate: the danger notice (`role=alert`). On the service path the preview pane holds a polite one of its own. */
const wizardNotice = (page: Page) => page.locator('[role="alert"][data-testid="crm-wizard-legal-entity-incomplete"]')
const wizardLink = (page: Page) => wizardNotice(page).getByTestId('crm-wizard-legal-entity-link')
/** The preview pane's own warning (the service path draws the pages, so it learns of the refusal first). */
const previewNotice = (page: Page) => page.getByTestId('crm-wizard-service-preview').getByTestId('crm-wizard-legal-entity-incomplete')

const generateInWizard = (page: Page) => page.getByTestId('offer-wizard-action-bar').getByRole('button', { name: 'Generate offer' })

/** What a refused generation answers: the Problem with `missing[]`. */
interface IncompleteProblem {
  code?: string
  entity?: string
  missing?: string[]
}

// ─── The journeys ────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe('specs/20261117-legal-entities T43: the CRM and the registry', () => {
  let people: LegalEntityPeople
  let crm: SeededSession
  let mixed: SeededSession
  let seller: SeededSession
  let service = false

  let itTemplate: TemplateRow
  let enTemplate: TemplateRow
  let classicTemplate: TemplateRow | null = null

  /** What each stage printed, by what made it. */
  const made: Record<string, OfferRow> = {}
  /** The IBAN and contacts of each entity before the run, given back at the end (the Legal entities journeys assume none is set). */
  const optional: Partial<Record<EntityId, OptionalDetails>> = {}
  const deals: Record<string, EntityDeal> = {}

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    people = await setUpLegalEntityPeople()
    for (const entity of ENTITIES) optional[entity] = await readOptionalDetails(people.admin, entity)
    crm = await offerAdmin()
    for (const entity of ENTITIES) await ensureProfileOf(crm, entity)

    const scope = await crmCall<{ letterheadService?: boolean }>(crm, 'GET', '/scope')
    service = scope.body.letterheadService === true

    // A deal of welld_ch may be managed by `mixed` (all entities) and by `seller` (welld_ch only); neither is an administrator.
    mixed = await makePerson(people.admin, {
      email: 'crm-le-e2e-mixed@operai.test',
      name: 'CRM Legal E2E Mixed',
      role: 'e2e-crm-legal-mixed',
      // manages every entity's deals, and the LEGAL details of its own entity (welld_ch) only
      rules: [
        ...CRM_BASE,
        { resource: 'deal', action: 'manage' },
        { resource: 'legal-entity', action: 'manage', conditions: OWN_ENTITY },
      ],
      entity: 'welld_ch',
    })
    seller = await makePerson(people.admin, {
      email: 'crm-le-e2e-seller@operai.test',
      name: 'CRM Legal E2E Seller',
      role: 'e2e-crm-legal-seller',
      rules: [...CRM_BASE, { resource: 'deal', action: 'manage', conditions: OWN_ENTITY }],
      entity: 'welld_ch',
    })

    // The wizard templates of welld_ch that print the issuer: Italian and English (the body's `[EMITTENTE]` line).
    itTemplate = await createTemplateOf(crm, 'welld_ch', `E2E legal it ${runId}`, ISSUER_TEMPLATE_SOURCE)
    const english = await crmCall<TemplateRow>(crm, 'POST', '/offer-templates', {
      entity: 'welld_ch',
      name: `E2E legal en ${runId}`,
      language: 'en',
      description: 'Created by the CRM legal entities e2e',
      uses: ['e2e'],
      source: ISSUER_TEMPLATE_SOURCE,
    })
    if (english.status !== 201 && english.status !== 200) {
      throw new Error(`[crm-legal-entities] English issuer template -> ${english.status}: ${JSON.stringify(english.body).slice(0, 400)}`)
    }
    enTemplate = english.body

    if (service) {
      await ensureIssuerFooter(people.admin)
    } else {
      const listed = await crmCall<{ items: TemplateRow[] }>(crm, 'GET', '/offer-templates?entity=welld_it&formats=sections')
      classicTemplate = listed.body.items?.find((row) => row.format === 'sections' && row.language === 'en' && !row.archived) ?? null
    }
  })

  test.afterAll(async () => {
    // Whatever happened, the registry is left complete, with the IBAN and contacts it had (versions are never deleted: these are
    // two more, the second only when the first run changed them).
    try {
      for (const entity of ENTITIES) {
        await ensureRegistryComplete(people.admin, entity)
        if (optional[entity]) await restoreOptionalDetails(people.admin, entity, optional[entity]!)
      }
    } finally {
      if (itTemplate) await archiveTemplateViaApi(crm, itTemplate.id)
      if (enTemplate) await archiveTemplateViaApi(crm, enTemplate.id)
    }
  })

  // ─── AC-6.1: Settings ──────────────────────────────────────────────────────────────────────────────────────────────

  test('Settings holds no legal field: the note, with the link for a manager of both entities (AC-6.1)', async ({ browser }) => {
    const context = await contextFor(browser, crm)
    const page = await context.newPage()
    await page.goto('/crm/settings')
    await expect(page.getByTestId('crm-settings-page')).toBeVisible({ timeout: 30_000 })

    for (const entity of ENTITIES) {
      await expect(settingsNote(page, entity)).toContainText(
        'Legal name, address, VAT number and IBAN are kept in Legal entities, not here.',
        { timeout: 30_000 },
      )
      await expect(settingsLink(page, entity)).toHaveAttribute('href', `/admin/legal-entities?entity=${entity}`)
      await expect(settingsLink(page, entity)).toHaveText('Open Legal entities')
    }

    // What the profile still holds is the CRM's own: the standard terms and the place of issue. No legal value is asked for.
    await expect(page.getByLabel('Standard terms (English)').first()).toBeVisible()
    await expect(page.getByLabel('Place of issue').first()).toBeVisible()
    for (const label of [/legal name/i, /vat number/i, /^iban/i, /^address/i]) {
      await expect(page.getByTestId('crm-settings-page').getByLabel(label)).toHaveCount(0)
    }

    // The link goes to the Legal entities page, on the entity's tab.
    await settingsLink(page, 'welld_ch').click()
    await expect(page).toHaveURL(/\/admin\/legal-entities\?entity=welld_ch/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Legal entities', level: 2 })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('tab', { name: /^WellD CH/ })).toHaveAttribute('aria-selected', 'true')
    await context.close()
  })

  test('a person who manages only welld_ch legal details gets the link for welld_ch and the sentence for welld_it (AC-6.1)', async ({ browser }) => {
    const context = await contextFor(browser, mixed)
    const page = await context.newPage()
    await page.goto('/crm/settings')
    await expect(settingsNote(page, 'welld_ch')).toBeVisible({ timeout: 30_000 })

    await expect(settingsLink(page, 'welld_ch')).toHaveAttribute('href', '/admin/legal-entities?entity=welld_ch')
    await expect(settingsNote(page, 'welld_ch')).toContainText('are kept in Legal entities, not here.')

    await expect(settingsNote(page, 'welld_it')).toContainText(
      'Legal name, address, VAT number and IBAN are kept on the Legal entities page (Admin). An administrator keeps them.',
    )
    await expect(settingsLink(page, 'welld_it')).toHaveCount(0)
    await context.close()
  })

  test('a person who holds deal:financials and manages deals but no legal details reads the sentence and gets no link (AC-6.1)', async ({ browser }) => {
    const context = await contextFor(browser, seller)
    const page = await context.newPage()
    await page.goto('/crm/settings')
    await expect(settingsNote(page, 'welld_ch')).toBeVisible({ timeout: 30_000 })

    await expect(settingsNote(page, 'welld_ch')).toContainText(
      'Legal name, address, VAT number and IBAN are kept on the Legal entities page (Admin). An administrator keeps them.',
    )
    await expect(settingsLink(page, 'welld_ch')).toHaveCount(0)
    // welld_it is not theirs to manage deals for: no section for it at all
    await expect(settingsNote(page, 'welld_it')).toHaveCount(0)
    await context.close()
  })

  // ─── AC-6.2: the offers print the registry ─────────────────────────────────────────────────────────────────────────

  /** The text an offer's PDF holds, whitespace removed (a PDF's text spacing is its drawing's, not its words'). */
  const pdfText = async (deal: EntityDeal, offer: OfferRow): Promise<string> => squash(await pdfWords(deal, offer))

  /** The same text with each run of white space as ONE space: what is needed to tell "CH93 0076" from "CH930076". */
  const pdfWords = async (deal: EntityDeal, offer: OfferRow): Promise<string> =>
    (await offerPdfPages(crm, deal.id, offer.id)).join('\n').replace(/\s+/g, ' ')

  /** A wizard offer of `template`'s language on a fresh deal of welld_ch, made through the API. */
  async function wizardOffer(label: string, template: TemplateRow): Promise<{ deal: EntityDeal; offer: OfferRow }> {
    const deal = await createDealOf(crm, 'welld_ch', label, runId)
    const offer = await generateWizardOfferViaApi(crm, deal.id, template.id, `Oggetto ${label}`)
    return { deal, offer }
  }

  const issuerLine = (details: LegalDetails, language: 'it' | 'en'): string =>
    squash(`Supplier line: ${details.legalName}, ${details.address[language].join(', ')}`)

  for (const stage of ['A', 'B'] as const) {
    test(`stage ${stage}: after the registry save the next offers print its legal name, the address in the offer's language and the grouped IBAN (AC-6.2)`, async () => {
      test.setTimeout(180_000)
      const want = Object.fromEntries(ENTITIES.map((entity) => [entity, stageDetails(entity, stage)])) as Record<EntityId, LegalDetails>
      for (const entity of ENTITIES) await saveDetails(people.admin, entity, want[entity])
      // the registry holds what was saved, IBAN printed in groups of four
      expect((await getRegistryEntity(people.admin, 'welld_ch')).ibanPrint).toBe(groupIban(want.welld_ch.iban))
      expect((await getRegistryEntity(people.admin, 'welld_it')).ibanPrint).toBe(groupIban(want.welld_it.iban))

      // crm-api's cache holds the old details for up to 30 s (AC-3.3 lets a document use details up to 60 s old)
      await settle()

      const it = await wizardOffer(`it-${stage}`, itTemplate)
      const en = await wizardOffer(`en-${stage}`, enTemplate)
      made[`it-${stage}`] = it.offer
      made[`en-${stage}`] = en.offer
      deals[`it-${stage}`] = it.deal
      deals[`en-${stage}`] = en.deal

      const ch = want.welld_ch
      const italianWords = await pdfWords(it.deal, it.offer)
      const englishWords = await pdfWords(en.deal, en.offer)
      const italian = squash(italianWords)
      expect(italian, 'Italian offer: the issuer line, in Italian').toContain(issuerLine(ch, 'it'))
      expect(italian).not.toContain(squash(ch.address.en[0]!))

      const english = squash(englishWords)
      expect(english, 'English offer: the issuer line, with the ENGLISH address').toContain(issuerLine(ch, 'en'))
      expect(english).not.toContain(squash(ch.address.it[0]!))

      if (service) {
        // The letterhead's own footer, drawn by the service: the registry's name and address (default config), and the VAT and
        // the IBAN in groups of four on the lines this spec adds (see `ensureIssuerFooter`).
        for (const [words, language] of [
          [italianWords, 'it'],
          [englishWords, 'en'],
        ] as const) {
          expect(words, `${language}: the footer's VAT number`).toContain(ch.vatNumber)
          expect(words, `${language}: the footer's IBAN in groups of four`).toContain(groupIban(ch.iban))
          expect(words, `${language}: never the electronic form`).not.toContain(ch.iban)
        }
      }
    })

    test(`stage ${stage}: a classic English offer of welld_it prints the registry in its plain letterhead: name, the English address, VAT and the grouped IBAN (AC-6.2)`, async () => {
      test.skip(service, 'the classic path is the stack without the letterhead service: run this spec there')
      test.skip(classicTemplate === null, 'welld_it has no active classic English template to make an offer from')
      test.setTimeout(120_000)
      const want = stageDetails('welld_it', stage)
      const deal = await createDealOf(crm, 'welld_it', `classic-${stage}`, runId)
      const offer = await generateClassicOfferViaApi(crm, deal.id, classicTemplate!)
      expect(offer.origin).toBe('sections')
      deals[`classic-${stage}`] = deal
      made[`classic-${stage}`] = offer

      const words = await pdfWords(deal, offer)
      const text = squash(words)
      expect(text, 'the legal name').toContain(squash(want.legalName))
      expect(text, "the address in the OFFER'S language (English)").toContain(squash(want.address.en.join('')))
      expect(text, 'not the Italian address').not.toContain(squash(want.address.it[0]!))
      expect(text, 'the VAT number').toContain(squash(`VAT ${want.vatNumber}`))
      expect(words, 'the IBAN in groups of four').toContain(`IBAN ${groupIban(want.iban)}`)
      expect(words, 'the electronic form is not what prints').not.toContain(want.iban)
    })
  }

  test('an offer made before the change keeps what it printed; the next one prints the change and never both (AC-6.4, AC-6.2)', async () => {
    const a = stageDetails('welld_ch', 'A')
    const b = stageDetails('welld_ch', 'B')
    for (const key of ['it', 'en'] as const) {
      const before = await pdfText(deals[`${key}-A`]!, made[`${key}-A`]!)
      const after = await pdfText(deals[`${key}-B`]!, made[`${key}-B`]!)
      // A: still A's name, nothing of B (read again now: the stored document is the record)
      expect(before).toContain(squash(a.legalName))
      expect(before).not.toContain(squash(b.legalName))
      expect(before).not.toContain(squash(b.address[key][0]!))
      // B: B's name, nothing of A
      expect(after).toContain(squash(b.legalName))
      expect(after).not.toContain(squash(a.legalName))
      expect(after).not.toContain(squash(a.address[key][0]!))
    }
    if (!service && classicTemplate) {
      const a2 = await pdfText(deals['classic-A']!, made['classic-A']!)
      const b2 = await pdfText(deals['classic-B']!, made['classic-B']!)
      expect(a2).toContain(squash(stageDetails('welld_it', 'A').legalName))
      expect(a2).not.toContain(squash(stageDetails('welld_it', 'B').legalName))
      expect(b2).toContain(squash(stageDetails('welld_it', 'B').legalName))
      expect(b2).not.toContain(squash(stageDetails('welld_it', 'A').legalName))
    }
  })

  // ─── AC-6.3: an incomplete entity ──────────────────────────────────────────────────────────────────────────────────

  test.describe('an incomplete entity is refused with the notice (AC-6.3, FU-2)', () => {
    let deal: EntityDeal
    let classicDeal: EntityDeal

    test.beforeAll(async () => {
      test.setTimeout(180_000)
      // the drafts and deals made while the entities are still complete, so the refusals are what is under test
      deal = await createDealOf(crm, 'welld_ch', 'incomplete', runId)
      const draft = await createDraftViaApi(crm, deal.id, itTemplate.id)
      await setFieldViaApi(crm, deal.id, draft, 'OGGETTO', 'Oggetto incompleto')
      classicDeal = await createDealOf(crm, 'welld_it', 'incomplete-classic', runId)

      for (const entity of ENTITIES) appendIncompleteVersion(entity, { id: people.admin.userId, name: 'Legal Entities E2E Admin' })
      for (const entity of ENTITIES) {
        const read = await getRegistryEntity(people.admin, entity)
        expect(read.complete, `${entity} is now incomplete`).toBe(false)
        expect(read.missing).toEqual(['vatNumber'])
      }
      await settle()
    })

    test.afterAll(async () => {
      for (const entity of ENTITIES) await ensureRegistryComplete(people.admin, entity)
      await discardDraft(deal)
    })

    const discardDraft = async (target: EntityDeal | undefined): Promise<void> => {
      if (!target) return
      const draft = await getDraftViaApi(crm, target.id).catch(() => null)
      if (draft) await crmCall(crm, 'DELETE', `/deals/${target.id}/offer-draft`, undefined, { 'If-Match': `"${draft.version}"` })
    }

    test('the service refuses: 409 legal_entity_incomplete naming the missing detail; no offer, no number, the draft as it was', async () => {
      const offersBefore = (await listOffersViaApi(crm, deal.id)).length
      const draftBefore = (await getDraftViaApi(crm, deal.id))!
      const refused = await tryGenerateDraftViaApi(crm, deal.id, draftBefore.version)
      expect(refused.status).toBe(409)
      const problem = refused.body as IncompleteProblem
      expect(problem.code).toBe('legal_entity_incomplete')
      expect(problem.missing).toEqual(['vatNumber'])
      expect(JSON.stringify(refused.body)).not.toContain(stageDetails('welld_ch', 'B').legalName)

      expect((await listOffersViaApi(crm, deal.id)).length).toBe(offersBefore)
      const draftAfter = (await getDraftViaApi(crm, deal.id))!
      expect(draftAfter.version).toBe(draftBefore.version)
      expect(draftAfter.answers.fields['OGGETTO']).toBe('Oggetto incompleto')
    })

    test("the wizard's Generate shows the notice naming the VAT number, with the link to Legal entities for a manager (AC-6.3)", async ({ browser }) => {
      const context = await contextFor(browser, crm)
      const page = await context.newPage()
      await page.goto(`/crm/deals/${deal.id}/offer?step=preview`)
      await expect(generateInWizard(page)).toBeVisible({ timeout: 30_000 })
      await generateInWizard(page).click()

      const notice = wizardNotice(page)
      await expect(notice).toBeVisible({ timeout: 30_000 })
      await expect(notice).toContainText('The legal details of wellD CH are incomplete')
      await expect(notice).toContainText('No offer was created.')
      await expect(notice).toContainText('Missing: VAT number.')
      await expect(notice).toContainText('Fill them in on the Legal entities page, then try again.')
      await expect(wizardLink(page)).toHaveAttribute('href', '/admin/legal-entities?entity=welld_ch')
      if (service) {
        // the service path's preview says it too, as a polite status that offers the same way out
        await expect(previewNotice(page)).toHaveAttribute('role', 'status')
        await expect(previewNotice(page)).toContainText('Missing: VAT number.')
        await expect(previewNotice(page).getByTestId('crm-wizard-legal-entity-link')).toHaveAttribute('href', '/admin/legal-entities?entity=welld_ch')
      }
      // nothing was generated, and the person is still on the draft
      expect((await listOffersViaApi(crm, deal.id)).filter((offer) => !offer.deleted)).toHaveLength(0)
      expect(await getDraftViaApi(crm, deal.id)).not.toBeNull()
      await context.close()
    })

    test('a person who manages no legal details reads the same notice with the sentence and no link (AC-6.3)', async ({ browser }) => {
      const context = await contextFor(browser, seller)
      const page = await context.newPage()
      await page.goto(`/crm/deals/${deal.id}/offer?step=preview`)
      await expect(generateInWizard(page)).toBeVisible({ timeout: 30_000 })
      await generateInWizard(page).click()

      const notice = wizardNotice(page)
      await expect(notice).toBeVisible({ timeout: 30_000 })
      await expect(notice).toContainText('Missing: VAT number.')
      await expect(notice).toContainText('Ask an administrator who keeps the Legal entities page to fill them in.')
      await expect(wizardLink(page)).toHaveCount(0)
      await context.close()
    })

    test('the classic Generate dialog shows the notice, with the link for a manager (FU-2)', async ({ browser }) => {
      test.skip(service, 'the classic dialog on welld_it needs its letterhead in the service; this journey runs on the classic stack')
      test.skip(classicTemplate === null, 'welld_it has no active classic English template to open the dialog on')
      test.setTimeout(90_000)
      const context = await contextFor(browser, crm)
      const page = await context.newPage()
      await page.goto(`/crm/deals/${classicDeal.id}`)
      await expect(page.getByTestId('crm-offers-card')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('crm-offer-generate').click()

      const dialog = page.getByRole('dialog', { name: 'Generate an offer' })
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByLabel('Template').selectOption(classicTemplate!.id)
      // the refusal comes with the template's prefill (the draft of a classic offer needs the issuer): the form never appears

      const notice = dialog.getByTestId('crm-wizard-legal-entity-incomplete')
      await expect(notice).toBeVisible({ timeout: 30_000 })
      await expect(notice).toContainText('The legal details of wellD IT are incomplete')
      await expect(notice).toContainText('Missing: VAT number.')
      await expect(dialog.getByTestId('crm-wizard-legal-entity-link')).toHaveAttribute('href', '/admin/legal-entities?entity=welld_it')
      // no offer was made and the dialog is still open, with nothing to generate
      expect((await listOffersViaApi(crm, classicDeal.id)).filter((offer) => !offer.deleted)).toHaveLength(0)
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Generate offer' })).toBeDisabled()
      await context.close()
    })

    test('the classic dialog says the sentence and offers no link to a person who manages no legal details (FU-2)', async ({ browser }) => {
      test.skip(service, 'runs on the classic stack')
      test.skip(classicTemplate === null, 'welld_it has no active classic English template to open the dialog on')
      test.setTimeout(90_000)
      // `mixed` manages welld_it deals but its legal details are welld_ch's alone
      const context = await contextFor(browser, mixed)
      const page = await context.newPage()
      await page.goto(`/crm/deals/${classicDeal.id}`)
      await expect(page.getByTestId('crm-offers-card')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('crm-offer-generate').click()
      const dialog = page.getByRole('dialog', { name: 'Generate an offer' })
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByLabel('Template').selectOption(classicTemplate!.id)
      // the refusal comes with the template's prefill (the draft of a classic offer needs the issuer): the form never appears

      const notice = dialog.getByTestId('crm-wizard-legal-entity-incomplete')
      await expect(notice).toBeVisible({ timeout: 30_000 })
      await expect(notice).toContainText('Ask an administrator who keeps the Legal entities page to fill them in.')
      await expect(dialog.getByTestId('crm-wizard-legal-entity-link')).toHaveCount(0)
      await context.close()
    })

    test('saved complete again, the same draft generates (the refusal was the registry, nothing else)', async () => {
      test.setTimeout(90_000)
      for (const entity of ENTITIES) await ensureRegistryComplete(people.admin, entity)
      const read = await getRegistryEntity(people.admin, 'welld_ch')
      expect(read.complete).toBe(true)
      const draft = (await getDraftViaApi(crm, deal.id))!
      // the cache of crm-api may still hold the incomplete details for up to 30 s
      await settle()
      const generated = await tryGenerateDraftViaApi(crm, deal.id, draft.version)
      expect(generated.status, JSON.stringify(generated.body).slice(0, 300)).toBeLessThan(300)
    })
  })

  // ─── FU-1: an overflowing legal name (service path) ────────────────────────────────────────────────────────────────

  test.describe('an overflowing legal name points at Legal entities (FU-1)', () => {
    let restoreConfig: Record<string, unknown> | null = null
    let deal: EntityDeal

    test.beforeAll(async () => {
      test.setTimeout(120_000)
      if (!service) return
      deal = await createDealOf(crm, 'welld_ch', 'overflow', runId)
      const draft = await createDraftViaApi(crm, deal.id, itTemplate.id)
      await setFieldViaApi(crm, deal.id, draft, 'OGGETTO', 'Oggetto troppo lungo')
    })

    test.afterAll(async () => {
      if (!service || restoreConfig === null) return
      // the letterhead as it was (a new version: versions are never deleted), and a legal name that fits
      await saveVersion(people.admin, 'welld_ch', restoreConfig)
      await saveDetails(people.admin, 'welld_ch', stageDetails('welld_ch', 'B'))
    })

    test('a legal name that does not fit the letterhead refuses Generate, and the notice offers Legal entities (a manager) or the sentence (anyone else)', async ({
      browser,
    }) => {
      test.skip(!service, 'the overflow is the letterhead service\'s: this journey runs on the service stack')
      test.setTimeout(240_000)
      const active = (await activeVersion(people.admin, 'welld_ch'))!
      restoreConfig = (await versionConfig(people.admin, 'welld_ch', active)) as Record<string, unknown>

      // Header: the legal name alone in the left zone at the largest size, under a 40 mm top margin. The 40 characters a save is
      // tried with fit; a 200-character name (the registry's longest) runs to more lines than a zone may hold and does not.
      const line = { bold: true, color: '1f2430', size: 14, text: { en: '{legal_name}', it: '{legal_name}' } }
      const narrow = JSON.parse(JSON.stringify(restoreConfig)) as {
        margins: { top: number }
        variants: { default: { header: Record<string, unknown> } }
      }
      narrow.margins.top = 40
      narrow.variants.default.header = { ...narrow.variants.default.header, left: [line], center: [], right: [] }
      await saveVersion(people.admin, 'welld_ch', narrow as unknown as Record<string, unknown>)

      const longName = 'W'.repeat(200)
      await saveDetails(people.admin, 'welld_ch', { ...stageDetails('welld_ch', 'B'), legalName: longName })
      await settle()

      // The service itself says so (409 letterhead_overflow), and crm-api passes it on.
      const refused = await tryGenerateDraftViaApi(crm, deal.id, (await getDraftViaApi(crm, deal.id))!.version)
      expect(refused.status).toBe(409)
      expect((refused.body as { code?: string }).code).toBe('letterhead_overflow')

      // A manager: the notice names the frame and says where the value is kept, with Open Legal entities (and Open Letterheads).
      const context = await contextFor(browser, crm)
      const page = await context.newPage()
      await page.goto(`/crm/deals/${deal.id}/offer?step=preview`)
      await expect(generateInWizard(page)).toBeVisible({ timeout: 30_000 })
      await generateInWizard(page).click()
      const notice = page.getByTestId('crm-wizard-letterhead-overflow')
      await expect(notice).toBeVisible({ timeout: 30_000 })
      await expect(notice).toContainText("does not fit the letterhead's header")
      await expect(notice).toContainText('Shorten the value on the Legal entities page')
      await expect(notice).not.toContainText('CRM Settings')
      await expect(page.getByTestId('crm-wizard-letterhead-overflow-legal-entity-link')).toHaveAttribute(
        'href',
        '/admin/legal-entities?entity=welld_ch',
      )
      await context.close()

      // Anyone else: the sentence naming the page an administrator keeps, no link to it.
      const other = await contextFor(browser, seller)
      const otherPage = await other.newPage()
      await otherPage.goto(`/crm/deals/${deal.id}/offer?step=preview`)
      await expect(generateInWizard(otherPage)).toBeVisible({ timeout: 30_000 })
      await generateInWizard(otherPage).click()
      const sentence = otherPage.getByTestId('crm-wizard-letterhead-overflow')
      await expect(sentence).toBeVisible({ timeout: 30_000 })
      await expect(sentence).toContainText('Ask an administrator who keeps the Legal entities page to shorten the value')
      await expect(sentence).not.toContainText('CRM Settings')
      await expect(otherPage.getByTestId('crm-wizard-letterhead-overflow-legal-entity-link')).toHaveCount(0)
      await other.close()
    })
  })
})

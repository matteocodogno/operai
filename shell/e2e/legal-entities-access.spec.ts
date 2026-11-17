/**
 * specs/20261117-legal-entities T42 — who reaches the Legal entities page, and how the grant is made, through the REAL
 * shell, admin-ui, and `auth` (nothing is stubbed: the people are made by helpers/legalEntitiesFixtures.ts exactly as an
 * administrator makes them, and the global setup (e2e/global-setup.ts) leaves the registry in order).
 *
 *   AC-4.3  a person who holds `legal-entity:manage` for at least one entity sees the Admin tool with the Legal entities
 *           section ONLY (no Roles / Departments / Users / Audit: absent, not disabled), the entities they may change
 *           editable and the others read-only; the URLs of the sections they may not use redirect to Legal entities
 *   AC-4.2  without the permission for an entity, a save and a restore are refused (403) and nothing changes; the
 *           person can still read it
 *   AC-3.1  a person with no grant sees no Admin tool, and reads the details of both entities through `GET /legal-entities`
 *           (a request that is not signed in is refused)
 *   AC-4.1  an administrator edits `legal-entity:manage` in the role editor, conditioned (the entity the person belongs
 *           to) and unconditioned (every entity); the grant cannot name another entity than the person's own (D6)
 *   AC-8.1  `axeViolations` is 0 on the read-only screen and in the role editor with the new rule
 *
 * Prerequisites: playwright.config.ts's header (item 10): `auth` with ENABLE_TEST_AUTH=true, migrated and seeded; the global
 * setup makes the registry and the three people. The journeys of the page itself are legal-entities.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import { authCall, contextFor } from './fixtures/letterheads'
import { axeViolations } from './helpers/meetingsFixtures'
import { seedUserSession, type SeededSession } from './helpers/adminSession'
import {
  getRegistryEntity,
  listRegistry,
  setUpLegalEntityPeople,
  type EntityId,
  type LegalEntityPeople,
} from './helpers/legalEntitiesFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = Date.now().toString(36)
let people: LegalEntityPeople

test.beforeAll(async () => {
  test.setTimeout(180_000)
  people = await setUpLegalEntityPeople()
})

const toolNav = (page: Page) => page.getByRole('navigation', { name: 'Tool navigation' })
const adminSections = (page: Page) => page.getByRole('navigation', { name: 'Admin sections' })
const entityTab = (page: Page, name: 'WellD Italia' | 'WellD CH') =>
  page.getByRole('tablist', { name: 'Legal entities' }).getByRole('tab', { name: new RegExp(`^${name},`) })

async function expectNoAxeViolations(page: Page, label: string, include?: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
  const violations = await axeViolations(page, include)
  expect(
    violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    `axe violations on ${label}`,
  ).toEqual([])
}

interface VersionItem {
  version: number
}
const versionsOf = async (session: SeededSession, entity: EntityId): Promise<number[]> => {
  const result = await authCall<{ items: VersionItem[] }>(session, 'GET', `/legal-entities/${entity}/versions`)
  expect(result.status).toBe(200)
  return result.body.items.map((item) => item.version)
}

test.describe('specs/20261117-legal-entities T42: reach the page by capability (AC-4.3, AC-4.2)', () => {
  test('a welld_ch manager sees Admin with only Legal entities: welld_ch editable, welld_it read-only, the admin URLs redirect (AC-4.3)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const context = await contextFor(browser, people.chManager)
    const page = await context.newPage()

    // The Admin tool is in the suite for a person who holds no `admin:access`, by the capability alone.
    await page.goto('/')
    const adminLink = toolNav(page).getByRole('link', { name: 'Admin', exact: true })
    await expect(adminLink).toBeVisible({ timeout: 30_000 })
    await adminLink.click()

    // The index lands on the one section they may use, and the strip lists only that one.
    await expect(page).toHaveURL(/\/admin\/legal-entities/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Legal entities', level: 2 })).toBeVisible({ timeout: 30_000 })
    const links = adminSections(page).getByRole('link')
    await expect(links).toHaveCount(1)
    await expect(links.first()).toHaveText('Legal entities')
    await expect(links.first()).toHaveAttribute('aria-current', 'page')
    for (const hidden of ['Roles', 'Departments', 'Users', 'Audit']) {
      await expect(adminSections(page).getByRole('link', { name: hidden, exact: true }), `${hidden} is absent, not disabled`).toHaveCount(0)
    }

    // welld_ch: the one they manage, selected by default, editable (the form), no read-only mark.
    await expect(entityTab(page, 'WellD CH')).toHaveAttribute('aria-selected', 'true')
    await expect(entityTab(page, 'WellD CH')).not.toHaveAccessibleName(/Read-only/)
    await expect(page.getByTestId('admin-legal-form')).toBeVisible()
    await expect(page.getByTestId('admin-legal-input-legalName')).toBeEditable()
    await expect(page.getByRole('button', { name: /^Save as version \d+$/ })).toBeVisible()
    await expect(page.getByTestId('admin-legal-entity-readonly-note')).toHaveCount(0)

    // welld_it: listed, marked read-only in the tab's own name, the values as facts: no input, no Save.
    await expect(entityTab(page, 'WellD Italia')).toHaveAccessibleName(/^WellD Italia, .*Read-only/)
    await entityTab(page, 'WellD Italia').click()
    await expect(page).toHaveURL(/entity=welld_it/)
    const panel = page.getByTestId('admin-legal-entity-panel-welld_it')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'WellD Italia', level: 3 })).toBeVisible()
    await expect(page.getByTestId('admin-legal-entity-facts')).toBeVisible()
    await expect(page.getByTestId('admin-legal-form')).toHaveCount(0)
    await expect(panel.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Save as version/ })).toHaveCount(0)
    await expect(panel.getByText('Read-only', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('admin-legal-entity-readonly-note')).toContainText('You can read these details but not change them')
    // The values are there to read (AC-4.2: "they can still read it").
    const itDetails = await getRegistryEntity(people.chManager, 'welld_it')
    await expect(page.getByTestId('admin-legal-fact-legalName')).toHaveText(itDetails.legalName)
    await expectNoAxeViolations(page, 'the read-only entity (S4)', 'main')

    // Every other section's URL, typed or followed, leads to Legal entities: the page for the sections they may not use is never shown.
    for (const path of ['/admin', '/admin/roles', '/admin/departments', '/admin/users', '/admin/audit', '/admin/roles/anything']) {
      await page.goto(path)
      await expect.poll(() => new URL(page.url()).pathname, { message: `${path} leads to Legal entities`, timeout: 30_000 }).toBe('/admin/legal-entities')
      await expect(page.getByRole('heading', { name: 'Legal entities', level: 2 })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('heading', { name: 'Roles', level: 2 })).toHaveCount(0)
    }
    await context.close()
  })

  test('the service itself holds the line for the manager: welld_it cannot be saved or restored and nothing changes, it can still be read (AC-4.2)', async () => {
    const before = await getRegistryEntity(people.chManager, 'welld_it')
    const versionsBefore = await versionsOf(people.chManager, 'welld_it')

    const manageable = await authCall<{ entities: EntityId[] }>(people.chManager, 'GET', '/legal-entities/manageable')
    expect(manageable.status).toBe(200)
    expect(manageable.body.entities).toEqual(['welld_ch'])

    const details = {
      legalName: before.legalName,
      address: before.address,
      vatNumber: before.vatNumber,
      iban: before.iban,
      contacts: { it: `refused ${RUN}`, en: before.contacts.en },
    }
    const save = await authCall(people.chManager, 'POST', '/legal-entities/welld_it/versions', { baseVersion: before.version, details })
    expect(save.status).toBe(403)
    const restore = await authCall(people.chManager, 'POST', `/legal-entities/welld_it/versions/${versionsBefore[versionsBefore.length - 1]}/restore`, {
      baseVersion: before.version,
    })
    expect(restore.status).toBe(403)

    // Nothing changed, and the person reads it exactly as before.
    const after = await getRegistryEntity(people.chManager, 'welld_it')
    expect(after).toEqual(before)
    expect(await versionsOf(people.admin, 'welld_it')).toEqual(versionsBefore)
  })

  test('a person with no grant sees no Admin tool, is sent away from it, and reads both entities through GET /legal-entities (AC-3.1, AC-4.3)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const context = await contextFor(browser, people.nobody)
    const page = await context.newPage()
    await page.goto('/')
    await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
    await expect(toolNav(page).getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)

    for (const path of ['/admin', '/admin/legal-entities', '/admin/legal-entities?entity=welld_ch', '/admin/roles']) {
      await page.goto(path)
      await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => new URL(page.url()).pathname, { message: `${path} is left`, timeout: 30_000 }).not.toMatch(/^\/admin/)
      await expect(page.getByRole('heading', { name: 'Legal entities', level: 2 })).toHaveCount(0)
      await expect(page.getByTestId('admin-legal-form')).toHaveCount(0)
    }
    await context.close()

    // The details are readable by anyone signed in, whatever their role (AC-3.1), both entities, in a fixed order.
    const list = await listRegistry(people.nobody)
    expect(list.map((entity) => entity.entity)).toEqual(['welld_it', 'welld_ch'])
    for (const entity of list) {
      const one = await getRegistryEntity(people.nobody, entity.entity)
      expect(one).toEqual(entity)
      expect(one.legalName).not.toBe('')
      expect(one.address.it.length).toBeGreaterThan(0)
      expect(one.address.en.length).toBeGreaterThan(0)
      expect(one.vatNumber).not.toBe('')
      expect(one.complete).toBe(true)
    }
    // A request that is not signed in is refused, and an unknown entity is said to be unknown and nothing else (AC-3.1, AC-3.4).
    const authUrl = (process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
    expect((await fetch(`${authUrl}/legal-entities`)).status).toBe(401)
    expect((await fetch(`${authUrl}/legal-entities/welld_ch`)).status).toBe(401)
    expect((await authCall(people.nobody, 'GET', '/legal-entities/welld_xx')).status).toBe(404)

    // They manage nothing: the list is empty and a write is refused, nothing changes.
    const manageable = await authCall<{ entities: EntityId[] }>(people.nobody, 'GET', '/legal-entities/manageable')
    expect(manageable.status).toBe(200)
    expect(manageable.body.entities).toEqual([])
    const ch = list.find((entity) => entity.entity === 'welld_ch')!
    const save = await authCall(people.nobody, 'POST', '/legal-entities/welld_ch/versions', {
      baseVersion: ch.version,
      details: { legalName: ch.legalName, address: ch.address, vatNumber: ch.vatNumber, iban: ch.iban, contacts: { it: `nobody ${RUN}`, en: '' } },
    })
    expect(save.status).toBe(403)
    expect(await getRegistryEntity(people.nobody, 'welld_ch')).toEqual(ch)
  })
})

test.describe('specs/20261117-legal-entities T42: the grant in the role editor (AC-4.1)', () => {
  let roleId = ''
  let holder: SeededSession | undefined

  test.afterAll(async () => {
    // Best effort: leave no role behind. The registry itself is append-only and untouched by this describe.
    try {
      if (holder && roleId) await authCall(people.admin, 'PUT', `/admin/users/${holder.userId}/roles`, { roleIds: [] })
      if (roleId) await authCall(people.admin, 'DELETE', `/admin/roles/${roleId}`)
    } catch {
      // nothing to do
    }
  })

  const rulesOf = async (): Promise<Array<{ resource: string; action: string; conditions: unknown }>> => {
    const detail = await authCall<{ rules: Array<{ resource: string; action: string; conditions: unknown }> }>(people.admin, 'GET', `/admin/roles/${roleId}`)
    expect(detail.status).toBe(200)
    // Each stored rule also carries its id: the journey compares what it asked for.
    return detail.body.rules.map(({ resource, action, conditions }) => ({ resource, action, conditions }))
  }
  const manageableFor = async (session: SeededSession): Promise<EntityId[]> => {
    const result = await authCall<{ entities: EntityId[] }>(session, 'GET', '/legal-entities/manageable')
    expect(result.status).toBe(200)
    return [...result.body.entities].sort()
  }

  test('an administrator adds legal-entity:manage conditioned on the person\'s own entity, then replaces it with the unconditioned one (AC-4.1)', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()

    // A role of its own, made as an administrator makes one.
    await page.goto('/admin/roles')
    await expect(page.getByTestId('admin-roles-page')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('roles-new-button').click()
    await expect(page.getByTestId('create-role-modal')).toBeVisible()
    await page.getByTestId('create-role-name').fill(`e2e-legal-entity-manager-${RUN}`)
    await page.getByTestId('create-role-submit').click()
    await expect(page.getByTestId('role-editor-page')).toBeVisible({ timeout: 30_000 })
    await page.waitForURL(/\/admin\/roles\/[^/]+$/)
    roleId = page.url().split('/').pop()!

    // The composer: the Admin tool's two resources are in the catalog; `legal-entity:manage` offers the Entity condition only.
    await page.getByTestId('rule-composer-toggle').click()
    await expect(page.getByTestId('rule-composer')).toBeVisible()
    await page.getByTestId('rule-composer-resource').selectOption('admin::legal-entity')
    await page.getByTestId('rule-composer-action').selectOption('manage')
    const entityCondition = page.getByTestId('rule-composer-attr-entity')
    await expect(entityCondition).toBeVisible()
    await expect(entityCondition).not.toBeChecked()
    await expect(page.getByTestId('rule-composer-attr-department')).toHaveCount(0)
    await expect(page.getByTestId('rule-composer-attr-jobTitle')).toHaveCount(0)
    await expect(page.getByTestId('rule-composer-self-approval')).toHaveCount(0)
    // The grant is "the person's own entity", never a pick of one: there is no entity chooser to name welld_it or welld_ch (D6).
    await expect(page.getByTestId('rule-composer').getByRole('combobox')).toHaveCount(2)
    await entityCondition.check()
    await page.getByTestId('rule-composer-add').click()
    await expect(page.getByTestId('rule-composer')).toHaveCount(0)
    await expect(page.getByTestId('role-rules-list').locator('[data-testid="condition-chip-entity"]')).toBeVisible()
    await page.getByTestId('role-save-rules').click()
    await expect(page.getByTestId('role-rules-success')).toBeVisible({ timeout: 15_000 })

    // What was stored: `legal-entity:manage` with the entity attribute matched to the user.
    expect(await rulesOf()).toEqual([
      { resource: 'legal-entity', action: 'manage', conditions: { attributes: [{ key: 'entity', match: 'user' }] } },
    ])
    await expectNoAxeViolations(page, 'the role editor with the conditioned rule', 'main')

    // Remove it and add the unconditioned one: every entity.
    await page.getByTestId('role-rule-remove-0').click()
    await expect(page.getByTestId('role-rules-list')).toHaveCount(0)
    await page.getByTestId('rule-composer-toggle').click()
    await page.getByTestId('rule-composer-resource').selectOption('admin::legal-entity')
    await page.getByTestId('rule-composer-action').selectOption('manage')
    await expect(page.getByTestId('rule-composer-attr-entity')).not.toBeChecked()
    await page.getByTestId('rule-composer-add').click()
    await expect(page.getByTestId('role-rules-list')).toBeVisible()
    await expect(page.getByTestId('role-rules-list').locator('[data-testid="condition-chip-entity"]')).toHaveCount(0)
    await page.getByTestId('role-save-rules').click()
    await expect(page.getByTestId('role-rules-success')).toBeVisible({ timeout: 15_000 })
    const stored = await rulesOf()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ resource: 'legal-entity', action: 'manage' })
    // Unconditioned: no condition at all (null or absent), never an empty attribute list standing for "everyone".
    expect(stored[0]!.conditions ?? null).toBeNull()
    await expectNoAxeViolations(page, 'the role editor with the unconditioned rule', 'main')
    await context.close()
  })

  test('the stored grant does what it says: conditioned it covers the person\'s own entity only, unconditioned it covers both (AC-4.1, AC-4.3)', async () => {
    holder = await seedUserSession(`le-e2e-role-holder-${RUN}@operai.test`, 'Legal Entities E2E Role Holder')
    const detail = await authCall<{ roles: Array<{ id: string }> }>(people.admin, 'GET', `/admin/users/${holder.userId}`)
    expect(detail.status).toBe(200)
    const assign = (ids: string[]) => authCall(people.admin, 'PUT', `/admin/users/${holder!.userId}/roles`, { roleIds: ids })
    const baseline = detail.body.roles.map((role) => role.id)

    // The role as the previous test left it is unconditioned: both entities, whoever the person belongs to.
    expect((await assign([...baseline, roleId])).status).toBeLessThan(300)
    expect(await manageableFor(holder)).toEqual(['welld_ch', 'welld_it'])

    // Put the conditioned rule back (the editor's own endpoint, which the previous test used through the screen).
    const conditioned = await authCall(people.admin, 'PUT', `/admin/roles/${roleId}/rules`, {
      rules: [{ resource: 'legal-entity', action: 'manage', conditions: { attributes: [{ key: 'entity', match: 'user' }] } }],
    })
    expect(conditioned.status).toBeLessThan(300)
    // A person who belongs to no entity matches nothing: the grant cannot name one for them.
    expect(await manageableFor(holder)).toEqual([])
    expect((await authCall(holder, 'POST', '/legal-entities/welld_it/versions', { baseVersion: 1, details: {} })).status).toBe(403)
    for (const entity of ['welld_it', 'welld_ch'] as const) {
      expect((await authCall(people.admin, 'PATCH', `/admin/users/${holder.userId}`, { entity })).status).toBeLessThan(300)
      expect(await manageableFor(holder), `belongs to ${entity}`).toEqual([entity])
    }
  })
})

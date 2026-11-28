/**
 * QE pass 1 of specs/20261112-project-hours — journeys the T18 spec leaves to fake owners, here against the REAL owners
 * (projects-api, crm-api, meetings-api, hours-api), nothing stubbed:
 *
 *  A. The other consumption variants as a person meets them: an exceeded yearly package says "Over by" (AC-1.1, D81), a capacity
 *     package past its expiry says Expired beside its dates (AC-1.9, D83), a fixed price shows man-days against its estimate and
 *     max effort (AC-1.4, AC-1.6), time and material against the total of its positions (AC-1.5), terms with no hour package show
 *     no block, only the total (AC-1.7), and no amount appears anywhere (AC-1.8).
 *  B. The deal's Hours card: everyone who reads the deal sees its total INCLUDING the meeting linked to it (AC-2.2); only its owner
 *     sees the hours per person (AC-2.4, AC-2.5); Record hours on the deal page grows the total without a reload (AC-2.8).
 *  C. A meeting linked to a project counts for it, follows a relink, and is named to a viewer only if they can read the project
 *     (AC-4.1, AC-4.2, AC-4.5, AC-4.6, AC-4.7): the summary, the by-project totals, the Entries line and the downloaded file of a
 *     person who cannot read the project never carry its name or id, and the file summed by Counts for project equals the by-project
 *     totals of the person who can.
 *
 * People are per-run (`php-*@operai.test`); every entry and meeting is removed afterwards (a person deletes only their own). The
 * company and the projects cannot be deleted from here, like the other specs. Needs the stack of project-hours.spec.ts.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  cleanupPeople,
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  hoursAdmin,
  hoursCall,
  minutesOfShort,
  newRunId,
  personContext,
  seedHoursPerson,
  todayZurich,
  type HoursPerson,
} from './helpers/hoursFixtures'
import {
  addDaysTo,
  createCompanyViaApi,
  createDealOwnedBy,
  createMeetingViaApi,
  deleteMeetingQuietly,
  firstOfMonthShifted,
  projectSummaryViaApi,
  readHoursExport,
  yearlyPackageAround,
  type CompanyRow,
  type DealRow,
} from './helpers/hoursOwnersFixtures'
import { apiCall, PROJECTS_API_URL } from './helpers/activitiesFixtures'
import { MEETINGS_API_URL, setParticipants } from './helpers/meetingsFixtures'
import type { SeededSession } from './helpers/adminSession'

const runId = newRunId()
const today = todayZurich()
const PREFIX = 'php' as const
const SALES = ['employee', 'sales']

const dmy = (iso: string): string => iso.split('-').reverse().join('.')

const fact = (card: Locator, term: string): Locator =>
  card
    .getByTestId('project-hours-consumption-facts')
    .locator('div')
    .filter({ has: card.page().locator('dt', { hasText: new RegExp(`^${term}$`) }) })
    .locator('dd')
const drawn = (value: Locator): Locator => value.locator('[aria-hidden="true"]').first()

interface Made {
  id: string
  name: string
}

test.describe('specs/20261112-project-hours QE: real owners — variants, the deal card, linked meetings and who may see their project', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let admin: SeededSession
  let pm: HoursPerson
  let reader: HoursPerson // projects:access + crm:access, neither manager nor deal owner
  let outsider: HoursPerson // `employee` only: cannot read any project or deal
  let dealOwner: HoursPerson
  let company: CompanyRow
  let deal: DealRow
  const projects = {} as Record<'over' | 'expired' | 'fixed' | 'tm' | 'sla' | 'linked', Made>
  const recorded: { by: HoursPerson; id: string }[] = []
  const meetings: { by: HoursPerson; id: string }[] = []
  let linkedMeeting: { id: string; title: string }
  let dealMeeting: { id: string; title: string }

  const startOfPackage = firstOfMonthShifted(today, -14)
  const currentPeriodStart = yearlyPackageAround(today).period.from
  const expiredStart = firstOfMonthShifted(today, -6)
  const expiredEnd = addDaysTo(today, -20)
  const fixedStart = firstOfMonthShifted(today, -3)

  async function makeProject(name: string, body: Record<string, unknown>): Promise<Made> {
    const result = await apiCall<Made & Record<string, unknown>>(PROJECTS_API_URL, admin, 'POST', '/projects', {
      name: `${name} ${runId}`,
      entity: 'welld_ch',
      ...body,
    })
    if (result.status !== 201 && result.status !== 200) {
      throw new Error(`POST /projects ${name} -> ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`)
    }
    return { id: result.body.id, name: result.body.name }
  }
  async function record(by: HoursPerson, input: unknown): Promise<void> {
    recorded.push({ by, id: (await createEntryViaApi(by, input)).id })
  }
  async function patchMeetingHost(creator: HoursPerson, id: string, host: unknown): Promise<number> {
    const response = await fetch(`${MEETINGS_API_URL}/meetings/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${creator.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host }),
    })
    return response.status
  }

  test.beforeAll(async () => {
    admin = await hoursAdmin(runId, PREFIX)
    pm = await seedHoursPerson('pm', SALES, runId, PREFIX)
    reader = await seedHoursPerson('reader', SALES, runId, PREFIX)
    outsider = await seedHoursPerson('outsider', ['employee'], runId, PREFIX)
    dealOwner = await seedHoursPerson('dealowner', SALES, runId, PREFIX)
    company = await createCompanyViaApi(admin, `Php qe company ${runId}`)
    const base = { companyId: company.id, projectManagerId: pm.userId }

    projects.over = await makeProject('Php QE over', {
      ...base,
      type: 'maintenance',
      terms: {
        startDate: startOfPackage,
        terms: { hourPackage: { hours: 2, kind: 'yearly', startDate: startOfPackage } },
      },
    })
    projects.expired = await makeProject('Php QE expired', {
      ...base,
      type: 'maintenance',
      terms: {
        startDate: expiredStart,
        terms: { hourPackage: { hours: 40, kind: 'capacity', startDate: expiredStart, expiryDate: expiredEnd } },
      },
    })
    projects.fixed = await makeProject('Php QE fixed', {
      ...base,
      type: 'fixed_price',
      terms: {
        startDate: fixedStart,
        terms: { deadline: addDaysTo(today, 90), estimatedManDays: 10, maxEffortManDays: 12 },
      },
    })
    projects.tm = await makeProject('Php QE tm', {
      ...base,
      type: 't_and_m',
      terms: {
        startDate: fixedStart,
        terms: {
          positions: [
            { profile: 'Dev', plannedManDays: 12 },
            { profile: 'QA', plannedManDays: 12 },
          ],
        },
      },
    })
    projects.sla = await makeProject('Php QE sla', {
      ...base,
      type: 'maintenance',
      terms: { startDate: fixedStart, terms: { sla: { highDays: 1, normalDays: 3 } } },
    })
    // The project a meeting is linked to: internal (no company, no terms), managed by the PM.
    projects.linked = await makeProject('Php QE linked', { type: 'internal', projectManagerId: pm.userId })

    await record(pm, { day: currentPeriodStart, minutes: 180, on: { type: 'project', id: projects.over.id } }) // 3 h on a 2 h package
    await record(pm, { day: expiredStart, minutes: 600, on: { type: 'project', id: projects.expired.id } }) // 10 h of 40
    for (const offset of [0, 1, 2]) {
      // 60 h = 7.5 man-days, in whole entries of 20 h (an entry is at most 24 h)
      await record(pm, {
        day: addDaysTo(fixedStart, offset),
        minutes: 1200,
        on: { type: 'project', id: projects.fixed.id },
      })
      await record(pm, {
        day: addDaysTo(fixedStart, offset),
        minutes: 1200,
        on: { type: 'project', id: projects.tm.id },
      })
    }
    await record(pm, { day: fixedStart, minutes: 90, on: { type: 'project', id: projects.sla.id } })

    // The linked meeting: the reader created it and the outsider took part; 2 h and 1 h recorded on it.
    linkedMeeting = await createMeetingViaApi(reader, {
      title: `Php QE linked meeting ${runId}`,
      source: 'text',
      host: { app: 'projects', entityType: 'project', entityId: projects.linked.id },
    })
    meetings.push({ by: reader, id: linkedMeeting.id })
    await setParticipants(reader, linkedMeeting.id, [{ userId: outsider.userId }])
    await record(reader, { day: today, minutes: 120, on: { type: 'meeting', id: linkedMeeting.id } })
    await record(outsider, { day: today, minutes: 60, on: { type: 'meeting', id: linkedMeeting.id } })
    await record(pm, { day: today, minutes: 30, on: { type: 'project', id: projects.linked.id } })

    // The deal, its owner, and a meeting linked to it.
    deal = await createDealOwnedBy(admin, company.id, `Php QE deal ${runId}`, dealOwner.userId)
    dealMeeting = await createMeetingViaApi(dealOwner, {
      title: `Php QE deal meeting ${runId}`,
      source: 'text',
      host: { app: 'crm', entityType: 'deal', entityId: deal.id },
    })
    meetings.push({ by: dealOwner, id: dealMeeting.id })
    await record(dealOwner, { day: today, minutes: 90, on: { type: 'deal', id: deal.id } })
    await record(dealOwner, { day: today, minutes: 60, on: { type: 'meeting', id: dealMeeting.id } })
  })

  test.afterAll(async () => {
    for (const { by, id } of recorded) await hoursCall(by, 'DELETE', `/time-entries/${encodeURIComponent(id)}`)
    for (const person of [pm, reader, outsider, dealOwner])
      if (person) await deleteOwnEntriesQuietly(person, startOfPackage)
    for (const { by, id } of meetings) await deleteMeetingQuietly(by, id)
    await cleanupPeople(runId)
  })

  async function openProject(page: Page, project: Made): Promise<Locator> {
    await page.goto(`/projects/${project.id}`)
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('project-hours')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByTestId('hours-host-hours-total')).toBeVisible({ timeout: 30_000 })
    return card
  }

  test('A: the consumption variants — Over by, Expired, man-days, time and material, no block without a package, no money (AC-1.1, AC-1.4–1.9)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, pm)
    const page = await ctx.newPage()

    // An exceeded yearly package: 3 h used of 2 h says "Over by 1 h", never "Hours left" and never a negative figure (D81).
    let card = await openProject(page, projects.over)
    await expect(drawn(fact(card, 'Hours used in this period'))).toHaveText('3 h', { timeout: 30_000 })
    await expect(drawn(fact(card, 'Over by'))).toHaveText('1 h')
    await expect(card.locator('dt', { hasText: /^Hours left$/ })).toHaveCount(0)
    expect(await card.innerText()).not.toMatch(/-\s?\d|−\s?\d/)

    // A capacity package past its expiry: its dates, the Expired mark beside them, and its final figures (D83).
    card = await openProject(page, projects.expired)
    await expect(fact(card, 'Package period')).toContainText(`${dmy(expiredStart)} – ${dmy(expiredEnd)}`, {
      timeout: 30_000,
    })
    await expect(card.getByTestId('project-hours-consumption-expired')).toHaveText('Expired')
    await expect(fact(card, 'Package period').getByTestId('project-hours-consumption-expired')).toBeVisible()
    await expect(drawn(fact(card, 'Hours used'))).toHaveText('10 h')
    await expect(drawn(fact(card, 'Hours left'))).toHaveText('30 h')

    // A fixed price: 60 h are 7.5 man-days of an estimate of 10.0 and a max effort of 12.0, with one decimal (AC-1.4, AC-1.6).
    card = await openProject(page, projects.fixed)
    await expect(fact(card, 'Man-days used')).toHaveText('7.5 man-days', { timeout: 30_000 })
    await expect(fact(card, 'Estimated man-days')).toHaveText('10.0 man-days')
    await expect(fact(card, 'Max effort')).toHaveText('12.0 man-days')
    await expect(card.getByTestId('project-hours-consumption-expired')).toHaveCount(0)

    // Time and material: against the TOTAL of the positions (12 + 12), no position on its own (AC-1.5).
    card = await openProject(page, projects.tm)
    await expect(fact(card, 'Man-days used')).toHaveText('7.5 man-days', { timeout: 30_000 })
    await expect(fact(card, 'Planned man-days')).toHaveText('24.0 man-days')
    expect(await card.innerText()).not.toMatch(/\bDev\b|\bQA\b/)

    // Terms that sold nothing comparable (an SLA and no hour package): no block, only the total recorded (AC-1.7).
    card = await openProject(page, projects.sla)
    await expect(card.getByTestId('project-hours-consumption')).toHaveCount(0)
    await expect(card.getByTestId('hours-host-hours-total')).toContainText('1 h 30')

    // No amount, price or rate in any of them (AC-1.8).
    expect(await card.innerText()).not.toMatch(/CHF|EUR|USD|€|\$|£/)
    await ctx.close()
  })

  test("B: the deal's Hours card — total with its linked meeting, per person only for its owner, a save grows it without a reload (AC-2.2, AC-2.4, AC-2.5, AC-2.8)", async ({
    browser,
  }) => {
    const openDeal = async (page: Page): Promise<Locator> => {
      await page.goto(`/crm/deals/${deal.id}`)
      const card = page.getByTestId('crm-deal-hours')
      await expect(card).toBeVisible({ timeout: 40_000 })
      await expect(card.getByTestId('hours-host-hours-total')).toBeVisible({ timeout: 30_000 })
      return card
    }
    const totalOf = (card: Locator): Locator => drawn(card.getByTestId('hours-host-hours-total').locator('dd'))

    // A reader of the deal who does not own it: the total (1 h 30 on the deal + 1 h on its meeting) and the work types, no people.
    const readerCtx = await personContext(browser, reader)
    const readerPage = await readerCtx.newPage()
    let card = await openDeal(readerPage)
    await expect(totalOf(card)).toHaveText('2 h 30')
    await card.getByTestId('hours-host-hours-toggle').click()
    await expect(card.getByTestId('hours-host-hours-work-types')).toBeVisible()
    await expect(card.getByTestId('hours-host-hours-people')).toHaveCount(0)
    await expect(card.getByRole('heading', { name: 'By person' })).toHaveCount(0)
    await readerCtx.close()

    // Its owner: the same total, and who recorded it.
    const ownerCtx = await personContext(browser, dealOwner)
    const page = await ownerCtx.newPage()
    card = await openDeal(page)
    await expect(totalOf(card)).toHaveText('2 h 30')
    await card.getByTestId('hours-host-hours-toggle').click()
    await expect(card.getByTestId('hours-host-hours-people')).toBeVisible()
    await expect(card.getByTestId('hours-host-hours-people').locator('tbody tr')).toHaveCount(1)
    await expect(card.getByTestId('hours-host-hours-people')).toContainText(dealOwner.name)

    // AC-2.8: Record hours on this page; the page is not reloaded and the card's total grows by exactly the half hour recorded.
    await page.evaluate(() => {
      ;(window as unknown as { __qeSameDocument: boolean }).__qeSameDocument = true
    })
    await page.getByRole('button', { name: 'Record hours', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByTestId('hours-entry-duration').fill('0:30')
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(totalOf(card)).toHaveText('3 h', { timeout: 30_000 })
    expect(await page.evaluate(() => (window as unknown as { __qeSameDocument?: boolean }).__qeSameDocument)).toBe(true)
    // The breakdown stayed open through the re-read.
    await expect(card.getByTestId('hours-host-hours-toggle')).toHaveAttribute('aria-expanded', 'true')
    for (const entry of (
      await hoursCall<{ items: { id: string }[] }>(
        dealOwner,
        'GET',
        `/time-entries?whose=mine&from=${today}&to=${today}`,
      )
    ).body.items) {
      if (!recorded.some((r) => r.id === entry.id)) recorded.push({ by: dealOwner, id: entry.id })
    }
    await ownerCtx.close()
  })

  test('C: a linked meeting counts for its project, follows a relink, and a viewer who cannot read the project is never given its name or id (AC-4.1, AC-4.2, AC-4.5, AC-4.6, AC-4.7)', async ({
    browser,
  }) => {
    const projectId = projects.linked.id
    const total = async (): Promise<number> => (await projectSummaryViaApi(pm, projectId)).body.totalMinutes
    const dealTotal = async (): Promise<number> =>
      (await hoursCall<{ totalMinutes: number }>(dealOwner, 'GET', `/time-entries/summary?dealId=${deal.id}`)).body
        .totalMinutes

    // AC-4.1: the meeting's 2 h (the reader) and 1 h (the outsider, who is on no team and cannot read the project) count, with the PM's own 30 min.
    expect(await total()).toBe(120 + 60 + 30)

    // AC-4.7 (API): the outsider is told a project exists on that meeting and nothing about it.
    const list = await hoursCall<{ items: { on: Record<string, unknown> }[]; unavailable: string[] }>(
      outsider,
      'GET',
      `/time-entries?whose=mine&from=${today}&to=${today}`,
    )
    expect(list.status).toBe(200)
    const meetingEntry = list.body.items.find((item) => item.on['type'] === 'meeting')
    expect(meetingEntry?.on['project']).toEqual({ state: 'linked', visibility: 'hidden' })
    expect(JSON.stringify(list.body)).not.toContain(projectId)
    expect(JSON.stringify(list.body)).not.toContain(projects.linked.name)
    const totals = await hoursCall<{ groups: { kind: string; key?: string; minutes: number }[] }>(
      outsider,
      'GET',
      `/time-entries/totals?groupBy=project&whose=mine&from=${today}&to=${today}`,
    )
    expect(totals.body.groups).toEqual([{ kind: 'hidden', minutes: 60 }])
    // …and the summary of the project is a 404, identical to a project that does not exist (AC-2.5's boundary: no reader, no figure).
    const refused = await projectSummaryViaApi(outsider, projectId)
    const missing = await projectSummaryViaApi(outsider, 'no-such-project')
    expect(refused.status).toBe(404)
    expect(missing.status).toBe(404)
    const problem = (result: { body: unknown }): Record<string, unknown> => result.body as Record<string, unknown>
    expect({ code: problem(refused)['code'], detail: problem(refused)['detail'] }).toEqual({
      code: problem(missing)['code'],
      detail: problem(missing)['detail'],
    })

    // The outsider's screen and file (AC-4.6, AC-4.7).
    const outsiderCtx = await personContext(browser, outsider)
    const outsiderPage = await outsiderCtx.newPage()
    await outsiderPage.goto('/hours?view=list')
    await expect(outsiderPage.getByTestId(`hours-day-${today}`)).toContainText(
      'Counts for a project that is not visible to you',
      {
        timeout: 30_000,
      },
    )
    expect(await outsiderPage.locator('main').innerText()).not.toContain(projects.linked.name)
    const outsiderDownload = outsiderPage.waitForEvent('download')
    await outsiderPage.getByTestId('hours-export').click()
    const outsiderFile = path.join(mkdtempSync(path.join(tmpdir(), 'php-qe-')), 'outsider.xlsx')
    await (await outsiderDownload).saveAs(outsiderFile)
    const outsiderSheet = await readHoursExport(outsiderFile)
    expect(outsiderSheet.header.slice(5, 8)).toEqual(['Counts for deal', 'Counts for project', 'Category or work type'])
    expect(outsiderSheet.rows).toHaveLength(1)
    expect(outsiderSheet.rows[0]!.countsForProject).toBe('Not visible to you')
    expect(JSON.stringify(outsiderSheet)).not.toContain(projects.linked.name)
    await outsiderCtx.close()

    // The reader, who can read the project: the line names it, and the file summed by Counts for project equals the by-project totals.
    const readerCtx = await personContext(browser, reader)
    const readerPage = await readerCtx.newPage()
    await readerPage.goto('/hours?view=list')
    await expect(readerPage.getByTestId(`hours-day-${today}`)).toContainText(
      `Counts for project ${projects.linked.name}`,
      {
        timeout: 30_000,
      },
    )
    const shownRows = readerPage.getByTestId('hours-totals-table').locator('tbody tr')
    await expect(shownRows).toHaveCount(1, { timeout: 30_000 })
    const shown = new Map<string, number>()
    for (const row of await shownRows.all()) {
      shown.set(
        (await row.getByRole('rowheader').innerText()).trim(),
        minutesOfShort(await row.getByRole('cell').last().innerText()),
      )
    }
    expect(Object.fromEntries(shown)).toEqual({ [projects.linked.name]: 120 })
    const readerDownload = readerPage.waitForEvent('download')
    await readerPage.getByTestId('hours-export').click()
    const readerFile = path.join(mkdtempSync(path.join(tmpdir(), 'php-qe-')), 'reader.xlsx')
    await (await readerDownload).saveAs(readerFile)
    const readerSheet = await readHoursExport(readerFile)
    const byProject = new Map<string, number>()
    for (const row of readerSheet.rows)
      byProject.set(
        row.countsForProject,
        (byProject.get(row.countsForProject) ?? 0) + Math.round(Number(row.hours) * 60),
      )
    expect(Object.fromEntries(byProject)).toEqual(Object.fromEntries(shown))
    await readerCtx.close()

    // AC-4.2: relink the meeting to the deal — from the next read the project no longer counts it and the deal does; unlink — neither; back — the project again.
    const dealBefore = await dealTotal()
    expect(
      await patchMeetingHost(reader, linkedMeeting.id, { app: 'crm', entityType: 'deal', entityId: deal.id }),
    ).toBe(200)
    expect(await total()).toBe(30)
    expect(await dealTotal()).toBe(dealBefore + 120 + 60)
    expect(await patchMeetingHost(reader, linkedMeeting.id, null)).toBe(200)
    expect(await total()).toBe(30)
    expect(await dealTotal()).toBe(dealBefore)
    expect(
      await patchMeetingHost(reader, linkedMeeting.id, { app: 'projects', entityType: 'project', entityId: projectId }),
    ).toBe(200)
    expect(await total()).toBe(120 + 60 + 30)
  })
})

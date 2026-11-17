/**
 * Fixtures of the CRM wizard journeys on the letterhead service path (specs/20261116-letterhead-service, T34).
 *
 * As everywhere in this suite nothing is stubbed: the journeys drive the REAL shell and crm-ui against the REAL crm-api
 * (`LETTERHEAD_SERVICE_ENABLED=true`), the REAL `auth` and the REAL letterhead-api. What is new here is the one thing the
 * browser cannot reach: the HOP FROM crm-api TO the service. A journey that needs "the service stops in the middle of a
 * session" cannot fake it on the wire (crm-api calls the service server-side) and must not stop a container it does not
 * own, so it runs a RELAY: a transparent TCP forwarder in the spec's own process, between crm-api and the service.
 *
 *     crm-api --LETTERHEAD_API_URL--> relay (this process, :E2E_LETTERHEAD_RELAY_PORT) --> the service
 *
 * While the relay is up it forwards bytes and changes nothing (no header, no status, no body); `down()` closes the
 * listener and every open connection, which is what a stopped service looks like to crm-api (connection refused). The
 * spec therefore needs crm-api's `LETTERHEAD_API_URL` to be the relay's address (header of the spec).
 *
 * The CRM helpers it builds on (`helpers/crmOfferFixtures.ts`) are the wizard suite's; this file adds only what the
 * service path needs: the relay, an entity other than welld_ch, a seller who has no access to Letterheads, a
 * template that runs to several pages, and readers of what a page looks like and of what the stored PDF holds.
 */
import { createRequire } from 'node:module'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { seedUserSession, type SeededSession } from '../helpers/adminSession'
import { MINIMAL_TEMPLATE_SOURCE, crmCall, ensureOwnSettings, type TemplateRow } from '../helpers/crmOfferFixtures'
import { ensureRegistryComplete } from '../helpers/legalEntitiesFixtures'
import {
  LETTERHEADS_API_URL,
  activeVersion,
  authCall,
  catalog,
  saveVersion,
  type EntityId,
} from './letterheads'

export type { SeededSession, TemplateRow }
export { LETTERHEADS_API_URL }

// ─── The relay between crm-api and the service ───────────────────────────────────────────────────────────────────────

/** Where crm-api must send its calls to the service (its `LETTERHEAD_API_URL`): the relay's port on this machine. */
export const RELAY_PORT = Number(process.env['E2E_LETTERHEAD_RELAY_PORT'] ?? '18240')

/**
 * A byte-for-byte TCP forwarder to the service. `forwarded` counts the connections it has carried: the proof that crm-api
 * really goes through it (a stack whose crm-api still points at the service directly would make every "service
 * stopped" journey pass or fail for the wrong reason, so the spec checks the count before it trusts the relay).
 */
export class ServiceRelay {
  forwarded = 0
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly target: { host: string; port: number }

  constructor(targetUrl: string = LETTERHEADS_API_URL) {
    const url = new URL(targetUrl)
    this.target = { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }
  }

  get isUp(): boolean {
    return this.server !== null
  }

  /** Starts listening (dual-stack: crm-api may resolve `localhost` to either family). Fails when the port is taken. */
  async up(): Promise<void> {
    if (this.server) return
    const server = createServer((client) => {
      this.forwarded += 1
      const upstream = connect(this.target)
      for (const socket of [client, upstream]) {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
        // a reset on one side is the other side's end too; nothing here may crash the spec's process
        socket.on('error', () => {
          client.destroy()
          upstream.destroy()
        })
      }
      client.pipe(upstream)
      upstream.pipe(client)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            `[crmOfferService] the relay cannot listen on :${RELAY_PORT} (${error.code ?? error.message}); ` +
              'something else holds that port (set E2E_LETTERHEAD_RELAY_PORT and crm-api\'s LETTERHEAD_API_URL to a free one)',
          ),
        ),
      )
      server.listen(RELAY_PORT, () => resolve())
    })
    this.server = server
  }

  /** Stops answering: the listener and every connection through it are closed, so a new call is refused. */
  async down(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ─── People, entities, templates ─────────────────────────────────────────────────────────────────────────────────────

/** A seller of wellD IT: CRM access and `deal:manage` on their own entity (the `sales` system role), NO access to Letterheads. */
export async function setUpSeller(admin: SeededSession): Promise<SeededSession> {
  const email = 'lh-e2e-it-seller@operai.test'
  const name = 'Letterheads E2E IT Seller'
  const first = await seedUserSession(email, name)
  const roles = await authCall<Array<{ id: string; name: string }>>(admin, 'GET', '/admin/roles')
  const sales = roles.body.find((role) => role.name === 'sales')
  if (!sales) throw new Error('[crmOfferService] auth has no `sales` role: has its seed been applied (`bun run db:release`)?')
  const detail = await authCall<{ entity: string | null; roles: Array<{ id: string }> }>(
    admin,
    'GET',
    `/admin/users/${first.userId}`,
  )
  const ids = new Set(detail.body.roles.map((role) => role.id))
  if (!ids.has(sales.id)) {
    ids.add(sales.id)
    const put = await authCall(admin, 'PUT', `/admin/users/${first.userId}/roles`, { roleIds: [...ids] })
    if (put.status !== 200 && put.status !== 204) throw new Error(`[crmOfferService] giving the sales role -> ${put.status}`)
  }
  if (detail.body.entity !== 'welld_it') {
    const patch = await authCall(admin, 'PATCH', `/admin/users/${first.userId}`, { entity: 'welld_it' })
    if (patch.status !== 200) throw new Error(`[crmOfferService] setting the seller's entity -> ${patch.status}`)
  }
  // minted again: the first token predates the grant and does not carry its `perm_epoch`
  return seedUserSession(email, name)
}

/**
 * A reader of the CRM's offer templates (T54, AC-10.14): `crm:access` and `deal:financials`, and NOT `deal:manage` (the
 * template editor's read guard and nothing else). They open the editor read-only and may still try the wizard, through the
 * service. The role is made through `auth`'s admin API like the seller's grants (idempotent; the rules are replaced).
 */
export async function setUpTemplateReader(admin: SeededSession): Promise<SeededSession> {
  const email = 'lh-e2e-crm-template-reader@operai.test'
  const name = 'Letterheads E2E CRM Template Reader'
  const roleName = 'e2e-crm-template-reader'
  const first = await seedUserSession(email, name)
  const roles = await authCall<Array<{ id: string; name: string }>>(admin, 'GET', '/admin/roles')
  if (roles.status !== 200) throw new Error(`[crmOfferService] GET /admin/roles -> ${roles.status}`)
  let role = roles.body.find((row) => row.name === roleName)
  if (!role) {
    const created = await authCall<{ id: string; name: string }>(admin, 'POST', '/admin/roles', {
      name: roleName,
      description: 'Created by the CRM wizard e2e on the letterhead service (T54): reads templates, manages no deal',
    })
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`[crmOfferService] POST /admin/roles -> ${created.status}: ${JSON.stringify(created.body)}`)
    }
    role = created.body
  }
  const rules = await authCall(admin, 'PUT', `/admin/roles/${role.id}/rules`, {
    rules: [
      { resource: 'crm', action: 'access' },
      { resource: 'deal', action: 'financials' },
    ],
  })
  if (rules.status !== 200 && rules.status !== 204) throw new Error(`[crmOfferService] PUT role rules -> ${rules.status}: ${JSON.stringify(rules.body)}`)
  const detail = await authCall<{ roles: Array<{ id: string }> }>(admin, 'GET', `/admin/users/${first.userId}`)
  const ids = new Set(detail.body.roles.map((row) => row.id))
  if (!ids.has(role.id)) {
    ids.add(role.id)
    const put = await authCall(admin, 'PUT', `/admin/users/${first.userId}/roles`, { roleIds: [...ids] })
    if (put.status !== 200 && put.status !== 204) throw new Error(`[crmOfferService] giving the reader role -> ${put.status}`)
  }
  // minted again: the first token predates the grant and does not carry its `perm_epoch`
  return seedUserSession(email, name)
}

/** The entity has an active letterhead in the service: the catalog's default when it has none (nothing is saved otherwise). */
export async function ensureServiceLetterhead(admin: SeededSession, entity: EntityId): Promise<number> {
  const have = await activeVersion(admin, entity)
  if (have !== null) return have
  return saveVersion(admin, entity, (await catalog(admin)).defaultConfig)
}

/**
 * The entity can issue a document: its CRM settings row exists (the CRM's own values only: since specs/20261117-legal-entities
 * no legal key is sent) and the registry's legal details are in order (generation and preview are refused without a legal
 * name and an address, AC-6.3). Existing values stay; an entity already in order gets no new registry version.
 */
export async function ensureProfileOf(admin: SeededSession, entity: EntityId): Promise<void> {
  await ensureOwnSettings(admin, entity)
  await ensureRegistryComplete(admin, entity)
}

export interface EntityDeal {
  id: string
  title: string
  entity: EntityId
}

/** A deal of `entity` (a company and a deal in its currency, let through the estimate gate by the override). */
export async function createDealOf(admin: SeededSession, entity: EntityId, label: string, runId: string): Promise<EntityDeal> {
  const company = await crmCall<{ id: string }>(admin, 'POST', '/companies', {
    name: `Service ${label} Co ${runId}`,
    status: 'prospect',
    entity,
  })
  const deal = await crmCall<{ id: string; title: string }>(admin, 'POST', '/deals', {
    companyId: company.body.id,
    title: `Service ${label} deal ${runId}`,
    currency: entity === 'welld_it' ? 'EUR' : 'CHF',
    entity,
    amountCents: 1_000_000,
  })
  if (deal.status !== 201 && deal.status !== 200) {
    throw new Error(`[crmOfferService] POST /deals (${entity}) -> ${deal.status}: ${JSON.stringify(deal.body)}`)
  }
  const override = await crmCall(admin, 'POST', `/deals/${deal.body.id}/estimate/override`, {
    reason: 'e2e: the offer wizard journeys on the letterhead service do not need an estimate',
  })
  if (override.status >= 300) throw new Error(`[crmOfferService] estimate override -> ${override.status}: ${JSON.stringify(override.body)}`)
  return { id: deal.body.id, title: deal.body.title, entity }
}

/**
 * `MINIMAL_TEMPLATE_SOURCE` with a long, numbered body of `paragraphs` paragraphs between the subject and the costs: about
 * eight paragraphs to a page on the default letterhead (24 run to about three pages, 90 to about ten).
 */
export const longTemplateSource = (paragraphs: number): string => {
  // sections of at most 40 paragraphs: one section may hold 20 000 characters (`section_too_long` above that)
  const sections: string[] = []
  for (let first = 0; first < paragraphs; first += 40) {
    const body = Array.from(
      { length: Math.min(40, paragraphs - first) },
      (_, k) =>
        `Paragrafo ${first + k + 1} del testo lungo. Il Fornitore realizza, collauda e consegna quanto descritto, secondo le modalità concordate con il Cliente nel corso delle riunioni preliminari e dei workshop di analisi, e ne risponde per i difetti accertati nel periodo di garanzia indicato di seguito.`,
    ).join('\n\n')
    sections.push(`## SCOPE OF WORK ${sections.length + 1}\n${body}`)
  }
  return MINIMAL_TEMPLATE_SOURCE.replace('## COSTS', `${sections.join('\n\n')}\n\n## COSTS`)
}

/** About four pages. */
export const LONG_TEMPLATE_SOURCE = longTemplateSource(24)

/** Creates a wizard template (Italian) of `entity`. `name` must be unique per run. */
export async function createTemplateOf(
  admin: SeededSession,
  entity: EntityId,
  name: string,
  source: string,
): Promise<TemplateRow> {
  const created = await crmCall<TemplateRow>(admin, 'POST', '/offer-templates', {
    entity,
    name,
    language: 'it',
    description: 'Created by the e2e journeys of the offer wizard on the letterhead service',
    uses: ['e2e'],
    source,
  })
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`[crmOfferService] POST /offer-templates (${entity}) -> ${created.status}: ${JSON.stringify(created.body)}`)
  }
  return created.body
}

// ─── What a page looks like ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many pixels of the `index`-th page image of the preview are the colour the service draws a missing field in
 * (the `missing` style: orange `b35c00`, `engine/src/layout/body`; the default letterhead and the body text use none
 * like it). Read through a canvas in the page, so the journey asserts on what is DRAWN, not on text that happens to
 * mention the label. The test region is `data-testid` of the preview region.
 */
export async function missingFieldPixels(page: Page, regionTestId: string, index = 0): Promise<number> {
  return page.evaluate(
    async ({ testId, n }) => {
      const images = document.querySelectorAll<HTMLImageElement>(`[data-testid="${testId}"] figure img`)
      const image = images[n]
      if (!image) return -1
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!
        const g = data[i + 1]!
        const b = data[i + 2]!
        // b35c00 and its anti-aliased and palette-quantised neighbours: strong red, half green, no blue
        if (r > 150 && r < 235 && g > 55 && g < 150 && b < 60 && r - g > 50) count += 1
      }
      return count
    },
    { testId: regionTestId, n: index },
  )
}

// ─── What the stored PDF holds ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The text of each page of a generated offer's stored PDF, read as a person reading the file would (crm-api's short-lived
 * download link, then pdf.js: crm-ui's pinned dependency, resolved by path, as `offerPdfText` does).
 */
export async function offerPdfPages(admin: SeededSession, dealId: string, offerId: string): Promise<string[]> {
  const link = await crmCall<{ url: string }>(admin, 'GET', `/deals/${dealId}/offers/${encodeURIComponent(offerId)}/download`)
  if (link.status !== 200) throw new Error(`[crmOfferService] offer download link -> ${link.status}`)
  const response = await fetch(link.body.url)
  if (!response.ok) throw new Error(`[crmOfferService] offer PDF download -> ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  const crmUiPackage = fileURLToPath(new URL('../../../crm-ui/package.json', import.meta.url))
  const entry = createRequire(crmUiPackage).resolve('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfjs = (await import(pathToFileURL(entry).href)) as {
    getDocument: (source: object) => {
      promise: Promise<{
        numPages: number
        getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>
      }>
    }
  }
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent()
    pages.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(' '))
  }
  return pages
}

/** Text compared as a reader would: no difference of spacing or line breaks, which the two extractors do not agree on. */
export const squash = (text: string): string => text.replace(/\s+/g, '')

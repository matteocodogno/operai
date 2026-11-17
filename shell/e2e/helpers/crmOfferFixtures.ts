/**
 * Test-only fixture bridge for the specs/20261115-crm-offer-wizard e2e journeys (T54, T55).
 *
 * Two kinds of helper live here, and the specs keep them apart:
 *
 *   - SETUP and out-of-band VERIFICATION go through crm-api's REAL REST API with a real, seeded Bearer token
 *     (companies, deals, the estimate override, wizard templates, drafts, generated and sent offers, the classic
 *     English offer of a legacy journey). Nothing here writes a row behind the API's back and nothing here is
 *     done through the UI.
 *   - Everything a journey asserts about what a person SEES or DOES is driven through the browser.
 *
 * Who: one dedicated admin (`crm-offer-qe-admin@operai.test`, the real `admin` role = `deal:manage` over both
 * entities, `deal:financials`), idempotent by e-mail and shared by both specs of this feature. Several browser
 * contexts may carry the SAME session (two tabs of one person, or two devices): that is the AC-6.3 journey.
 *
 * The estimate gate (AC-2.4) is passed by the admin's OVERRIDE (`POST /deals/{id}/estimate/override`): an estimate
 * made ready needs EstimAI and a second person closing it, which is not what these journeys are about. With the
 * override the wizard runs with no estimate figures, which the minimal template below does not need.
 *
 * The wizard template. The seven seeded templates of welld_ch (Italian) are what a person really starts from, and the
 * first journey uses one. Every journey that must reach a GENERATED offer uses `MINIMAL_TEMPLATE_SOURCE` instead: one
 * required text field, one literal cost line, no annex. It is created through the API per run, named with the run id,
 * and archived afterwards (`archiveTemplateViaApi`), so a seeded template's many required fields are not the thing
 * under test and nothing outlives the run in the entity's template list. It is written in ITALIAN on purpose: the
 * first wizard template of a language archives that language's classic templates (supersession, AC-8.1 amended by
 * ADR 20261115-offer-template-format-supersession-per-entity-language), and welld_ch's Italian classic templates are
 * already archived by the seeds, whereas its English ones must stay active for the legacy journey (AC-7.3).
 *
 * Offer numbers. Generating an offer takes the entity's next number (`NNNN/YYYY`): a run of these journeys spends a
 * handful of welld_ch numbers on the database it runs against. That is the feature working, not a leak, but it is
 * the reason this suite is not pointed at a database whose numbering matters.
 *
 * Prerequisites: see the header of crm-offer-wizard.spec.ts.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { seedAdminSession, type SeededSession } from './adminSession'
import { ensureRegistryComplete, getRegistryEntity } from './legalEntitiesFixtures'
import { newRunId, signInContext } from './meetingsFixtures'

export { newRunId, signInContext }
export type { SeededSession }

const trim = (url: string): string => url.replace(/\/$/, '')

export const CRM_API_URL = trim(
  process.env['E2E_CRM_API_URL'] ?? process.env['VITE_CRM_API_URL'] ?? 'http://localhost:8084',
)

type Json = Record<string, unknown>

// ─── People ─────────────────────────────────────────────────────────────────

let sharedAdmin: SeededSession | null = null

/** The one admin of these journeys, per worker process. A fixed e-mail: idempotent, never removed. */
export async function offerAdmin(): Promise<SeededSession> {
  sharedAdmin ??= await seedAdminSession('crm-offer-qe-admin@operai.test', 'CRM Offer QE Admin')
  return sharedAdmin
}

// ─── REST ───────────────────────────────────────────────────────────────────

export interface ApiResult<T = Json> {
  status: number
  body: T
  etag: string | null
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A JSON call to crm-api as `session`. Never throws on a status: the caller asserts what it expects. */
export async function crmCall<T = Json>(
  session: SeededSession,
  method: Method,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const res = await fetch(`${CRM_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed as T, etag: res.headers.get('ETag') }
}

/** A setup call that must succeed: any non-2xx stops the run with the Problem body in the message. */
async function must<T = Json>(
  session: SeededSession,
  method: Method,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const result = await crmCall<T>(session, method, route, body, headers)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `[crmOfferFixtures] ${method} ${CRM_API_URL}${route} -> ${result.status}: ${JSON.stringify(result.body).slice(0, 600)}` +
        ' (is crm-api running with the offer-wizard migration applied: `cd crm-api && bun run db:deploy`?)',
    )
  }
  return result
}

/** `If-Match` for a numeric version, quoted as the services send their ETags. */
const ifMatch = (version: number | string): Record<string, string> => ({ 'If-Match': `"${version}"` })

// ─── Company, deal, estimate gate, entity profile ───────────────────────────

export interface DealRow {
  id: string
  title: string
  companyName: string
}

/** A welld_ch company and a CHF deal on it (lead stage, a figure), let through the estimate gate by the override. */
export async function createDealPastEstimateGate(admin: SeededSession, label: string, runId: string): Promise<DealRow> {
  const companyName = `Offer ${label} Co ${runId}`
  const company = await must<{ id: string }>(admin, 'POST', '/companies', {
    name: companyName,
    status: 'prospect',
    entity: 'welld_ch',
  })
  const deal = await must<{ id: string; title: string }>(admin, 'POST', '/deals', {
    companyId: company.body.id,
    title: `Offer ${label} deal ${runId}`,
    currency: 'CHF',
    entity: 'welld_ch',
    amountCents: 1_000_000,
  })
  await must(admin, 'POST', `/deals/${deal.body.id}/estimate/override`, {
    reason: 'e2e: the offer wizard journeys do not need an estimate',
  })
  return { id: deal.body.id, title: deal.body.title, companyName }
}

/**
 * Makes sure welld_ch can issue an offer. Since specs/20261117-legal-entities the issuer's legal details are the REGISTRY's
 * (auth, `/legal-entities`) and the CRM's entity settings hold only its own values (offer terms, place of issue; AC-6.1): the
 * settings PUT is sent no legal key (crm-api would accept and ignore it, but a fixture must not rely on the tolerance, which
 * goes with the contract step). So this does two things, each only when needed:
 *   - the CRM has no settings row for the entity: one is written with the CRM's own values only;
 *   - the registry entity is not in order (a required value missing or invalid): ONE registry save by `admin` fills it
 *     (helpers/legalEntitiesFixtures.ts). The global setup has normally done it already; this keeps a spec that runs on its own
 *     (E2E_SKIP_LEGAL_ENTITIES_SETUP=1) honest. An entity in order is never saved again.
 * An existing row and existing legal values are left exactly as they are.
 */
export async function ensureEntityProfile(admin: SeededSession): Promise<void> {
  await ensureOwnSettings(admin, 'welld_ch')
  await ensureRegistryComplete(admin, 'welld_ch')
}

/** The CRM's own settings of `entity` exist (offer terms in both languages); no legal key is sent. Existing values stay. */
export async function ensureOwnSettings(admin: SeededSession, entity: 'welld_ch' | 'welld_it'): Promise<void> {
  const listed = await must<{ items: { entity: string }[] }>(admin, 'GET', '/entity-profiles')
  if (listed.body.items.some((profile) => profile.entity === entity)) return
  await must(admin, 'PUT', `/entity-profiles/${entity}`, {
    offerTermsEn: 'Payment within 30 days.',
    offerTermsIt: 'Pagamento a 30 giorni.',
  })
}

export interface ProfileRow {
  entity: string
  /** The issuer's legal name: the REGISTRY's (the CRM's settings no longer hold it). */
  legalName?: string | null
  /** The registry's address lines in Italian (the language of the wizard templates the journeys use); see `address` for both. */
  addressLines?: string[] | null
  /** The registry's address lines in both languages. */
  address?: { it: string[]; en: string[] }
  vatNumber?: string
  /** The registry's IBAN as the documents print it (groups of four); empty when none. */
  ibanPrint?: string
  /** The registry version the details were read at. */
  registryVersion?: number
  /** The CRM's own: the letterhead upload, when there is one. */
  letterhead?: { uploadedAt: string } | null
}

/**
 * welld_ch's issuer as a journey asserts it: the CRM's own settings row (its letterhead) joined with the registry's legal
 * details (what the documents print, AC-6.2). Read as `admin`; the registry is read as the entity it is, not as crm-api sees it.
 */
export async function getEntityProfile(admin: SeededSession): Promise<ProfileRow> {
  const listed = await must<{ items: ProfileRow[] }>(admin, 'GET', '/entity-profiles')
  const have = listed.body.items.find((profile) => profile.entity === 'welld_ch')
  if (!have) throw new Error('[crmOfferFixtures] welld_ch has no entity profile')
  const registry = await getRegistryEntity(admin, 'welld_ch')
  return {
    entity: have.entity,
    letterhead: have.letterhead ?? null,
    legalName: registry.legalName,
    addressLines: registry.address.it,
    address: registry.address,
    vatNumber: registry.vatNumber,
    ibanPrint: registry.ibanPrint,
    registryVersion: registry.version,
  }
}

/**
 * The issuer's address as the offer prints it: the non-blank lines of the registry's address in the document's language
 * (Italian unless said: the wizard templates of these journeys are Italian), joined by a comma and a space (AC-12.9, AC-6.2).
 */
export const issuerAddressText = (profile: ProfileRow, language: 'it' | 'en' = 'it'): string =>
  ((profile.address?.[language] ?? (language === 'it' ? profile.addressLines : null)) ?? [])
    .filter((line) => line.trim() !== '')
    .join(', ')

/** The entity letterhead fixture (T59): one readable A4 page. */
export const LETTERHEAD_FIXTURE = fileURLToPath(new URL('../fixtures/letterhead-a4.pdf', import.meta.url))

/**
 * Makes sure welld_ch's profile HAS a letterhead. An existing one (the owner's real one on a dev stack) is never
 * replaced or removed; only a missing one is uploaded, through the same three calls the Settings screen makes (the
 * presigned POST to the CRM bucket, then confirm). There is no route to remove a letterhead, so what this adds stays.
 * Returns whether this call uploaded it.
 */
export async function ensureLetterhead(admin: SeededSession): Promise<boolean> {
  if ((await getEntityProfile(admin)).letterhead) return false
  const started = await must<{ key: string; upload: { url: string; fields: Record<string, string> } }>(
    admin,
    'POST',
    '/entity-profiles/welld_ch/letterhead',
  )
  const form = new FormData()
  for (const [name, value] of Object.entries(started.body.upload.fields)) form.append(name, value)
  form.append(
    'file',
    new Blob([new Uint8Array(await readFile(LETTERHEAD_FIXTURE))], { type: 'application/pdf' }),
    'letterhead.pdf',
  )
  const stored = await fetch(started.body.upload.url, { method: 'POST', body: form })
  if (!stored.ok) throw new Error(`[crmOfferFixtures] letterhead upload to the bucket -> ${stored.status}`)
  await must(admin, 'POST', '/entity-profiles/welld_ch/letterhead/confirm', { key: started.body.key })
  return true
}

// ─── Offer templates ────────────────────────────────────────────────────────

/** The label of the one required field of `MINIMAL_TEMPLATE_SOURCE`, as the wizard shows it. */
export const SUBJECT_LABEL = 'Project subject'

/**
 * The smallest useful wizard template: a salutation, one section asking one required text field (step Scope), and a
 * cost table with one literal one-off line (step Costs, nothing to enter). A fresh draft is therefore missing exactly
 * ONE value, `OGGETTO`, so "Generate blocked, fill it in, generated" is one field long. Checked against the shared
 * engine (parse: no problems; resolve: missing `[OGGETTO]` only, then nothing).
 */
export const MINIMAL_TEMPLATE_SOURCE = [
  '@@salutation To',
  '',
  'Dear client.',
  '',
  '## SUBJECT',
  'Subject of the work: [OGGETTO]',
  '',
  '## COSTS',
  '@@step costs',
  '@@costs',
  '@@line work one_off | Work | unit=1000 | qty=1',
  '@@total **TOTAL**',
  '@@end',
  '',
  '@@field OGGETTO',
  `label: ${SUBJECT_LABEL}`,
  '',
].join('\n')

export interface TemplateRow {
  id: string
  name: string
  language: 'en' | 'it'
  format: 'wizard' | 'sections'
  archived: boolean
  seeded?: boolean
  description?: string | null
  uses?: string[]
  version: number
}

/** Creates the minimal wizard template (Italian, welld_ch). `name` must be unique per run. */
export async function createMinimalTemplateViaApi(admin: SeededSession, name: string): Promise<TemplateRow> {
  const created = await must<TemplateRow>(admin, 'POST', '/offer-templates', {
    entity: 'welld_ch',
    name,
    language: 'it',
    description: 'Created by the e2e journeys of the offer wizard',
    uses: ['e2e'],
    source: MINIMAL_TEMPLATE_SOURCE,
  })
  return created.body
}

/**
 * `MINIMAL_TEMPLATE_SOURCE` plus the two CRM-supplied issuer fields, written the way the seeded SLA annex writes its
 * "Fornitore" row (specs/20261115-crm-offer-wizard AC-12.9, AC-12.10): `[EMITTENTE]` and the address behind a condition.
 * The wizard never asks for them, so a fresh draft is still missing only `OGGETTO`.
 */
export const ISSUER_TEMPLATE_SOURCE =
  MINIMAL_TEMPLATE_SOURCE.replace(
    'Subject of the work: [OGGETTO]',
    'Subject of the work: [OGGETTO]\n\nSupplier line: [EMITTENTE]{{?INDIRIZZO_EMITTENTE::, [INDIRIZZO_EMITTENTE]}}',
  ) + '\n@@field EMITTENTE\nsource: issuer\n\n@@field INDIRIZZO_EMITTENTE\nsource: issuerAddress\n'

/** Creates the issuer-field wizard template (Italian, welld_ch). `name` must be unique per run. */
export async function createIssuerTemplateViaApi(admin: SeededSession, name: string): Promise<TemplateRow> {
  const created = await must<TemplateRow>(admin, 'POST', '/offer-templates', {
    entity: 'welld_ch',
    name,
    language: 'it',
    description: 'Created by the e2e journeys of the offer wizard (issuer fields)',
    uses: ['e2e'],
    source: ISSUER_TEMPLATE_SOURCE,
  })
  return created.body
}

/** Archives a template this run created. Best effort (an afterAll must not hide the journey's own failure). */
export async function archiveTemplateViaApi(admin: SeededSession, templateId: string): Promise<void> {
  try {
    const one = await crmCall<TemplateRow>(admin, 'GET', `/offer-templates/${encodeURIComponent(templateId)}`)
    if (one.status !== 200 || one.body.archived) return
    await crmCall(
      admin,
      'POST',
      `/offer-templates/${encodeURIComponent(templateId)}/archive`,
      undefined,
      ifMatch(one.body.version),
    )
  } catch {
    // the stack went away: nothing left to clean
  }
}

/**
 * Archives every wizard template of welld_ch whose name starts with `prefix` (the editor journey creates one through
 * the UI and only knows its name).
 */
export async function archiveTemplatesNamedViaApi(admin: SeededSession, prefix: string): Promise<void> {
  try {
    for (const row of await listTemplatesViaApi(admin, 'sections,wizard', true)) {
      if (row.name.startsWith(prefix)) await archiveTemplateViaApi(admin, row.id)
    }
  } catch {
    // best effort
  }
}

/** welld_ch's templates in the given formats (the first read of the wizard format also seeds the seven). */
export async function listTemplatesViaApi(
  admin: SeededSession,
  formats: 'sections' | 'wizard' | 'sections,wizard' = 'sections,wizard',
  includeArchived = false,
): Promise<TemplateRow[]> {
  const result = await must<{ items: TemplateRow[] }>(
    admin,
    'GET',
    `/offer-templates?entity=welld_ch&formats=${encodeURIComponent(formats)}&includeArchived=${includeArchived}`,
  )
  return result.body.items
}

/** One of the seeded Italian wizard templates (AC-9.1): "Progetto a corpo", else any seeded one. */
export async function findSeededTemplate(admin: SeededSession): Promise<TemplateRow> {
  const wizard = (await listTemplatesViaApi(admin, 'wizard')).filter(
    (row) => row.seeded === true && row.language === 'it',
  )
  const hit = wizard.find((row) => row.name === 'Progetto a corpo') ?? wizard[0]
  if (!hit)
    throw new Error('[crmOfferFixtures] welld_ch has no seeded Italian wizard template (AC-9.1): did the seed run?')
  return hit
}

/** The seeded Italian wizard template with this name (e.g. "Manutenzione e SLA", whose parties row names the issuer). */
export async function findSeededTemplateNamed(admin: SeededSession, name: string): Promise<TemplateRow> {
  const hit = (await listTemplatesViaApi(admin, 'wizard')).find(
    (row) => row.seeded === true && row.language === 'it' && row.name === name,
  )
  if (!hit) throw new Error(`[crmOfferFixtures] welld_ch has no seeded Italian wizard template named "${name}"`)
  return hit
}

/** An active classic (`sections`) template of welld_ch in English: what the legacy journey (AC-7.3) generates from. */
export async function findClassicEnglishTemplate(admin: SeededSession): Promise<TemplateRow | null> {
  const rows = await listTemplatesViaApi(admin, 'sections,wizard')
  return rows.find((row) => row.format === 'sections' && row.language === 'en' && !row.archived) ?? null
}

/** Whether welld_ch has an ACTIVE wizard template in English: then a classic English offer opens the wizard, not the dialog. */
export async function hasEnglishWizardTemplate(admin: SeededSession): Promise<boolean> {
  const rows = await listTemplatesViaApi(admin, 'wizard')
  return rows.some((row) => row.language === 'en' && !row.archived)
}

// ─── Drafts, offers ─────────────────────────────────────────────────────────

export interface DraftView {
  template: { id: string; name: string; language: 'en' | 'it'; version: number; archived: boolean }
  version: number
  answers: { fields: Record<string, string | number>; lastStep?: string } & Json
  target: Json
  templateVersion: number
}

export interface OfferRow {
  id: string
  reference: string
  version: number
  deleted: boolean
  sent: { at: string } | null
  origin: 'wizard' | 'sections' | string
  templateName: string | null
}

/** Starts the deal's draft from a template (the Template step's "Use template", through the API). */
export async function createDraftViaApi(admin: SeededSession, dealId: string, templateId: string): Promise<DraftView> {
  const created = await must<DraftView>(
    admin,
    'POST',
    `/deals/${dealId}/offer-draft`,
    { templateId },
    { 'If-None-Match': '*' },
  )
  return created.body
}

/** The deal's draft, or null when it has none (404 `draft_not_found`). */
export async function getDraftViaApi(admin: SeededSession, dealId: string): Promise<DraftView | null> {
  const result = await crmCall<DraftView>(admin, 'GET', `/deals/${dealId}/offer-draft`)
  if (result.status === 404) return null
  if (result.status !== 200) throw new Error(`[crmOfferFixtures] GET offer-draft -> ${result.status}`)
  return result.body
}

/** Sets one text answer on the draft (a content save: the same PUT the wizard's autosave sends). */
export async function setFieldViaApi(
  admin: SeededSession,
  dealId: string,
  draft: DraftView,
  name: string,
  value: string,
): Promise<DraftView> {
  const saved = await must<DraftView>(
    admin,
    'PUT',
    `/deals/${dealId}/offer-draft`,
    {
      templateVersion: draft.templateVersion,
      target: draft.target,
      answers: { ...draft.answers, fields: { ...draft.answers.fields, [name]: value } },
    },
    ifMatch(draft.version),
  )
  return saved.body
}

/** Generates the offer of the deal's draft at the draft's version; returns the offer. */
export async function generateDraftViaApi(admin: SeededSession, dealId: string, draft: DraftView): Promise<OfferRow> {
  const generated = await must<OfferRow>(
    admin,
    'POST',
    `/deals/${dealId}/offer-draft/generate`,
    undefined,
    ifMatch(draft.version),
  )
  return generated.body
}

/** The raw generate call: the status and body of a refusal, for the journey that proves "refused, creates no offer". */
export function tryGenerateDraftViaApi(admin: SeededSession, dealId: string, version: number) {
  return crmCall<Json & { code?: string; missing?: { name: string }[] }>(
    admin,
    'POST',
    `/deals/${dealId}/offer-draft/generate`,
    undefined,
    ifMatch(version),
  )
}

/** A wizard offer made entirely through the API: draft from `templateId`, the subject answered, generated (unsent). */
export async function generateWizardOfferViaApi(
  admin: SeededSession,
  dealId: string,
  templateId: string,
  subject: string,
): Promise<OfferRow> {
  const draft = await createDraftViaApi(admin, dealId, templateId)
  const filled = await setFieldViaApi(admin, dealId, draft, 'OGGETTO', subject)
  return generateDraftViaApi(admin, dealId, filled)
}

export async function markOfferSentViaApi(admin: SeededSession, dealId: string, offerId: string): Promise<void> {
  await must(admin, 'POST', `/deals/${dealId}/offers/${encodeURIComponent(offerId)}/sent`)
}

/** The deal's offers, newest first. */
export async function listOffersViaApi(admin: SeededSession, dealId: string): Promise<OfferRow[]> {
  const result = await must<{ items: OfferRow[] }>(admin, 'GET', `/deals/${dealId}/offers`)
  return result.body.items
}

/** The offers of a deal that are neither deleted nor hidden (what the table lists as live). */
export async function liveOffersViaApi(admin: SeededSession, dealId: string): Promise<OfferRow[]> {
  return (await listOffersViaApi(admin, dealId)).filter((offer) => !offer.deleted)
}

/**
 * A CLASSIC (018) offer in English, generated through the legacy routes from the template's own prefill: what a deal
 * has from before the wizard. Its `origin` is `sections`.
 */
export async function generateClassicOfferViaApi(
  admin: SeededSession,
  dealId: string,
  template: TemplateRow,
): Promise<OfferRow> {
  const prefill = await must<{
    salutation: string
    clientLines: string[]
    opening: string
    sections: { heading: string; body: string; costs: boolean }[]
    costColumns: { position: boolean; unit: boolean }
    showTotal: boolean
    costLines: {
      description: string
      kind: string
      unitCents: number | null
      percentBp: number | null
      quantity: number
    }[]
    acceptanceLabel: string | null
    annex: boolean
    validityDays: number
  }>(admin, 'GET', `/deals/${dealId}/offers/draft?templateId=${encodeURIComponent(template.id)}`)
  const p = prefill.body
  const generated = await must<OfferRow>(admin, 'POST', `/deals/${dealId}/offers`, {
    templateId: template.id,
    salutation: p.salutation,
    clientLines: p.clientLines,
    contactIds: [],
    opening: p.opening,
    sections: p.sections,
    costColumns: p.costColumns,
    showTotal: p.showTotal,
    // the prefill states an absent figure as null; the generate body omits it
    costLines: p.costLines.map(({ unitCents, percentBp, ...line }) => ({
      ...line,
      ...(unitCents === null ? {} : { unitCents }),
      ...(percentBp === null ? {} : { percentBp }),
    })),
    acceptanceLabel: p.acceptanceLabel,
    annex: p.annex,
    attachmentIds: [],
    validityDays: p.validityDays,
    aiAssisted: false,
  })
  return generated.body
}

/** Removes a deal's draft (best effort): a journey that started one through the API and did not generate it. */
export async function discardDraftViaApi(admin: SeededSession, dealId: string): Promise<void> {
  try {
    const draft = await getDraftViaApi(admin, dealId)
    if (draft) await crmCall(admin, 'DELETE', `/deals/${dealId}/offer-draft`, undefined, ifMatch(draft.version))
  } catch {
    // best effort
  }
}

// ─── What a generated offer printed ─────────────────────────────────────────

/**
 * The text of a generated offer's PDF, read the way a person reading the file would: crm-api's short-lived download
 * link, then the bytes through pdf.js. No route exposes a wizard offer's snapshot, so the PDF it was rendered into is
 * the one record of what it printed (it never changes after generation, AC-9.4).
 *
 * pdf.js is crm-ui's own pinned dependency (`pdfjs-dist`, T59); the shell has none, so it is resolved from crm-ui's
 * install by path. Its legacy build runs in Node with no worker file and no canvas.
 */
export async function offerPdfText(admin: SeededSession, dealId: string, offerId: string): Promise<string> {
  const link = await must<{ url: string }>(
    admin,
    'GET',
    `/deals/${dealId}/offers/${encodeURIComponent(offerId)}/download`,
  )
  const response = await fetch(link.body.url)
  if (!response.ok) throw new Error(`[crmOfferFixtures] offer PDF download -> ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  const crmUiPackage = fileURLToPath(new URL('../../../crm-ui/package.json', import.meta.url))
  const entry = createRequire(crmUiPackage).resolve('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfjs = (await import(pathToFileURL(entry).href)) as {
    getDocument: (source: object) => {
      promise: Promise<{
        numPages: number
        getPage: (
          n: number,
        ) => Promise<{ getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>
      }>
    }
  }
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    pages.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(' '))
  }
  return pages.join('\n')
}

// ─── A long offer, for the preview's pages ──────────────────────────────────

/** Sentences numbered and named, so no stretch of the long offer's text repeats and a search finds exactly one place. */
const longAnswer = (field: string, sentences: number): string =>
  Array.from(
    { length: sentences },
    (_, i) =>
      `Frase ${i + 1} del campo ${field}: il Fornitore realizza, collauda e consegna quanto descritto, secondo le modalità concordate con il Cliente nel corso delle riunioni preliminari e dei workshop di analisi.`,
  ).join(' ')
const LONG_WORD =
  'Supercalifragilistichespiralidosoimpossibilmenteluncoparolaincredibilmentelungaperverificarelaregoladiaccapoinognicontestoeinognilarghezzadellapagina '

/** A section of the offer's text, edited by hand: long enough to run over a break (AC-11.1 "edited by hand" marks). */
const handEditedBody = (): string =>
  Array.from({ length: 14 }, (_, i) =>
    Array.from(
      { length: 3 },
      (_, j) =>
        `Paragrafo ${i + 1}, parte ${j + 1}. Il testo modificato a mano resta nel documento con la sua linea a sinistra, interrotta dal bordo della pagina e mai disegnata nel margine o nello spazio tra le pagine.`,
    ).join(' '),
  ).join('\n\n')

/**
 * A long offer for the pages journeys (specs/20261115-crm-offer-wizard AC-11.2, 11.10-11.12): the draft of `dealId`
 * from `templateId` (the seeded "Progetto a corpo con SLA", which has two annexes and tables), every text field answered
 * with long text, one with an unbreakable word, and one section hand-edited with fourteen paragraphs. Set up through
 * the API; a field the server refuses as an answer (a number or a choice) is left unanswered, which the preview shows
 * as a missing-field placeholder, still real text. Returns the draft as saved.
 */
export async function createLongDraftViaApi(
  admin: SeededSession,
  dealId: string,
  templateId: string,
): Promise<DraftView> {
  const template = await must<{ source: string }>(admin, 'GET', `/offer-templates/${templateId}`)
  const names = [...template.body.source.matchAll(/^@@field (\S+)/gm)].map((match) => match[1]!)
  const draft = await createDraftViaApi(admin, dealId, templateId)
  const fields: Record<string, string> = {}
  for (const name of names) {
    if (name.includes('DURATA')) fields[name] = 'sei mesi'
    else if (name.startsWith('OGGETTO')) fields[name] = `Piattaforma gestionale ${longAnswer(name, 1)}`
    else fields[name] = longAnswer(name, 2)
  }
  const wordy = names[2] ?? names[0]!
  fields[wordy] = `${LONG_WORD}${longAnswer(wordy, 1)}`

  let saved = draft
  for (let attempt = 0; attempt < names.length + 1; attempt++) {
    const put = await crmCall<DraftView & { path?: string }>(
      admin,
      'PUT',
      `/deals/${dealId}/offer-draft`,
      {
        templateVersion: draft.templateVersion,
        target: draft.target,
        answers: { ...draft.answers, fields },
      },
      ifMatch(draft.version),
    )
    if (put.status === 200) {
      saved = put.body
      break
    }
    const refused = typeof put.body.path === 'string' ? put.body.path.replace(/^fields\./, '') : ''
    if (put.status !== 422 || !(refused in fields)) {
      throw new Error(`[crmOfferFixtures] long draft PUT -> ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`)
    }
    delete fields[refused]
  }

  const edited = await must<DraftView>(
    admin,
    'PUT',
    `/deals/${dealId}/offer-draft`,
    {
      templateVersion: saved.templateVersion,
      target: saved.target,
      answers: {
        ...saved.answers,
        handEdits: {
          'CONDIZIONI DI FORNITURA#0': {
            heading: '4. CONDIZIONI MODIFICATE A MANO',
            body: handEditedBody(),
            sourceHeading: 'CONDIZIONI DI FORNITURA',
          },
        },
      },
    },
    ifMatch(saved.version),
  )
  return edited.body
}

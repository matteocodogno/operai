import { ApiError } from './api'
import { codeOf, errorMessage, isNulRefusal } from './errors'
import { strings } from '../strings'
import type { TemplateAst } from './offerEngine/syntax'
import type { Entity, OfferIncomplete, PersonRef, TemplateProblem } from './types'

/** The readable line for a refused or failed generation (also used for download and delete). */
export function offerFailure(error: unknown): string {
  const t = strings.offers.errors
  switch (codeOf(error)) {
    case 'estimate_not_ready':
      return t.estimateNotReady
    // specs/20261117-legal-entities (E4): the issuer's details come from the registry; a missing CRM profile row no longer
    // refuses a document, so `entity_profile_missing` is worded only where the letterhead upload says it (LetterheadCard)
    case 'legal_entity_incomplete': {
      const found = legalEntityIncompleteOf(error)
      if (!found) return errorMessage(error)
      const label = found.entity ? strings.badges.entity[found.entity] : ''
      return label ? t.legalEntityIncomplete(label, legalDetailsInWords(found.missing)) : errorMessage(error)
    }
    case 'legal_entities_unavailable':
      return legalEntitiesUnavailableOf(error) ? t.legalEntitiesUnavailable : errorMessage(error)
    case 'storage_unconfigured':
      return t.storageUnconfigured
    case 'estimai_unavailable':
    case 'estimai_unconfigured':
    case 'estimate_unavailable':
      return t.estimaiUnavailable
    case 'contact_not_in_company':
      return t.contactNotInCompany
    case 'template_archived':
      return t.templateArchived
    case 'version_conflict':
      return t.versionConflict
    case 'attachment_invalid':
      return t.attachmentInvalid
    case 'attachment_not_pdf':
      return t.attachmentNotPdf(fileNameOf(error))
    case 'attachment_unreadable':
      return t.attachmentUnreadable(fileNameOf(error))
    case 'attachments_too_large':
      return t.attachmentsTooLarge
    case 'discounts_exceed_one_off':
      return t.discountsExceed
    case 'cost_total_too_large':
      return t.costTotalTooLarge
    case 'offer_sent':
      return t.offerSent
    case 'offer_not_sent':
      return t.offerNotSent
    case 'offer_not_latest':
      return t.offerNotLatest
    case 'offer_legacy':
      return t.offerLegacy
    // The wizard's draft (specs/20261115-crm-offer-wizard, plan § API contracts)
    case 'draft_exists':
      return t.draftExists
    case 'draft_not_found':
      return t.draftNotFound
    case 'draft_invalid':
      return t.draftInvalid
    case 'draft_too_large':
      return t.draftTooLarge
    case 'answers_invalid':
      return t.answersInvalid
    case 'template_changed':
      return t.templateChanged
    case 'template_format_mismatch':
      return t.templateFormatMismatch
    case 'template_required':
      return t.templateRequired
    case 'offer_changed':
      return t.offerChanged
    case 'offer_wizard':
      return t.offerWizard
    case 'offer_incomplete':
      return t.offerIncomplete
    case 'letterhead_unusable': {
      // the entity the server named, by its badge label (design S10); a body that does not name a known one has no
      // honest sentence to fill, so the server's own constant line stands
      const entity = letterheadUnusableOf(error)?.entity ?? null
      return entity ? t.letterheadUnusable(strings.badges.entity[entity]) : errorMessage(error)
    }
    default:
      return errorMessage(error)
  }
}

const ENTITIES: readonly string[] = ['welld_it', 'welld_ch'] satisfies readonly Entity[]

/**
 * A 409 `letterhead_unusable` (security M-4, plan DD-76): the stored letterhead fails the service's decoded-size bound,
 * so the link and offer generation are refused until it is uploaded again. `entity` is the one the body names, or null
 * when it names none we know. Null for any other failure — the code alone is not enough, the status must agree.
 */
export function letterheadUnusableOf(error: unknown): { entity: Entity | null } | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'letterhead_unusable') return null
  const entity = error.extras['entity']
  return { entity: typeof entity === 'string' && ENTITIES.includes(entity) ? (entity as Entity) : null }
}

/**
 * A 409 `legal_entity_incomplete` (specs/20261117-legal-entities AC-6.3): the registry says the issuer's details are not all
 * filled in. `entity` is the one the body names (null when it names none we know) and `missing` the values it lists, as
 * received. Null for any other failure — the code alone is not enough, the status must agree.
 */
export function legalEntityIncompleteOf(error: unknown): { entity: Entity | null; missing: string[] } | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'legal_entity_incomplete') return null
  const { entity, missing } = error.extras
  return {
    entity: typeof entity === 'string' && ENTITIES.includes(entity) ? (entity as Entity) : null,
    missing: Array.isArray(missing) ? missing.filter((value): value is string => typeof value === 'string') : [],
  }
}

/** A 503 `legal_entities_unavailable` (AC-5.5): the registry cannot be read, so no document is made (retry after 5 s). */
export const legalEntitiesUnavailableOf = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 503 && error.code === 'legal_entities_unavailable'

/** The missing details of a refusal as one list of words (design S10); a value we have no word for is shown as received. */
export function legalDetailsInWords(missing: readonly string[]): string {
  const words = strings.offerWizard.legalEntity.missingWords
  return missing.map((value) => (Object.hasOwn(words, value) ? words[value] : value)).join(', ')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A 422 `offer_incomplete` as the typed lists it carries (DD-32); null for any other failure or a body that is not the contract. */
export function offerIncompleteOf(error: unknown): OfferIncomplete | null {
  if (!(error instanceof ApiError) || error.status !== 422 || error.code !== 'offer_incomplete') return null
  const { missing, invalid } = error.extras
  return Array.isArray(missing) && Array.isArray(invalid)
    ? { missing: missing as OfferIncomplete['missing'], invalid: invalid as OfferIncomplete['invalid'] }
    : null
}

/** The JSON path (under `answers`, or `templateVersion` / `target`) of a 422 `answers_invalid`, or null. */
export function answersInvalidPathOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'answers_invalid') return null
  const path = error.extras['path']
  return typeof path === 'string' ? path : null
}

/**
 * A 422 `answers_invalid` that refuses a character no text can hold (a NUL) in an answer. The server's `reason` says only
 * "shape" for it, so — as for every other NUL refusal — the wording of its message is what tells (`isNulRefusal`).
 */
export const answersNulRefused = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'answers_invalid' && isNulRefusal(error)

/** `fields.NAME`, `lists.NAME[2]`, `tables.T[0].cells.COL`, `fields["a b"]`: the name after the root, and what follows. */
const ANSWER_PATH = /^([A-Za-z]+)(?:\.([^.[]+)|\[("(?:[^"\\]|\\.)*")\])(.*)$/
const CELL = /^(?:\[\d+\])?\.cells(?:\.([^.[]+)|\[("(?:[^"\\]|\\.)*")\])$/

const unquote = (dotted: string | undefined, quoted: string | undefined): string | null => {
  if (dotted !== undefined) return dotted
  if (quoted === undefined) return null
  try {
    const parsed: unknown = JSON.parse(quoted)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The label a person sees for the answer at a JSON `path` of a draft (what the server names in `answers_invalid`):
 * a field's, a list's or a table's (with the column) as the template declares it, or the client block's own. Null for
 * a path that is none of those or names something the template does not declare — the caller then says it without a
 * name rather than invent one. Never returns the path itself.
 */
export function answerLabelOf(ast: TemplateAst | null, path: string | null): string | null {
  if (path === null) return null
  const t = strings.offerWizard.client
  if (path === 'client.lines' || path.startsWith('client.lines[')) return t.lines
  if (path === 'client.place') return t.place
  if (ast === null) return null
  const found = ANSWER_PATH.exec(path)
  if (!found) return null
  const [, root, dotted, quoted, rest = ''] = found
  const name = unquote(dotted, quoted)
  if (name === null) return null
  if (root === 'fields' || root === 'prefilled') {
    const field = ast.fields.find((candidate) => candidate.name === name)
    return field ? (field.label ?? field.name) : null
  }
  if (root === 'lists') {
    const list = ast.lists.find((candidate) => candidate.name === name)
    return list ? (list.label ?? list.name) : null
  }
  if (root === 'tables') {
    const table = ast.tables.find((candidate) => candidate.name === name)
    if (!table) return null
    const tableLabel = table.label ?? table.name
    const cell = CELL.exec(rest)
    const column = cell ? unquote(cell[1], cell[2]) : null
    const field = column === null ? undefined : ast.fields.find((candidate) => candidate.name === column)
    return field ? `${tableLabel}, ${field.label ?? field.name}` : tableLabel
  }
  return null
}

/** The sentence for a refused draft save that says the answers are not valid, with a refused character named by its answer. */
export function invalidAnswersLine(rejection: { path: string | null; nul: boolean }, ast: TemplateAst | null): string {
  if (!rejection.nul) return strings.offers.errors.answersInvalid
  const label = answerLabelOf(ast, rejection.path)
  const t = strings.offerWizard.save
  return label === null ? t.answerNulUnnamed : t.answerNul(label)
}

/** Who started the draft that a 409 `draft_exists` found, and when; null for any other failure. */
export function draftExistsOf(error: unknown): { updatedBy: PersonRef; updatedAt: string } | null {
  if (!(error instanceof ApiError) || error.code !== 'draft_exists') return null
  const { updatedBy, updatedAt } = error.extras
  return isRecord(updatedBy) && typeof updatedAt === 'string' ? { updatedBy: updatedBy as PersonRef, updatedAt } : null
}

/** The problems of a 422 `template_invalid` (line, code, severity — never the text); empty for any other failure. */
export function templateProblemsOf(error: unknown): TemplateProblem[] {
  if (!(error instanceof ApiError) || error.code !== 'template_invalid') return []
  const problems = error.extras['problems']
  return Array.isArray(problems) ? (problems as TemplateProblem[]) : []
}

/** The `fileName` extension member of an attachment problem (422). */
function fileNameOf(error: unknown): string {
  const name = error instanceof ApiError ? error.extras['fileName'] : undefined
  return typeof name === 'string' ? name : ''
}

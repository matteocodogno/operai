/**
 * ProtectedChangeModel — the small pure helpers behind the protected-change confirmations (T60,
 * specs/20261117-legal-entities, design S12 and S7, plan G7; AC-9.1, AC-9.4, AC-9.17).
 *
 * The page never decides what a save changes (auth's check route does, and the normalisation lives only there,
 * plan decision 10). The one place it compares values itself is the restore dialog, which holds two versions and
 * lists the protected details that differ between them: it compares them the way the registry does (`sameFieldValue`
 * normalises) so a version that differs only in IBAN spacing or case lists nothing, as a save would not ask either.
 */
import { PROTECTED_FIELDS } from '../lib/legalEntitiesApi'
import type { ProtectedChange, ProtectedField } from '../lib/legalEntitiesApi'
import { getFieldValue, sameFieldValue } from '../lib/legalEntityModel'
import type { LegalEntityDetails } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

/** A version as the restore dialog holds it: its details and the IBAN as the registry prints it (groups of four). */
export type ComparedVersion = LegalEntityDetails & { ibanPrint: string }

const shown = (version: ComparedVersion, field: ProtectedField): string =>
  field === 'iban' ? version.ibanPrint : field === 'vatNumber' ? version.vatNumber : version.legalName

/**
 * The protected details that differ between the current version (Old) and the version to restore (New), in the
 * closed order. Empty when none differs: the restore dialog is then as it was before (AC-9.4).
 */
export const protectedChangesBetween = (current: ComparedVersion, target: ComparedVersion): ProtectedChange[] =>
  PROTECTED_FIELDS.filter(
    (field) => !sameFieldValue(field, getFieldValue(current, field), getFieldValue(target, field)),
  ).map((field) => ({ field, before: shown(current, field), after: shown(target, field) }))

/**
 * "about 3 minutes": the wait of a 429 as whole minutes, rounded UP and at least one (a header of 61 seconds is two
 * minutes, of 0 is one). `undefined` when the header was missing or unreadable: the caller then uses its "no wait"
 * sentence rather than a number the server did not give.
 */
export const waitText = (retryAfterSeconds: number | undefined): string | undefined =>
  retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0
    ? undefined
    : t.wait.minutes(Math.max(1, Math.ceil(retryAfterSeconds / 60)))

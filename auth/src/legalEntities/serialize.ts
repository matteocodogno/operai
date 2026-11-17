/**
 * The one serializer of a legal entity (specs/20261117-legal-entities, plan § API contracts "Details", E6).
 *
 * Every read - the person's `GET /legal-entities[/{entity}]`, the service's `GET /system/legal-entities[/{entity}]`
 * (T6) and the version view (T7) - builds its `LegalEntity` here, so the same rows give the same bytes whoever asks.
 * The key order below is part of the contract: the shared fixture
 * `specs/20261117-legal-entities/fixtures/legal-entities.json` is compared byte for byte with this output.
 *
 * Pure: no database, no clock. The judgement of a value (`missing`, `complete`, `invalid`) is `rules.ts`'s, never
 * re-implemented here; the stored values are returned as they are (a moved value that breaks today's rules is kept
 * and reported in `invalid`, D3), never normalised on the way out.
 */

import { LEGAL_ENTITIES, type LegalEntity } from "./entities";
import {
  complete,
  EMPTY_DETAILS,
  type Field,
  ibanPrint,
  invalid,
  type LegalDetails,
  type Reason,
  missing,
  type RequiredField,
} from "./rules";

/** The columns of a stored version the serializer reads (one row of `legal_entity_version`). */
export interface VersionRow {
  entity: string;
  version: number;
  legalName: string;
  addressIt: readonly string[];
  addressEn: readonly string[];
  vatNumber: string;
  iban: string;
  contactsIt: string;
  contactsEn: string;
  createdAt: Date;
}

/** `{ field, line?, reason, limit? }` of E6, in this key order. */
export interface InvalidItem {
  field: Field;
  line?: number;
  reason: Reason;
  limit?: number;
}

/** `LegalEntity` of plan § API contracts "Details". */
export interface LegalEntityBody {
  entity: LegalEntity;
  /** 0: not moved yet (empty values below). */
  version: number;
  /** null when `version` is 0. */
  updatedAt: string | null;
  legalName: string;
  address: { it: string[]; en: string[] };
  vatNumber: string;
  /** Electronic form; "" when empty. */
  iban: string;
  /** Groups of four (D2); "" when empty. */
  ibanPrint: string;
  contacts: { it: string; en: string };
  complete: boolean;
  missing: RequiredField[];
  invalid: InvalidItem[];
}

/** The details of a stored row (copies the arrays: callers may keep or change the result). */
export function detailsOf(row: VersionRow): LegalDetails {
  return {
    legalName: row.legalName,
    address: { it: [...row.addressIt], en: [...row.addressEn] },
    vatNumber: row.vatNumber,
    iban: row.iban,
    contacts: { it: row.contactsIt, en: row.contactsEn },
  };
}

/**
 * One `LegalEntity`. `row === null` is an entity that has no version yet (the move has not run): `version: 0`,
 * `updatedAt: null`, empty values, the four required ones listed in `missing`, `invalid` empty.
 */
export function serializeEntity(entity: LegalEntity, row: VersionRow | null): LegalEntityBody {
  const details = row === null ? EMPTY_DETAILS : detailsOf(row);
  return {
    entity,
    version: row === null ? 0 : row.version,
    updatedAt: row === null ? null : row.createdAt.toISOString(),
    legalName: details.legalName,
    address: { it: [...details.address.it], en: [...details.address.en] },
    vatNumber: details.vatNumber,
    iban: details.iban,
    ibanPrint: ibanPrint(details.iban),
    contacts: { it: details.contacts.it, en: details.contacts.en },
    complete: complete(details),
    missing: missing(details),
    invalid: invalid(details).map(
      (p): InvalidItem => ({
        field: p.field,
        ...(p.line !== undefined ? { line: p.line } : {}),
        reason: p.reason,
        ...(p.limit !== undefined ? { limit: p.limit } : {}),
      }),
    ),
  };
}

/**
 * The list answer: exactly one item per entity, in `LEGAL_ENTITIES` order, whatever `currentRows` holds (one row
 * per entity, the highest version; an entity without a row is `version: 0`). A row of an entity outside the
 * registry is ignored (the table CHECKs it cannot exist).
 */
export function serializeAll(currentRows: readonly VersionRow[]): { items: LegalEntityBody[] } {
  return {
    items: LEGAL_ENTITIES.map((entity) =>
      serializeEntity(entity, currentRows.find((row) => row.entity === entity) ?? null),
    ),
  };
}

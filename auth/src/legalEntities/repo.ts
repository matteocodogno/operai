/**
 * Reads of the legal-entity registry (specs/20261117-legal-entities). `legal_entity_version` is Tier 1 and
 * append-only: this module only ever SELECTs; the writes of a save/restore/import live in their own modules and
 * go through the audit transaction.
 *
 * Every function takes the client to read through, defaulting to `db`, so a test can read through the
 * rolled-back transaction it wrote its rows in (`testDb.ts`) and a save can read inside its own transaction.
 */

import { db } from "../lib/db";
import type { Field } from "./rules";
import type { VersionRow } from "./serialize";

/** Anything that can run a raw query: `db` or a transaction client. */
export type Reader = Pick<typeof db, "$queryRaw">;

/**
 * The highest version of each entity that has one, in one query (one snapshot: the list never shows two entities
 * from different moments of a concurrent save). An entity with no version yet has no row.
 */
export async function currentVersions(client: Reader = db): Promise<VersionRow[]> {
  return client.$queryRaw<VersionRow[]>`
    SELECT DISTINCT ON ("entity")
      "entity", "version", "legalName",
      COALESCE("addressIt", ARRAY[]::text[]) AS "addressIt", COALESCE("addressEn", ARRAY[]::text[]) AS "addressEn",
      "vatNumber", "iban",
      "contactsIt", "contactsEn", "createdAt"
    FROM "legal_entity_version"
    ORDER BY "entity", "version" DESC`;
}

/** One stored version with the record of how it came to be (the history and the version view). */
export interface HistoryRow extends VersionRow {
  /** The table CHECKs the three values. */
  action: "import" | "save" | "restore";
  restoredFrom: number | null;
  /** As stored, in the closed-set order the save wrote (never recomputed on a read). */
  changedFields: Field[];
  /** null = the system (the import). */
  createdByUserId: string | null;
  createdByName: string | null;
}

/** Every version of one entity, newest first (AC-2.2): no page, no cap - a registry of two entities stays small. */
export async function versionsOf(entity: string, client: Reader = db): Promise<HistoryRow[]> {
  return client.$queryRaw<HistoryRow[]>`
    SELECT
      "entity", "version", "legalName",
      COALESCE("addressIt", ARRAY[]::text[]) AS "addressIt", COALESCE("addressEn", ARRAY[]::text[]) AS "addressEn",
      "vatNumber", "iban", "contactsIt", "contactsEn",
      "action", "restoredFrom", COALESCE("changedFields", ARRAY[]::text[]) AS "changedFields",
      "createdByUserId", "createdByName", "createdAt"
    FROM "legal_entity_version"
    WHERE "entity" = ${entity}
    ORDER BY "version" DESC`;
}

/** Version `version` of `entity`, or null when it does not exist (`version` is an int4 the caller has bounded). */
export async function versionOf(entity: string, version: number, client: Reader = db): Promise<HistoryRow | null> {
  const rows = await client.$queryRaw<HistoryRow[]>`
    SELECT
      "entity", "version", "legalName",
      COALESCE("addressIt", ARRAY[]::text[]) AS "addressIt", COALESCE("addressEn", ARRAY[]::text[]) AS "addressEn",
      "vatNumber", "iban", "contactsIt", "contactsEn",
      "action", "restoredFrom", COALESCE("changedFields", ARRAY[]::text[]) AS "changedFields",
      "createdByUserId", "createdByName", "createdAt"
    FROM "legal_entity_version"
    WHERE "entity" = ${entity} AND "version" = ${version}`;
  return rows[0] ?? null;
}

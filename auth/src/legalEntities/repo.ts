/**
 * Reads of the legal-entity registry (specs/20261117-legal-entities). `legal_entity_version` is Tier 1 and
 * append-only: this module only ever SELECTs; the writes of a save/restore/import live in their own modules and
 * go through the audit transaction.
 *
 * Every function takes the client to read through, defaulting to `db`, so a test can read through the
 * rolled-back transaction it wrote its rows in (`testDb.ts`) and a save can read inside its own transaction.
 */

import { db } from "../lib/db";
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

/**
 * Reads and the one append of the legal-entity registry (specs/20261117-legal-entities). `legal_entity_version` is
 * Tier 1 and append-only: this module SELECTs, takes the entity's lock and INSERTS a version (`appendVersion`, T8);
 * nothing here updates or deletes a row (the database would refuse it, and `routerTable.test.ts` scans for it).
 * A save/restore calls `appendVersion` from inside the audit transaction (`withAudit`), never outside it.
 *
 * Every function takes the client to read through, defaulting to `db`, so a test can read through the
 * rolled-back transaction it wrote its rows in (`testDb.ts`) and a save can read inside its own transaction.
 */

import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import type { LegalEntity } from "./entities";
import type { Field, LegalDetails } from "./rules";
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

/**
 * The key of the advisory lock every writer of an entity takes (a save, a restore, the import script of T9):
 * `pg_advisory_xact_lock(hashtext('legal_entity:<entity>'))`. The text is built here so the name cannot drift from
 * the one `import.ts` uses (its test reads both).
 */
export const lockKey = (entity: LegalEntity): string => `legal_entity:${entity}`;

/** Takes the entity's transaction-scoped advisory lock: held until the surrounding transaction ends. */
export async function lockEntity(tx: Prisma.TransactionClient, entity: LegalEntity): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(entity)}))`;
}

/** The highest version of one entity, or null when it has none (the move has not run). */
export async function latestVersion(entity: string, client: Reader = db): Promise<HistoryRow | null> {
  const rows = await client.$queryRaw<HistoryRow[]>`
    SELECT
      "entity", "version", "legalName",
      COALESCE("addressIt", ARRAY[]::text[]) AS "addressIt", COALESCE("addressEn", ARRAY[]::text[]) AS "addressEn",
      "vatNumber", "iban", "contactsIt", "contactsEn",
      "action", "restoredFrom", COALESCE("changedFields", ARRAY[]::text[]) AS "changedFields",
      "createdByUserId", "createdByName", "createdAt"
    FROM "legal_entity_version"
    WHERE "entity" = ${entity}
    ORDER BY "version" DESC
    LIMIT 1`;
  return rows[0] ?? null;
}

/** What a save or a restore appends. `details` is already `normalise`d by the caller. */
export interface NewVersion {
  entity: LegalEntity;
  version: number;
  details: LegalDetails;
  action: "save" | "restore";
  restoredFrom: number | null;
  changedFields: readonly Field[];
  createdByUserId: string;
  createdByName: string;
}

/**
 * Appends version `version` of an entity and returns it as the database stored it (what the answer then reports).
 * The caller holds the entity's lock and has read the current version, so `version` is current + 1; the primary key
 * and the table's CHECKs are the last line of defence, never the first.
 */
export async function appendVersion(tx: Prisma.TransactionClient, v: NewVersion): Promise<HistoryRow> {
  const row = await tx.legalEntityVersion.create({
    data: {
      entity: v.entity,
      version: v.version,
      legalName: v.details.legalName,
      addressIt: [...v.details.address.it],
      addressEn: [...v.details.address.en],
      vatNumber: v.details.vatNumber,
      iban: v.details.iban,
      contactsIt: v.details.contacts.it,
      contactsEn: v.details.contacts.en,
      action: v.action,
      restoredFrom: v.restoredFrom,
      changedFields: [...v.changedFields],
      createdByUserId: v.createdByUserId,
      createdByName: v.createdByName,
    },
  });
  return {
    entity: row.entity,
    version: row.version,
    legalName: row.legalName,
    addressIt: row.addressIt,
    addressEn: row.addressEn,
    vatNumber: row.vatNumber,
    iban: row.iban,
    contactsIt: row.contactsIt,
    contactsEn: row.contactsEn,
    action: row.action as HistoryRow["action"],
    restoredFrom: row.restoredFrom,
    changedFields: row.changedFields as Field[],
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
  };
}

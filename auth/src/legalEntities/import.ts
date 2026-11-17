/**
 * The copy of the CRM's legal details into the registry (specs/20261117-legal-entities, T9; US-7, AC-7.1 to AC-7.5;
 * ADR 20261117-the-crms-legal-details-move-to-the-registry-by-expand-copy-switch-contract-and-version-1-is-attributed-to-the-system;
 * plan sequence "Copy (script)", amendment E11).
 *
 * The entry point is `auth/scripts/import-crm-legal-details.ts`; everything testable lives here.
 *
 * What it does, per legal entity, under the entity's advisory lock (`--apply` only):
 *   - no version in the registry  -> insert version 1 (`action: import`, `createdByUserId: null`) and its
 *                                    `legal_entity.import` audit row in ONE transaction (`inserted`; dry run: `would_insert`);
 *   - a version exists            -> compare the CRM row, under the mapping, with version 1 and with the current version:
 *       `present`    equals version 1;
 *       `resolved`   differs from version 1 but equals the CURRENT version (someone carried the CRM edit into the registry);
 *       `mismatched` differs from both. Nothing is ever overwritten, repaired or inserted.
 * The comparison covers the four values the CRM holds (`legalName`, `address.it`, `vatNumber`, `iban`); `address.en`
 * is not compared (the CRM has one language, E11) and the contacts are not in the CRM.
 *
 * Stop rule (E11): there is NO refusal while the CRM columns exist: a dry run may run at any time, and an apply with a
 * version on both entities inserts nothing and exits 0. Once the CRM's four columns are dropped (release step 6) the
 * run stops with `crm_legal_columns_absent` BEFORE reading any row.
 *
 * Safety rules the code keeps:
 *   - the CRM session is opened read only (`default_transaction_read_only = on` as a startup parameter) and the
 *     script verifies that the server honoured it before reading (a pooler may drop startup parameters): a session
 *     that is not read only is refused, never trusted;
 *   - nothing the CRM or the registry holds is ever printed or put in an error: the report names entities, categories,
 *     field names, reasons and line numbers only (a database error message can carry a failing row, so only its code
 *     is shown);
 *   - the connection strings come from the environment only, never from an argument (they would show in `ps`).
 *
 * Exit codes: 0 accounted for (nothing `mismatched`), 1 a mismatch or a failure, 2 `crm_legal_columns_absent`,
 * 64 usage (an unknown argument, a missing or equal pair of connection strings).
 */

import { SQL } from "bun";
import type { Prisma } from "../lib/generated/prisma/client";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";
import {
  type Field,
  type LegalDetails,
  type Problem,
  type RequiredField,
  changedFields,
  ibanPrint,
  invalid,
  missing,
  normaliseIban,
} from "./rules";

export type Tx = Prisma.TransactionClient;
/** Runs `fn` in one database transaction of the registry's database (the script's: `db.$transaction`). */
export type Transact = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------------------------------------------
// Errors

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_COLUMNS_ABSENT = 2;
export const EXIT_USAGE = 64;

/** A refusal with a stable code; its message never carries a value. */
export class ImportError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** What is safe to print about an unexpected error: its class and a database code, never its message. */
export function safeErrorText(error: unknown): string {
  if (error instanceof ImportError) return `${error.code}: ${error.message}`;
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current !== "object") break;
    const e = current as { name?: unknown; code?: unknown; errno?: unknown; meta?: { code?: unknown } };
    if (typeof e.name === "string" && depth === 0) parts.push(e.name);
    for (const code of [e.code, e.errno, e.meta?.code]) {
      if ((typeof code === "string" || typeof code === "number") && !parts.includes(`code ${code}`)) {
        parts.push(`code ${code}`);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(", ") : "unexpected error";
}

// ---------------------------------------------------------------------------------------------------------------
// The mapping

/** The four CRM columns that are the source (`entity_profile`, crm-api/prisma/schema.prisma). */
export const CRM_LEGAL_COLUMNS = ["legalName", "addressLines", "vatNumber", "iban"] as const;

/** One CRM `entity_profile` row, the legal part only. */
export interface CrmProfile {
  legalName: string;
  addressLines: string[];
  vatNumber: string | null;
  iban: string | null;
  /** ISO 8601 (UTC) of the row's `updatedAt`, for the audit row. */
  updatedAt: string;
}

/**
 * CRM's own print rule (`oneLine`, crm-api/src/offers/blocks.ts): a line break and the blanks around it become one
 * space, then trim. Copied, not imported (no shared package between services); it is what the CRM printed, so the
 * moved value prints the same (AC-7.5). Note it is deliberately NOT the registry's `clean`: no Unicode
 * normalisation, and U+0085 / U+2028 / U+2029 on their own are not line breaks to it (the registry's rules then flag
 * them `invalid`, which is what D3 asks for).
 */
export const crmOneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** What a CRM row becomes as the registry's version 1 (plan "Copy (script)"); no row -> empty values (AC-7.3). */
export function mapProfile(profile: CrmProfile | null): LegalDetails {
  if (profile === null) {
    return { legalName: "", address: { it: [], en: [] }, vatNumber: "", iban: "", contacts: { it: "", en: "" } };
  }
  const lines = profile.addressLines.map(crmOneLine).filter((line) => line !== "");
  return {
    legalName: crmOneLine(profile.legalName),
    // Both languages: the CRM has one address (AC-7.1).
    address: { it: [...lines], en: [...lines] },
    vatNumber: crmOneLine(profile.vatNumber ?? ""),
    // AC-1.4's stored form: all whitespace removed, upper case. The check digits are reported, not enforced (D3).
    iban: normaliseIban(crmOneLine(profile.iban ?? "")),
    contacts: { it: "", en: "" },
  };
}

/** D2: the CRM printed the typed text; the registry prints groups of four. True when the printed IBAN would differ. */
export function ibanPrintChangedOf(profile: CrmProfile | null, details: LegalDetails): boolean {
  if (profile === null) return false;
  return crmOneLine(profile.iban ?? "") !== ibanPrint(details.iban);
}

/** The values the CRM holds, compared with a stored version (E11: `address.en` and contacts are not compared). */
const COMPARED = ["legalName", "address.it", "vatNumber", "iban"] as const satisfies readonly Field[];
type Compared = (typeof COMPARED)[number];

function comparedValue(d: LegalDetails, f: Compared): string | readonly string[] {
  switch (f) {
    case "legalName":
      return d.legalName;
    case "address.it":
      return d.address.it;
    case "vatNumber":
      return d.vatNumber;
    case "iban":
      return d.iban;
  }
}

function sameCompared(a: string | readonly string[], b: string | readonly string[]): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** The compared fields on which two details differ (names only). */
export function differingFields(a: LegalDetails, b: LegalDetails): Compared[] {
  return COMPARED.filter((f) => !sameCompared(comparedValue(a, f), comparedValue(b, f)));
}

interface StoredVersion {
  legalName: string;
  addressIt: string[];
  addressEn: string[];
  vatNumber: string;
  iban: string;
  contactsIt: string;
  contactsEn: string;
}

function detailsOf(v: StoredVersion): LegalDetails {
  return {
    legalName: v.legalName,
    address: { it: v.addressIt, en: v.addressEn },
    vatNumber: v.vatNumber,
    iban: v.iban,
    contacts: { it: v.contactsIt, en: v.contactsEn },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The source: the CRM database, read only

export interface CrmSource {
  /** The session's `default_transaction_read_only` is `on`. */
  isReadOnly(): Promise<boolean>;
  /** Whether `entity_profile` exists, and which of the four legal columns it no longer has. */
  legalColumns(): Promise<{ table: boolean; absent: string[] }>;
  /** The legal part of the entity's profile, or null when the CRM has no row. */
  profile(entity: LegalEntity): Promise<CrmProfile | null>;
  close(): Promise<void>;
}

/** `openCrmSource` also hands out the session, so a test can prove that a write on it fails. */
export interface OpenedCrmSource extends CrmSource {
  readonly sql: SQL;
}

const TIMESTAMP_UTC = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

export function openCrmSource(url: string): OpenedCrmSource {
  // One connection, read only from its first statement: the setting is a startup parameter, so a reconnect keeps it.
  const sql = new SQL(url, { max: 1, connection: { default_transaction_read_only: "on" } });
  return {
    sql,
    async isReadOnly() {
      const rows = (await sql`SELECT current_setting('default_transaction_read_only') AS value`) as { value: string }[];
      return rows[0]?.value === "on";
    },
    async legalColumns() {
      // pg_attribute, not information_schema: the latter hides a column the role has no privilege on, which would
      // read as "dropped".
      const rows = (await sql`
        SELECT to_regclass('entity_profile') IS NOT NULL AS "table",
               COALESCE(
                 (SELECT array_agg(a.attname::text) FROM pg_attribute a
                   WHERE a.attrelid = to_regclass('entity_profile') AND a.attnum > 0 AND NOT a.attisdropped),
                 ARRAY[]::text[]) AS present`) as { table: boolean; present: string[] | string }[];
      const row = rows[0];
      if (!row || !row.table) return { table: false, absent: [...CRM_LEGAL_COLUMNS] };
      const present = new Set(parsePgTextArray(row.present));
      return { table: true, absent: CRM_LEGAL_COLUMNS.filter((c) => !present.has(c)) };
    },
    async profile(entity) {
      const rows = (await sql`
        SELECT "legalName", to_jsonb("addressLines") AS "addressLines", "vatNumber", "iban",
               to_char("updatedAt", ${TIMESTAMP_UTC}) AS "updatedAt"
          FROM "entity_profile" WHERE "entity"::text = ${entity}`) as {
        legalName: unknown;
        addressLines: unknown;
        vatNumber: unknown;
        iban: unknown;
        updatedAt: unknown;
      }[];
      const row = rows[0];
      if (!row) return null;
      return readProfile(row);
    },
    async close() {
      await sql.close();
    },
  };
}

/** Bun may hand a `text[]` back as an array or, for some drivers, as its text form; accept both, safely. */
function parsePgTextArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.map(String);
  const inner = value.replace(/^\{|\}$/g, "");
  return inner === "" ? [] : inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
}

function readProfile(row: {
  legalName: unknown;
  addressLines: unknown;
  vatNumber: unknown;
  iban: unknown;
  updatedAt: unknown;
}): CrmProfile {
  // The column is a nullable text[]; a NULL list prints as no lines.
  const raw = typeof row.addressLines === "string" ? JSON.parse(row.addressLines) : row.addressLines;
  const lines = raw === null || raw === undefined ? [] : raw;
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  if (!Array.isArray(lines)) throw new ImportError("crm_row_unreadable", EXIT_FAILED, "the CRM row has an unexpected shape");
  return {
    legalName: text(row.legalName) ?? "",
    // A NULL element of the array would print as nothing in the CRM; it is a blank line, which the mapping drops.
    addressLines: lines.map((l) => (l === null || l === undefined ? "" : String(l))),
    vatNumber: text(row.vatNumber),
    iban: text(row.iban),
    updatedAt: text(row.updatedAt) ?? "",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The report

export type Category = "inserted" | "would_insert" | "present" | "resolved" | "mismatched";

export interface EntityReport {
  entity: LegalEntity;
  category: Category;
  /** The CRM has a profile row for this entity (false: the move carries empty values, AC-7.3). */
  crmRow: boolean;
  /** A required value is missing (AC-1.2): the page marks the entity incomplete. */
  incomplete: boolean;
  missing: RequiredField[];
  /** What AC-1.3 / AC-1.4 refuse in the moved values: field, line, reason, limit; never a value. */
  invalid: Problem[];
  /** D2: the printed IBAN differs from the CRM's typed text. */
  ibanPrintChanged: boolean;
  /** `mismatched`: the compared fields on which the CRM row differs from version 1. */
  differs: string[];
}

export interface ImportReport {
  applied: boolean;
  /** Entities that have a CRM profile row. */
  found: number;
  entities: EntityReport[];
  inserted: number;
  wouldInsert: number;
  present: number;
  resolved: number;
  mismatched: number;
  /** Entities flagged. */
  incomplete: number;
  invalid: number;
  ibanPrintChanged: number;
}

export function summarise(applied: boolean, entities: EntityReport[]): ImportReport {
  const count = (c: Category) => entities.filter((e) => e.category === c).length;
  return {
    applied,
    found: entities.filter((e) => e.crmRow).length,
    entities,
    inserted: count("inserted"),
    wouldInsert: count("would_insert"),
    present: count("present"),
    resolved: count("resolved"),
    mismatched: count("mismatched"),
    incomplete: entities.filter((e) => e.incomplete).length,
    invalid: entities.filter((e) => e.invalid.length > 0).length,
    ibanPrintChanged: entities.filter((e) => e.ibanPrintChanged).length,
  };
}

/** The gate: nothing `mismatched` (E11). The owner reads the flags separately. */
export function exitCodeOf(report: ImportReport): number {
  return report.mismatched > 0 ? EXIT_FAILED : EXIT_OK;
}

const problemText = (p: Problem): string =>
  `${p.field}${p.line === undefined ? "" : `[${p.line}]`} ${p.reason}${p.limit === undefined ? "" : ` (limit ${p.limit})`}`;

/** The text report: counts, then one block per entity. Names, categories, reasons and numbers only. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(`legal-entities import: ${report.applied ? "APPLY" : "dry run (nothing is written)"}`);
  lines.push(
    `found ${report.found} | ${report.applied ? `inserted ${report.inserted}` : `would insert ${report.wouldInsert}`}` +
      ` | present ${report.present} | resolved ${report.resolved} | mismatched ${report.mismatched}`,
  );
  lines.push(
    `flags: incomplete ${report.incomplete} | invalid ${report.invalid} | ibanPrintChanged ${report.ibanPrintChanged}`,
  );
  for (const e of report.entities) {
    lines.push("");
    lines.push(`${e.entity}: ${e.category}${e.crmRow ? "" : " (no CRM row: empty values)"}`);
    if (e.differs.length > 0) lines.push(`  differs from version 1: ${e.differs.join(", ")}`);
    if (e.incomplete) lines.push(`  incomplete, missing: ${e.missing.join(", ")}`);
    if (e.invalid.length > 0) lines.push(`  invalid: ${e.invalid.map(problemText).join("; ")}`);
    if (e.ibanPrintChanged) lines.push("  ibanPrintChanged: the printed IBAN differs from the CRM's typed text (D2)");
  }
  lines.push("");
  lines.push(report.mismatched > 0 ? "NOT ACCOUNTED FOR: mismatched above 0, nothing was overwritten" : "ACCOUNTED FOR");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// One entity

const lockName = (entity: LegalEntity): string => `legal_entity:${entity}`;

async function importEntity(
  tx: Tx,
  entity: LegalEntity,
  crm: CrmSource,
  apply: boolean,
): Promise<EntityReport> {
  // The same lock as a registry save (plan "Save"): a save and the copy never interleave.
  if (apply) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockName(entity)}))`;

  const profile = await crm.profile(entity);
  const details = mapProfile(profile);
  const flags = {
    crmRow: profile !== null,
    missing: missing(details),
    invalid: invalid(details),
    ibanPrintChanged: ibanPrintChangedOf(profile, details),
  };
  const base = {
    entity,
    crmRow: flags.crmRow,
    incomplete: flags.missing.length > 0,
    missing: flags.missing,
    invalid: flags.invalid,
    ibanPrintChanged: flags.ibanPrintChanged,
    differs: [] as string[],
  };

  const first = await tx.legalEntityVersion.findUnique({ where: { entity_version: { entity, version: 1 } } });
  if (first === null) {
    const latest = await tx.legalEntityVersion.findFirst({ where: { entity }, orderBy: { version: "desc" } });
    if (latest !== null) {
      throw new ImportError("registry_not_contiguous", EXIT_FAILED, `${entity} has versions but no version 1`);
    }
    if (!apply) return { ...base, category: "would_insert" };

    const fields = changedFields(null, details);
    await tx.legalEntityVersion.create({
      data: {
        entity,
        version: 1,
        legalName: details.legalName,
        addressIt: details.address.it,
        addressEn: details.address.en,
        vatNumber: details.vatNumber,
        iban: details.iban,
        contactsIt: details.contacts.it,
        contactsEn: details.contacts.en,
        action: "import",
        restoredFrom: null,
        changedFields: fields,
        createdByUserId: null,
        createdByName: null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        action: "legal_entity.import",
        targetType: "legal_entity",
        targetId: entity,
        summary: `Imported the CRM's legal details of ${entity} as version 1`,
        data: toJson({
          version: 1,
          source: { table: "crm.entity_profile", row: profile !== null, updatedAt: profile?.updatedAt ?? null },
          // The import has no `before`; `after` is the value moved (plan, audit shape).
          changes: Object.fromEntries(fields.map((f) => [f, { after: afterValue(details, f) }])),
          missing: flags.missing,
          invalid: flags.invalid,
          ibanPrintChanged: flags.ibanPrintChanged,
        }),
      },
    });
    // Read back what the database holds: a value that does not survive the round trip (array quoting, encoding) is
    // not accounted for, and the transaction rolls back.
    const stored = await tx.legalEntityVersion.findUnique({ where: { entity_version: { entity, version: 1 } } });
    if (stored === null || differingFields(detailsOf(stored), details).length > 0) {
      throw new ImportError("import_readback_mismatch", EXIT_FAILED, `${entity}: the stored version 1 is not what was written`);
    }
    return { ...base, category: "inserted" };
  }

  const differs = differingFields(details, detailsOf(first));
  if (differs.length === 0) return { ...base, category: "present" };

  const latest = await tx.legalEntityVersion.findFirst({ where: { entity }, orderBy: { version: "desc" } });
  if (latest !== null && latest.version !== 1 && differingFields(details, detailsOf(latest)).length === 0) {
    return { ...base, category: "resolved" };
  }
  return { ...base, category: "mismatched", differs };
}

/** A plain JSON value for the audit row's `data` (the report types are not assignable to Prisma's input type). */
const toJson = (value: unknown): Prisma.InputJsonObject => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

function afterValue(d: LegalDetails, f: Field): string | string[] {
  switch (f) {
    case "legalName":
      return d.legalName;
    case "address.it":
      return d.address.it;
    case "address.en":
      return d.address.en;
    case "vatNumber":
      return d.vatNumber;
    case "iban":
      return d.iban;
    case "contacts.it":
      return d.contacts.it;
    case "contacts.en":
      return d.contacts.en;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The run

export interface RunOptions {
  apply: boolean;
  crm: CrmSource;
  transact: Transact;
}

/**
 * Checks the source, then accounts for every entity, each in its own transaction (an apply that fails on the second
 * entity leaves the first inserted, and the next run reports it `present`). Throws `ImportError`:
 * `crm_not_read_only`, `crm_entity_profile_absent`, `crm_legal_columns_absent` (exit 2), and a failure per entity.
 */
export async function runImport({ apply, crm, transact }: RunOptions): Promise<ImportReport> {
  if (!(await crm.isReadOnly())) {
    throw new ImportError("crm_not_read_only", EXIT_FAILED, "the CRM session is not read only; nothing was read");
  }
  const columns = await crm.legalColumns();
  if (!columns.table) {
    throw new ImportError("crm_entity_profile_absent", EXIT_FAILED, "the CRM has no entity_profile table: wrong database?");
  }
  if (columns.absent.length > 0) {
    throw new ImportError(
      "crm_legal_columns_absent",
      EXIT_COLUMNS_ABSENT,
      `the CRM's entity_profile no longer has ${columns.absent.join(", ")}: the source of the move is gone, nothing was read or written`,
    );
  }
  const entities: EntityReport[] = [];
  for (const entity of LEGAL_ENTITIES) {
    entities.push(await transact((tx) => importEntity(tx, entity, crm, apply)));
  }
  return summarise(apply, entities);
}

// ---------------------------------------------------------------------------------------------------------------
// The command

export interface MainDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  transact: Transact;
  /** Test seam: the source to use instead of opening `CRM_DATABASE_URL`. */
  openCrm?: (url: string) => CrmSource;
}

const USAGE =
  "usage: CRM_DATABASE_URL=<url> DATABASE_URL=<url> bun run scripts/import-crm-legal-details.ts [--apply] [--json]\n" +
  "  The connection strings are environment variables only (never arguments: they would show in ps).\n" +
  "  Dry run unless --apply.";

/** Returns the exit code; never calls `process.exit` (the entry point does, after closing connections). */
export async function main(deps: MainDeps): Promise<number> {
  let apply = false;
  let json = false;
  for (const arg of deps.argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else {
      // The argument is not echoed: it may be a connection string.
      deps.stderr(`unknown argument\n${USAGE}`);
      return EXIT_USAGE;
    }
  }
  const crmUrl = deps.env["CRM_DATABASE_URL"];
  const authUrl = deps.env["DATABASE_URL"];
  if (!crmUrl || !authUrl) {
    deps.stderr(`CRM_DATABASE_URL and DATABASE_URL must both be set in the environment\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (crmUrl === authUrl) {
    deps.stderr("CRM_DATABASE_URL and DATABASE_URL are the same: the source and the registry are different databases");
    return EXIT_USAGE;
  }

  let crm: CrmSource | undefined;
  try {
    crm = (deps.openCrm ?? openCrmSource)(crmUrl);
    const report = await runImport({ apply, crm, transact: deps.transact });
    deps.stdout(json ? JSON.stringify(report, null, 2) : formatReport(report));
    return exitCodeOf(report);
  } catch (error) {
    deps.stderr(`import failed: ${safeErrorText(error)}`);
    return error instanceof ImportError ? error.exitCode : EXIT_FAILED;
  } finally {
    await crm?.close().catch(() => undefined);
  }
}

/**
 * One-off copy of the CRM's legal details into the legal-entity registry (specs/20261117-legal-entities, T9;
 * ADR 20261117-the-crms-legal-details-move-to-the-registry-by-expand-copy-switch-contract-and-version-1-is-attributed-to-the-system).
 *
 *   CRM_DATABASE_URL=<url> DATABASE_URL=<url> bun run scripts/import-crm-legal-details.ts [--apply] [--json]
 *
 * Dry run unless `--apply`. The two connection strings come from the ENVIRONMENT only, never from arguments (an
 * argument lands in `ps` and in the shell history). The CRM database is opened read only; nothing the CRM or the
 * registry holds is printed. The logic, the report categories and the stop rule are in `src/legalEntities/import.ts`.
 *
 * Exit codes: 0 accounted for, 1 mismatched or failed, 2 `crm_legal_columns_absent` (the CRM's columns are dropped:
 * the move is over), 64 usage.
 */

import { db } from "../src/lib/db";
import { main } from "../src/legalEntities/import";

const code = await main({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
  transact: (fn) => db.$transaction(fn, { timeout: 30_000 }),
});
await db.$disconnect().catch(() => undefined);
process.exit(code);

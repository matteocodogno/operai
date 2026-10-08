/**
 * One-off import of the legacy Excel hardware register for `welld_ch`
 * (T23, specs/015-hardware-inventory; US-12, AC-12.1 to AC-12.9; ADR-0046).
 * A script, not a route and not a screen (spec non-goal).
 *
 *   bun scripts/import-legacy.ts --file <register.xlsx> --user-map <users.json>
 *        --expected-opening-cents <n> [--apply]
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` the script reads the sheet, plans
 * every row and prints the report, and writes nothing. `--apply` additionally
 * needs `--expected-opening-cents`: the opening balance accounting confirmed
 * for 2026 (spec O3), as integer cents. The import is refused, with nothing
 * written, unless the sum of every imported asset's book value at 31.12.2025
 * equals it exactly (AC-12.4).
 *
 * The three tables it writes (`asset_year_figure`, `fiscal_year`, `asset_event`)
 * are append-only at the database, so a wrong import cannot be corrected later.
 * Hence: all or nothing in one transaction under the entity lock; a row it
 * cannot interpret is reported with its sheet row number and stops the apply; and
 * a second run on an entity that already holds the import writes nothing.
 *
 * `--user-map` is a JSON file produced by hand from the user directory:
 * `[{"id": "<auth user id>", "name": "<full name>"}, ...]` (extra keys, such as
 * the directory's `email`, are ignored). An assignee text that equals the name
 * of EXACTLY ONE entry (case, accents and spacing aside) becomes the holder.
 *
 * How the sheet is read, where it was not obvious:
 *  - the number of units in a row is its book value at the end of its schedule
 *    (purchase year + rule life - 1) divided by the rule's residual per unit:
 *    CHF 13.00 at the end of a three-year schedule with a CHF 1 residual is 13
 *    units. A value that is not a whole number of residuals is an error.
 *  - a blank "Valore al 31.12.2025" next to a 2025 depreciation that takes the
 *    value to exactly zero is a closing value of 0 (spec O4); any other blank is
 *    an error.
 *  - the three rows with a value at 31.12.2023 and nothing after, and a cession
 *    whose serial matches no purchase row, are spec O5: reported and skipped.
 *  - there is no category column: the category is a keyword match on the
 *    description, else `other`. A manager corrects it in the edit form.
 *
 * Exit codes: 0 done (or a clean dry run); 1 refused (unreadable rows, wrong
 * balance, entity not empty, database fault); 2 bad usage.
 *
 * The workbook is company data and untrusted input: it is only read, never
 * copied, and the report carries counts and row numbers, never row content.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { resolveRule } from "../src/depreciation/resolveRule";
import { applyPlan, classify, ImportRefused, readEntityState } from "./legacy/apply";
import { parseSheet } from "./legacy/parse";
import { buildPlan, ENTITY, LAST_IMPORTED_YEAR, type DirectoryUser, type RuleInputs } from "./legacy/plan";
import { formatCents, renderReport } from "./legacy/report";
import { readSheetRows } from "./legacy/sheet";

export interface ImportOptions {
  readonly file: string;
  readonly userMapPath: string;
  readonly expectedOpeningCents: number | undefined;
  readonly apply: boolean;
}

export interface Io {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** The launch rule of AC-6.6, used only by a dry run that cannot reach the database. */
const LAUNCH_RULE: RuleInputs = { usefulLifeYears: 3, residualCents: 100 };

/** Reads `[{id, name}]` (or `{users: [...]}`); throws a message that never echoes file content. */
export function loadUserMap(path: string): DirectoryUser[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`--user-map ${path} is not readable JSON`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { users?: unknown } | null)?.users;
  if (!Array.isArray(list)) throw new Error("--user-map must be a JSON array of {id, name} (or {users: [...]})");
  const users: DirectoryUser[] = [];
  list.forEach((entry, i) => {
    const { id, name } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "" || typeof name !== "string" || name.trim() === "") {
      throw new Error(`--user-map entry ${i} needs a non-empty string "id" and "name"`);
    }
    users.push({ id: id.trim(), name: name.trim() });
  });
  return users;
}

export async function runImport(options: ImportOptions, io: Io): Promise<number> {
  const mode = options.apply ? "apply" : "dry-run";
  if (options.apply && options.expectedOpeningCents === undefined) {
    io.error("--apply needs --expected-opening-cents <n>: the opening balance accounting confirmed for 2026, in cents");
    return 2;
  }

  let users: DirectoryUser[];
  let parsedRows;
  try {
    users = loadUserMap(options.userMapPath);
    parsedRows = await readSheetRows(options.file);
  } catch (error) {
    io.error(error instanceof Error ? error.message : "could not read the input");
    return 2;
  }

  // The rule in force decides how many units a row stands for. From the database; a dry run may fall back to the launch rule.
  let ruleFor: (date: string) => RuleInputs | null;
  const warnings: string[] = [];
  try {
    const rules = await db.depreciationRule.findMany({ where: { entity: ENTITY } });
    ruleFor = (date) => {
      const rule = resolveRule(rules, ENTITY, new Date(`${date}T00:00:00.000Z`));
      return rule ? { usefulLifeYears: rule.usefulLifeYears, residualCents: rule.residualCents } : null;
    };
  } catch {
    if (options.apply) {
      io.error("could not read the depreciation rules from the database; nothing was written");
      return 1;
    }
    warnings.push("database not reachable: using the launch rule (3 years, CHF 1.00 residual) and skipping the entity check");
    ruleFor = () => LAUNCH_RULE;
  }

  const parsed = parseSheet(parsedRows);
  const plan = buildPlan({ parsed, users, ruleFor });
  for (const line of renderReport({ mode, parsed, plan, expectedCents: options.expectedOpeningCents })) io.log(line);
  for (const w of warnings) io.log(`Warning: ${w}`);

  const errors = plan.issues.filter((i) => i.kind === "error");
  if (errors.length > 0) {
    io.error(`${errors.length} row(s) cannot be interpreted. Nothing was written.`);
    return 1;
  }
  const total = plan.stats.closingByYear[LAST_IMPORTED_YEAR] ?? 0;
  if (options.expectedOpeningCents !== undefined && total !== options.expectedOpeningCents) {
    io.error(
      `The imported book values at 31.12.${LAST_IMPORTED_YEAR} add up to ${formatCents(total)}, not the expected ${formatCents(options.expectedOpeningCents)}. Nothing was written.`,
    );
    return 1;
  }

  // What the database says about the entity (read only).
  if (warnings.length === 0) {
    try {
      const state = await readEntityState(db);
      const kind = classify(state);
      io.log(
        kind === "empty"
          ? `Database: ${ENTITY} has no assets and no closed years - ready.`
          : kind === "imported"
            ? `Database: ${ENTITY} already holds an import (${state.importedAssets} assets, imported closing ${formatCents(state.importedClosingCents)}) - a run writes nothing.`
            : `Database: ${ENTITY} holds assets or closed fiscal years that did not come from an import - the apply will be refused.`,
      );
      if (kind === "blocked" && !options.apply) {
        io.error("The entity is not empty.");
        return 1;
      }
    } catch {
      io.log("Warning: could not read the entity's state from the database.");
      if (options.apply) return 1;
    }
  }

  if (!options.apply) {
    io.log("Dry run: nothing was written. Add --apply to import.");
    return 0;
  }

  try {
    const result = await applyPlan(plan, options.expectedOpeningCents!);
    io.log(
      result.kind === "applied"
        ? `Imported ${result.assets} assets; fiscal years ${plan.fiscalYears.map((f) => f.year).join(", ")} closed; opening balance ${formatCents(result.closingCents)}.`
        : `Already imported (${result.assets} assets, closing ${formatCents(result.closingCents)}): nothing written.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ImportRefused) {
      io.error(`${error.message} Nothing was written.`);
    } else {
      io.error(`The import failed and was rolled back: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return 1;
  }
}

function parseCli(argv: string[]): ImportOptions | string {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        file: { type: "string" },
        "user-map": { type: "string" },
        "expected-opening-cents": { type: "string" },
        apply: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    return error instanceof Error ? error.message : "bad arguments";
  }
  if (!values.file) return "--file <register.xlsx> is required";
  if (!values["user-map"]) return "--user-map <users.json> is required";
  if (values.apply && values["dry-run"]) return "--apply and --dry-run contradict each other";
  let expected: number | undefined;
  if (values["expected-opening-cents"] !== undefined) {
    if (!/^\d+$/.test(values["expected-opening-cents"])) return "--expected-opening-cents must be a non-negative integer (cents)";
    expected = Number(values["expected-opening-cents"]);
    if (!Number.isSafeInteger(expected)) return "--expected-opening-cents is out of range";
  }
  return { file: values.file, userMapPath: values["user-map"], expectedOpeningCents: expected, apply: values.apply === true };
}

if (import.meta.main) {
  const parsed = parseCli(process.argv.slice(2));
  const io: Io = { log: (l) => console.log(l), error: (l) => console.error(l) };
  const code =
    typeof parsed === "string"
      ? (console.error(`${parsed}\nUsage: bun scripts/import-legacy.ts --file <xlsx> --user-map <json> [--expected-opening-cents <n>] [--apply]`), 2)
      : await runImport(parsed, io);
  await db.$disconnect();
  process.exit(code);
}

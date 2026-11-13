#!/usr/bin/env bun
/**
 * scripts/check-shared-copies.ts — keep deliberately duplicated code in sync.
 *
 * The backends are separate Bun apps with no shared package (a workspace would break the
 * per-app installs and Railway builds, see AGENTS.md ### Git), so a few modules are COPIED.
 * Nothing used to stop the copies drifting. Each copy now brackets its shared region with
 *
 *     // shared-copy:begin <name>
 *     ...
 *     // shared-copy:end <name>
 *
 * and this check fails, naming the files, when the regions are not byte-identical (CRLF
 * ignored). What lies outside the markers (header comment, a per-service final export) may
 * differ freely. A region may only change by editing every copy in the same commit.
 *
 * Usage:  bun scripts/check-shared-copies.ts      (mise run shared:check)
 * Test:   bun test scripts/check-shared-copies.test.ts
 * Exit:   0 = in sync, 1 = drift or a malformed copy.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SharedGroup {
  readonly name: string;
  /** Repo-relative paths. The first readable one is the reference the others are compared with. */
  readonly files: readonly string[];
  readonly why: string;
  /**
   * `region` (default): compare the text between `// shared-copy:begin|end <name>` markers.
   * `whole`: compare the files byte for byte, for a file that cannot carry markers (JSON test vectors).
   */
  readonly mode?: "region" | "whole";
}

/** The registry: add a group here when a module is copied on purpose. */
export const SHARED_COPIES: readonly SharedGroup[] = [
  {
    name: "serviceToken",
    files: [
      "inventory-api/src/lib/serviceToken.ts",
      "refund-api/src/lib/serviceToken.ts",
      "estimai-api/src/lib/serviceToken.ts",
      "crm-api/src/lib/serviceToken.ts",
      "notify-api/src/lib/serviceToken.ts",
      "meetings-api/src/lib/serviceToken.ts",
      "projects-api/src/lib/serviceToken.ts",
      "activities-api/src/lib/serviceToken.ts",
      "hours-api/src/lib/serviceToken.ts",
    ],
    why: "the auth service-token client (ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049/0056); a fix to one copy must reach every copy",
  },
  // s3Residency is registered as TWO narrow regions on purpose. Each copy re-points the
  // MEETINGS_/CRM_/INVENTORY_S3_* names and its refusal messages (meetings-api's deliberately
  // never echo the endpoint, host or region, specs/20261104-meetings T11; crm/inventory-api's do), so
  // `checkEuResidency` cannot be byte-identical. Only the allowlist helpers (region list,
  // isAwsS3Endpoint, host matching) and the path-style rule are shared; the divergent function
  // is outside the markers. refund-api's copy is structured differently and is not in a group.
  {
    name: "s3ResidencyAllowlist",
    files: [
      "inventory-api/src/lib/s3Residency.ts",
      "crm-api/src/lib/s3Residency.ts",
      "meetings-api/src/lib/s3Residency.ts",
      "activities-api/src/lib/s3Residency.ts",
    ],
    why: "the EU region list and endpoint-host matching of the data-residency guard (ADR 20260716-eu-object-storage-refund-attachments); a fix must reach every bucket-owning service",
  },
  {
    name: "s3ResidencyAddressing",
    files: [
      "inventory-api/src/lib/s3Residency.ts",
      "crm-api/src/lib/s3Residency.ts",
      "meetings-api/src/lib/s3Residency.ts",
      "activities-api/src/lib/s3Residency.ts",
    ],
    why: "the path-style addressing rule for non-AWS S3 endpoints; a fix must reach every bucket-owning service",
  },
  // The /system route credential check: a scoped service JWT (scope + `sub` allowlist, one 401 for
  // every failure). notify-api's own copy is structured differently and is not in the group.
  {
    name: "systemAuth",
    files: [
      "crm-api/src/auth/systemAuth.middleware.ts",
      "estimai-api/src/auth/systemAuth.middleware.ts",
      "activities-api/src/auth/systemAuth.middleware.ts",
      "accounting-api/src/auth/systemAuth.middleware.ts",
      "meetings-api/src/auth/systemAuth.middleware.ts",
    ],
    why: "the service-JWT guard of every /system route (ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049); a fix to one copy must reach every copy",
  },
  // meetings-api's, activities-api's and hours-api's problem/logger are whole-file copies of
  // crm-api's (crm-api is the template).
  {
    name: "problem",
    files: [
      "crm-api/src/lib/problem.ts",
      "meetings-api/src/lib/problem.ts",
      "activities-api/src/lib/problem.ts",
      "accounting-api/src/lib/problem.ts",
      "hours-api/src/lib/problem.ts",
    ],
    why: "RFC 7807 Problem JSON helpers; the error shape is a suite contract",
  },
  {
    name: "logger",
    files: [
      "crm-api/src/lib/logger.ts",
      "meetings-api/src/lib/logger.ts",
      "activities-api/src/lib/logger.ts",
      "accounting-api/src/lib/logger.ts",
      "hours-api/src/lib/logger.ts",
    ],
    why: "the request logger; it must keep logging no business data (data residency)",
  },
  // The wire of accounting-api's two /system/v1 answers (specs/20261119-accounting T7, D23): the producer validates what it
  // sends and the consumer parses what it receives with the same code, so the two sides cannot each read the wire their own way.
  {
    name: "accountingWire",
    files: ["accounting-api/src/system/accountingWire.ts", "refund-api/src/accounting/accountingWire.ts"],
    why: "the producer/consumer wire schema of accounting-api's /system/v1 answers (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…, D23); change both files in one commit",
  },
  {
    name: "manDays",
    files: ["crm-api/src/offers/scope.ts", "estimai-api/src/system/manDays.ts"],
    why: "the Expected-effort arithmetic behind a purchase order's man-days (specs/20261103-projects-handoff, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential); estimai-ui's pertCalc is the source of truth",
  },
  // The offer document's paper (page, frame, type, spacing; specs/20261115-crm-offer-wizard T69, DD-67): the PDF draws from
  // it and the paginated preview scales it, so the preview's frame cannot drift from the PDF's (AC-11.10). Whole file: pure
  // constants, no markers, and the header comment is part of what must match.
  {
    name: "offerPaper",
    files: ["crm-api/src/offers/paper.ts", "crm-ui/src/lib/offerPaper/paper.ts"],
    why: "the offer PDF's page size, frame, type sizes and spacing, scaled by the wizard's preview (AC-11.10); change both copies in one commit",
    mode: "whole",
  },
  ...offerEngineGroups(),
];

/**
 * The offer wizard's interpreter (specs/20261115-crm-offer-wizard, DD-6/DD-51, ADR 20261115-offer-template-self-describing-text-shared-interpreter):
 * crm-api and crm-ui hold the same reviewed code, so the server's checks and the browser's preview can never
 * disagree (AC-3.2). One group per engine file (marked region) and one per shared test vector (whole file).
 * The engine is frozen: a change edits both copies and their vectors in one commit.
 */
function offerEngineGroups(): SharedGroup[] {
  const api = "crm-api/src/offers/engine";
  const ui = "crm-ui/src/lib/offerEngine";
  const files = ["markup", "printable", "format", "words", "costs", "compute", "syntax", "answers", "outline", "resolve", "numbering", "edit"];
  const vectors = readdirSync(join(import.meta.dir, "..", api, "vectors"))
    .filter((f) => f.endsWith(".json"))
    .sort();
  return [
    ...files.map((f) => ({
      name: `offerEngine.${f}`,
      files: [`${api}/${f}.ts`, `${ui}/${f}.ts`],
      why: "the offer wizard's shared interpreter (AC-3.2); both copies are the same reviewed code, change them in one commit",
    })),
    ...vectors.map((v) => ({
      name: `offerEngine.vectors.${v}`,
      files: [`${api}/vectors/${v}`, `${ui}/vectors/${v}`],
      why: "the engine's shared test vectors: both copies must pass the same cases (AC-3.2)",
      mode: "whole" as const,
    })),
  ];
}

export type Region = { ok: true; lines: string[]; startLine: number } | { ok: false; reason: string };

/** The lines strictly between the begin/end markers for `name`; exactly one well-ordered pair is required. */
export function extractRegion(text: string, name: string): Region {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const begin = `// shared-copy:begin ${name}`;
  const end = `// shared-copy:end ${name}`;
  const begins = lines.flatMap((l, i) => (l.trim() === begin ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === end ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1) {
    return { ok: false, reason: `expected exactly one "${begin}" and one "${end}" (found ${begins.length} and ${ends.length})` };
  }
  const [b, e] = [begins[0]!, ends[0]!];
  if (e <= b) return { ok: false, reason: `the end marker comes before the begin marker` };
  return { ok: true, lines: lines.slice(b + 1, e), startLine: b + 2 };
}

const clip = (s: string | undefined) => (s === undefined ? "<end of region>" : JSON.stringify(s.length > 100 ? `${s.slice(0, 100)}…` : s));

/** `whole` mode: every file must hold the reference's exact bytes (no marker, no CRLF normalisation). */
function checkWholeFiles(g: SharedGroup, root: string): string[] {
  const errors: string[] = [];
  let ref: { file: string; bytes: Buffer } | undefined;
  for (const file of g.files) {
    const path = join(root, file);
    if (!existsSync(path)) {
      errors.push(`${g.name}: ${file} does not exist`);
      continue;
    }
    const bytes = readFileSync(path);
    if (bytes.length === 0) {
      errors.push(`${g.name}: ${file}: the file is empty, so it guards nothing`);
      continue;
    }
    if (!ref) {
      ref = { file, bytes };
      continue;
    }
    if (ref.bytes.equals(bytes)) continue;
    let at = 0;
    while (at < ref.bytes.length && at < bytes.length && ref.bytes[at] === bytes[at]) at++;
    errors.push(
      `${g.name}: ${file} differs from ${ref.file} at byte offset ${at} (${ref.bytes.length} vs ${bytes.length} bytes) (${g.why})`,
    );
  }
  return errors;
}

/** One message per problem; an empty list means every group is in sync. */
export function checkGroups(groups: readonly SharedGroup[], root: string): string[] {
  const errors: string[] = [];
  for (const g of groups) {
    if (g.files.length < 2) {
      errors.push(`${g.name}: a shared group needs at least two files, got ${g.files.length}`);
      continue;
    }
    if (g.mode === "whole") {
      errors.push(...checkWholeFiles(g, root));
      continue;
    }
    let ref: { file: string; lines: string[]; startLine: number } | undefined;
    for (const file of g.files) {
      const path = join(root, file);
      if (!existsSync(path)) {
        errors.push(`${g.name}: ${file} does not exist`);
        continue;
      }
      const region = extractRegion(readFileSync(path, "utf8"), g.name);
      if (!region.ok) {
        errors.push(`${g.name}: ${file}: ${region.reason}`);
        continue;
      }
      if (region.lines.every((l) => l.trim() === "")) {
        errors.push(`${g.name}: ${file}: the marked region is empty, so it guards nothing`);
        continue;
      }
      if (!ref) {
        ref = { file, ...region };
        continue;
      }
      const n = Math.max(ref.lines.length, region.lines.length);
      for (let i = 0; i < n; i++) {
        if (ref.lines[i] === region.lines[i]) continue;
        errors.push(
          `${g.name}: ${file} differs from ${ref.file} at line ${region.startLine + i} of ${file}: ` +
            `expected ${clip(ref.lines[i])}, found ${clip(region.lines[i])} (${g.why})`,
        );
        break;
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = checkGroups(SHARED_COPIES, join(import.meta.dir, ".."));
  if (errors.length) {
    for (const e of errors) console.error(`shared-copies: ${e}`);
    console.error("\nEdit every copy of the shared region in the same change (or update the registry in scripts/check-shared-copies.ts).");
    process.exit(1);
  }
  console.log(`shared-copies: ${SHARED_COPIES.length} group(s) in sync (${SHARED_COPIES.map((g) => g.name).join(", ")})`);
}

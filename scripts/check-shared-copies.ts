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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SharedGroup {
  readonly name: string;
  /** Repo-relative paths. The first readable one is the reference the others are compared with. */
  readonly files: readonly string[];
  readonly why: string;
}

/** The registry: add a group here when a module is copied on purpose. */
export const SHARED_COPIES: readonly SharedGroup[] = [
  {
    name: "serviceToken",
    files: [
      "inventory-api/src/lib/serviceToken.ts",
      "refund-api/src/lib/serviceToken.ts",
      "estimai-api/src/lib/serviceToken.ts",
    ],
    why: "the auth service-token client (ADR-0044/0049); a fix to one copy must reach all three",
  },
];

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

/** One message per problem; an empty list means every group is in sync. */
export function checkGroups(groups: readonly SharedGroup[], root: string): string[] {
  const errors: string[] = [];
  for (const g of groups) {
    if (g.files.length < 2) {
      errors.push(`${g.name}: a shared group needs at least two files, got ${g.files.length}`);
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

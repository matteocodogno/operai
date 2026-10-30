import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { BACKENDS, FORBIDDEN_VARS, type ServiceName } from "./manifest";

// specs/016 AC-5.2: the retired shared notify token is not a setting any service
// reads, requires or documents. The env contract flags a deployed copy
// (check.test.ts); this guards the code, so the name cannot creep back into a
// service's `src/` (a schema, a header read, a comment that calls it current).
//
// The name is assembled here only so this file is not itself a hit of the
// repository-wide search in infra/README.md; it lives under tools/, not a src/.
const RETIRED = ["NOTIFY", "INTERNAL", "TOKEN"].join("_");

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && st.size < 2_000_000) yield full;
  }
}

describe("the retired shared notify token is absent from every service's src/", () => {
  test("the manifest forbids it on all five backends", () => {
    const entry = FORBIDDEN_VARS.find((v) => v.name === RETIRED);
    expect(entry).toBeDefined();
    expect([...entry!.services].sort()).toEqual([...BACKENDS].sort());
  });

  for (const svc of BACKENDS as readonly ServiceName[]) {
    test(`${svc}/src never mentions the retired token`, () => {
      const src = join(REPO_ROOT, svc, "src");
      expect(existsSync(src)).toBe(true); // a moved service must not make this test vacuous
      const files = [...walk(src)];
      expect(files.length).toBeGreaterThan(0);
      const hits = files
        .filter((f) => readFileSync(f, "utf8").includes(RETIRED))
        .map((f) => relative(REPO_ROOT, f));
      expect(hits).toEqual([]);
    });
  }
});

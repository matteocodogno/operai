/**
 * The host path's wait for a team read sits strictly inside the deadline of every caller of a host resolve (specs/20261126-teams,
 * plan D16, AC-4.6, AC-5.4; ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-
 * inside-the-deadline-of-the-consumer-...). Modelled on `accounting-api/src/budgets.cross-package.test.ts`.
 *
 * Four packages, one inequality: `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS` must stay under the 2 s that activities-api
 * (`RESOLVE_TIMEOUT_MS`), meetings-api (`RESOLVE_TIMEOUT_MS`) and hours-api (`OWNER_TIMEOUT_MS`) give a host resolve, or a slow
 * auth costs the whole batch instead of one item's `assignees`.
 *
 * HOW THE CONSTANTS ARE READ. The three consumer files cannot be IMPORTED from here: each evaluates its own `env` (which ends the
 * process when its variables are not set) and resolves its own `node_modules`, which a projects-api install does not have. So each
 * is read as text and the one `export const <NAME> = …;` declaration is evaluated (a number, or a product of numbers). A file
 * that is missing, a declaration that is absent, repeated, not exported or not a plain number is a FAILURE, never a skip: the
 * inequality is the whole point of this file.
 *
 * THE STATIC CHECK. The two host routes must read teams only through `teamReader.cached(`: a route moved to `fresh(` or
 * `options(` (the page path, 5 s) would silently be back inside its callers' 2 s. A planted source proves the check can fail.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { TEAMS_HOST_MARGIN_MS, TEAMS_HOST_WAIT_MS, TEAMS_TIMEOUT_MS } from "./teams";

/** The value of the one `export const <name> = <n | n * n>;` of `source`; throws when it is not exactly that. */
function deadlineOf(source: string, name: string): number {
  const declaration = new RegExp(`^export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([^;\\n]*);`, "gm");
  const found = [...source.matchAll(declaration)];
  if (found.length !== 1) throw new Error(`expected exactly one \`export const ${name} = …;\`, found ${found.length}`);
  const expression = found[0]![1]!.trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expression)) throw new Error(`${name} is not a plain number or product of numbers: ${expression}`);
  return expression.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
}

/** Repo-relative: this file is `projects-api/src/lib/…`. */
const fileUrl = (path: string): URL => new URL(`../../../${path}`, import.meta.url);

function readSource(path: string): string {
  const url = fileUrl(path);
  if (!existsSync(url)) throw new Error(`${path} is not at ${url.pathname}: this test does not skip, the inequality it checks has to be checkable`);
  return readFileSync(url, "utf8");
}

const CONSUMERS = [
  { service: "activities-api", path: "activities-api/src/hosts/client.ts", name: "RESOLVE_TIMEOUT_MS" },
  { service: "meetings-api", path: "meetings-api/src/hosts/client.ts", name: "RESOLVE_TIMEOUT_MS" },
  { service: "hours-api", path: "hours-api/src/clients/owner.ts", name: "OWNER_TIMEOUT_MS" },
] as const;

describe("the reader of a consumer constant", () => {
  it("evaluates a number, a number with separators and a product, and refuses anything else", () => {
    expect(deadlineOf("export const X_MS = 2_000;", "X_MS")).toBe(2_000);
    expect(deadlineOf("export const X_MS: number = 2 * 1_000;", "X_MS")).toBe(2_000);
    expect(deadlineOf("// export const X_MS = 1;\nexport const X_MS = 3_000;", "X_MS")).toBe(3_000);
    for (const bad of [
      "",
      "const X_MS = 2_000;", // not exported
      "export const X_MS = env.DEADLINE;", // not a literal
      "export const X_MS = 2_000 + 1;",
      "export const X_MS = 2_000;\nexport const X_MS = 5_000;", // repeated
      "export const OTHER_MS = 2_000;", // absent
    ]) {
      expect(() => deadlineOf(bad, "X_MS")).toThrow();
    }
  });
});

describe("the host wait sits strictly inside every caller's deadline (D16)", () => {
  it("pins the figures: wait 800 ms, margin 1 000 ms, a flight's own limit 5 000 ms, the wait shorter than the flight", () => {
    expect(TEAMS_HOST_WAIT_MS).toBe(800);
    expect(TEAMS_HOST_MARGIN_MS).toBe(1_000);
    expect(TEAMS_TIMEOUT_MS).toBe(5_000);
    expect(TEAMS_HOST_WAIT_MS).toBeLessThan(TEAMS_TIMEOUT_MS);
  });

  for (const { service, path, name } of CONSUMERS) {
    it(`${service} ${name}: 2 000 ms, and wait + margin is under it`, () => {
      const deadline = deadlineOf(readSource(path), name);
      expect(deadline).toBe(2_000);
      expect(TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS).toBeLessThan(deadline);
    });
  }
});

/** What is wrong with a host route's use of the team reader, as a list of problems (empty = fine). */
function hostRouteProblems(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes("teamReader.cached(")) problems.push("does not read teams through teamReader.cached(");
  if (/\.fresh\s*\(/.test(source)) problems.push("calls .fresh(");
  if (/\.options\s*\(/.test(source)) problems.push("calls .options(");
  return problems;
}

describe("a host route stays on the cached read (D16)", () => {
  it("the activity-host and meeting-host routes call only teamReader.cached(", () => {
    for (const path of ["projects-api/src/activity-host/activity-host.routes.ts", "projects-api/src/meeting-host/meeting-host.routes.ts"]) {
      expect({ path, problems: hostRouteProblems(readSource(path)) }).toEqual({ path, problems: [] });
    }
  });

  it("the check can fail: a planted fresh(), a planted options() and a missing cached() are each found", () => {
    expect(hostRouteProblems("const r = await teamReader.cached(ids);")).toEqual([]);
    expect(hostRouteProblems("const r = await teamReader.cached(ids); await teamReader.fresh(ids, { fallback: true });")).toEqual(["calls .fresh("]);
    expect(hostRouteProblems("await teamReader.cached(ids); await teamReader.options('x');")).toEqual(["calls .options("]);
    expect(hostRouteProblems("const r = await teamReader.fresh(ids, { fallback: true });")).toEqual([
      "does not read teams through teamReader.cached(",
      "calls .fresh(",
    ]);
    expect(hostRouteProblems("")).toEqual(["does not read teams through teamReader.cached("]);
  });
});

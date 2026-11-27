/**
 * The host path's wait for a permission check sits strictly inside the deadline of every caller of a host resolve
 * (specs/20261126-teams R13 a; ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-
 * the-deadline-of-the-consumer-...). Modelled on `projects-api/src/lib/teams.budgets.cross-package.test.ts`.
 *
 * crm-api answers `POST /activity-host/v1/resolve` and `POST /meeting-host/v1/resolve` for activities-api
 * (`RESOLVE_TIMEOUT_MS`), meetings-api (`RESOLVE_TIMEOUT_MS`) and hours-api (`OWNER_TIMEOUT_MS`), each 2 s. Cold, its
 * permission check (`RESOLVE_TIMEOUT_MS` = 5 s, which keeps running and fills the cache) used to run inside those 2 s. Now the host
 * routes wait at most `HOST_AUTHZ_WAIT_MS` for it, and the rest of the route (`HOST_PATH_REST_MS`) fits beside it.
 *
 * HOW THE CONSTANTS ARE READ. The consumer files cannot be IMPORTED from here (each evaluates its own `env` and resolves its own
 * `node_modules`), so each is read as text and the one `export const <NAME> = …;` declaration is evaluated (a number, or a
 * product of numbers). A file that is missing, a declaration that is absent, repeated, not exported or not a plain number is a
 * FAILURE, never a skip: the inequality is the whole point of this file.
 *
 * THE STATIC CHECK. Both host route files must be guarded by `[jwtMiddleware, hostAuthzMiddleware]`: a route moved back to
 * `authzMiddleware` (no wait) is silently back to 5 s inside 2 s. A planted source proves the check can fail.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { HOST_AUTHZ_WAIT_MS, HOST_PATH_REST_MS } from "./hostBudget";

// shared-copy:begin deadlineReader
/** The value of the one `export const <name> = <n | n * n>;` of `source`; throws when it is not exactly that. */
function deadlineOf(source: string, name: string): number {
  const declaration = new RegExp(`^export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([^;\\n]*);`, "gm");
  const found = [...source.matchAll(declaration)];
  if (found.length !== 1) throw new Error(`expected exactly one \`export const ${name} = …;\`, found ${found.length}`);
  const expression = found[0]![1]!.trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expression)) throw new Error(`${name} is not a plain number or product of numbers: ${expression}`);
  return expression.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
}
// shared-copy:end deadlineReader

/** Repo-relative: this file is `crm-api/src/lib/…`. */
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

describe("the host path's permission wait sits strictly inside every caller's deadline (R13 a)", () => {
  const resolveLimit = () => deadlineOf(readSource("crm-api/src/authz/resolveClient.ts"), "RESOLVE_TIMEOUT_MS");

  it("pins the figures: wait 500 ms, rest 500 ms, the resolve's own limit 5 000 ms, the wait shorter than the resolve", () => {
    expect(HOST_AUTHZ_WAIT_MS).toBe(500);
    expect(HOST_PATH_REST_MS).toBe(500);
    expect(resolveLimit()).toBe(5_000);
    expect(HOST_AUTHZ_WAIT_MS).toBeLessThan(resolveLimit());
  });

  for (const { service, path, name } of CONSUMERS) {
    it(`${service} ${name}: 2 000 ms, and wait + rest is under it`, () => {
      const deadline = deadlineOf(readSource(path), name);
      expect(deadline).toBe(2_000);
      expect(HOST_AUTHZ_WAIT_MS + HOST_PATH_REST_MS).toBeLessThan(deadline);
    });
  }
});

/** What is wrong with a host route's guard, as a list of problems (empty = fine). */
function hostGuardProblems(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes("const hostCaller: MiddlewareHandler[] = [jwtMiddleware, hostAuthzMiddleware];")) {
    problems.push("hostCaller is not [jwtMiddleware, hostAuthzMiddleware]");
  }
  if (source.includes("[jwtMiddleware, authzMiddleware]")) problems.push("uses [jwtMiddleware, authzMiddleware], the page variant with no wait");
  return problems;
}

describe("a host route is on the bounded permission wait (R13 a)", () => {
  it("the activity-host and meeting-host routes use hostAuthzMiddleware and never authzMiddleware", () => {
    for (const path of ["crm-api/src/activity-host/resolve.routes.ts", "crm-api/src/meeting-host/resolve.routes.ts"]) {
      expect({ path, problems: hostGuardProblems(readSource(path)) }).toEqual({ path, problems: [] });
    }
  });

  it("the check can fail: a route still on authzMiddleware, and one with neither, are each found", () => {
    expect(hostGuardProblems("const hostCaller: MiddlewareHandler[] = [jwtMiddleware, hostAuthzMiddleware];")).toEqual([]);
    expect(hostGuardProblems("const hostCaller: MiddlewareHandler[] = [jwtMiddleware, authzMiddleware];")).toEqual([
      "hostCaller is not [jwtMiddleware, hostAuthzMiddleware]",
      "uses [jwtMiddleware, authzMiddleware], the page variant with no wait",
    ]);
    expect(
      hostGuardProblems(
        "const hostCaller: MiddlewareHandler[] = [jwtMiddleware, hostAuthzMiddleware]; const other = [jwtMiddleware, authzMiddleware];",
      ),
    ).toEqual(["uses [jwtMiddleware, authzMiddleware], the page variant with no wait"]);
    expect(hostGuardProblems("")).toEqual(["hostCaller is not [jwtMiddleware, hostAuthzMiddleware]"]);
  });
});

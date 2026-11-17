/**
 * AC-2.7 tripwire (T8, specs/20261117-legal-entities): the registry is append-only at every layer, and this file is
 * the part that watches the application code. (The database part - triggers that refuse UPDATE, DELETE and TRUNCATE -
 * is `immutability.contract.test.ts`.)
 *
 *   (a) ROUTER TABLE - the real app's route table has no PUT, PATCH or DELETE (and no catch-all) under
 *       `/legal-entities` or `/system/legal-entities`, and its only POSTs are the save and the restore. A request with
 *       each of those verbs answers 404 for a signed-in administrator, so the 404 proves the route is absent and not
 *       masked by a 401 or a 403.
 *   (b) STATIC SCAN - `auth/src/**` (tests and the generated client excluded) holds no mutating Prisma call on
 *       `legalEntityVersion` (update, updateMany, upsert, delete, deleteMany) and no raw UPDATE / DELETE / TRUNCATE
 *       against `legal_entity_version`, nor a switch-off of its triggers. As the audit tripwire, it is a TRIPWIRE, not a
 *       proof (a dynamic `db[model].delete(...)` would evade it): it catches the failure worth defending against, a
 *       route or service that gains a mutating call. `create` is the append and is allowed.
 */

import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

let currentSession: { user: { id: string; email: string; name: string }; session: { id: string } } | null = {
  user: { id: "u-tripwire-admin", email: "tripwire@legalentities.test", name: "Tripwire Admin" },
  session: { id: "sess-tripwire" },
};

mock.module("../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession), handler: mock(async () => new Response("{}")) } },
}));

const { app } = await import("../index");

const REGISTRY_PATHS = /^\/(system\/)?legal-entities(\/|$)/;

describe("AC-2.7 (a) - the router table", () => {
  const routes = app.routes.filter((r) => REGISTRY_PATHS.test(r.path));

  test("there are routes under /legal-entities to speak of (the filter is not vacuous)", () => {
    const table = routes.map((r) => `${r.method} ${r.path}`);
    expect(table).toContain("GET /legal-entities");
    expect(table).toContain("GET /legal-entities/manageable");
    expect(table).toContain("GET /legal-entities/:entity/versions");
    expect(table).toContain("POST /legal-entities/:entity/versions");
    expect(table).toContain("POST /legal-entities/:entity/versions/:n/restore");
    expect(table).toContain("GET /system/legal-entities");
  });

  test("no PUT, PATCH, DELETE or catch-all (ALL) route is registered under /legal-entities or /system/legal-entities", () => {
    const verbs = new Set(routes.map((r) => r.method));
    expect([...verbs].sort()).toEqual(["GET", "POST"]);
    for (const r of routes) expect(["PUT", "PATCH", "DELETE", "ALL"]).not.toContain(r.method);
  });

  test("a wildcard registered for every method could still reach the registry: none matches its paths", () => {
    // `app.use("*", ...)` (cors, the logger) is ALL on "*", which is not under the registry's paths and runs no handler
    // of its own; a middleware on `/legal-entities/*` would be: it is what this refuses.
    const wildcards = app.routes.filter((r) => r.method === "ALL" && /legal-entities/.test(r.path));
    expect(wildcards).toEqual([]);
  });

  test("the only POSTs are the save and the restore", () => {
    // (Hono lists every handler of a route, middleware included: compare the distinct paths.)
    expect([...new Set(routes.filter((r) => r.method === "POST").map((r) => r.path))].sort()).toEqual([
      "/legal-entities/:entity/versions",
      "/legal-entities/:entity/versions/:n/restore",
    ]);
  });

  test("PUT, PATCH and DELETE on every path of the registry answer 404 to a signed-in administrator", async () => {
    const paths = [
      "/legal-entities",
      "/legal-entities/manageable",
      "/legal-entities/welld_ch",
      "/legal-entities/welld_ch/versions",
      "/legal-entities/welld_ch/versions/1",
      "/legal-entities/welld_ch/versions/1/restore",
      "/system/legal-entities",
      "/system/legal-entities/welld_ch",
    ];
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const path of paths) {
        const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
    }
  });
});

// ─── (b) the static scan ──────────────────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = resolve(import.meta.dir, "..");

/** `auth/src/**\/*.ts`, minus tests, the test preload and the generated client (which defines every delegate method). */
function productionSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (full === join(root, "lib", "generated")) continue;
        walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-setup.ts") {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

const MODEL = String.raw`legalEntityVersion`;
const MUTATING = String.raw`(?:update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)`;
/** Patterns run over a file's WHOLE content (a call split over lines must not evade a line-by-line scan). */
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "a mutating Prisma call on legalEntityVersion", pattern: new RegExp(String.raw`\b${MODEL}\s*\.\s*${MUTATING}\b`) },
  { name: "a mutating Prisma call through a bracketed model name", pattern: new RegExp(String.raw`\[\s*["'\x60]${MODEL}["'\x60]\s*\]\s*\.\s*${MUTATING}\b`) },
  { name: "a destructured mutating delegate", pattern: new RegExp(String.raw`\{[^}]*\b${MUTATING}\b[^}]*\}\s*=\s*[\w.]*\b${MODEL}\b`) },
  {
    name: "a raw UPDATE / DELETE / TRUNCATE against legal_entity_version",
    pattern: /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?)\s+(?:"?public"?\s*\.\s*)?"?legal_entity_version"?/i,
  },
  { name: "switching the table's triggers off", pattern: /\b(?:DISABLE|ALTER)\s+(?:TRIGGER|TABLE\s+"?legal_entity_version"?\s+DISABLE)/i },
  { name: "session_replication_role (bypasses every trigger)", pattern: /session_replication_role/i },
];

describe("AC-2.7 (b) - the static scan of auth/src", () => {
  test("the scan root is auth/src and it reads the registry's own modules (the scan is not vacuous)", () => {
    expect(relative(resolve(import.meta.dir, "../.."), SRC_ROOT).split(sep).join("/")).toBe("src");
    const files = productionSources(SRC_ROOT).map((f) => relative(SRC_ROOT, f).split(sep).join("/"));
    for (const expected of ["legalEntities/repo.ts", "legalEntities/write.routes.ts", "legalEntities/import.ts", "authz/audit.ts", "index.ts"]) {
      expect(files).toContain(expected);
    }
    for (const file of files) {
      expect(file.endsWith(".test.ts")).toBe(false);
      expect(file.startsWith("lib/generated/")).toBe(false);
    }
    // The module that appends really does mention the model: what the scan looks for exists where it looks.
    expect(readFileSync(join(SRC_ROOT, "legalEntities/repo.ts"), "utf8")).toContain("legalEntityVersion.create");
  });

  test("the patterns catch what they are for (positive controls) and let the append through", () => {
    const hits = (source: string) => FORBIDDEN.filter((f) => f.pattern.test(source)).map((f) => f.name);
    const bad = [
      "await tx.legalEntityVersion.update({ where, data })",
      "db.legalEntityVersion\n  .deleteMany()",
      "await tx . legalEntityVersion . upsert(x)",
      'tx["legalEntityVersion"].delete({})',
      "const { update } = tx.legalEntityVersion;",
      'await tx.$executeRaw`UPDATE legal_entity_version SET "iban" = ${x}`',
      'await tx.$executeRawUnsafe(`DELETE FROM "legal_entity_version"`)',
      "TRUNCATE TABLE legal_entity_version",
      'DELETE FROM public."legal_entity_version"',
      "ALTER TABLE legal_entity_version DISABLE TRIGGER ALL",
      "SET LOCAL session_replication_role = replica",
    ];
    for (const source of bad) expect([source, hits(source).length > 0]).toEqual([source, true]);
    const good = [
      "await tx.legalEntityVersion.create({ data })",
      "await tx.legalEntityVersion.findMany()",
      "await tx.legalEntityVersion.findUnique({ where })",
      "await tx.legalEntityVersion.count()",
      'SELECT * FROM "legal_entity_version" WHERE "entity" = ${e}',
      'INSERT INTO legal_entity_version ("entity") VALUES (1)',
    ];
    for (const source of good) expect([source, hits(source)]).toEqual([source, []]);
  });

  test("no production source mutates a stored version, or bypasses the table's triggers", () => {
    const offences: string[] = [];
    for (const file of productionSources(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(content)) offences.push(`${relative(SRC_ROOT, file)}: ${name}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

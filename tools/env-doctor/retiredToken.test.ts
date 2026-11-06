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
  test("the manifest forbids it on every backend", () => {
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

// specs/021 plan § Amendment 2026-11-05 (G-7, T105): the Azure and AWS provider variables meetings-api
// used to read are retired by the move to Google Cloud. The contract flags a deployed copy by name
// (check.test.ts); this pins the manifest, so the list cannot shrink by accident.
describe("the seven variables retired by the Google Cloud provider change are forbidden on meetings-api", () => {
  const SEVEN = [
    "AZURE_SPEECH_REGION", "AZURE_SPEECH_KEY", "AZURE_SPEECH_ENDPOINT",
    "BEDROCK_REGION", "BEDROCK_MODEL_ID", "MEETINGS_AWS_ACCESS_KEY_ID", "MEETINGS_AWS_SECRET_ACCESS_KEY",
  ];
  for (const name of SEVEN) {
    test(`${name} is forbidden on meetings-api only, with a reason naming the provider change`, () => {
      const entry = FORBIDDEN_VARS.find((v) => v.name === name);
      expect(entry).toBeDefined();
      expect(entry!.services).toEqual(["meetings-api"]);
      expect(entry!.why).toContain("retired by the provider change to Google Cloud");
    });
  }

  test("the production template holds none of them and holds the Google variables instead", () => {
    const tpl = readFileSync(join(import.meta.dir, "templates", "production", "meetings-api.env"), "utf8");
    const assigned = new Set(tpl.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => l.split("=")[0]));
    for (const name of SEVEN) expect(assigned.has(name)).toBe(false);
    for (const name of [
      "MEETINGS_SPEECH_LOCATION", "MEETINGS_VERTEX_LOCATION", "MEETINGS_VERTEX_MODEL_ID",
      "MEETINGS_GCP_PROJECT_ID", "MEETINGS_GCP_SERVICE_ACCOUNT_KEY", "MEETINGS_GCS_TRANSIENT_BUCKET",
    ]) expect(assigned.has(name)).toBe(true);
  });

  test("the template's service-account key is a 1Password reference, never a literal", () => {
    const tpl = readFileSync(join(import.meta.dir, "templates", "production", "meetings-api.env"), "utf8");
    expect(tpl).toMatch(/^MEETINGS_GCP_SERVICE_ACCOUNT_KEY=\$\{OP:[^}]+\}$/m);
  });
});

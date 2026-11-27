import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFile, checkReplicas, RAILWAY_FILE, replicasOf, SINGLE_REPLICA } from "./check-single-replica";

const svc = (name: string, replicas: string) =>
  `  const x = service("${name}", {\n    start: "bun run src/index.ts",\n    ${replicas}\n    deploy: { restartPolicyMaxRetries: 3 },\n  });\n`;
const file = (...blocks: string[]) =>
  `export default defineRailway(() => {\n${blocks.join("")}  return project("operai", { resources: [] });\n});\n`;
const reg = [{ service: "a-api", why: "because A" }];

describe("replicasOf", () => {
  test("one region with 1", () => {
    expect(replicasOf(file(svc("a-api", 'replicas: { "r1": 1 },')), "a-api")).toEqual({ ok: true, total: 1 });
  });
  test("sums regions", () => {
    expect(replicasOf(file(svc("a-api", 'replicas: { "r1": 1, "r2": 1 },')), "a-api")).toEqual({ ok: true, total: 2 });
  });
  test("reads only its own block", () => {
    const f = file(svc("a-api", 'replicas: { "r1": 1 },'), svc("b-api", 'replicas: { "r1": 3 },'));
    expect(replicasOf(f, "a-api")).toEqual({ ok: true, total: 1 });
    expect(replicasOf(f, "b-api")).toEqual({ ok: true, total: 3 });
  });
  test("a commented-out figure does not count", () => {
    const f = file(svc("a-api", '// replicas: { "r1": 5 },\n    replicas: { "r1": 1 }, // was 2'));
    expect(replicasOf(f, "a-api")).toEqual({ ok: true, total: 1 });
  });
  test.each([
    ["absent", ""],
    ["non-literal", "replicas: REPLICAS,"],
    ["twice", 'replicas: { "r1": 1 },\n    replicas: { "r1": 1 },'],
    ["empty", "replicas: {},"],
    ["non-integer", 'replicas: { "r1": one },'],
    ["unquoted region", "replicas: { r1: 1 },"],
  ])("unreadable (%s) is a failure, not a pass", (_n, r) => {
    expect(replicasOf(file(svc("a-api", r)), "a-api").ok).toBe(false);
  });
  test("a missing or duplicated service is a failure", () => {
    expect(replicasOf(file(svc("b-api", 'replicas: { "r": 1 },')), "a-api").ok).toBe(false);
    const f = file(svc("a-api", 'replicas: { "r": 1 },'), svc("a-api", 'replicas: { "r": 1 },'));
    expect(replicasOf(f, "a-api").ok).toBe(false);
  });
  test("a service name that is a prefix of another is not confused", () => {
    expect(replicasOf(file(svc("a-api-2", 'replicas: { "r": 1 },')), "a-api").ok).toBe(false);
  });
});

describe("checkReplicas", () => {
  test("exactly 1 passes", () => {
    expect(checkReplicas(reg, file(svc("a-api", 'replicas: { "r": 1 },')))).toEqual([]);
  });
  test("2 fails, names the service, the count, why and what to change first", () => {
    const [e, ...rest] = checkReplicas(reg, file(svc("a-api", 'replicas: { "r": 2 },')));
    expect(rest).toEqual([]);
    expect(e).toContain("a-api: .railway/railway.ts must give it exactly 1 replica (found 2).");
    expect(e).toContain("Why: because A");
    expect(e).toContain("make the change the reason names first");
    expect(e).toContain("SINGLE_REPLICA");
  });
  test("0 fails too", () => {
    expect(checkReplicas(reg, file(svc("a-api", 'replicas: { "r": 0 },')))).toHaveLength(1);
  });
  test("two regions of 1 each fail (sum 2)", () => {
    expect(checkReplicas(reg, file(svc("a-api", 'replicas: { "r1": 1, "r2": 1 },')))[0]).toContain("found 2");
  });
});

describe("checkFile and the real file", () => {
  test("a missing file fails", () => {
    expect(checkFile(reg, mkdtempSync(join(tmpdir(), "single-replica-")))[0]).toContain("not found");
  });
  test("every registered service is in the repo's railway.ts with exactly 1 replica", () => {
    expect(checkFile(SINGLE_REPLICA, join(import.meta.dir, ".."))).toEqual([]);
  });
  test("the registry names projects-api first, each with a reason", () => {
    expect(SINGLE_REPLICA[0]!.service).toBe("projects-api");
    for (const s of SINGLE_REPLICA) expect(s.why.length).toBeGreaterThan(20);
  });
  test("the real file with projects-api at 2 replicas fails naming projects-api only", () => {
    const real = readFileSync(join(import.meta.dir, "..", RAILWAY_FILE), "utf8");
    const mutated = real.replace(/(service\("projects-api",[\s\S]*?replicas: \{ "europe-west4-drams3a": )1/, "$12");
    expect(mutated).not.toBe(real);
    const root = mkdtempSync(join(tmpdir(), "single-replica-"));
    mkdirSync(join(root, ".railway"));
    writeFileSync(join(root, RAILWAY_FILE), mutated);
    const errors = checkFile(SINGLE_REPLICA, root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("projects-api");
    expect(errors[0]).toContain("found 2");
  });
});

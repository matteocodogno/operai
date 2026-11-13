import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkGroups, extractRegion, SHARED_COPIES, type SharedGroup } from "./check-shared-copies";

const wrap = (body: string, head = "// header", tail = "// tail", name = "g") =>
  `${head}\n// shared-copy:begin ${name}\n${body}\n// shared-copy:end ${name}\n${tail}\n`;

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "shared-copies-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const group = (...files: string[]): SharedGroup => ({ name: "g", files, why: "test" });
const wholeFile = (...files: string[]): SharedGroup => ({ name: "g", files, why: "test", mode: "whole" });

describe("extractRegion", () => {
  test("returns the lines strictly between the markers", () => {
    expect(extractRegion(wrap("a\nb"), "g")).toEqual({ ok: true, lines: ["a", "b"], startLine: 3 });
  });

  test("ignores what is outside the markers", () => {
    const a = extractRegion(wrap("x", "// one"), "g");
    const b = extractRegion(wrap("x", "// completely different header", "export const y = 1;"), "g");
    expect(a.ok && b.ok && a.lines).toEqual(b.ok ? b.lines : []);
  });

  test("normalises CRLF", () => {
    expect(extractRegion(wrap("a\nb").replace(/\n/g, "\r\n"), "g")).toMatchObject({ ok: true, lines: ["a", "b"] });
  });

  test.each([
    ["no markers", "const a = 1;\n"],
    ["begin only", "// shared-copy:begin g\nx\n"],
    ["end only", "x\n// shared-copy:end g\n"],
    ["end before begin", "// shared-copy:end g\nx\n// shared-copy:begin g\n"],
    ["two regions", wrap("x") + wrap("y")],
  ])("a malformed file (%s) is an error, not an empty match", (_n, text) => {
    expect(extractRegion(text, "g").ok).toBe(false);
  });

  test("a marker for another group is not this group's", () => {
    expect(extractRegion(wrap("x", "", "", "other"), "g").ok).toBe(false);
  });
});

describe("checkGroups", () => {
  test("identical regions pass even when the surrounding text differs", () => {
    const root = tree({ "a.ts": wrap("same", "// A"), "b.ts": wrap("same", "// B", "export const only = 1;") });
    expect(checkGroups([group("a.ts", "b.ts")], root)).toEqual([]);
  });

  test("a differing region fails and names both files and the first differing line", () => {
    const root = tree({ "a.ts": wrap("l1\nl2\nl3"), "b.ts": wrap("l1\nCHANGED\nl3"), "c.ts": wrap("l1\nl2\nl3") });
    const errors = checkGroups([group("a.ts", "b.ts", "c.ts")], root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("a.ts");
    expect(errors[0]).toContain("b.ts");
    expect(errors[0]).not.toContain("c.ts"); // c matches the reference
    expect(errors[0]).toContain("line 4"); // 1-based line in b.ts: begin marker on line 2, so l2 is line 4
  });

  test("a length difference (extra trailing line) fails", () => {
    const root = tree({ "a.ts": wrap("l1"), "b.ts": wrap("l1\nl2") });
    expect(checkGroups([group("a.ts", "b.ts")], root)).toHaveLength(1);
  });

  test("whitespace-only drift fails (the copies are meant to be byte-identical)", () => {
    const root = tree({ "a.ts": wrap("x = 1;"), "b.ts": wrap("x = 1; ") });
    expect(checkGroups([group("a.ts", "b.ts")], root)).toHaveLength(1);
  });

  test("a missing file and a file without markers are reported by name", () => {
    const root = tree({ "a.ts": wrap("x"), "nomarkers.ts": "const x = 1;\n" });
    const errors = checkGroups([group("a.ts", "nomarkers.ts", "gone.ts")], root);
    expect(errors.join("\n")).toContain("nomarkers.ts");
    expect(errors.join("\n")).toContain("gone.ts");
  });

  test("an empty region everywhere is not a pass (markers wrapping nothing guard nothing)", () => {
    const root = tree({ "a.ts": wrap(""), "b.ts": wrap("") });
    expect(checkGroups([group("a.ts", "b.ts")], root).length).toBeGreaterThan(0);
  });

  test("a group of fewer than two files is a configuration error", () => {
    expect(checkGroups([group("a.ts")], tree({ "a.ts": wrap("x") }))).toHaveLength(1);
  });
});

describe("checkGroups, whole-file mode (JSON vectors cannot carry markers)", () => {
  const json = '{\n  "a": [1, 2]\n}\n';

  test("byte-identical files pass", () => {
    expect(checkGroups([wholeFile("a.json", "b.json")], tree({ "a.json": json, "b.json": json }))).toEqual([]);
  });

  test("one changed byte fails, naming both files and the offset", () => {
    const errors = checkGroups([wholeFile("a.json", "b.json")], tree({ "a.json": json, "b.json": json.replace("2", "3") }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("a.json");
    expect(errors[0]).toContain("b.json");
    expect(errors[0]).toContain("byte offset 13"); // 0-based: the "2" of `[1, 2]`
  });

  test("a missing trailing newline or a CRLF is a difference too (identical BYTES, unlike a marked region)", () => {
    const root = tree({ "a.json": json, "b.json": json.trimEnd(), "c.json": json.replace(/\n/g, "\r\n") });
    expect(checkGroups([wholeFile("a.json", "b.json")], root)).toHaveLength(1);
    expect(checkGroups([wholeFile("a.json", "c.json")], root)).toHaveLength(1);
  });

  test("a missing file is reported, an empty file guards nothing", () => {
    expect(checkGroups([wholeFile("a.json", "gone.json")], tree({ "a.json": json })).join("\n")).toContain("gone.json");
    expect(checkGroups([wholeFile("a.json", "b.json")], tree({ "a.json": "", "b.json": "" })).length).toBeGreaterThan(0);
  });
});

describe("the committed registry", () => {
  const repoRoot = join(import.meta.dir, "..");

  test("lists every serviceToken copy, meetings-api, projects-api and hours-api included, and the registry is in sync right now", () => {
    const g = SHARED_COPIES.find((x) => x.name === "serviceToken");
    expect(g?.files.sort()).toEqual([
      "activities-api/src/lib/serviceToken.ts",
      "crm-api/src/lib/serviceToken.ts",
      "estimai-api/src/lib/serviceToken.ts",
      "hours-api/src/lib/serviceToken.ts",
      "inventory-api/src/lib/serviceToken.ts",
      "meetings-api/src/lib/serviceToken.ts",
      "notify-api/src/lib/serviceToken.ts",
      "projects-api/src/lib/serviceToken.ts",
      "refund-api/src/lib/serviceToken.ts",
    ]);
    expect(checkGroups(SHARED_COPIES, repoRoot)).toEqual([]);
  });

  test("registers activities-api's problem and logger copies (specs/20261110-activities T2)", () => {
    for (const name of ["problem", "logger"]) {
      const g = SHARED_COPIES.find((x) => x.name === name);
      expect(g?.files).toContain(`activities-api/src/lib/${name}.ts`);
    }
  });

  test("registers hours-api's problem and logger copies (specs/20261112-time-tracking T10)", () => {
    for (const name of ["problem", "logger"]) {
      const g = SHARED_COPIES.find((x) => x.name === name);
      expect(g?.files).toContain(`hours-api/src/lib/${name}.ts`);
    }
  });

  test("registers the systemAuth guard of crm-api, estimai-api, activities-api and accounting-api (specs/20261110-activities T10, specs/20261119-accounting T4)", () => {
    const g = SHARED_COPIES.find((x) => x.name === "systemAuth");
    expect(g?.files.sort()).toEqual([
      "accounting-api/src/auth/systemAuth.middleware.ts",
      "activities-api/src/auth/systemAuth.middleware.ts",
      "crm-api/src/auth/systemAuth.middleware.ts",
      "estimai-api/src/auth/systemAuth.middleware.ts",
    ]);
  });

  test("registers accounting-api's problem and logger copies (specs/20261119-accounting T4)", () => {
    for (const name of ["problem", "logger"]) {
      const g = SHARED_COPIES.find((x) => x.name === name);
      expect(g?.files).toContain(`accounting-api/src/lib/${name}.ts`);
    }
  });

  test("registers the accountingWire schema of accounting-api and refund-api (specs/20261119-accounting T7)", () => {
    const g = SHARED_COPIES.find((x) => x.name === "accountingWire");
    expect(g?.files).toEqual(["accounting-api/src/system/accountingWire.ts", "refund-api/src/accounting/accountingWire.ts"]);
    expect(g?.mode ?? "region").toBe("region");
    expect(checkGroups(g ? [g] : [], repoRoot)).toEqual([]);
  });

  test("registers meetings-api's other copies (specs/20261104-meetings T43)", () => {
    for (const name of ["s3ResidencyAllowlist", "s3ResidencyAddressing", "problem", "logger"]) {
      const g = SHARED_COPIES.find((x) => x.name === name);
      expect(g?.files).toContain(`meetings-api/src/lib/${name.startsWith("s3") ? "s3Residency" : name}.ts`);
    }
  });

  // specs/20261115-crm-offer-wizard T13: the offer engine is copied into crm-ui byte for byte (AC-3.2).
  const ENGINE_FILES = ["markup", "printable", "format", "words", "costs", "compute", "syntax", "answers", "outline", "resolve", "numbering", "edit"];
  const apiEngine = "crm-api/src/offers/engine";
  const uiEngine = "crm-ui/src/lib/offerEngine";

  test("registers one offerEngine.<file> group per engine file, crm-api and crm-ui", () => {
    for (const file of ENGINE_FILES) {
      const g = SHARED_COPIES.find((x) => x.name === `offerEngine.${file}`);
      expect(g?.files, file).toEqual([`${apiEngine}/${file}.ts`, `${uiEngine}/${file}.ts`]);
      expect(g?.mode ?? "region", file).toBe("region");
    }
  });

  test("no engine file and no vector escapes the check (a new one must be registered)", () => {
    const engine = readdirSync(join(repoRoot, apiEngine)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(engine.map((f) => f.replace(/\.ts$/, "")).sort()).toEqual([...ENGINE_FILES].sort());
    const vectors = readdirSync(join(repoRoot, apiEngine, "vectors")).filter((f) => f.endsWith(".json"));
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      const g = SHARED_COPIES.find((x) => x.files.includes(`${apiEngine}/vectors/${v}`));
      expect(g?.mode, v).toBe("whole");
      expect(g?.files, v).toEqual([`${apiEngine}/vectors/${v}`, `${uiEngine}/vectors/${v}`]);
    }
    expect(readdirSync(join(repoRoot, uiEngine, "vectors")).sort()).toEqual([...vectors].sort());
  });

  test("copies no test file into crm-ui's engine directory", () => {
    expect(readdirSync(join(repoRoot, uiEngine)).filter((f) => /\.test\.tsx?$/.test(f))).toEqual([]);
  });

  // specs/20261115-crm-offer-wizard T69 (DD-67): the paper constants are copied into crm-ui byte for byte (AC-11.10).
  test("registers the offerPaper group, crm-api and crm-ui, compared whole-file (byte-identical, no markers)", () => {
    const g = SHARED_COPIES.find((x) => x.name === "offerPaper");
    expect(g?.files).toEqual(["crm-api/src/offers/paper.ts", "crm-ui/src/lib/offerPaper/paper.ts"]);
    expect(g?.mode).toBe("whole");
  });
});

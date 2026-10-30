import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("the committed registry", () => {
  const repoRoot = join(import.meta.dir, "..");

  test("lists the three serviceToken copies and they are in sync right now", () => {
    const g = SHARED_COPIES.find((x) => x.name === "serviceToken");
    expect(g?.files.sort()).toEqual([
      "estimai-api/src/lib/serviceToken.ts",
      "inventory-api/src/lib/serviceToken.ts",
      "refund-api/src/lib/serviceToken.ts",
    ]);
    expect(checkGroups(SHARED_COPIES, repoRoot)).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import { PASSAGE_CHARS, splitPassages } from "./passages";

// AC-3.4 / AC-6.1: a text meeting's transcript is passages of ~1,000 characters
// split at paragraph boundaries, with no times and no speaker.

const para = (n: number, ch = "a") => (ch.repeat(9) + " ").repeat(Math.ceil(n / 10)).slice(0, n).trim();

describe("splitPassages", () => {
  it("nothing, or only whitespace, is no passage", () => {
    expect(splitPassages("")).toEqual([]);
    expect(splitPassages(" \n\n \t \r\n ")).toEqual([]);
  });

  it("a short text is one passage, trimmed", () => {
    expect(splitPassages("  Hello there.  ")).toEqual(["Hello there."]);
  });

  it("packs consecutive paragraphs up to the target and keeps the blank line between them", () => {
    expect(splitPassages("one\n\ntwo\n\n\n\nthree")).toEqual(["one\n\ntwo\n\nthree"]);
  });

  it("starts a new passage when the next paragraph would not fit", () => {
    const a = para(600);
    const b = para(600, "b");
    expect(splitPassages(`${a}\n\n${b}`)).toEqual([a, b]);
    const c = para(300, "c");
    expect(splitPassages(`${a}\n\n${c}\n\n${b}`)).toEqual([`${a}\n\n${c}`, b]);
  });

  it("treats CRLF and CR line endings as paragraph breaks too", () => {
    expect(splitPassages("x\r\n\r\ny")).toEqual(["x\n\ny"]);
    expect(splitPassages(`${para(700)}\r\n\r\n${para(700, "b")}`)).toHaveLength(2);
  });

  it("splits an over-long paragraph at whitespace, never beyond the target, losing no word", () => {
    const long = para(2500);
    const out = splitPassages(long);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const p of out) {
      expect(p.length).toBeLessThanOrEqual(PASSAGE_CHARS);
      expect(p).toBe(p.trim());
      expect(p.length).toBeGreaterThan(0);
    }
    expect(out.join(" ").split(/\s+/)).toEqual(long.split(/\s+/));
  });

  it("splits a paragraph with no whitespace at the target", () => {
    const out = splitPassages("x".repeat(2500));
    expect(out.map((p) => p.length)).toEqual([1000, 1000, 500]);
  });

  it("never cuts a surrogate pair in half", () => {
    const text = "x" + "😀".repeat(1200); // the 1000-unit cut would land between the halves of a pair
    const out = splitPassages(text);
    expect(out.join("")).toBe(text);
    for (const p of out) {
      expect(p.length).toBeLessThanOrEqual(PASSAGE_CHARS);
      expect(p.codePointAt(p.length - 1)).not.toBeLessThan(0xdc00); // last unit is not a lone high surrogate
      expect([...p].every((ch) => ch === "😀" || ch === "x")).toBe(true);
    }
  });

  it("200,000 characters become passages that together keep every non-space character", () => {
    const text = Array.from({ length: 400 }, (_, i) => para(499, String.fromCharCode(97 + (i % 26)))).join("\n\n");
    const out = splitPassages(text);
    expect(out.length).toBeGreaterThanOrEqual(200);
    expect(out.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});

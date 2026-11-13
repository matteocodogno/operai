/**
 * How minutes are collected into groups and how the groups are ordered (specs/029 T18; plan § Totals, the table). Pure:
 * no database, no other service. What the routes make of them is in ./totals.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Tally, byKeyDesc, byLabel, byMinutesThenLabel, type KeyedGroup } from "./groups";

const group = (key: string, label: string | null, minutes = 30): KeyedGroup => ({ kind: "keyed", key, label, minutes });

describe("Tally", () => {
  it("adds minutes under one key into one group, whoever adds them, and totals everything it was given", () => {
    const tally = new Tally();
    tally.addKeyed({ key: "d1", label: "Deal one" }, 60);
    tally.addKeyed({ key: "d1", label: "Deal one" }, 120);
    tally.addKeyed({ key: "d2", label: "Deal two" }, 30);
    tally.addBucket("none", 30);
    tally.addBucket("none", 60);
    tally.addBucket("hidden", 90);

    expect(tally.totalMinutes).toBe(60 + 120 + 30 + 30 + 60 + 90);
    expect(tally.groups(byMinutesThenLabel, ["hidden", "none"])).toEqual([
      { kind: "keyed", key: "d1", label: "Deal one", minutes: 180 },
      { kind: "keyed", key: "d2", label: "Deal two", minutes: 30 },
      { kind: "hidden", minutes: 90 },
      { kind: "none", minutes: 90 },
    ]);
  });

  it("lists a group that names nothing only when it holds minutes, in the order it is told, and never one it was not told of", () => {
    const tally = new Tally();
    tally.addBucket("none", 30);
    tally.addBucket("deal-unknown", 60);
    tally.addBucket("unavailable", 90);

    expect(tally.groups(byKeyDesc, ["hidden", "unavailable", "deal-unknown", "none"]).map((entry) => entry.kind)).toEqual(["unavailable", "deal-unknown", "none"]);
    // A grouping that has no `none` never lists one: the tail is the grouping's own.
    expect(tally.groups(byKeyDesc, ["unavailable"]).map((entry) => entry.kind)).toEqual(["unavailable"]);
  });

  it("is empty when nothing was added: no group, no total", () => {
    const tally = new Tally();

    expect(tally.totalMinutes).toBe(0);
    expect(tally.groups(byKeyDesc, ["hidden", "unavailable", "deal-unknown", "none"])).toEqual([]);
  });
});

describe("the order of keyed groups", () => {
  it("byLabel: the English collator with case and accents set aside, a missing label last, ties by key", () => {
    const sorted = [group("k5", null), group("k4", "Zoë"), group("k2", "alpha"), group("k1", "Alpha"), group("k3", "émile"), group("k0", null)].sort(byLabel);

    expect(sorted.map((entry) => entry.key)).toEqual(["k1", "k2", "k3", "k4", "k0", "k5"]);
  });

  it("byMinutesThenLabel: the most hours first, equal hours by label, then key", () => {
    const sorted = [group("a", "Beta", 60), group("b", "Alpha", 60), group("c", "Zulu", 120), group("d", "Alpha", 30)].sort(byMinutesThenLabel);

    expect(sorted.map((entry) => entry.key)).toEqual(["c", "b", "a", "d"]);
  });

  it("byKeyDesc: the newest first, which for `YYYY-MM-DD` and `YYYY-MM` is the larger text", () => {
    expect([group("2026-11-02", null), group("2026-12-01", null), group("2026-11-30", null)].sort(byKeyDesc).map((entry) => entry.key)).toEqual([
      "2026-12-01",
      "2026-11-30",
      "2026-11-02",
    ]);
    expect([group("2026-09", null), group("2027-01", null), group("2026-11", null)].sort(byKeyDesc).map((entry) => entry.key)).toEqual(["2027-01", "2026-11", "2026-09"]);
  });
});

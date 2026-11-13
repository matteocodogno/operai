/**
 * Listing one's own entries, `GET /time-entries?whose=mine` (specs/029 T17; AC-1.1, AC-2.4, AC-2.6, AC-4.2, AC-4.4,
 * AC-4.7, AC-4.11; plan § Entries "The span", "A day", "The id rule", "The cursor", § Sequences "List / totals"),
 * through the ASSEMBLED app, against the real database and the fake hosts of T11.
 *
 * Rows are inserted directly where a test needs a particular day, `createdAt` or id (what a route would have to be
 * driven for), and recorded through `POST` where the point is that a recorded entry is listed. What each owner says
 * is scripted per test; what hours-api asked of them is read back from `hosts.calls`.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PERSONAS,
  SEED,
  bearerOf,
  call,
  db,
  makeDealEntry,
  makeMeetingEntry,
  makeNoEntityEntry,
  makeProjectEntry,
  resetWorld,
  type PersonaName,
} from "../test-support/world";
import { claimsOf, startHosts } from "../test-support/hosts";
import { isCalendarDay } from "./rules";
import { __setClockForTests } from "./today";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** A period that holds every day these tests use. */
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

/** `GET /time-entries?<query>` as `as`. The query is sent exactly as written, so a test can send what a client should not. */
const list = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries?${query}`, { as });

describe("GET /time-entries, whose=mine (AC-1.1, AC-4.2)", () => {
  it("lists an entry recorded with POST, exactly as POST returned it", async () => {
    const created = await call("POST", "/time-entries", {
      body: { day: "2026-11-12", minutes: 90, on: { type: "none", categoryId: SEED.categories.training }, note: "Fixed the expense report" },
    });
    expect(created.status).toBe(201);

    const res = await list(NOVEMBER);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [created.json], nextCursor: null, unavailable: [] });
  });

  it("never returns another person's row: whose=mine is the default and is the caller's own, whoever is asking", async () => {
    const mine = await makeNoEntityEntry(SEED.categories.training, { userId: ALICE, day: "2026-11-05" });
    const bobs = await makeNoEntityEntry(SEED.categories.training, { userId: BOB, day: "2026-11-05" });

    for (const query of [NOVEMBER, `whose=mine&${NOVEMBER}`]) {
      const asAlice = await list(query, "alice");
      expect(asAlice.status).toBe(200);
      expect(asAlice.json.items.map((item: { id: string }) => item.id)).toEqual([mine.id]);

      const asBob = await list(query, "bob");
      expect(asBob.json.items.map((item: { id: string }) => item.id)).toEqual([bobs.id]);
    }
  });

  it("lists only the days from..to, both end days included", async () => {
    const before = await makeNoEntityEntry(SEED.categories.training, { day: "2026-10-31" });
    const first = await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-01" });
    const last = await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-30" });
    const after = await makeNoEntityEntry(SEED.categories.training, { day: "2026-12-01" });

    const res = await list(NOVEMBER);

    const ids = res.json.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual([last.id, first.id]);
    expect(ids).not.toContain(before.id);
    expect(ids).not.toContain(after.id);
  });
});

/** What a 400 of the router says: `invalid_request`, and the member it names. */
const expectInvalid = (res: { status: number; json: any }, field: string) => {
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ code: "invalid_request", field });
};

/** A cursor as hours-api mints it (plan § Entries, "The cursor"): base64url of `<day>|<13-digit epoch ms>|<id>`. */
const mint = (day: string, ms: string, id: string): string => Buffer.from(`${day}|${ms}|${id}`, "utf8").toString("base64url");
const VALID_CURSOR = mint("2026-11-05", String(Date.parse("2026-11-05T10:00:00Z")), "cmhw3q0a10000x2k9");

describe("the period: from and to, both end days included (AC-4.4; plan § Entries, 'The span')", () => {
  it("requires both: a missing one is a 400 naming it", async () => {
    expectInvalid(await list("to=2026-11-30"), "from");
    expectInvalid(await list("from=2026-11-01"), "to");
    expectInvalid(await list(""), "from");
    expect(hosts.calls).toEqual([]);
  });

  it("takes one day, a year and a day, and a whole leap year: 200", async () => {
    for (const period of ["from=2026-11-13&to=2026-11-13", "from=2026-01-01&to=2027-01-01", "from=2028-01-01&to=2028-12-31"]) {
      const res = await list(period);
      expect(res.status).toBe(200);
    }
  });

  it("refuses a period of 367 days, and a `from` after `to`, naming `to`", async () => {
    expectInvalid(await list("from=2026-01-01&to=2027-01-02"), "to");
    expectInvalid(await list("from=2028-01-01&to=2029-01-01"), "to");
    expectInvalid(await list("from=2026-11-14&to=2026-11-13"), "to");
    expectInvalid(await list("from=2026-11-30&to=2026-11-01"), "to");
    expect(hosts.calls).toEqual([]);
  });

  /** A day outside the rule of plan § Entries, "A day": not real, before 2000-01-01, or not `YYYY-MM-DD`. */
  const NOT_A_DAY = ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "1999-12-31", "0000-01-01", "0050-01-01", "2026-2-01", "2026-11-13T00:00:00Z", ""];

  it("refuses a `from` or `to` that is not a real calendar day from 2000-01-01, naming it, never a 500, and asks nobody", async () => {
    for (const day of NOT_A_DAY) {
      expectInvalid(await list(`from=${day}&to=2026-11-30`), "from");
      expectInvalid(await list(`from=2026-11-01&to=${day}`), "to");
    }
    expect(hosts.calls).toEqual([]);
  });

  it("refuses a `from` or `to` sent twice, naming it", async () => {
    expectInvalid(await list("from=2026-11-01&from=2026-11-02&to=2026-11-30"), "from");
    expectInvalid(await list("from=2026-11-01&to=2026-11-30&to=2026-11-30"), "to");
    expect(hosts.calls).toEqual([]);
  });

  it("names the period, not the cursor, when a bad day comes with a cursor", async () => {
    expectInvalid(await list(`from=2026-02-30&to=2026-11-30&cursor=${VALID_CURSOR}`), "from");
    expectInvalid(await list(`from=2026-11-01&to=1999-12-31&cursor=${VALID_CURSOR}`), "to");
    expectInvalid(await list(`from=2026-01-01&to=2027-01-02&cursor=${VALID_CURSOR}`), "to");
    expect(hosts.calls).toEqual([]);
  });

  it("applies the one date rule of T14 (`isCalendarDay`), not a second one: they agree on a grid of years, months and days", async () => {
    let accepted = 0;
    let refused = 0;
    for (const year of ["0000", "0050", "1999", "2000", "2024", "2025", "2026", "9999"]) {
      for (const month of ["00", "01", "02", "12", "13"]) {
        for (const day of ["00", "01", "28", "29", "30", "31", "32"]) {
          const text = `${year}-${month}-${day}`;
          // A period of one day: from = to = the text, so a real day is a valid period.
          const status = (await list(`from=${text}&to=${text}`)).status;
          expect({ text, status }).toEqual({ text, status: isCalendarDay(text) ? 200 : 400 });
          if (status === 200) accepted += 1;
          else refused += 1;
        }
      }
    }
    // The grid holds both kinds, so the agreement is not vacuous.
    expect(accepted).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(30);
  });

  it("takes the first day the product holds and the last day the format holds", async () => {
    const first = await makeNoEntityEntry(SEED.categories.training, { day: "2000-01-01" });
    const last = await makeNoEntityEntry(SEED.categories.training, { day: "9999-12-31" });

    const year2000 = await list("from=2000-01-01&to=2000-12-31");
    expect(year2000.status).toBe(200);
    expect(year2000.json.items.map((item: { id: string }) => item.id)).toEqual([first.id]);

    const lastDay = await list("from=9999-12-31&to=9999-12-31");
    expect(lastDay.status).toBe(200);
    expect(lastDay.json.items.map((item: { id: string }) => item.id)).toEqual([last.id]);
  });
});

// ─── The order, the page and the cursor ──────────────────────────────────────

type Item = { id: string; day: string };
const idsOf = (res: { json: { items: Item[] } }): string[] => res.json.items.map((item) => item.id);

/** An entry of `alice` on no entity with the id, day and `createdAt` a test needs (`createdAt` as an ISO instant). */
const insertAt = (id: string, day: string, createdAt: string, userId = ALICE) =>
  db.timeEntry.create({
    data: { id, userId, day: new Date(`${day}T00:00:00Z`), minutes: 60, target: "none", categoryId: SEED.categories.training, createdAt: new Date(createdAt) },
  });

/** Pages of `limit` until `nextCursor` is null: every item, in the order read, and how many pages it took. */
async function walk(limit: number, period = NOVEMBER) {
  const items: string[] = [];
  let pages = 0;
  let cursor: string | null = null;
  do {
    const res: Awaited<ReturnType<typeof list>> = await list(`${period}&limit=${limit}${cursor === null ? "" : `&cursor=${cursor}`}`);
    expect(res.status).toBe(200);
    items.push(...idsOf(res));
    pages += 1;
    cursor = res.json.nextCursor;
    expect(pages).toBeLessThan(50);
  } while (cursor !== null);
  return { items, pages };
}

describe("the order of the list (AC-4.1; plan § Entries, 'The cursor')", () => {
  it("is day desc, then createdAt desc, then id desc", async () => {
    // The ids run AGAINST the createdAt order within a day, so an order on id alone cannot pass for the right one.
    await insertAt("order-z", "2026-11-03", "2026-11-13T09:00:00Z");
    await insertAt("order-y", "2026-11-04", "2026-11-04T08:00:00Z");
    await insertAt("order-x", "2026-11-04", "2026-11-04T09:00:00.500Z");
    await insertAt("order-w", "2026-11-04", "2026-11-04T09:00:00.501Z");

    expect(idsOf(await list(NOVEMBER))).toEqual(["order-w", "order-x", "order-y", "order-z"]);
  });

  it("breaks a tie on the day and the createdAt, to the millisecond, by id desc", async () => {
    for (const id of ["tiea", "tiec", "tieb"]) await insertAt(id, "2026-11-04", "2026-11-04T09:00:00.123Z");

    expect(idsOf(await list(NOVEMBER))).toEqual(["tiec", "tieb", "tiea"]);
  });
});

describe("limit and the cursor (AC-4.1, AC-4.4; plan § Entries, 'The cursor')", () => {
  it("refuses a limit that is not a whole number from 1 to 500, naming it", async () => {
    for (const limit of ["0", "501", "1000", "-1", "1.5", "abc", "", "1e2", "0x10", " 5", "+5", "05"]) {
      expectInvalid(await list(`${NOVEMBER}&limit=${encodeURIComponent(limit)}`), "limit");
    }
    expectInvalid(await list(`${NOVEMBER}&limit=5&limit=6`), "limit");
    expect(hosts.calls).toEqual([]);
  });

  it("pages 100 by default, and takes 1 and 500", async () => {
    await db.timeEntry.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        id: `bulk-${String(index).padStart(3, "0")}`,
        userId: ALICE,
        day: new Date("2026-11-04T00:00:00Z"),
        minutes: 30,
        target: "none" as const,
        categoryId: SEED.categories.training,
        createdAt: new Date(Date.parse("2026-11-04T09:00:00Z") + index * 1000),
      })),
    });

    const byDefault = await list(NOVEMBER);
    expect(byDefault.json.items).toHaveLength(100);
    expect(byDefault.json.nextCursor).not.toBeNull();
    expect((await list(`${NOVEMBER}&limit=1`)).json.items).toHaveLength(1);
    expect((await list(`${NOVEMBER}&limit=500`)).json.items).toHaveLength(101);
    expect((await list(`${NOVEMBER}&limit=500`)).json.nextCursor).toBeNull();
  });

  it("walks every matching row exactly once, in order, with limit 1, 2 and 500", async () => {
    // Days apart, one day with distinct instants, and three rows that share their day AND their createdAt.
    await insertAt("walk-a", "2026-11-09", "2026-11-09T07:00:00Z");
    await insertAt("walk-r", "2026-11-05", "2026-11-05T07:00:00Z");
    await insertAt("walk-q", "2026-11-05", "2026-11-05T08:00:00Z");
    for (const id of ["walk-d", "walk-e", "walk-f"]) await insertAt(id, "2026-11-05", "2026-11-05T09:00:00.007Z");
    await insertAt("walk-g", "2026-11-01", "2026-11-01T07:00:00Z");
    // Not in the walk: someone else's, and a day outside the period.
    await insertAt("walk-other", "2026-11-05", "2026-11-05T09:00:00.007Z", BOB);
    await insertAt("walk-outside", "2026-12-05", "2026-11-05T09:00:00.007Z");
    const expected = ["walk-a", "walk-f", "walk-e", "walk-d", "walk-q", "walk-r", "walk-g"];

    for (const [limit, pages] of [[1, 7], [2, 4], [3, 3], [500, 1]] as const) {
      expect(await walk(limit)).toEqual({ items: expected, pages });
    }
  });

  it("walks a row older than 2001, whose createdAt is 12 digits of milliseconds, without refusing its own cursor", async () => {
    await insertAt("old-a", "2026-11-05", "1999-12-31T23:59:59.999Z");
    await insertAt("old-b", "2026-11-05", "1999-12-31T23:59:59.998Z");

    expect(await walk(1)).toEqual({ items: ["old-a", "old-b"], pages: 2 });
  });

  it("walks a page of exactly `limit` rows to its end: no empty last page", async () => {
    for (const id of ["exact-a", "exact-b"]) await insertAt(id, "2026-11-05", "2026-11-05T09:00:00Z");

    expect(await walk(2)).toEqual({ items: ["exact-b", "exact-a"], pages: 1 });
  });

  it("mints nextCursor as base64url of `<day>|<13-digit epoch ms>|<id>` of the page's last item", async () => {
    await insertAt("mint-a", "2026-11-05", "2026-11-05T09:00:00.007Z");
    await insertAt("mint-b", "2026-11-04", "2026-11-04T09:00:00Z");

    const { nextCursor } = (await list(`${NOVEMBER}&limit=1`)).json;

    expect(nextCursor).toBe(mint("2026-11-05", String(Date.parse("2026-11-05T09:00:00.007Z")), "mint-a"));
    expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("keeps walking when the entry the cursor named is deleted meanwhile", async () => {
    await insertAt("gone-a", "2026-11-05", "2026-11-05T09:00:00Z");
    await insertAt("gone-b", "2026-11-04", "2026-11-04T09:00:00Z");
    await insertAt("gone-c", "2026-11-03", "2026-11-03T09:00:00Z");
    const first = await list(`${NOVEMBER}&limit=1`);
    expect(idsOf(first)).toEqual(["gone-a"]);

    await db.timeEntry.delete({ where: { id: "gone-a" } });

    expect(idsOf(await list(`${NOVEMBER}&limit=5&cursor=${first.json.nextCursor}`))).toEqual(["gone-b", "gone-c"]);
  });
});

describe("a cursor hours-api did not mint is a 400 naming `cursor`, never a 500 (AC-4.4; plan § Entries, 'The cursor')", () => {
  const MS = String(Date.parse("2026-11-05T09:00:00.007Z"));
  const ID = "cmhw3q0a10000x2k9";

  /** Every cursor in `bad` is refused, nothing was asked of any other service, and nothing was written. */
  async function expectRefused(bad: Record<string, string>) {
    for (const [what, cursor] of Object.entries(bad)) {
      const res = await list(`${NOVEMBER}&cursor=${encodeURIComponent(cursor)}`);
      expect({ what, status: res.status, field: res.json?.field }).toEqual({ what, status: 400, field: "cursor" });
    }
    expect(hosts.calls).toEqual([]);
  }

  it("accepts a cursor of the shape it mints, and the list's own nextCursor", async () => {
    await insertAt("c-first", "2026-11-05", "2026-11-05T09:00:00.007Z");
    await insertAt("c-second", "2026-11-04", "2026-11-04T09:00:00Z");

    expect((await list(`${NOVEMBER}&cursor=${mint("2026-11-05", MS, ID)}`)).status).toBe(200);
    const next = (await list(`${NOVEMBER}&limit=1`)).json.nextCursor;
    expect(idsOf(await list(`${NOVEMBER}&cursor=${next}`))).toEqual(["c-second"]);
  });

  it("takes at most 200 characters: a cursor of exactly 200 that is valid in every other way is taken, 202 is not", async () => {
    // A 3-byte character per UTF-16 unit stretches an id of the id rule's 64 units to ~290 characters; no real id does (cuids are ASCII).
    const at200 = mint("2026-11-05", MS, `${"€".repeat(41)}ab`);
    const at202 = mint("2026-11-05", MS, "€".repeat(42));
    expect([at200.length, at202.length]).toEqual([200, 202]);

    expect((await list(`${NOVEMBER}&cursor=${at200}`)).status).toBe(200);
    await expectRefused({ "202 characters": at202, "290 characters": mint("2026-11-05", MS, "€".repeat(64)), "201 characters": "A".repeat(201) });
  });

  it("refuses an empty cursor and one sent twice", async () => {
    expectInvalid(await list(`${NOVEMBER}&cursor=`), "cursor");
    expectInvalid(await list(`${NOVEMBER}&cursor=${VALID_CURSOR}&cursor=${VALID_CURSOR}`), "cursor");
    expect(hosts.calls).toEqual([]);
  });

  it("refuses one outside the base64url alphabet, or not canonical", async () => {
    // Text of 18 bytes more than a multiple of 3 leaves unused bits in the last character: they decode alike but are not what was minted.
    const text = mint("2026-11-05", MS, "cmhw3q0a10000x2k9a");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const decoded = (cursor: string) => Buffer.from(cursor, "base64url").toString("utf8");
    const aliases = [...alphabet].map((char) => text.slice(0, -1) + char).filter((alias) => alias !== text && decoded(alias) === decoded(text));
    expect(aliases.length).toBeGreaterThan(0);

    await expectRefused({
      "a plus": text.replace(/[A-Za-z0-9]/, "+"),
      "a slash": `${text}/`,
      "padding": `${text}=`,
      "a space": `${text} `,
      "a bang": `${text}!`,
      "a NUL": `${text}\u0000`,
      "non-ASCII": `${text}é`,
      "a trailing-bits alias of a valid cursor": aliases[0]!,
    });
  });

  it("refuses text that decodes to junk, to too few or too many parts, or to a NUL", async () => {
    const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");
    await expectRefused({
      "junk": encode("hello"),
      "bytes that are not text": Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64url"),
      "two parts": encode(`2026-11-05|${MS}`),
      "four parts": encode(`2026-11-05|${MS}|${ID}|x`),
      "an id holding a bar": encode(`2026-11-05|${MS}|a|b`),
      "empty parts": encode("||"),
      "a NUL in the id": mint("2026-11-05", MS, "a\u0000b"),
      "a NUL in the day": mint("2026-11-05\u0000", MS, ID),
      "a NUL in the instant": mint("2026-11-05", `${MS.slice(0, 12)}\u0000`, ID),
    });
  });

  it("refuses an impossible day, and a day outside from..to", async () => {
    await expectRefused({
      "2026-02-30": mint("2026-02-30", MS, ID),
      "2026-2-05": mint("2026-2-05", MS, ID),
      "an ISO instant for the day": mint("2026-11-05T00:00:00Z", MS, ID),
      "a day before from": mint("2026-10-31", MS, ID),
      "a day after to": mint("2026-12-01", MS, ID),
      "a day before 2000": mint("1999-12-31", MS, ID),
    });
  });

  it("takes a day on either end of the period", async () => {
    expect((await list(`${NOVEMBER}&cursor=${mint("2026-11-01", MS, ID)}`)).status).toBe(200);
    expect((await list(`${NOVEMBER}&cursor=${mint("2026-11-30", MS, ID)}`)).status).toBe(200);
  });

  it("refuses an instant that is not 13 digits of epoch milliseconds", async () => {
    await expectRefused({
      "12 digits": mint("2026-11-05", MS.slice(1), ID),
      "14 digits": mint("2026-11-05", `${MS}0`, ID),
      "a sign": mint("2026-11-05", `-${MS.slice(1)}`, ID),
      "letters": mint("2026-11-05", `${MS.slice(0, 12)}a`, ID),
      "a decimal point": mint("2026-11-05", `${MS.slice(0, 12)}.`, ID),
      "an ISO instant": mint("2026-11-05", "2026-11-05T09:00:00.007Z", ID),
      "empty": mint("2026-11-05", "", ID),
    });
  });

  it("refuses an id outside the id rule", async () => {
    await expectRefused({
      "empty": mint("2026-11-05", MS, ""),
      "65 characters": mint("2026-11-05", MS, "x".repeat(65)),
      "a comma": mint("2026-11-05", MS, "a,b"),
      "a space in front": mint("2026-11-05", MS, " a"),
      "a space behind": mint("2026-11-05", MS, "a "),
      "spaces only": mint("2026-11-05", MS, "   "),
    });
  });

  it("is decided before any owner is asked: a deal filter next to a bad cursor, limit or period never reaches meetings-api", async () => {
    expectInvalid(await list(`${NOVEMBER}&dealId=d1&cursor=junk`), "cursor");
    expectInvalid(await list(`${NOVEMBER}&dealId=d1&limit=0`), "limit");
    expectInvalid(await list("from=2026-11-30&to=2026-11-01&dealId=d1"), "to");
    expectInvalid(await list(`${NOVEMBER}&dealId=d1&userId=${ALICE}`), "userId");
    expect(hosts.calls).toEqual([]);
  });

  it("refuses a query member it does not know: a typo must not widen what is read", async () => {
    expectInvalid(await list(`${NOVEMBER}&projectID=p1`), "");
    expectInvalid(await list(`${NOVEMBER}&groupBy=day`), "");
    expect(hosts.calls).toEqual([]);
  });
});

// ─── The filters ─────────────────────────────────────────────────────────────

describe("the filters narrow the items (AC-4.4)", () => {
  /** One entry of alice on each kind of thing, and a second on a project, a meeting and a category. */
  async function fixture() {
    return {
      p1: await makeProjectEntry("p1", { day: "2026-11-02", workTypeId: SEED.workTypes.project.development }),
      p2: await makeProjectEntry("p2", { day: "2026-11-03" }),
      d1: await makeDealEntry("d1", { day: "2026-11-04", workTypeId: SEED.workTypes.deal.analysis }),
      m1: await makeMeetingEntry("m1", { day: "2026-11-05" }),
      m2: await makeMeetingEntry("m2", { day: "2026-11-06" }),
      training: await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-07" }),
      admin: await makeNoEntityEntry(SEED.categories.administration, { day: "2026-11-08" }),
    };
  }

  const narrowedBy = async (query: string) => idsOf(await list(`${NOVEMBER}&${query}`));

  it("by target: the kind of thing the entry itself is on", async () => {
    const e = await fixture();

    expect(await narrowedBy("target=project")).toEqual([e.p2.id, e.p1.id]);
    expect(await narrowedBy("target=deal")).toEqual([e.d1.id]);
    expect(await narrowedBy("target=meeting")).toEqual([e.m2.id, e.m1.id]);
    expect(await narrowedBy("target=none")).toEqual([e.admin.id, e.training.id]);
  });

  it("by projectId, meetingId, categoryId and workTypeId", async () => {
    const e = await fixture();

    expect(await narrowedBy("projectId=p1")).toEqual([e.p1.id]);
    expect(await narrowedBy("meetingId=m2")).toEqual([e.m2.id]);
    expect(await narrowedBy(`categoryId=${SEED.categories.training}`)).toEqual([e.training.id]);
    expect(await narrowedBy(`workTypeId=${SEED.workTypes.project.development}`)).toEqual([e.p1.id]);
    expect(await narrowedBy(`workTypeId=${SEED.workTypes.deal.analysis}`)).toEqual([e.d1.id]);
  });

  it("with every filter a narrowing: together they AND, and a filter nothing matches is an empty page, never a 404", async () => {
    const e = await fixture();

    expect(await narrowedBy("target=project&projectId=p1")).toEqual([e.p1.id]);
    expect(await narrowedBy("target=project&workTypeId=wt-project-development&projectId=p1")).toEqual([e.p1.id]);
    expect(await narrowedBy("target=deal&projectId=p1")).toEqual([]);
    expect(await narrowedBy(`projectId=p1&categoryId=${SEED.categories.training}`)).toEqual([]);
    expect(await narrowedBy("projectId=no-such-project")).toEqual([]);
    const none = await list(`${NOVEMBER}&meetingId=no-such-meeting`);
    expect(none.json).toEqual({ items: [], nextCursor: null, unavailable: [] });
  });

  it("never reaches another person's row, whichever filter names it", async () => {
    await makeProjectEntry("p1", { userId: BOB, day: "2026-11-02" });
    const mine = await makeProjectEntry("p1", { userId: ALICE, day: "2026-11-02" });

    expect(await narrowedBy("projectId=p1")).toEqual([mine.id]);
    expect(await narrowedBy("target=project")).toEqual([mine.id]);
  });

  it("lists every entry even when an owner does not answer, and names the source (AC-4.7)", async () => {
    const onProject = await makeProjectEntry("p1", { day: "2026-11-02", minutes: 120 });
    const training = await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-03", minutes: 30 });
    hosts.fail("projects.resolve", { status: 500 });
    hosts.fail("auth.identities", { status: 500 });

    const res = await list(NOVEMBER);

    expect(res.status).toBe(200);
    expect(res.json.unavailable).toEqual(["projects", "identities"]);
    expect(idsOf(res)).toEqual([training.id, onProject.id]);
    expect(res.json.items.reduce((sum: number, item: { minutes: number }) => sum + item.minutes, 0)).toBe(150);
    expect(res.json.items[1]).toMatchObject({ on: { type: "project", id: "p1", label: null, visibility: "unavailable" }, person: { status: "unknown" } });
  });

  it("an entry on a project its author has left is still listed under it (AC-2.4)", async () => {
    const entry = await makeProjectEntry("p1", { day: "2026-11-02" });
    // Alice was on the team when she recorded it; now she is not, and the project is closed.
    hosts.projects.setProject("p1", { label: "Alpha", assignees: [BOB], writable: false });

    const res = await list(`${NOVEMBER}&projectId=p1`);

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0]).toMatchObject({ id: entry.id, on: { type: "project", id: "p1", label: "Alpha", visibility: "visible" } });
  });
});

describe("a filter outside its rule is a 400 naming it, and nobody is asked (AC-4.4; plan § Entries, 'The id rule')", () => {
  const FILTERS = ["projectId", "dealId", "meetingId", "categoryId", "workTypeId"] as const;
  const OUTSIDE: Record<string, string> = {
    "empty": "",
    "65 characters": "x".repeat(65),
    "a NUL": "%00",
    "a NUL inside": "a%00b",
    "a comma": "a%2Cb",
    "a comma only": "%2C",
    "a space in front": "%20a",
    "a space behind": "a%20",
    "spaces only": "%20%20",
    "a tab behind": "a%09",
  };

  it("for each of the filter ids: empty, 65 characters, a NUL, a comma, a space at either end", async () => {
    for (const filter of FILTERS) {
      for (const [what, value] of Object.entries(OUTSIDE)) {
        const res = await list(`${NOVEMBER}&${filter}=${value}`);
        expect({ filter, what, status: res.status, field: res.json?.field }).toEqual({ filter, what, status: 400, field: filter });
      }
    }
    expect(hosts.calls).toEqual([]);
  });

  it("for each of the filter ids sent twice, even the same value twice", async () => {
    for (const filter of FILTERS) {
      expectInvalid(await list(`${NOVEMBER}&${filter}=a&${filter}=b`), filter);
      expectInvalid(await list(`${NOVEMBER}&${filter}=a&${filter}=a`), filter);
    }
    expect(hosts.calls).toEqual([]);
  });

  it("takes an id of exactly 64 characters, and one holding what only needs escaping", async () => {
    for (const filter of FILTERS) {
      expect((await list(`${NOVEMBER}&${filter}=${"x".repeat(64)}`)).status).toBe(200);
      expect((await list(`${NOVEMBER}&${filter}=${encodeURIComponent("a&b#c+d%e f")}`)).status).toBe(200);
    }
  });

  it("refuses a target that is not one of the four, and a whose that is not mine or all", async () => {
    expectInvalid(await list(`${NOVEMBER}&target=meetings`), "target");
    expectInvalid(await list(`${NOVEMBER}&target=`), "target");
    expectInvalid(await list(`${NOVEMBER}&target=project&target=deal`), "target");
    expectInvalid(await list(`${NOVEMBER}&whose=everyone`), "whose");
    expectInvalid(await list(`${NOVEMBER}&whose=`), "whose");
    expect(hosts.calls).toEqual([]);
  });
});

// ─── dealId: the deal's entries and the entries on the meetings linked to it ─────

describe("the dealId filter counts the meetings currently linked to the deal (AC-2.6, AC-4.4)", () => {
  /** Two deals, three meetings (m1 → d1, m2 → d2, m3 → none), and an entry of alice's on each, deal d1 and d2 included. */
  async function fixture() {
    for (const id of ["m1", "m2", "m3"]) hosts.meetings.add({ id, creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    hosts.meetings.relink("m2", "d2");
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.crm.setDeal("d2", { label: "Deal two" });
    return {
      d1: await makeDealEntry("d1", { day: "2026-11-02" }),
      d2: await makeDealEntry("d2", { day: "2026-11-03" }),
      m1: await makeMeetingEntry("m1", { day: "2026-11-04" }),
      m2: await makeMeetingEntry("m2", { day: "2026-11-05" }),
      m3: await makeMeetingEntry("m3", { day: "2026-11-06" }),
      project: await makeProjectEntry("p1", { day: "2026-11-07" }),
    };
  }

  const forDeal = async (dealId: string, extra = "") => idsOf(await list(`${NOVEMBER}&dealId=${dealId}${extra}`));

  it("lists the entries on the deal plus those on the meetings linked to it, and no others", async () => {
    const e = await fixture();

    expect(await forDeal("d1")).toEqual([e.m1.id, e.d1.id]);
    expect(await forDeal("d2")).toEqual([e.m2.id, e.d2.id]);
    expect(await forDeal("no-such-deal")).toEqual([]);
  });

  it("moves the hours of a meeting when the meeting is relinked: nothing about the deal is stored on the entry", async () => {
    const e = await fixture();
    expect(await forDeal("d1")).toEqual([e.m1.id, e.d1.id]);

    hosts.meetings.relink("m1", "d2");
    expect(await forDeal("d1")).toEqual([e.d1.id]);
    expect(await forDeal("d2")).toEqual([e.m2.id, e.m1.id, e.d2.id]);

    hosts.meetings.relink("m1", null);
    hosts.meetings.relink("m3", "d1");
    expect(await forDeal("d1")).toEqual([e.m3.id, e.d1.id]);
    expect(await forDeal("d2")).toEqual([e.m2.id, e.d2.id]);
  });

  it("narrows with the other filters: the meeting must be the one asked for AND linked to the deal", async () => {
    const e = await fixture();

    expect(await forDeal("d1", "&meetingId=m1")).toEqual([e.m1.id]);
    expect(await forDeal("d1", "&meetingId=m2")).toEqual([]);
    expect(await forDeal("d1", "&target=meeting")).toEqual([e.m1.id]);
    expect(await forDeal("d1", "&target=deal")).toEqual([e.d1.id]);
    expect(await forDeal("d1", "&target=project")).toEqual([]);
  });

  it("never lists another person's entry on a linked meeting", async () => {
    const e = await fixture();
    await makeMeetingEntry("m1", { userId: BOB, day: "2026-11-04" });

    expect(await forDeal("d1")).toEqual([e.m1.id, e.d1.id]);
  });

  it("walks the cursor across the deal's own and the meetings' entries alike", async () => {
    const e = await fixture();

    const first = await list(`${NOVEMBER}&dealId=d1&limit=1`);
    expect(idsOf(first)).toEqual([e.m1.id]);
    expect(idsOf(await list(`${NOVEMBER}&dealId=d1&limit=1&cursor=${first.json.nextCursor}`))).toEqual([e.d1.id]);
  });

  it("asks meetings-api once for the deal's meetings, with hours-api's own credential and never the caller's", async () => {
    await fixture();
    const caller = await bearerOf("alice");

    await list(`${NOVEMBER}&dealId=d1`);

    const calls = hosts.callsTo("meetings.system-hosts").filter((recorded) => recorded.query.has("dealId"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("dealId")).toBe("d1");
    expect(calls[0]?.authorization).not.toBe(caller);
    expect(claimsOf(calls[0]?.authorization ?? null)).toMatchObject({ sub: "system:hours-api", scope: "meetings.hosts.read" });
    // Whatever the view asks of the system route afterwards is by ids, never a second question about the deal.
    expect(hosts.callsTo("meetings.system-hosts").filter((recorded) => recorded.query.has("dealId"))).toHaveLength(1);
  });

  it("sends the deal id exactly as given: what only needs escaping reaches meetings-api intact", async () => {
    const odd = "d&1#2+3%4 5";
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relink("m1", odd);
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });

    expect(await forDeal(encodeURIComponent(odd))).toEqual([meeting.id]);
    expect(hosts.callsTo("meetings.system-hosts")[0]?.query.get("dealId")).toBe(odd);
  });

  it("lists every meeting of a deal with many: the answer is not paged and not capped", async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `many-${String(index).padStart(3, "0")}`);
    for (const id of ids) {
      hosts.meetings.add({ id, creator: ALICE });
      hosts.meetings.relink(id, "d1");
    }
    await db.timeEntry.createMany({
      data: ids.map((id, index) => ({
        userId: ALICE,
        day: new Date(`2026-11-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`),
        minutes: 30,
        target: "meeting" as const,
        meetingId: id,
      })),
    });

    const res = await list(`${NOVEMBER}&dealId=d1&limit=500`);

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(130);
    expect(res.json.unavailable).toEqual([]);
  });

  it("counts only the meetings meetings-api says are linked to THIS deal: an item linked elsewhere, to none or to another host is not counted", async () => {
    const e = await fixture();
    await makeMeetingEntry("m4", { day: "2026-11-08" });
    // The route's answer is whatever meetings-api stores: here, items that are not this deal's among its own.
    hosts.fail("meetings.system-hosts", {
      times: 1,
      body: {
        items: [
          { id: "m1", host: { app: "crm", entityType: "deal", entityId: "d1" } },
          { id: "m2", host: { app: "crm", entityType: "deal", entityId: "d2" } },
          { id: "m3", host: null },
          { id: "m4", host: { app: "testhost", entityType: "widget", entityId: "d1" } },
        ],
      },
    });

    expect(await forDeal("d1")).toEqual([e.m1.id, e.d1.id]);
  });

  it("drops a meeting id outside the id rule from the question instead of sending it to the database", async () => {
    const e = await fixture();
    hosts.fail("meetings.system-hosts", {
      times: 1,
      body: {
        items: [
          { id: "m\u0000x", host: { app: "crm", entityType: "deal", entityId: "d1" } },
          { id: "m1", host: { app: "crm", entityType: "deal", entityId: "d1" } },
        ],
      },
    });

    const res = await list(`${NOVEMBER}&dealId=d1`);

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([e.m1.id, e.d1.id]);
  });
});

describe("while meetings-api cannot say which meetings are linked, the deal filter refuses (AC-4.11)", () => {
  const OUTAGES: Array<[string, () => void]> = [
    ["answering 500", () => hosts.fail("meetings.system-hosts", { status: 500 })],
    ["answering 503", () => hosts.fail("meetings.system-hosts", { status: 503 })],
    ["answering 401 to the credential, even after a fresh one", () => hosts.fail("meetings.system-hosts", { status: 401 })],
    ["a route that is not deployed yet (404)", () => hosts.fail("meetings.system-hosts", { status: 404 })],
    ["an owner that refuses the question (422)", () => hosts.fail("meetings.system-hosts", { status: 422 })],
    ["a good answer under another status", () => hosts.fail("meetings.system-hosts", { withStatus: 203 })],
    ["slower than 2 s", () => hosts.fail("meetings.system-hosts", { delayMs: 2_600 })],
    ["a redirect", () => hosts.fail("meetings.system-hosts", { redirect: true })],
    ["a body that is not JSON", () => hosts.fail("meetings.system-hosts", { rawBody: "not json" })],
    ["a body that is not the route's shape", () => hosts.fail("meetings.system-hosts", { malformed: true })],
    ["a connection that cannot be made", () => hosts.sever("meetings")],
    ["no credential: auth would not mint one", () => hosts.fail("auth.service-token", { status: 500 })],
  ];

  it.each(OUTAGES)("is a 503 host_unavailable with no items, however it is down: %s", async (_what, breakIt) => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    await makeDealEntry("d1", { day: "2026-11-02" });
    await makeMeetingEntry("m1", { day: "2026-11-04" });
    breakIt();

    const res = await list(`${NOVEMBER}&dealId=d1`);

    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "host_unavailable", status: 503 });
    // Nothing partial: not the deal's own entries, not an empty page, no cursor, no list of what was unavailable.
    expect(res.json).not.toHaveProperty("items");
    expect(res.json).not.toHaveProperty("nextCursor");
    expect(res.json).not.toHaveProperty("unavailable");
  });

  it("refuses even when the deal has no entries at all, and a page that would have been empty is not an empty page", async () => {
    hosts.fail("meetings.system-hosts", { status: 500 });

    expect((await list(`${NOVEMBER}&dealId=d1`)).status).toBe(503);
  });

  it("answers again, whole, once meetings-api does", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    hosts.meetings.relink("m1", "d1");
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });
    hosts.fail("meetings.system-hosts", { status: 500 });
    expect((await list(`${NOVEMBER}&dealId=d1`)).status).toBe(503);

    hosts.heal("meetings.system-hosts");

    expect(idsOf(await list(`${NOVEMBER}&dealId=d1`))).toEqual([meeting.id]);
  });

  it("is only the deal filter: without it the same outage lists every entry, a meeting's deal unknown and `meeting-deals` named (AC-4.7)", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE, title: "Kick-off" });
    hosts.meetings.relink("m1", "d1");
    const meeting = await makeMeetingEntry("m1", { day: "2026-11-04" });
    const training = await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-05" });
    hosts.fail("meetings.system-hosts", { status: 500 });

    for (const query of [NOVEMBER, `${NOVEMBER}&meetingId=m1`, `${NOVEMBER}&target=meeting`]) {
      const res = await list(query);
      expect(res.status).toBe(200);
      expect(res.json.unavailable).toEqual(["meeting-deals"]);
      expect(res.json.items.find((item: Item) => item.id === meeting.id)).toMatchObject({ on: { type: "meeting", id: "m1", deal: { state: "unknown" } } });
    }
    expect(idsOf(await list(NOVEMBER))).toEqual([training.id, meeting.id]);
  });

  it("is not asked about when no filter names a deal: the entries of a period that holds no meeting ask nobody", async () => {
    await makeNoEntityEntry(SEED.categories.training, { day: "2026-11-05" });
    hosts.fail("meetings.system-hosts", { status: 500 });

    const res = await list(NOVEMBER);

    expect(res.status).toBe(200);
    expect(res.json.unavailable).toEqual([]);
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
  });
});

describe("the contract the clients read (plan § Entries)", () => {
  it("answers every 400 in one shape, whether the router's schema or a rule across two members found it", async () => {
    const bySchema = await list("from=2026-02-30&to=2026-11-30");
    const byRule = await list("from=2026-11-30&to=2026-11-01");
    const byCursor = await list(`${NOVEMBER}&cursor=junk`);

    for (const res of [bySchema, byRule, byCursor]) {
      expect(res.status).toBe(400);
      expect(Object.keys(res.json).sort()).toEqual(Object.keys(bySchema.json).sort());
      expect(res.json.errors).toEqual([{ field: res.json.field, message: expect.any(String) }]);
      expect(res.json.detail).toStartWith(`${res.json.field}: `);
    }
  });

  it("needs a session, like every route below the guard", async () => {
    expect((await list(NOVEMBER, null)).status).toBe(401);
  });

  it("is documented in the OpenAPI document: the query members, which are required, and what it answers", async () => {
    const res = await call("GET", "/openapi.json", { as: null });

    expect(res.status).toBe(200);
    const operation = res.json.paths["/time-entries"].get;
    const parameters: Array<{ name: string; in: string; required?: boolean; schema: { type?: string; minimum?: number; maximum?: number } }> = operation.parameters;
    expect(parameters.map((parameter) => parameter.name).sort()).toEqual(
      ["categoryId", "cursor", "dealId", "from", "limit", "meetingId", "projectId", "target", "to", "userId", "whose", "workTypeId"].sort(),
    );
    expect(parameters.every((parameter) => parameter.in === "query")).toBe(true);
    expect(parameters.filter((parameter) => parameter.required === true).map((parameter) => parameter.name).sort()).toEqual(["from", "to"]);
    expect(parameters.find((parameter) => parameter.name === "limit")?.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 500 });
    expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "401", "403", "503"]);
    expect(JSON.stringify(operation.responses["200"])).toContain("TimeEntryView");
  });
});

describe("whose and userId (AC-4.2; what whose=all and userId then DO is src/oversight/read.test.ts)", () => {
  it("refuses a userId without whose=all, naming it, even one's own and before any other check", async () => {
    expectInvalid(await list(`${NOVEMBER}&userId=${ALICE}`), "userId");
    expectInvalid(await list(`${NOVEMBER}&whose=mine&userId=${BOB}`), "userId");
    expect(hosts.calls).toEqual([]);
  });

  it("checks a userId against the id rule before anything else is done with it", async () => {
    for (const userId of ["", "x".repeat(65), "%00", "a%2Cb", "%20a"]) {
      expectInvalid(await list(`${NOVEMBER}&whose=all&userId=${userId}`), "userId");
    }
    expect(hosts.calls).toEqual([]);
  });

  it("refuses a malformed cursor, period or filter with whose=all before auth is asked: the holder and the non-holder get the same 400, and no call is recorded", async () => {
    for (const as of ["alice", "holder"] as const) {
      for (const query of [
        `${NOVEMBER}&whose=all&userId=`,
        `${NOVEMBER}&whose=all&userId=${"x".repeat(65)}`,
        `${NOVEMBER}&whose=all&cursor=!!!`,
        `${NOVEMBER}&whose=all&cursor=${VALID_CURSOR}&limit=0`,
        `from=2026-11-30&to=2026-11-01&whose=all`,
        `${NOVEMBER}&whose=all&dealId=a%2Cb`,
      ]) {
        expect((await list(query, as)).status).toBe(400);
      }
    }
    expect(hosts.calls).toEqual([]);
  });
});

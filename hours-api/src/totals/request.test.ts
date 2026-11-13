/**
 * What `GET /time-entries/totals` accepts (specs/029 T18; AC-4.4; plan § Totals "same whose, filter and span rules as the
 * list; no cursor or limit", § Entries "The span", "A day", "The id rule", § Errors): the period, the filters, `groupBy`
 * and who is asking, through the ASSEMBLED app. Every refusal is a 400 `invalid_request` naming the member, decided from
 * the request alone, so NO other service is asked (`hosts.calls` stays empty) and nothing reaches the database as a 500.
 *
 * The same rules as the list's (T17 ./list.test.ts), proved again here because the totals are a second route that must
 * apply them, not a second opinion on what they are: the code is T17's (src/entries/filters.ts).
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, call, makeNoEntityEntry, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { isCalendarDay } from "../entries/rules";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const NOVEMBER = "from=2026-11-01&to=2026-11-30";
const GROUPINGS = ["person", "project", "deal", "category", "month", "day"] as const;

const totals = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/totals?${query}`, { as });

/** What a 400 of the router says: `invalid_request`, and the member it names. */
const expectInvalid = (res: { status: number; json: any }, field: string) => {
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ code: "invalid_request", field });
};

describe("the session and groupBy (plan § Totals)", () => {
  it("needs a session, like every route below the guard", async () => {
    expect((await totals(`groupBy=day&${NOVEMBER}`, null)).status).toBe(401);
  });

  it("takes each of the six groupings, and is a 200 for a period nothing was recorded in", async () => {
    for (const groupBy of GROUPINGS) {
      const res = await totals(`groupBy=${groupBy}&${NOVEMBER}`);
      expect({ groupBy, status: res.status, json: res.json }).toEqual({ groupBy, status: 200, json: { totalMinutes: 0, groups: [], unavailable: [] } });
    }
  });

  it("refuses a missing, an unknown, an empty and a repeated groupBy, naming it", async () => {
    expectInvalid(await totals(NOVEMBER), "groupBy");
    expectInvalid(await totals(`groupBy=week&${NOVEMBER}`), "groupBy");
    expectInvalid(await totals(`groupBy=&${NOVEMBER}`), "groupBy");
    expectInvalid(await totals(`groupBy=DAY&${NOVEMBER}`), "groupBy");
    expectInvalid(await totals(`groupBy=day&groupBy=month&${NOVEMBER}`), "groupBy");
    expectInvalid(await totals(`groupBy=day&groupBy=day&${NOVEMBER}`), "groupBy");
    expect(hosts.calls).toEqual([]);
  });

  it("is never paged: a cursor or a limit is refused, and so is a member it does not know (a typo must not widen what is read)", async () => {
    expect((await totals(`groupBy=day&${NOVEMBER}&limit=10`)).status).toBe(400);
    expect((await totals(`groupBy=day&${NOVEMBER}&cursor=YQ`)).status).toBe(400);
    expect((await totals(`groupBy=day&${NOVEMBER}&projectID=p1`)).status).toBe(400);
    expect((await totals(`groupBy=day&${NOVEMBER}&group=day`)).status).toBe(400);
    expect(hosts.calls).toEqual([]);
  });

  it("answers every refusal in one shape: a Problem with code invalid_request, the field, and its errors", async () => {
    for (const query of [`groupBy=nope&${NOVEMBER}`, "groupBy=day&from=2026-02-30&to=2026-11-30", "groupBy=day&from=2026-11-30&to=2026-11-01", `groupBy=day&${NOVEMBER}&dealId=`]) {
      const res = await totals(query);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ status: 400, code: "invalid_request", title: "Bad Request" });
      expect(typeof res.json.field).toBe("string");
      expect(Array.isArray(res.json.errors)).toBe(true);
    }
  });
});

describe("the contract the clients read", () => {
  it("is documented in the OpenAPI document: the query members, which are required, and what it answers", async () => {
    const res = await call("GET", "/openapi.json", { as: null });

    expect(res.status).toBe(200);
    const operation = res.json.paths["/time-entries/totals"].get;
    const parameters: Array<{ name: string; in: string; required?: boolean; schema: { enum?: string[] } }> = operation.parameters;
    // The list's filters and period, and `groupBy`: no `cursor`, no `limit` (the answer is never paged).
    expect(parameters.map((parameter) => parameter.name).sort()).toEqual(
      ["categoryId", "dealId", "from", "groupBy", "meetingId", "projectId", "target", "to", "userId", "whose", "workTypeId"].sort(),
    );
    expect(parameters.every((parameter) => parameter.in === "query")).toBe(true);
    expect(parameters.filter((parameter) => parameter.required === true).map((parameter) => parameter.name).sort()).toEqual(["from", "groupBy", "to"]);
    expect(parameters.find((parameter) => parameter.name === "groupBy")?.schema.enum).toEqual([...GROUPINGS]);
    expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "401", "503"]);
    expect(JSON.stringify(operation.responses["200"])).toContain("#/components/schemas/TotalsGroup");
    const group = JSON.stringify(res.json.components.schemas.TotalsGroup);
    for (const kind of ["keyed", "none", "hidden", "unavailable", "deal-unknown"]) expect(group).toContain(`"${kind}"`);
  });

  it("answers the groups in the wire shape the clients read: a kind, and a key and label only on a keyed group", async () => {
    await makeNoEntityEntry(SEED.categories.training, { minutes: 30 });
    await makeProjectEntry("p1", { minutes: 60 });

    const res = await totals(`groupBy=category&${NOVEMBER}`);

    expect(res.json).toEqual({
      totalMinutes: 90,
      groups: [
        { kind: "keyed", key: SEED.categories.training, label: "Training", minutes: 30, retired: false },
        { kind: "none", minutes: 60 },
      ],
      unavailable: [],
    });
  });
});

describe("the period: from and to, both end days included (AC-4.4; plan § Entries, 'The span')", () => {
  it("requires both: a missing one is a 400 naming it", async () => {
    expectInvalid(await totals("groupBy=day&to=2026-11-30"), "from");
    expectInvalid(await totals("groupBy=day&from=2026-11-01"), "to");
    expectInvalid(await totals("groupBy=day"), "from");
    expect(hosts.calls).toEqual([]);
  });

  it("takes one day, a year and a day, and a whole leap year: 200, whatever the grouping", async () => {
    for (const groupBy of GROUPINGS) {
      for (const period of ["from=2026-11-13&to=2026-11-13", "from=2026-01-01&to=2027-01-01", "from=2028-01-01&to=2028-12-31"]) {
        expect({ groupBy, period, status: (await totals(`groupBy=${groupBy}&${period}`)).status }).toEqual({ groupBy, period, status: 200 });
      }
    }
  });

  it("refuses a period of 367 days, and a `from` after `to`, naming `to`, whatever the grouping", async () => {
    for (const groupBy of GROUPINGS) {
      expectInvalid(await totals(`groupBy=${groupBy}&from=2026-01-01&to=2027-01-02`), "to");
      expectInvalid(await totals(`groupBy=${groupBy}&from=2028-01-01&to=2029-01-01`), "to");
      expectInvalid(await totals(`groupBy=${groupBy}&from=2026-11-14&to=2026-11-13`), "to");
      expectInvalid(await totals(`groupBy=${groupBy}&from=2026-11-30&to=2026-11-01`), "to");
    }
    expect(hosts.calls).toEqual([]);
  });

  /** A day outside the rule of plan § Entries, "A day": not real, before 2000-01-01, or not `YYYY-MM-DD`. */
  const NOT_A_DAY = ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "1999-12-31", "0000-01-01", "0050-01-01", "2026-2-01", "2026-11-13T00:00:00Z", ""];

  it("refuses a `from` or `to` that is not a real calendar day from 2000-01-01, naming it, never a 500, and asks nobody", async () => {
    for (const day of NOT_A_DAY) {
      expectInvalid(await totals(`groupBy=day&from=${day}&to=2026-11-30`), "from");
      expectInvalid(await totals(`groupBy=day&from=2026-11-01&to=${day}`), "to");
    }
    expect(hosts.calls).toEqual([]);
  });

  it("refuses a `from` or `to` sent twice, naming it", async () => {
    expectInvalid(await totals("groupBy=day&from=2026-11-01&from=2026-11-02&to=2026-11-30"), "from");
    expectInvalid(await totals("groupBy=day&from=2026-11-01&to=2026-11-30&to=2026-11-30"), "to");
    expect(hosts.calls).toEqual([]);
  });

  it("applies the one date rule of T14 (`isCalendarDay`), not a second one: they agree on a grid of years, months and days", async () => {
    let accepted = 0;
    let refused = 0;
    for (const year of ["0000", "0050", "1999", "2000", "2024", "2025", "2026", "9999"]) {
      for (const month of ["00", "01", "02", "12", "13"]) {
        for (const day of ["00", "01", "28", "29", "30", "31", "32"]) {
          const text = `${year}-${month}-${day}`;
          const status = (await totals(`groupBy=day&from=${text}&to=${text}`)).status;
          expect({ text, status }).toEqual({ text, status: isCalendarDay(text) ? 200 : 400 });
          if (status === 200) accepted += 1;
          else refused += 1;
        }
      }
    }
    expect(accepted).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(30);
  });

  it("takes the first day the product holds and the last day the format holds, and counts what is recorded there", async () => {
    await makeNoEntityEntry(SEED.categories.training, { day: "2000-01-01", minutes: 30 });
    await makeNoEntityEntry(SEED.categories.training, { day: "9999-12-31", minutes: 60 });

    const first = await totals("groupBy=day&from=2000-01-01&to=2000-12-31");
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ totalMinutes: 30, groups: [{ kind: "keyed", key: "2000-01-01", label: null, minutes: 30 }], unavailable: [] });

    const last = await totals("groupBy=month&from=9999-12-31&to=9999-12-31");
    expect(last.status).toBe(200);
    expect(last.json).toEqual({ totalMinutes: 60, groups: [{ kind: "keyed", key: "9999-12", label: null, minutes: 60 }], unavailable: [] });
  });

  it("names the period field when a bad day comes with a member that is not valid either", async () => {
    expectInvalid(await totals("groupBy=day&from=2026-02-30&to=2026-11-30&projectId="), "from");
    expectInvalid(await totals("groupBy=day&from=2026-11-01&to=1999-12-31&dealId=%00"), "to");
    expectInvalid(await totals("groupBy=day&from=2026-01-01&to=2027-01-02&dealId=d1"), "to");
    expect(hosts.calls).toEqual([]);
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

  it("for each of the filter ids: empty, 65 characters, a NUL, a comma, a space at either end, whatever the grouping", async () => {
    for (const groupBy of GROUPINGS) {
      for (const filter of FILTERS) {
        for (const [what, value] of Object.entries(OUTSIDE)) {
          const res = await totals(`groupBy=${groupBy}&${NOVEMBER}&${filter}=${value}`);
          expect({ groupBy, filter, what, status: res.status, field: res.json?.field }).toEqual({ groupBy, filter, what, status: 400, field: filter });
        }
      }
    }
    // A malformed `dealId` above all: it is 400, never forwarded to meetings-api, whose 422 would read as the AC-4.11 503.
    expect(hosts.callsTo("meetings.system-hosts")).toEqual([]);
    expect(hosts.calls).toEqual([]);
  });

  it("for each of the filter ids sent twice, even the same value twice", async () => {
    for (const filter of FILTERS) {
      expectInvalid(await totals(`groupBy=day&${NOVEMBER}&${filter}=a&${filter}=b`), filter);
      expectInvalid(await totals(`groupBy=day&${NOVEMBER}&${filter}=a&${filter}=a`), filter);
    }
    expect(hosts.calls).toEqual([]);
  });

  it("takes an id of exactly 64 characters, and one holding what only needs escaping", async () => {
    // A well-formed `dealId` is asked of meetings-api; the fake answers it, with no meeting linked, as the real one does.
    for (const filter of FILTERS) {
      expect((await totals(`groupBy=day&${NOVEMBER}&${filter}=${"x".repeat(64)}`)).status).toBe(200);
      expect((await totals(`groupBy=day&${NOVEMBER}&${filter}=${encodeURIComponent("a&b#c+d%e f")}`)).status).toBe(200);
    }
    expect(hosts.callsTo("meetings.system-hosts").map((recorded) => recorded.query.get("dealId"))).toEqual(["x".repeat(64), "a&b#c+d%e f"]);
  });

  it("refuses a target that is not one of the four, and a whose that is not mine or all", async () => {
    expectInvalid(await totals(`groupBy=day&${NOVEMBER}&target=meetings`), "target");
    expectInvalid(await totals(`groupBy=day&${NOVEMBER}&target=`), "target");
    expectInvalid(await totals(`groupBy=day&${NOVEMBER}&target=project&target=deal`), "target");
    expectInvalid(await totals(`groupBy=day&${NOVEMBER}&whose=everyone`), "whose");
    expectInvalid(await totals(`groupBy=day&${NOVEMBER}&whose=`), "whose");
    expect(hosts.calls).toEqual([]);
  });
});

describe("whose and userId (AC-4.2; oversight is T19's)", () => {
  it("refuses a userId without whose=all, naming it, even one's own and before any other check", async () => {
    expectInvalid(await totals(`groupBy=person&${NOVEMBER}&userId=${ALICE}`), "userId");
    expectInvalid(await totals(`groupBy=person&${NOVEMBER}&whose=mine&userId=${BOB}`), "userId");
    expect(hosts.calls).toEqual([]);
  });

  it("checks a userId against the id rule before anything else is done with it", async () => {
    for (const userId of ["", "x".repeat(65), "%00", "a%2Cb", "%20a"]) {
      expectInvalid(await totals(`groupBy=person&${NOVEMBER}&whose=all&userId=${userId}`), "userId");
    }
    expect(hosts.calls).toEqual([]);
  });

  it("does not serve whose=all yet, as the list does not: nobody's rows but the caller's leave, and no other service is asked", async () => {
    await makeNoEntityEntry(SEED.categories.training, { userId: BOB, day: "2026-11-05", minutes: 60 });

    for (const query of [`groupBy=person&${NOVEMBER}&whose=all`, `groupBy=person&${NOVEMBER}&whose=all&userId=${BOB}`, `groupBy=day&${NOVEMBER}&whose=all&dealId=d1`]) {
      const res = await totals(query);
      expect(res.status).toBe(501);
      expect(res.json).toMatchObject({ code: "not_implemented" });
      expect(res.json).not.toHaveProperty("groups");
      expect(res.json).not.toHaveProperty("totalMinutes");
    }
    expect(hosts.calls).toEqual([]);
  });
});

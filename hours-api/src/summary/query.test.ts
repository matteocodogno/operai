/**
 * What `GET /time-entries/summary` accepts (specs/20261112-project-hours T9; plan § API contracts "Query (`.strict()`)"): exactly one of `projectId` and `dealId`, the window
 * both-or-neither and only with a project, real calendar days, `windowFrom` not after `windowTo`, no member the route does not know. Every refusal is a 400 `invalid_request`
 * naming the member, decided from the request alone: nobody is asked — not the record's owner, not meetings-api, not `auth` — and the id space says nothing about what exists.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, call, makeProjectEntry, resetWorld, type PersonaName } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import { __resetOversightCacheForTests } from "../oversight/oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  __resetOversightCacheForTests();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

const summary = (query: string, as: PersonaName | null = "alice") => call("GET", `/time-entries/summary${query === "" ? "" : `?${query}`}`, { as });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expectInvalid = (res: { status: number; json: any }, field: string) => {
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ status: 400, code: "invalid_request", field });
};

describe("exactly one record: projectId or dealId (plan § API contracts)", () => {
  it("is a 400 naming projectId for a query that names none", async () => {
    expectInvalid(await summary(""), "projectId");
    expectInvalid(await summary("windowFrom=2026-01-01&windowTo=2026-12-31"), "projectId");
  });

  it("is a 400 naming dealId for a query that names both", async () => {
    expectInvalid(await summary("projectId=p1&dealId=d1"), "dealId");
  });

  it("asks nobody for any of them", async () => {
    await summary("");
    await summary("projectId=p1&dealId=d1");

    expect(hosts.calls).toEqual([]);
  });

  it("takes a project or a deal alone", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });
    hosts.crm.setDeal("d1", { label: "Deal one" });

    expect((await summary("projectId=p1")).status).toBe(200);
    expect((await summary("dealId=d1")).status).toBe(200);
  });
});

describe("a member the route does not know is a 400, never ignored (`.strict()`)", () => {
  it.each(["whose=all", "userId=user-bob", "from=2026-11-01&to=2026-11-30", "limit=5", "cursor=abc", "groupBy=person", "projectID=p1", "windowfrom=2026-01-01", "x=1"])(
    "%s",
    async (extra) => {
      const res = await summary(`projectId=p1&${extra}`);

      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ status: 400, code: "invalid_request" });
      expect(hosts.calls).toEqual([]);
    },
  );
});

describe("an id outside the id rule is a 400 naming it, and nobody is asked (plan § Entries, 'The id rule')", () => {
  const OUTSIDE: Record<string, string> = {
    "empty": "",
    "65 characters": "x".repeat(65),
    "a NUL": "%00",
    "a NUL inside": "a%00b",
    "a comma": "a%2Cb",
    "a space in front": "%20a",
    "a space behind": "a%20",
    "spaces only": "%20%20",
    "a tab behind": "a%09",
  };

  it("for each of the two ids: empty, 65 characters, a NUL, a comma, a space at either end", async () => {
    for (const member of ["projectId", "dealId"]) {
      for (const [what, value] of Object.entries(OUTSIDE)) {
        const res = await summary(`${member}=${value}`);
        expect({ member, what, status: res.status, field: res.json?.field }).toEqual({ member, what, status: 400, field: member });
      }
    }
    expect(hosts.calls).toEqual([]);
  });

  it("for each of the two ids sent twice, even the same value twice", async () => {
    for (const member of ["projectId", "dealId"]) {
      expectInvalid(await summary(`${member}=a&${member}=b`), member);
      expectInvalid(await summary(`${member}=a&${member}=a`), member);
    }
    expect(hosts.calls).toEqual([]);
  });

  it("takes an id of exactly 64 characters, and one holding what only needs escaping, to the owner as it is", async () => {
    expect((await summary(`projectId=${"x".repeat(64)}`)).status).toBe(404);
    expect((await summary(`dealId=${encodeURIComponent("a&b#c+d%e f")}`)).status).toBe(404);

    expect(hosts.callsTo("projects.resolve")[0]?.body).toEqual({ entityType: "project", ids: ["x".repeat(64)] });
    expect(hosts.callsTo("crm.resolve")[0]?.body).toEqual({ entityType: "deal", ids: ["a&b#c+d%e f"] });
  });
});

describe("the window: both ends or neither, only for a project, real days, in order (plan § API contracts)", () => {
  it("is a 400 naming windowTo for a window with only a start, and windowFrom for one with only an end", async () => {
    expectInvalid(await summary("projectId=p1&windowFrom=2026-01-01"), "windowTo");
    expectInvalid(await summary("projectId=p1&windowTo=2026-12-31"), "windowFrom");
  });

  it("is a 400 naming windowFrom for a window on a deal, whole or in part: only a project has a package period", async () => {
    expectInvalid(await summary("dealId=d1&windowFrom=2026-01-01&windowTo=2026-12-31"), "windowFrom");
    expectInvalid(await summary("dealId=d1&windowFrom=2026-01-01"), "windowTo");
    expectInvalid(await summary("dealId=d1&windowTo=2026-12-31"), "windowFrom");
  });

  it("is a 400 naming windowTo for a window that ends before it begins, and takes one that begins and ends the same day", async () => {
    hosts.projects.setProject("p1", { label: "Alpha" });

    expectInvalid(await summary("projectId=p1&windowFrom=2026-12-31&windowTo=2026-01-01"), "windowTo");
    expectInvalid(await summary("projectId=p1&windowFrom=2026-06-02&windowTo=2026-06-01"), "windowTo");
    expect((await summary("projectId=p1&windowFrom=2026-06-01&windowTo=2026-06-01")).status).toBe(200);
  });

  it("is a 400 naming the member for a day that is not a real calendar day from 2000-01-01", async () => {
    for (const member of ["windowFrom", "windowTo"]) {
      for (const day of ["2026-02-30", "2026-13-01", "1999-12-31", "2026-1-1", "tomorrow", "20260101", "2026-01-01T00:00:00Z", ""]) {
        const other = member === "windowFrom" ? "windowTo=2026-12-31" : "windowFrom=2000-01-01";
        const res = await summary(`projectId=p1&${member}=${encodeURIComponent(day)}&${other}`);
        expect({ member, day, status: res.status, field: res.json?.field }).toEqual({ member, day, status: 400, field: member });
      }
    }
  });

  it("is a 400 for a window member sent twice", async () => {
    expectInvalid(await summary("projectId=p1&windowFrom=2026-01-01&windowFrom=2026-01-02&windowTo=2026-12-31"), "windowFrom");
  });

  it("asks nobody for any of them, and the record's owner is not asked about a request that is malformed", async () => {
    hosts.projects.setReader(PERSONAS.alice.sub, false);
    await makeProjectEntry("p1", { minutes: 60 });

    // A project nobody may read is a 404 for a well-formed question and a 400 for a malformed one: the shape is judged first.
    expectInvalid(await summary("projectId=p1&windowFrom=2026-01-01"), "windowTo");
    expect(hosts.calls).toEqual([]);
    expect((await summary("projectId=p1")).status).toBe(404);
  });
});

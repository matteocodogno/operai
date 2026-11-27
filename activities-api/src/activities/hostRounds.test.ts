/**
 * How many SEQUENTIAL host calls one list request makes to ONE host (specs/20261126-teams R13 b, ADR 20261119-on-demand-outbound-work-...,
 * rule 7). hours-api waits `RELAYED_OWNER_TIMEOUT_MS` for `GET /activities?ids=` and `?dealId=`, which is
 * `LIST_HOST_ROUNDS × RESOLVE_TIMEOUT_MS + NAMES_WAIT_MS + margin`; `LIST_HOST_ROUNDS` is descriptive, and THIS file is what ties it
 * to the code: a third sequential round fails here, and raising the constant fails
 * `hours-api/src/clients/owners.budgets.cross-package.test.ts` until hours-api's wait moves with it.
 *
 *   ?ids= (≤ 50)     ceil(50 / 25) = 2 calls to a host that owns all of them; the hosts themselves are asked in parallel
 *   ?dealId= (a page) the deal's company (round 1), then, in `toViews`, that company with the page's related contacts and deal (round 2)
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { LIST_HOST_ROUNDS, RESOLVE_BATCH_SIZE } from "../hosts/client";
import { call, db, hosts, makeCompany, makeDeal, makeProject, resetWorld } from "../test-support/world";

beforeEach(resetWorld);

const byIds = (ids: readonly string[]) => call("GET", `/activities?ids=${ids.join(",")}`, { as: "bob" });

const rawNote = (companyId: string, subject: string, extra: { dealId?: string; contactId?: string } = {}) =>
  db.activity.create({
    data: { kind: "pre_sales", type: "note", hostApp: "crm", hostType: "company", hostId: companyId, subject, occurredAt: new Date(), authorUserId: "user-consultant", ...extra },
  });

const rawTask = (projectId: string, subject: string) =>
  db.activity.create({
    data: { kind: "operational", type: "task", hostApp: "projects", hostType: "project", hostId: projectId, subject, occurredAt: new Date(), authorUserId: "user-manager", assigneeUserId: "user-pm" },
  });

const reset = () => {
  hosts.crm.resolves.length = 0;
  hosts.projects.resolves.length = 0;
};

describe("the constant", () => {
  it("is 2 and a host call takes 25 ids", () => {
    expect(LIST_HOST_ROUNDS).toBe(2);
    expect(RESOLVE_BATCH_SIZE).toBe(25);
  });
});

describe("GET /activities?ids= (R13 b)", () => {
  it("50 ids over 50 projects are exactly 2 sequential calls to the projects host, and none to the CRM", async () => {
    const rows = await Promise.all(Array.from({ length: 50 }, (_, i) => rawTask(makeProject(`Project ${i}`).id, `Task ${i}`)));
    reset();
    hosts.projects.mode = { delayMs: 120 };

    const started = Date.now();
    const res = await byIds(rows.map((r) => r.id));
    const took = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(50);
    expect(hosts.projects.resolves).toHaveLength(2);
    expect(hosts.projects.resolves.map((r) => r.body.ids.length)).toEqual([25, 25]);
    expect(hosts.crm.resolves).toHaveLength(0);
    expect(hosts.projects.resolves.length).toBeLessThanOrEqual(LIST_HOST_ROUNDS);
    expect(took).toBeGreaterThanOrEqual(2 * 120 - 10); // the two calls are in sequence: the round count is real time
  });

  it("25 ids are one call", async () => {
    const rows = await Promise.all(Array.from({ length: 25 }, (_, i) => rawTask(makeProject(`Project ${i}`).id, `Task ${i}`)));
    reset();
    const res = await byIds(rows.map((r) => r.id));
    expect(res.json.items).toHaveLength(25);
    expect(hosts.projects.resolves).toHaveLength(1);
  });

  it("the two hosts are asked in parallel: 25 projects and 25 companies take one round of time, not two", async () => {
    const tasks = await Promise.all(Array.from({ length: 25 }, (_, i) => rawTask(makeProject(`Project ${i}`).id, `Task ${i}`)));
    const notes = await Promise.all(Array.from({ length: 25 }, (_, i) => rawNote(makeCompany(`Company ${i}`).id, `Note ${i}`)));
    reset();
    hosts.projects.mode = { delayMs: 200 };
    hosts.crm.mode = { delayMs: 200 };

    const started = Date.now();
    const res = await byIds([...tasks, ...notes].map((r) => r.id));
    const took = Date.now() - started;

    expect(res.json.items).toHaveLength(50);
    expect(hosts.projects.resolves).toHaveLength(1);
    expect(hosts.crm.resolves).toHaveLength(1);
    expect(took).toBeLessThan(2 * 200); // in sequence it would be 400 ms and more
  });

  it("50 CRM activities, each with its own deal, are 2 calls to the CRM: the related ids ride in the same calls, never a third round", async () => {
    const rows = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const company = makeCompany(`Company ${i}`);
        const deal = makeDeal(company.id, `Deal ${i}`);
        return rawNote(company.id, `Note ${i}`, { dealId: deal.id });
      }),
    );
    reset();
    const res = await byIds(rows.map((r) => r.id));
    expect(res.json.items).toHaveLength(50);
    expect(hosts.crm.resolves).toHaveLength(2);
    expect(hosts.crm.resolves.length).toBeLessThanOrEqual(LIST_HOST_ROUNDS);
    expect(res.json.items.every((item: { deal: { title: string } | null }) => item.deal !== null)).toBe(true);
  });
});

describe("GET /activities?dealId= (R13 b)", () => {
  it("a page is exactly 2 sequential calls to the CRM: the deal's company, then the company with the page's related records", async () => {
    const company = makeCompany();
    const deal = makeDeal(company.id, "Grid analytics");
    await Promise.all(Array.from({ length: 100 }, (_, i) => rawNote(company.id, `Note ${i}`, { dealId: deal.id })));
    reset();
    hosts.crm.mode = { delayMs: 120 };

    const started = Date.now();
    const res = await call("GET", `/activities?dealId=${deal.id}&pageSize=100`, { as: "bob" });
    const took = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(100);
    expect(hosts.crm.resolves).toHaveLength(2);
    expect(hosts.crm.resolves.length).toBeLessThanOrEqual(LIST_HOST_ROUNDS);
    expect(hosts.crm.resolves[0]!.body.related ?? {}).toEqual({}); // round 1: may the caller read the company?
    expect(hosts.crm.resolves[1]!.body.related).toEqual({ deal: [deal.id] }); // round 2: the labels of the page's records
    expect(hosts.projects.resolves).toHaveLength(0);
    expect(took).toBeGreaterThanOrEqual(2 * 120 - 10);
  });
});

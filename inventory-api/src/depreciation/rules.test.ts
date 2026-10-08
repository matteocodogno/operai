/**
 * Depreciation rules (T10, specs/015-hardware-inventory; AC-6.1..6.5).
 * Real router + real middleware over the shared harness, real Postgres.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";
import { truncateInventoryTables } from "../test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("../lib/db");
const { handleProblemError } = await import("../lib/problem");
const { rulesRouter } = await import("./rules.routes");
const { resolveRule } = await import("./resolveRule");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");

const app = new OpenAPIHono();
app.route("/", rulesRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.json({ error: String(err) }, 500));

const ENTITY: ResolvedPermission["conditions"] = {
  attributes: [{ key: "entity", match: "user" }],
};
const grant = (
  resource: string,
  action: string,
  conditions: ResolvedPermission["conditions"] = null,
): ResolvedPermission => ({ resource, action, conditions });

const resolving =
  (permissions: ResolvedPermission[], entity: string | null) => async () => ({
    sub: "u",
    epoch: 1,
    permissions,
    entity,
    jobTitle: null,
  });

let token: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeAll(async () => {
  token = await harness.signToken({ sub: "acc-1", email: "acc1@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  __resetAuthzCacheForTests();
  __resetIdentityCacheForTests();
  harness.setResolve(resolving([grant("ledger", "manage")], "welld_ch"));
  fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockImplementation((async () =>
    Response.json({ users: [{ id: "acc-1", status: "active", name: "Anna Accountant" }] })) as unknown as typeof fetch);
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await truncateInventoryTables();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const get = (path: string) => app.request(path, { headers: auth() });
const post = (body: unknown) =>
  app.request("/rules", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const valid = {
  entity: "welld_ch",
  effectiveFrom: "2031-01-01",
  usefulLifeYears: 4,
  firstYearShare: "full",
  lowValueThresholdCents: null,
  residualCents: 100,
};

type RuleBody = Record<string, unknown> & { id: string };

describe("resolveRule", () => {
  const rule = (id: string, entity: string, from: string, createdAt: string) => ({
    id,
    entity,
    effectiveFrom: new Date(`${from}T00:00:00Z`),
    createdAt: new Date(createdAt),
  });
  const rules = [
    rule("a", "welld_ch", "2000-01-01", "2026-01-01T00:00:00Z"),
    rule("b", "welld_ch", "2026-06-01", "2026-02-01T00:00:00Z"),
    rule("c", "welld_ch", "2026-06-01", "2026-03-01T00:00:00Z"),
    rule("d", "welld_it", "2000-01-01", "2026-01-01T00:00:00Z"),
  ];
  const at = (d: string) => new Date(`${d}T00:00:00Z`);

  it("is the latest effectiveFrom <= purchase date; a tie goes to the later createdAt", () => {
    expect(resolveRule(rules, "welld_ch", at("2026-05-31"))?.id).toBe("a");
    expect(resolveRule(rules, "welld_ch", at("2026-06-01"))?.id).toBe("c");
    expect(resolveRule(rules, "welld_ch", at("2040-01-01"))?.id).toBe("c");
  });
  it("only considers the asset's entity, and is null before any rule", () => {
    expect(resolveRule(rules, "welld_it", at("2026-06-01"))?.id).toBe("d");
    expect(resolveRule(rules, "welld_ch", at("1999-12-31"))).toBeNull();
  });
  it("a new rule at D changes the answer only for dates >= D", () => {
    const withNew = [...rules, rule("n", "welld_ch", "2026-09-01", "2026-09-02T00:00:00Z")];
    expect(resolveRule(withNew, "welld_ch", at("2026-08-31"))?.id).toBe("c");
    expect(resolveRule(withNew, "welld_ch", at("2026-09-01"))?.id).toBe("n");
  });
});

describe("GET /rules", () => {
  it("lists past, current and future rules with creator and time, and marks inForceId", async () => {
    await post({ ...valid, effectiveFrom: "2031-01-01" });
    const res = await get("/rules?entity=welld_ch");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: RuleBody[]; inForceId: string };
    expect(body.rules).toHaveLength(2);
    const [future, launch] = body.rules as [RuleBody, RuleBody];
    expect(future["effectiveFrom"]).toBe("2031-01-01");
    expect(future["createdBy"]).toEqual({ id: "acc-1", name: "Anna Accountant", status: "active" });
    expect(typeof future["createdAt"]).toBe("string");
    expect(launch["effectiveFrom"]).toBe("2000-01-01");
    expect(launch["createdBy"]).toEqual({ id: "system:launch-seed", name: null, status: "system" });
    // The future rule is not in force yet; the launch rule is.
    expect(body.inForceId).toBe(launch.id);
    expect(body.inForceId).not.toBe(future.id);
  });

  it("a rule effective today or earlier supersedes the launch rule as in force", async () => {
    const created = (await (await post({ ...valid, effectiveFrom: "2026-01-01" })).json()) as RuleBody;
    const body = (await (await get("/rules?entity=welld_ch")).json()) as { inForceId: string };
    expect(body.inForceId).toBe(created.id);
  });

  it("only lists the requested entity", async () => {
    harness.setResolve(resolving([grant("ledger", "manage")], "welld_ch"));
    const body = (await (await get("/rules?entity=welld_it")).json()) as { rules: RuleBody[] };
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.["entity"]).toBe("welld_it");
  });

  it("requires the entity query parameter (422 naming it)", async () => {
    const res = await get("/rules");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { field: string }).field).toBe("entity");
  });

  it("out-of-scope entity -> 404", async () => {
    harness.setResolve(resolving([grant("ledger", "manage", ENTITY)], "welld_ch"));
    expect((await get("/rules?entity=welld_it")).status).toBe(404);
    expect((await get("/rules?entity=welld_ch")).status).toBe(200);
  });

  it("asset:manage-only caller -> 403; no capability -> 403", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], "welld_ch"));
    expect((await get("/rules?entity=welld_ch")).status).toBe(403);
    __resetAuthzCacheForTests();
    harness.setResolve(resolving([], "welld_ch"));
    expect((await get("/rules?entity=welld_ch")).status).toBe(403);
  });

  it("no token -> 401", async () => {
    expect((await app.request("/rules?entity=welld_ch")).status).toBe(401);
  });
});

describe("POST /rules", () => {
  it("creates a rule, records actor and time, and returns 201 with the Rule shape", async () => {
    const res = await post(valid);
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuleBody;
    expect(body).toMatchObject({
      entity: "welld_ch",
      effectiveFrom: "2031-01-01",
      usefulLifeYears: 4,
      firstYearShare: "full",
      lowValueThresholdCents: null,
      residualCents: 100,
      createdBy: { id: "acc-1", status: "active" },
    });
    const row = await db.depreciationRule.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.createdByUserId).toBe("acc-1");
    expect(row.createdByEmail).toBe("acc1@welld.ch");
    expect(Date.now() - row.createdAt.getTime()).toBeLessThan(10_000);
  });

  it("accepts a zero threshold and a zero residual", async () => {
    const res = await post({ ...valid, lowValueThresholdCents: 0, residualCents: 0 });
    expect(res.status).toBe(201);
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["life 0", { usefulLifeYears: 0 }, "usefulLifeYears"],
    ["fractional life", { usefulLifeYears: 2.5 }, "usefulLifeYears"],
    ["negative threshold", { lowValueThresholdCents: -1 }, "lowValueThresholdCents"],
    ["negative residual", { residualCents: -1 }, "residualCents"],
    ["bad share", { firstYearShare: "third" }, "firstYearShare"],
    ["impossible date", { effectiveFrom: "2031-02-30" }, "effectiveFrom"],
    ["malformed date", { effectiveFrom: "01/01/2031" }, "effectiveFrom"],
    ["unknown entity", { entity: "welld_xx" }, "entity"],
  ];
  for (const [name, patch, field] of invalid) {
    it(`${name} -> 422 naming ${field}, nothing stored`, async () => {
      const res = await post({ ...valid, ...patch });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { field: string }).field).toBe(field);
      expect(await db.depreciationRule.count({ where: { effectiveFrom: new Date("2031-01-01") } })).toBe(0);
    });
  }

  it("a missing field -> 422 naming it", async () => {
    const { residualCents: _omit, ...rest } = valid;
    const res = await post(rest);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { field: string }).field).toBe("residualCents");
  });

  it("a rule effective in a closed year -> 409 fiscal_year_closed with the year", async () => {
    await db.fiscalYear.create({
      data: {
        entity: "welld_ch",
        year: 2025,
        openingCents: 0,
        disposalsCents: 0,
        purchasesCents: 0,
        depreciationCents: 0,
        closingCents: 0,
        source: "closed",
        closedByUserId: "acc-1",
      },
    });
    const res = await post({ ...valid, effectiveFrom: "2025-12-31" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; year: number };
    expect(body.code).toBe("fiscal_year_closed");
    expect(body.year).toBe(2025);
    // The first open year is accepted; the other entity is unaffected.
    expect((await post({ ...valid, effectiveFrom: "2026-01-01" })).status).toBe(201);
    expect((await post({ ...valid, entity: "welld_it", effectiveFrom: "2025-12-31" })).status).toBe(
      201,
    );
  });

  it("out-of-scope entity -> 404 and nothing stored", async () => {
    harness.setResolve(resolving([grant("ledger", "manage", ENTITY)], "welld_ch"));
    const res = await post({ ...valid, entity: "welld_it" });
    expect(res.status).toBe(404);
    expect(await db.depreciationRule.count({ where: { entity: "welld_it" } })).toBe(1);
  });

  it("asset:manage-only caller -> 403", async () => {
    harness.setResolve(resolving([grant("asset", "manage")], "welld_ch"));
    expect((await post(valid)).status).toBe(403);
  });

  it("there is no update or delete route for rules", async () => {
    const created = (await (await post(valid)).json()) as RuleBody;
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.request(`/rules/${created.id}`, { method, headers: auth() });
      expect(res.status).toBe(404);
    }
  });

  it("a new rule at D leaves earlier purchase dates on the previous rule", async () => {
    await post({ ...valid, effectiveFrom: "2031-01-01", usefulLifeYears: 9 });
    const rows = await db.depreciationRule.findMany({ where: { entity: "welld_ch" } });
    expect(resolveRule(rows, "welld_ch", new Date("2030-12-31T00:00:00Z"))?.usefulLifeYears).toBe(3);
    expect(resolveRule(rows, "welld_ch", new Date("2031-01-01T00:00:00Z"))?.usefulLifeYears).toBe(9);
  });
});

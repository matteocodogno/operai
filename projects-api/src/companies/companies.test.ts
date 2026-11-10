/**
 * `GET /companies?q=` (specs/025 T5, AC-1.1): the company picker, answered from the CRM
 * through a service credential (ADR-0080) for people who may hold no `crm:access` (D13).
 * crm-api is the fake of test-support/world.ts.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { authSystem, call, crm, resetWorld, SERVICE_JWT } from "../test-support/world";
import { serviceTokens } from "../lib/serviceToken";

beforeEach(async () => {
  await resetWorld();
  crm.companies = [
    { id: "co-acme", name: "Acme SA", entity: "welld_ch", archived: false },
    { id: "co-acmeco", name: "Acmeco Italia", entity: "welld_it", archived: false },
    { id: "co-zeta", name: "Zeta AG", entity: "welld_ch", archived: false },
    { id: "co-old", name: "Acme Legacy", entity: "welld_ch", archived: true },
  ];
});

describe("GET /companies", () => {
  it("lists the CRM's active companies matching q as { id, name, entity }, and nothing else", async () => {
    const res = await call("GET", "/companies?q=acme", { as: "pmCh" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { id: "co-acme", name: "Acme SA", entity: "welld_ch" },
        { id: "co-acmeco", name: "Acmeco Italia", entity: "welld_it" },
      ],
    });
  });

  it("reads the CRM as the service principal, never forwarding the caller's JWT", async () => {
    await call("GET", "/companies?q=zeta", { as: "pmCh" });
    expect(crm.lastAuthorization).toBe(`Bearer ${SERVICE_JWT}`);
  });

  it("needs project:manage: a reader without it is 403 `forbidden`", async () => {
    const res = await call("GET", "/companies?q=acme", { as: "viewer" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
    expect(crm.calls).toBe(0);
  });

  it("needs the module at all: no projects:access is 403 and no token is 401", async () => {
    expect((await call("GET", "/companies?q=acme", { as: "outsider" })).status).toBe(403);
    expect((await call("GET", "/companies?q=acme", { as: null })).status).toBe(401);
  });

  it("is 503 `crm_unavailable` when the CRM cannot answer", async () => {
    crm.down = true;
    const res = await call("GET", "/companies?q=acme", { as: "pmCh" });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ status: 503, code: "crm_unavailable" });
  });

  it("is 503 `crm_unavailable` when auth cannot mint the service token", async () => {
    serviceTokens!.invalidate(SERVICE_JWT); // the provider caches a token for minutes; start without one
    authSystem.down = true;
    const res = await call("GET", "/companies?q=acme", { as: "pmCh" });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ code: "crm_unavailable" });
  });

  it("forgets a service token the CRM rejects (401), so the next lookup mints a fresh one", async () => {
    const getToken = spyOn(serviceTokens!, "getToken").mockResolvedValueOnce("stale-token");
    const invalidate = spyOn(serviceTokens!, "invalidate");
    const first = await call("GET", "/companies?q=acme", { as: "pmCh" });
    expect(first.status).toBe(503);
    expect(invalidate).toHaveBeenCalledWith("stale-token");
    getToken.mockRestore();
    invalidate.mockRestore();
    expect((await call("GET", "/companies?q=acme", { as: "pmCh" })).status).toBe(200);
  });

  it("rejects an over-long q with 400 `validation_failed`", async () => {
    const res = await call("GET", `/companies?q=${"a".repeat(201)}`, { as: "pmCh" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "validation_failed" });
  });
});

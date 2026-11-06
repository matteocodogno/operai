/**
 * The deal page's "Delivery" read (specs/022 T10, AC-3.4): `GET /deals/{id}` gains
 * `delivery: { project: { id, name }, bexioOrderId } | null` and `deliveryKnown`, read live from
 * projects-api with crm-api's own service credential, so a CRM user without `projects:access` sees
 * it. It FAILS SOFT: projects-api down or not configured, the deal still loads (`deliveryKnown:
 * false`). projects-api is a fake over the network seam of `lib/projects.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { call, makeCompany, makeDeal, resetWorld } from "../test-support/world";
import { createProjectsReader, setProjectsReaderForTests } from "../lib/projects";
import type { ServiceTokenProvider } from "../lib/serviceToken";

/** A fake projects-api: the purchase orders it holds, by deal id, and a switch for an outage. */
const projectsApi = {
  purchaseOrders: new Map<string, { project: { id: string; name: string }; bexioOrderId: string | null }>(),
  down: false,
  calls: [] as { url: string; authorization: string | null }[],
};

const tokens: ServiceTokenProvider = { getToken: async () => "service-jwt", invalidate: () => {} };

const fetchImpl = (async (url: unknown, init?: RequestInit) => {
  const target = new URL(String(url));
  projectsApi.calls.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
  if (projectsApi.down) return new Response("down", { status: 503 });
  const dealIds = (target.searchParams.get("dealIds") ?? "").split(",");
  const items = dealIds.flatMap((dealId) => {
    const purchaseOrder = projectsApi.purchaseOrders.get(dealId);
    return purchaseOrder ? [{ dealId, purchaseOrderId: `purchase-order-of-${dealId}`, ...purchaseOrder }] : [];
  });
  return Response.json({ items });
}) as typeof fetch;

beforeEach(async () => {
  await resetWorld();
  projectsApi.purchaseOrders.clear();
  projectsApi.down = false;
  projectsApi.calls = [];
  setProjectsReaderForTests(createProjectsReader({ baseUrl: "http://projects.test", tokens, fetchImpl }));
});
afterEach(() => setProjectsReaderForTests(undefined));

const newDeal = async () => makeDeal((await makeCompany()).id);

describe("GET /deals/{id} — delivery (AC-3.4)", () => {
  it("shows the project's name and the purchase order's Bexio order id for a deal projects-api knows", async () => {
    const deal = await newDeal();
    projectsApi.purchaseOrders.set(deal.id, { project: { id: "project-1", name: "Koordy" }, bexioOrderId: "BX-1001" });

    const res = await call("GET", `/deals/${deal.id}`, { as: "consultant" });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: deal.id,
      delivery: { project: { id: "project-1", name: "Koordy" }, bexioOrderId: "BX-1001" },
      deliveryKnown: true,
    });
    expect(projectsApi.calls).toEqual([{ url: `http://projects.test/system/purchase-orders?dealIds=${deal.id}`, authorization: "Bearer service-jwt" }]);
  });

  it("keeps the Bexio order id empty when accounting has not typed one yet", async () => {
    const deal = await newDeal();
    projectsApi.purchaseOrders.set(deal.id, { project: { id: "project-1", name: "Koordy" }, bexioOrderId: null });
    const res = await call("GET", `/deals/${deal.id}`);
    expect(res.json).toMatchObject({ delivery: { bexioOrderId: null }, deliveryKnown: true });
  });

  it("says `delivery: null` with `deliveryKnown: true` for a deal no project carries", async () => {
    const deal = await newDeal();
    const res = await call("GET", `/deals/${deal.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ delivery: null, deliveryKnown: true });
  });

  it("still loads the deal, with `deliveryKnown: false`, when projects-api is down", async () => {
    const deal = await newDeal();
    projectsApi.purchaseOrders.set(deal.id, { project: { id: "project-1", name: "Koordy" }, bexioOrderId: "BX-1001" });
    projectsApi.down = true;
    const res = await call("GET", `/deals/${deal.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: deal.id, title: deal.title, delivery: null, deliveryKnown: false });
  });

  it("still loads the deal, with `deliveryKnown: false`, when projects-api is not configured", async () => {
    setProjectsReaderForTests(null); // PROJECTS_INTERNAL_URL / SERVICE_CLIENT_* unset
    const deal = await newDeal();
    const res = await call("GET", `/deals/${deal.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ delivery: null, deliveryKnown: false });
    expect(projectsApi.calls).toEqual([]);
  });

  it("is not configured by default under test, so no test ever calls a real projects-api", async () => {
    setProjectsReaderForTests(undefined);
    const deal = await newDeal();
    const res = await call("GET", `/deals/${deal.id}`);
    expect(res.json).toMatchObject({ delivery: null, deliveryKnown: false });
  });

  it("answers 404 for an unknown deal without asking projects-api", async () => {
    const res = await call("GET", "/deals/no-such-deal");
    expect(res.status).toBe(404);
    expect(projectsApi.calls).toEqual([]);
  });

  it("leaves the other deal routes' views as they were: delivery is the deal page's alone", async () => {
    const deal = await newDeal();
    const list = await call("GET", "/deals");
    expect(list.json.items[0]).not.toHaveProperty("delivery");
    const moved = await call("PATCH", `/deals/${deal.id}`, { ifMatch: 1, body: { title: "Renamed" } });
    expect(moved.status).toBe(200);
    expect(moved.json).not.toHaveProperty("delivery");
    expect(projectsApi.calls).toEqual([]);
  });
});

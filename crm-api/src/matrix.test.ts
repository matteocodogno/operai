/**
 * Authorization matrix over the ASSEMBLED app (specs/017-crm AC-5.1): every
 * route the app serves, except `/health` and the API docs, refuses a missing
 * token with 401 and a caller without `crm:access` with 403 — before any
 * validation or lookup. The route list is read from the app's own table, so a
 * route added without the guard fails here. A `/system` route takes a service
 * credential only (ADR-0073): every user token there is a 401.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { app, call, resetWorld } from "./test-support/world";

beforeEach(resetWorld);

const PUBLIC = new Set(["GET /health", "GET /openapi.json", "GET /docs"]);

// The meeting-host contract (specs/021, ADR-0059) is the one deliberate exception to "403 without
// crm:access": `resolve` answers a caller without it `closed`/`missing` (a 200). Each exception is
// asserted below by name instead of by the generic rule, and the list is pinned, so another route
// cannot hide here.
const HOST_CONTRACT = new Set(["POST /meeting-host/v1/resolve"]);

const routes = [
  ...new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  ),
].filter((key) => !PUBLIC.has(key) && !HOST_CONTRACT.has(key));
const allRoutes = [...new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`))];
const isSystem = (key: string) => key.split(" ")[1]!.startsWith("/system/");
const userRoutes = routes.filter((key) => !isSystem(key));
const systemRoutes = routes.filter(isSystem);

const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, "some-id");

describe("authorization matrix", () => {
  it("covers the routes of every group", () => {
    for (const expected of [
      "GET /scope",
      "POST /companies",
      "DELETE /contacts/:id",
      "GET /pipeline",
      "GET /tasks",
      // specs/020
      "GET /offer-templates",
      "GET /offer-templates/:id",
      "POST /offer-templates",
      "POST /offer-templates/:id/duplicate",
      "PUT /offer-templates/:id",
      "POST /offer-templates/:id/archive",
      "POST /offer-templates/:id/restore",
      "GET /deals/:id/offers/draft",
      "POST /entity-profiles/:entity/letterhead",
      "POST /entity-profiles/:entity/letterhead/confirm",
      "GET /entity-profiles/:entity/letterhead",
      // specs/018 AC-3.3
      "POST /system/estimate-notices",
    ]) {
      expect(routes).toContain(expected);
    }
  });

  it.each(systemRoutes)("%s: 401 without a token and for any user token", async (key) => {
    const [method, path] = key.split(" ") as [string, string];
    expect((await call(method, concrete(path), { as: null, body: {} })).status).toBe(401);
    expect((await call(method, concrete(path), { as: "admin", body: {} })).status).toBe(401);
  });

  it.each(userRoutes)("%s: 401 without a token, 403 without crm:access", async (key) => {
    const [method, path] = key.split(" ") as [string, string];
    const body = method === "GET" || method === "DELETE" ? undefined : {};
    expect((await call(method, concrete(path), { as: null, body })).status).toBe(401);
    expect((await call(method, concrete(path), { as: "outsider", body, ifMatch: 1 })).status).toBe(403);
  });

  it("the host-contract exceptions are exactly the listed routes, and each is mounted", () => {
    for (const key of HOST_CONTRACT) expect(allRoutes).toContain(key);
    expect(allRoutes.filter((key) => key.includes("meeting-host"))).toHaveLength(HOST_CONTRACT.size);
  });

  it("POST /meeting-host/v1/resolve: 401 without a token, a 200 `closed` (not 403) without crm:access", async () => {
    const body = { entityType: "deal", ids: ["some-id"] };
    expect((await call("POST", "/meeting-host/v1/resolve", { as: null, body })).status).toBe(401);
    const res = await call("POST", "/meeting-host/v1/resolve", { as: "outsider", body });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [{ id: "some-id", state: "missing" }] });
  });

  it("GET /scope reports deal entities and erase per persona", async () => {
    expect((await call("GET", "/scope", { as: "consultant" })).json).toEqual({ deal: [], canErase: false, financials: false, managesAll: false });
    expect((await call("GET", "/scope", { as: "salesCh" })).json).toEqual({ deal: ["welld_ch"], canErase: false, financials: true, managesAll: false });
    expect((await call("GET", "/scope", { as: "admin" })).json).toEqual({
      deal: ["welld_ch", "welld_it"],
      canErase: true,
      financials: true,
      managesAll: true,
    });
  });
});

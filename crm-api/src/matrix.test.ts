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

// `GET /system/companies` (specs/021), `GET /system/deals` and `GET /system/contacts` (specs/022)
// are guarded by a scoped SERVICE credential, not by user capabilities; their own 401 matrices
// live in src/system/companies.routes.test.ts, src/system/deals.routes.test.ts and
// src/system/contacts.routes.test.ts.
const PUBLIC = new Set([
  "GET /health",
  "GET /openapi.json",
  "GET /docs",
  "GET /system/companies",
  "GET /system/deals",
  "GET /system/contacts",
]);

const routes = [
  ...new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  ),
].filter((key) => !PUBLIC.has(key));
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

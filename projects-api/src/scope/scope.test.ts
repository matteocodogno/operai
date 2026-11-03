/** AC-4.1–4.6 as the UI reads them: `GET /scope` says what the caller may manage. */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, resetWorld } from "../test-support/world";

beforeEach(resetWorld);

describe("GET /scope", () => {
  it("is 401 without a token", async () => {
    const res = await call("GET", "/scope", { as: null });
    expect(res.status).toBe(401);
  });

  it("is 403 `forbidden` without projects:access (AC-4.2)", async () => {
    const res = await call("GET", "/scope", { as: "outsider" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("gives a reader no manage scope and no Bexio (AC-4.3)", async () => {
    const res = await call("GET", "/scope", { as: "viewer" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ manage: [], managesAll: false, bexio: false });
  });

  it("scopes a project manager to their own entity (AC-4.4)", async () => {
    const res = await call("GET", "/scope", { as: "pmCh" });
    expect(res.json).toEqual({ manage: ["welld_ch"], managesAll: false, bexio: false });
  });

  it("scopes sales to its own entity too (AC-4.4)", async () => {
    const res = await call("GET", "/scope", { as: "salesIt" });
    expect(res.json).toEqual({ manage: ["welld_it"], managesAll: false, bexio: false });
  });

  it("gives accounting the Bexio capability and nothing to manage (AC-4.5)", async () => {
    const res = await call("GET", "/scope", { as: "accounting" });
    expect(res.json).toEqual({ manage: [], managesAll: false, bexio: true });
  });

  it("gives an admin every entity and the Bexio capability (AC-4.6)", async () => {
    const res = await call("GET", "/scope", { as: "admin" });
    expect(res.json).toEqual({ manage: ["welld_ch", "welld_it"], managesAll: true, bexio: true });
  });
});

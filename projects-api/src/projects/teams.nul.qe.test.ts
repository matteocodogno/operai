/**
 * QE probe (specs/20261126-teams, qe-report.md): a text id that carries a NUL character must be refused 4xx on every team
 * surface, never reach Postgres (which cannot hold U+0000 in text and raises -> 500). The assembled app, `*_test` database.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, db, resetWorld } from "../test-support/world";

beforeEach(resetWorld);

const seed = () =>
  db.project.create({
    data: { name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
  });

describe("NUL in a team id never becomes a 5xx", () => {
  it("GET /projects?teamId=<NUL> is a 4xx, not a 500", async () => {
    await seed();
    const res = await call("GET", `/projects?teamId=${encodeURIComponent("a\u0000b")}`, { as: "viewer" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("PUT /projects/{id}/teams with a NUL team id is a 4xx, not a 500", async () => {
    const project = await seed();
    const res = await call("PUT", `/projects/${project.id}/teams`, {
      as: "pmCh",
      body: { teamIds: ["a\u0000b"] },
      ifMatch: 1,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

/**
 * A NUL in a text id is a 400 `validation_failed` on every route that takes one through the shared `IdSchema`, and never echoes
 * the input (specs/20261126-teams, QE D1). Postgres text cannot hold U+0000, so without this it would be a 500.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { authSystem, call, db, identities, resetWorld, teamsAuth } from "../test-support/world";

beforeEach(resetWorld);

const NUL = "zz\u0000qq";
const enc = encodeURIComponent(NUL);

/** 400 `validation_failed`, no value in the body (sentinel) and no call to auth. */
const expectRefused = (res: { status: number; json: { code?: string; instance?: string } }) => {
  expect(res.status).toBe(400);
  expect(res.json.code).toBe("validation_failed");
  // `instance` is the request path by RFC 7807 convention (every error carries it); detail and errors never repeat the value.
  const { instance: _instance, ...rest } = res.json as Record<string, unknown>;
  expect(JSON.stringify(rest)).not.toContain("zz");
  expect(teamsAuth.calls).toBe(0);
  expect(identities.calls).toBe(0);
  expect(authSystem.tokenCalls).toBe(0);
};

describe("NUL in an id is a 400", () => {
  it("GET /projects?teamId=", async () => expectRefused(await call("GET", `/projects?teamId=${enc}`, { as: "viewer" })));
  it("GET /projects?projectManagerId=", async () =>
    expectRefused(await call("GET", `/projects?projectManagerId=${enc}`, { as: "viewer" })));
  it("GET /projects/{id}", async () => expectRefused(await call("GET", `/projects/${enc}`, { as: "viewer" })));

  it("PUT /projects/{id}/teams with a NUL team id", async () => {
    const project = await db.project.create({
      data: { name: "Koordy", type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" },
    });
    expectRefused(await call("PUT", `/projects/${project.id}/teams`, { as: "pmCh", body: { teamIds: [NUL] }, ifMatch: 1 }));
    expect(await db.attachedTeam.count()).toBe(0);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).version).toBe(project.version);
  });

  it("a clean id still passes validation (the project is simply not found)", async () => {
    const res = await call("GET", "/projects/nope", { as: "viewer" });
    expect(res.status).toBe(404);
  });
});

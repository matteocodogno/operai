/**
 * `auth` is down (specs/021-meetings T42; AC-10.6, AC-10.4, ADR-0058): `GET /authz/resolve` fails
 * for every request. Over the assembled app and the SAME route table as the matrix:
 *
 *   - a route that needs no capability (`selfScoped`, plus the creator's own deletions) keeps
 *     answering a creator and a participant EXACTLY as it does when `auth` is up;
 *   - every route that needs a capability answers 503 `authorization_unavailable`, never an
 *     allow and never a 403 that would pass a missing grant off as a refusal;
 *   - the meeting says so (`capabilities: "unavailable"`) and withholds every control that needs
 *     a grant, while deleting your own data stays offered;
 *   - a host reader (who is vouched for only live, with `meetings:access`) is a stranger: fail closed;
 *   - nobody is let in without a token, and the first request after `auth` is back works again.
 */

import { describe, expect, it } from "bun:test";
import { createKit } from "./test-support/routeKit";
import { ROWS, SPECS, kindsOf, rowName, seedWorld, type Persona, type RouteRow } from "./test-support/matrixKit";

const kit = await createKit();

const outcome = async (row: RouteRow, persona: Persona, authDown: boolean) => {
  const world = await seedWorld(kit, persona, kindsOf(row));
  if (authDown) kit.setAuthDown(true);
  const [method] = row.route.split(" ") as [string];
  const res = await kit.call(SPECS[persona].caller, method, row.path(world), row.body?.(world), row.headers);
  const body = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
  return { status: res.status, code: typeof body?.["code"] === "string" ? body["code"] : undefined, body };
};

describe("self-scoped routes keep working without auth (AC-10.6)", () => {
  const serving = ROWS.filter((row) => row.outage === "serves");

  it("pins which routes are self-scoped, so a new one has to choose", () => {
    expect(serving.map(rowName).sort()).toEqual(
      [
        "DELETE /meetings/:id",
        "DELETE /meetings/:id/audio",
        "DELETE /meetings/:id/conversation",
        "DELETE /meetings/:id/summaries/:sid",
        "GET /hosts",
        "GET /hosts/:app/:type/:id/meetings",
        "GET /meetings",
        "GET /meetings/:id",
        "GET /meetings/:id/audio",
        "GET /meetings/:id/conversation",
        "GET /meetings/:id/summaries",
        "GET /meetings/:id/transcript",
      ].sort(),
    );
  });

  it.each(serving.map((row) => [rowName(row), row] as const))("%s: the creator and a participant get what they get with auth up", async (_name, row) => {
    const wrong: string[] = [];
    for (const persona of ["creator", "participant"] as const) {
      const up = await outcome(row, persona, false);
      const down = await outcome(row, persona, true);
      // Not vacuous: with auth up the call really went through (or was the participant's normal refusal).
      if (up.status === 503) wrong.push(`${persona}: 503 even with auth up`);
      if (down.status !== up.status || down.code !== up.code) wrong.push(`${persona}: ${up.status} ${up.code ?? ""} with auth up, ${down.status} ${down.code ?? ""} without`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("capability routes answer 503 without auth (fail closed)", () => {
  const gated = ROWS.filter((row) => row.outage === "unavailable");

  it.each(gated.map((row) => [rowName(row), row] as const))("%s: 503 authorization_unavailable for every signed-in caller, even one who held the grant", async (_name, row) => {
    const wrong: string[] = [];
    for (const persona of ["creator", "participant", "outsiderNoAccess", "eraser"] as const) {
      const down = await outcome(row, persona, true);
      if (down.status !== 503 || down.code !== "authorization_unavailable") wrong.push(`${persona}: ${down.status} ${down.code ?? ""}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every route is classified, and the classes are the two the plan names", () => {
    expect(ROWS.filter((row) => row.outage !== "serves" && row.outage !== "unavailable")).toEqual([]);
    expect(gated.length + ROWS.filter((row) => row.outage === "serves").length).toBe(ROWS.length);
  });

  it("nobody is let in without a token while auth is down", async () => {
    for (const row of ROWS) {
      const world = await seedWorld(kit, "creator", kindsOf(row));
      kit.setAuthDown(true);
      const [method] = row.route.split(" ") as [string];
      expect((await kit.call(null, method, row.path(world), row.body?.(world), row.headers)).status, rowName(row)).toBe(401);
    }
  });
});

describe("the meeting a creator opens during an outage (AC-10.6, AC-10.4)", () => {
  it("says capabilities are unavailable, withholds every grant-bound control and keeps the deletions of their own data", async () => {
    const world = await seedWorld(kit, "creator", ["ready"]);
    kit.setAuthDown(true);
    const res = await kit.call("u-creator", "GET", `/meetings/${world.m.ready}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: string; role: string; can: Record<string, boolean> };
    expect(body.capabilities).toBe("unavailable");
    expect(body.role).toBe("creator");
    const granted = Object.entries(body.can).filter(([, value]) => value);
    // Everything that needs `meetings:access` is off; removing your own meeting and recording never needed it.
    expect(granted.map(([key]) => key).sort()).toEqual(["deleteAudio", "deleteMeeting"]);
  });

  it("a participant still reads the whole record: meeting, transcript, summaries, their conversation (AC-10.4)", async () => {
    const world = await seedWorld(kit, "participantNoAccess", ["ready"]);
    kit.setAuthDown(true);
    for (const tail of ["", "/transcript", "/summaries", "/conversation", "/audio"]) {
      expect((await kit.call("u-part-na", "GET", `/meetings/${world.m.ready}${tail}`)).status, tail || "meeting").toBe(200);
    }
    expect((await kit.call("u-part-na", "GET", "/meetings")).status).toBe(200);
  });

  it("My meetings lists the creator's and the participant's meetings", async () => {
    const world = await seedWorld(kit, "participant", ["ready"]);
    kit.setAuthDown(true);
    const res = await kit.call("u-part", "GET", "/meetings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual([world.m.ready!]);
  });
});

describe("what an outage must not do", () => {
  it("a host reader is vouched for only live, so without auth they are a stranger (404), not a reader", async () => {
    const world = await seedWorld(kit, "hostReader", ["ready"]);
    expect((await kit.call("u-host", "GET", `/meetings/${world.m.ready}`)).status).toBe(200);
    kit.setAuthDown(true);
    expect((await kit.call("u-host", "GET", `/meetings/${world.m.ready}`)).status).toBe(404);
  });

  it("an outage never grants: a creator without meetings:access is refused (503), not let through, on a creator control", async () => {
    const world = await seedWorld(kit, "creatorNoAccess", ["ready"]);
    kit.setAuthDown(true);
    const res = await kit.call("u-creator-na", "PATCH", `/meetings/${world.m.ready}`, { title: "x" });
    expect(res.status).toBe(503);
  });

  it("the first request after auth is back works, with no memory of the outage", async () => {
    const world = await seedWorld(kit, "creator", ["ready"]);
    kit.setAuthDown(true);
    expect((await kit.call("u-creator", "PATCH", `/meetings/${world.m.ready}`, { title: "x" })).status).toBe(503);
    kit.setAuthDown(false);
    expect((await kit.call("u-creator", "PATCH", `/meetings/${world.m.ready}`, { title: "x" })).status).toBe(200);
    const view = (await (await kit.call("u-creator", "GET", `/meetings/${world.m.ready}`)).json()) as { capabilities: string; can: { edit: boolean } };
    expect(view).toMatchObject({ capabilities: "resolved", can: { edit: true } });
  });
});

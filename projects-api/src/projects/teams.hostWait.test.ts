/**
 * The host path waits for a team read inside its callers' deadline (specs/20261126-teams, plan D16; AC-4.6, AC-5.4).
 * The ASSEMBLED app on the `*_test` database, with the real constants and a fake auth that HOLDS `/system/teams` (a slow
 * auth, not a failing one): a resolve answers within `TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS`, a slower flight still fills
 * the cache, and the page path is not bound by the wait.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TEAMS_HOST_MARGIN_MS, TEAMS_HOST_WAIT_MS } from "../lib/teams";
import { advanceTime, attachTeam, call, db, makeTeam, resetWorld, teamsAuth, type PersonaName } from "../test-support/world";

let release: () => void = () => {};
let logged: string[] = [];
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

/** Makes auth hold every team read until `release()`. */
function holdAuth(): void {
  teamsAuth.hold = new Promise<void>((resolve) => {
    release = () => {
      teamsAuth.hold = null;
      resolve();
    };
  });
}

beforeEach(async () => {
  await resetWorld();
  release = () => {};
  logged = [];
  const keep = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  warnSpy = spyOn(console, "warn").mockImplementation(keep);
  errorSpy = spyOn(console, "error").mockImplementation(keep);
});
afterEach(async () => {
  release(); // never leave a flight held into the next test
  await sleep(30);
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const seed = (name: string) =>
  db.project.create({ data: { name, type: "internal", entity: "welld_ch", projectManagerId: "user-pm-ch", createdById: "user-pm-ch" } });

const timed = async <T>(work: Promise<T>): Promise<{ value: T; elapsed: number }> => {
  const started = performance.now();
  const value = await work;
  return { value, elapsed: performance.now() - started };
};
const activityResolve = (ids: string[], as: PersonaName = "viewer") =>
  call("POST", "/activity-host/v1/resolve", { as, body: { entityType: "project", ids } });
const meetingResolve = (ids: string[], as: PersonaName) => call("POST", "/meeting-host/v1/resolve", { as, body: { entityType: "project", ids } });

const BOUND = TEAMS_HOST_WAIT_MS + TEAMS_HOST_MARGIN_MS;

describe("the activity-host resolve with a slow auth (AC-5.4, D16)", () => {
  it("answers within the wait: null assignees for the project with a team, the listed set for the one without; the flight then fills the cache", async () => {
    const withTeam = await seed("With");
    const without = await seed("Without");
    await db.projectMember.create({ data: { projectId: without.id, userId: "user-viewer" } });
    await attachTeam(withTeam.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    holdAuth(); // past the 2 s of the callers: nothing is answered until released

    const { value: res, elapsed } = await timed(activityResolve([withTeam.id, without.id]));
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(TEAMS_HOST_WAIT_MS - 100);
    expect(elapsed).toBeLessThan(BOUND);
    const [a, b] = res.json.items as Array<Record<string, unknown>>;
    expect(a!["assignees"]).toBeNull();
    expect(b!["assignees"]).toEqual(["user-pm-ch", "user-viewer"]);
    expect(teamsAuth.idsCalls).toBe(1);

    release();
    await sleep(50); // the flight that outlived the wait stores its answer
    const second = await activityResolve([withTeam.id]);
    expect((second.json.items as Array<Record<string, unknown>>)[0]!["assignees"]).toEqual(["user-pm-ch", "user-colleague"]);
    expect(teamsAuth.idsCalls).toBe(1); // no new call: it came from the flight the first resolve started
  });

  it("answers from an entry of 40 s within the same bound and logs teams_stale_used", async () => {
    const project = await seed("Koordy");
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    expect((await activityResolve([project.id])).json.items[0].assignees).toEqual(["user-pm-ch", "user-colleague"]);
    advanceTime(40_000);
    holdAuth();

    const { value: res, elapsed } = await timed(activityResolve([project.id]));
    expect(elapsed).toBeLessThan(BOUND);
    expect(res.json.items[0].assignees).toEqual(["user-pm-ch", "user-colleague"]);
    expect(logged.join("\n")).toContain("teams_stale_used");
  });
});

describe("the meeting-host resolve with a slow auth (AC-5.4, D16)", () => {
  it("answers 503 teams_unavailable to a team-only caller within the bound, and the project manager at once with no read", async () => {
    const project = await seed("Koordy");
    await attachTeam(project.id, makeTeam({ members: [{ id: "user-colleague" }] }).id);
    holdAuth();

    const { value: res, elapsed } = await timed(meetingResolve([project.id], "colleague"));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("teams_unavailable");
    expect(elapsed).toBeGreaterThanOrEqual(TEAMS_HOST_WAIT_MS - 100);
    expect(elapsed).toBeLessThan(BOUND);
    const callsAfterSlow = teamsAuth.calls;

    const pm = await timed(meetingResolve([project.id], "pmCh"));
    expect(pm.value.status).toBe(200);
    expect(pm.value.json.items[0].hostVisible).toBe(true);
    expect(pm.elapsed).toBeLessThan(TEAMS_HOST_WAIT_MS - 100);
    expect(teamsAuth.calls).toBe(callsAfterSlow); // the PM's answer made no call
  });
});

describe("the page path is not bound by the host wait (D16)", () => {
  it("GET /projects/{id} with auth answering after 1.5 s (over the wait, under 5 s) is complete, with the members", async () => {
    const project = await seed("Koordy");
    await attachTeam(project.id, makeTeam({ name: "Backend", members: [{ id: "user-colleague" }] }).id);
    teamsAuth.delayMs = 1_500;

    const { value: res, elapsed } = await timed(call("GET", `/projects/${project.id}`, { as: "viewer" }));
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(res.status).toBe(200);
    expect(res.json.teamsStatus).toBe("complete");
    expect(res.json.teams[0].members).not.toBeNull();
    expect(res.json.onProject.map((p: { id: string }) => p.id)).toContain("user-colleague");
  }, 10_000);
});

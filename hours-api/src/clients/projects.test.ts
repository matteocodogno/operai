/**
 * projects-api's host resolve, asked as the caller (specs/029 T11; plan § Sequences "On a project",
 * AC-2.2, AC-2.10, AC-2.11, ADR-0089). The caller's own header, the timeout, the redirect and the
 * failures are in `contract.test.ts`; this file is what is particular to the projects answer.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { startHosts, tokenShaped } from "../test-support/hosts";
import { resolveProjects } from "./projects";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = `Bearer ${tokenShaped({ sub: "user-alice" })}`;

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  hosts.reset();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const ok = async (ids: string[]) => {
  const answer = await resolveProjects(ALICE, ids);
  if (answer.state !== "ok") throw new Error(`expected ok, got ${answer.state}`);
  return answer.items;
};

describe("resolveProjects", () => {
  it("answers an open project with its label, href, writability and assignees (the project manager and the team)", async () => {
    hosts.projects.setProject("p1", { label: "Atlas", assignees: ["user-pm", "user-alice"] });
    expect((await ok(["p1"])).get("p1")).toEqual({
      state: "open",
      label: "Atlas",
      href: "/projects/p1",
      writable: true,
      assignees: ["user-pm", "user-alice"],
    });
  });

  it("reports `writable: false` as it is: the caller of the client decides it does not matter (A12)", async () => {
    hosts.projects.setProject("p1", { label: "Closed one", writable: false, assignees: ["user-alice"] });
    const project = (await ok(["p1"])).get("p1");
    expect(project).toMatchObject({ state: "open", writable: false });
  });

  it("answers a project nobody knows as `missing`", async () => {
    expect((await ok(["nope"])).get("nope")).toEqual({ state: "missing" });
  });

  it("answers `not_reader` for a caller without projects access, and nothing else", async () => {
    hosts.projects.setProject("p1", { label: "Atlas", assignees: ["user-alice"] });
    hosts.projects.setReader("user-alice", false);
    expect(await resolveProjects(ALICE, ["p1"])).toEqual({ state: "not_reader" });
  });

  it("lets `reader: false` decide alone, whatever else the body holds", async () => {
    hosts.fail("projects.resolve", { body: { reader: false, items: "garbage", surprise: 1 } });
    expect(await resolveProjects(ALICE, ["p1"])).toEqual({ state: "not_reader" });
  });

  it("sends `entityType: project` and the distinct ids, as a strict body", async () => {
    await resolveProjects(ALICE, ["p1", "p2", "p1"]);
    expect(hosts.callsTo("projects.resolve").map((call) => call.body)).toEqual([{ entityType: "project", ids: ["p1", "p2"] }]);
  });

  it("asks nothing for no ids", async () => {
    expect(await resolveProjects(ALICE, [])).toEqual({ state: "ok", items: new Map() });
    expect(hosts.calls).toEqual([]);
  });

  it("splits ids into batches of 25 and answers them all", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `p${i}`);
    for (const id of ids) hosts.projects.setProject(id, { label: `Project ${id}`, assignees: [] });
    const items = await ok(ids);
    expect(hosts.callsTo("projects.resolve").map((call) => (call.body as { ids: string[] }).ids.length).sort((a, b) => b - a)).toEqual([25, 25, 10]);
    expect(items.size).toBe(60);
    expect(items.get("p59")).toMatchObject({ state: "open", label: "Project p59" });
  });

  it("answers `unavailable` when any one batch does not answer, never a shorter list", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `p${i}`);
    hosts.fail("projects.resolve", { status: 500, times: 1 });
    expect(await resolveProjects(ALICE, ids)).toEqual({ state: "unavailable" });
  });

  it("ignores an item about an id it did not ask for", async () => {
    hosts.fail("projects.resolve", {
      body: {
        reader: true,
        items: [
          { id: "p1", state: "missing" },
          { id: "smuggled", state: "open", writable: true, label: "Injected", href: "/projects/smuggled", may: { write: true, manage: true }, assignees: ["user-alice"] },
        ],
      },
    });
    const items = await ok(["p1"]);
    expect([...items.keys()]).toEqual(["p1"]);
  });

  it("answers `unavailable` when the owner leaves an asked id unanswered", async () => {
    hosts.fail("projects.resolve", { body: { reader: true, items: [{ id: "p1", state: "missing" }] } });
    expect(await resolveProjects(ALICE, ["p1", "p2"])).toEqual({ state: "unavailable" });
  });

  it("answers `unavailable` for an open project that does not state its assignees: absent is not nobody", async () => {
    hosts.fail("projects.resolve", {
      body: { reader: true, items: [{ id: "p1", state: "open", writable: true, label: "Atlas", href: "/projects/p1", may: { write: true, manage: true } }] },
    });
    expect(await resolveProjects(ALICE, ["p1"])).toEqual({ state: "unavailable" });
  });

  it.each(["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", "projects/p1", "/a\\b", "/with space", ""])(
    "answers `unavailable` when an href is not a path inside the suite: %p",
    async (href) => {
      hosts.projects.setProject("p1", { label: "Atlas", href, assignees: ["user-alice"] });
      expect(await resolveProjects(ALICE, ["p1"])).toEqual({ state: "unavailable" });
    },
  );

  it("sends an id holding & # + % a comma, a quote or a space inside the JSON body exactly as given", async () => {
    const odd = ["a,b", 'q"uote', "in ner", "x&y=1", "h#sh", "pl+us", "per%cent", "pct%2Cenc"];
    await resolveProjects(ALICE, odd);
    expect(hosts.callsTo("projects.resolve").map((call) => (call.body as { ids: string[] }).ids)).toEqual([odd]);
  });
});

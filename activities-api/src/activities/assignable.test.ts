/**
 * Who a project task may go to when the host cannot say (specs/20261126-teams AC-5.2, AC-5.4;
 * ADR 20261126-a-host-says-unknown-for-the-one-field-a-decision-needs-instead-of-failing-the-reads-that-do-not-need-it).
 *
 * projects-api answers `assignees: null` for a project whose attached teams it cannot read. That
 * is "could not find out", never "nobody": assigning on it is 503 `host_unavailable`, while
 * listing, opening, completing and an unchanged resent assignee do not need the list.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { call, db, hosts, makeProject, resetWorld } from "../test-support/world";

beforeEach(resetWorld);

const create = (projectId: string, body: Record<string, unknown> = {}) =>
  call("POST", "/activities", { as: "manager", body: { type: "task", subject: "Install the gateways", projectId, ...body } });

/** The projects host answers `assignees: null` for these projects from now on (the caller manages them). */
function unknownAssignees(...projects: Array<{ id: string; name: string }>) {
  hosts.projects.mode = {
    body: {
      reader: true,
      items: projects.map((p) => ({
        id: p.id,
        state: "open",
        writable: true,
        label: p.name,
        href: `/projects/${p.id}`,
        may: { write: true, manage: true },
        assignees: null,
      })),
    },
  };
}

describe("a person who is on the project only through a team (AC-5.2)", () => {
  it("is assignable like a listed member, on create and on reassign", async () => {
    const project = makeProject("Rollout", { assignees: ["user-pm", "user-team-only"] });
    const created = await create(project.id, { assigneeUserId: "user-team-only" });
    expect(created.status).toBe(201);
    expect(created.json.task.assignee.id).toBe("user-team-only");

    const other = (await create(project.id, { assigneeUserId: "user-pm" })).json;
    const moved = await call("PATCH", `/activities/${other.id}`, { as: "manager", body: { assigneeUserId: "user-team-only" } });
    expect(moved.status).toBe(200);
    expect(moved.json.task.assignee.id).toBe("user-team-only");
  });
});

describe("`assignees: null` from the host (AC-5.4)", () => {
  it("refuses creating a task with an assignee: 503 host_unavailable, nothing written", async () => {
    const project = makeProject();
    unknownAssignees(project);
    const res = await create(project.id, { assigneeUserId: "user-pm" });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("host_unavailable");
    expect(await db.activity.count()).toBe(0);
  });

  it("refuses naming yourself too: unknown is not nobody", async () => {
    const project = makeProject();
    unknownAssignees(project);
    const res = await create(project.id, { assigneeUserId: "user-manager" });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("host_unavailable");
  });

  it("a task created with no assignee (the author) needs no list", async () => {
    const project = makeProject();
    unknownAssignees(project);
    const res = await create(project.id);
    expect(res.status).toBe(201);
    expect(res.json.task.assignee.id).toBe("user-manager");
  });

  it("refuses reassigning to someone else: 503 host_unavailable, the assignee is unchanged", async () => {
    const project = makeProject();
    const task = (await create(project.id, { assigneeUserId: "user-pm" })).json;
    unknownAssignees(project);
    const res = await call("PATCH", `/activities/${task.id}`, { as: "manager", body: { assigneeUserId: "user-member" } });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("host_unavailable");
    expect((await db.activity.findUniqueOrThrow({ where: { id: task.id } })).assigneeUserId).toBe("user-pm");
  });

  it("accepts an unchanged assignee resent with another edit (AC-3.7 of 20261110)", async () => {
    const project = makeProject();
    const task = (await create(project.id, { assigneeUserId: "user-pm" })).json;
    unknownAssignees(project);
    const res = await call("PATCH", `/activities/${task.id}`, { as: "manager", body: { subject: "Renamed", assigneeUserId: "user-pm" } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ subject: "Renamed", task: { assignee: { id: "user-pm" } } });
  });

  it("does not stop reading: the project's list answers 200", async () => {
    const project = makeProject();
    const task = (await create(project.id, { assigneeUserId: "user-pm" })).json;
    unknownAssignees(project);
    const listed = await call("GET", `/activities?projectId=${project.id}`, { as: "manager" });
    expect(listed.status).toBe(200);
    expect(listed.json.items.map((t: { id: string }) => t.id)).toEqual([task.id]);
  });

  it("does not stop an edit that names no assignee, or completing", async () => {
    const project = makeProject();
    const task = (await create(project.id, { assigneeUserId: "user-pm" })).json;
    unknownAssignees(project);
    expect((await call("PATCH", `/activities/${task.id}`, { as: "manager", body: { subject: "Renamed" } })).status).toBe(200);
    expect((await call("POST", `/activities/${task.id}/complete`, { as: "manager" })).status).toBe(200);
  });
});

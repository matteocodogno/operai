/**
 * `assertActivityOf` — the decision of whether an entry on a project or a deal may point at an activity
 * (specs/029 T16; plan § Sequences step 5, § Reading the owners' list answers; AC-2.7, AC-2.11; ADR-0089), on its
 * own, against the fake activities-api of T11 and the real client. src/entries/activityPointer.test.ts drives the
 * same decisions through the routes; this one pins the module's contract: it answers by THROWING, on every outcome
 * but "yes", and asks exactly one question.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, bearerOf, resetWorld } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { ProblemError } from "../lib/problem";
import { assertActivityOf, type Pointer } from "./activity";
import { hostUnavailable } from "./errors";
import { activityNotAllowed } from "../entries/rules";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  await resetWorld();
});

const aliceAuthorization = () => bearerOf("alice");

/** What the module said: "yes" (it returned), or the problem it threw — status, code, field and the whole message. */
async function answer(pointer: Pointer): Promise<"yes" | { status: number; code: string | undefined; detail: string }> {
  try {
    await assertActivityOf({ authorization: await aliceAuthorization() }, pointer);
    return "yes";
  } catch (error) {
    if (error instanceof ProblemError) return { status: error.status, code: error.code, detail: error.message };
    throw error;
  }
}
const said = (error: ProblemError) => ({ status: error.status, code: error.code, detail: error.message });
const NOT_ALLOWED = said(activityNotAllowed());
const UNAVAILABLE = said(hostUnavailable());

const onProject = (activityId: string, projectId: string): Pointer => ({ id: activityId, target: { type: "project", id: projectId } });
const onDeal = (activityId: string, dealId: string): Pointer => ({ id: activityId, target: { type: "deal", id: dealId } });

describe("assertActivityOf (AC-2.7, AC-2.11)", () => {
  it("says yes to a task of the project and to any pre-sales activity of the deal", async () => {
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.activities.add({ id: "a-call", subject: "Discovery call", type: "call", deal: "d1" });
    hosts.activities.add({ id: "a-note", subject: "Budget notes", type: "note", deal: "d1" });

    expect(await answer(onProject("t1", "p1"))).toBe("yes");
    expect(await answer(onDeal("a-call", "d1"))).toBe("yes");
    expect(await answer(onDeal("a-note", "d1"))).toBe("yes");
  });

  it("says 422 activity_not_allowed to an activity of something else: another project, another deal, the other kind of target", async () => {
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    hosts.activities.add({ id: "a-d1", subject: "Discovery call", type: "call", deal: "d1" });

    expect(await answer(onProject("t1", "p2"))).toEqual(NOT_ALLOWED);
    expect(await answer(onDeal("a-d1", "d2"))).toEqual(NOT_ALLOWED);
    expect(await answer(onDeal("t1", "p1"))).toEqual(NOT_ALLOWED); // a project's task on a deal that has the project's id
    expect(await answer(onProject("a-d1", "d1"))).toEqual(NOT_ALLOWED); // a deal's activity on a project that has the deal's id
    expect(NOT_ALLOWED).toMatchObject({ status: 422, code: "activity_not_allowed" });
  });

  it("says the same 422 to an id nobody holds and to an activity the caller may not read", async () => {
    hosts.activities.add({ id: "t-secret", subject: "Not for alice", project: "p1", readableBy: [BOB] });

    expect(await answer(onProject("t-secret", "p1"))).toEqual(NOT_ALLOWED);
    expect(await answer(onProject("t-nobody", "p1"))).toEqual(NOT_ALLOWED);
    expect(NOT_ALLOWED.detail).not.toMatch(/t-secret|t-nobody|p1/);
  });

  it("asks once, with the caller's token, for that one id and no other filter", async () => {
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    await answer(onProject("t1", "p1"));

    expect(hosts.calls.map((recorded) => recorded.route)).toEqual(["activities.list"]);
    expect(hosts.calls[0]?.authorization).toBe(await aliceAuthorization());
    expect([...hosts.calls[0]!.query.keys()]).toEqual(["ids"]);
    expect(hosts.calls[0]?.query.get("ids")).toBe("t1");
  });

  it("says 503 when activities-api does not answer, and never mistakes that for a no", async () => {
    hosts.activities.add({ id: "t1", subject: "Build the importer", project: "p1" });
    for (const mode of [{ status: 500 }, { malformed: true }, { redirect: true }, { rawBody: "nope" }]) {
      hosts.fail("activities.list", mode);
      expect(await answer(onProject("t1", "p1"))).toEqual(UNAVAILABLE);
    }
    hosts.heal("activities.list");
    expect(await answer(onProject("t1", "p1"))).toBe("yes");
  });

  it("says 503, never 422, when the answer carries another activity and not the asked one: the filter was ignored", async () => {
    const another = { id: "t-another", type: "task", subject: "Somebody else's", project: { id: "p1" }, deal: null, participants: [], task: { assignee: { id: ALICE } } };
    hosts.fail("activities.list", { body: { items: [another], total: 1, page: 1, pageSize: 50 } });

    expect(await answer(onProject("t1", "p1"))).toEqual(UNAVAILABLE);
  });
});

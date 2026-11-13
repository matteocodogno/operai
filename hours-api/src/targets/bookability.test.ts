/**
 * `assertBookable` — the decision of whether a caller may record hours on a project or a meeting
 * (specs/029 T15; plan § Sequences; ADR-0089; AC-2.2, AC-2.5, AC-2.10, AC-2.11), on its own, against the fake
 * owners of T11 and the real clients. src/entries/bookability.test.ts drives the same decisions through the
 * routes; this one pins the module's contract: it answers by THROWING, on every outcome but "yes".
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, bearerOf, resetWorld } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { ProblemError } from "../lib/problem";
import { assertBookable, type BookableTarget, type Caller } from "./bookability";
import { hostUnavailable, notOnProject, targetNotFound } from "./errors";

const hosts = startHosts();
afterAll(() => hosts.stop());

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;

beforeEach(async () => {
  await resetWorld();
});

const aliceCaller = async (): Promise<Caller> => ({ userId: ALICE, authorization: await bearerOf("alice") });

/** What the module said: "yes" (it returned), or the problem it threw — status, code and the whole message. */
async function answer(caller: Caller, target: BookableTarget): Promise<"yes" | { status: number; code: string | undefined; detail: string }> {
  try {
    await assertBookable(caller, target);
    return "yes";
  } catch (error) {
    if (error instanceof ProblemError) return { status: error.status, code: error.code, detail: error.message };
    throw error;
  }
}

/** The three answers a person can get, as the module makes them. */
const said = (error: ProblemError) => ({ status: error.status, code: error.code, detail: error.message });
const NOT_FOUND = said(targetNotFound());
const NOT_ON_PROJECT = said(notOnProject());
const UNAVAILABLE = said(hostUnavailable());

describe("assertBookable on a project (AC-2.2, AC-2.10, AC-2.11)", () => {
  const onProject = (id: string): BookableTarget => ({ type: "project", id });

  it("says yes to a project manager or team member, whatever the project's state", async () => {
    hosts.projects.setProject("p-open", { label: "Apollo", assignees: [BOB, ALICE] });
    hosts.projects.setProject("p-closed", { label: "Gemini", writable: false, assignees: [ALICE] });
    expect(await answer(await aliceCaller(), onProject("p-open"))).toBe("yes");
    expect(await answer(await aliceCaller(), onProject("p-closed"))).toBe("yes");
  });

  it("decides by the caller's user id and asks with the caller's token: the two are not the same input", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    const asAlice = await aliceCaller();

    expect(await answer(asAlice, onProject("p1"))).toEqual(NOT_ON_PROJECT);
    // Same token, another person's id: the project's people decide, not the token.
    expect(await answer({ ...asAlice, userId: BOB }, onProject("p1"))).toBe("yes");
    for (const recorded of hosts.callsTo("projects.resolve")) expect(recorded.authorization).toBe(asAlice.authorization);
    expect(hosts.callsTo("projects.resolve").map((recorded) => recorded.body)).toEqual([
      { entityType: "project", ids: ["p1"] },
      { entityType: "project", ids: ["p1"] },
    ]);
  });

  it("says 403 not_on_project to a reader who is not on it, and nothing is remembered between calls", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] });
    expect(await answer(await aliceCaller(), onProject("p1"))).toEqual(NOT_ON_PROJECT);

    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB, ALICE] }); // added to the team since
    expect(await answer(await aliceCaller(), onProject("p1"))).toBe("yes");
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [BOB] }); // and removed again
    expect(await answer(await aliceCaller(), onProject("p1"))).toEqual(NOT_ON_PROJECT);
  });

  it("says one and the same 404 to a missing project, one the caller cannot read and an id nobody holds", async () => {
    hosts.projects.setProject("p-secret", { label: "Secret", assignees: [ALICE] });
    hosts.projects.setReader(ALICE, false);
    const unreadable = await answer(await aliceCaller(), onProject("p-secret"));
    hosts.projects.setReader(ALICE, true);
    const missing = await answer(await aliceCaller(), onProject("p-nobody"));

    expect(unreadable).toEqual(NOT_FOUND);
    expect(missing).toEqual(NOT_FOUND);
    // The answer names neither the kind of target nor its id.
    expect(NOT_FOUND.detail).not.toMatch(/project|meeting|deal|p-secret|p-nobody/i);
  });

  it("says 503 when projects-api does not answer, and never mistakes that for a no", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    for (const mode of [{ status: 500 }, { malformed: true }, { redirect: true }, { rawBody: "nope" }]) {
      hosts.fail("projects.resolve", mode);
      expect(await answer(await aliceCaller(), onProject("p1"))).toEqual(UNAVAILABLE);
    }
    hosts.heal("projects.resolve");
    expect(await answer(await aliceCaller(), onProject("p1"))).toBe("yes");
  });
});

describe("assertBookable on a meeting (AC-2.5, AC-2.10, AC-2.11)", () => {
  const onMeeting = (id: string): BookableTarget => ({ type: "meeting", id });

  it("says yes to the creator and to an Operai participant", async () => {
    hosts.meetings.add({ id: "m-mine", creator: ALICE });
    hosts.meetings.add({ id: "m-invited", creator: BOB, participants: [ALICE] });
    expect(await answer(await aliceCaller(), onMeeting("m-mine"))).toBe("yes");
    expect(await answer(await aliceCaller(), onMeeting("m-invited"))).toBe("yes");
  });

  it("says 404 to anyone else — a reader through the meeting's host included — and to an unknown id: the same answer", async () => {
    hosts.meetings.add({ id: "m-theirs", creator: BOB, dealId: "d1" });
    expect(await answer(await aliceCaller(), onMeeting("m-theirs"))).toEqual(NOT_FOUND);
    expect(await answer(await aliceCaller(), onMeeting("m-nobody"))).toEqual(NOT_FOUND);
  });

  it("asks the caller's own list, with the caller's token, for that one id", async () => {
    hosts.meetings.add({ id: "m1", creator: ALICE });
    const caller = await aliceCaller();
    await answer(caller, onMeeting("m1"));
    expect(hosts.calls.map((recorded) => recorded.route)).toEqual(["meetings.list"]);
    expect(hosts.calls[0]?.authorization).toBe(caller.authorization);
    expect(hosts.calls[0]?.query.get("ids")).toBe("m1");
  });

  it("says 503 when meetings-api does not answer, or answered the caller's latest page without the asked meeting", async () => {
    hosts.meetings.add({ id: "m-oldest", creator: ALICE });
    for (let n = 1; n <= 25; n++) hosts.meetings.add({ id: `m-newer-${n}`, creator: ALICE });

    hosts.fail("meetings.list", { status: 500 });
    expect(await answer(await aliceCaller(), onMeeting("m-oldest"))).toEqual(UNAVAILABLE);
    hosts.heal("meetings.list");

    hosts.meetings.legacy = true; // before the `ids` filter: the latest page, which cannot hold the oldest meeting
    expect(await answer(await aliceCaller(), onMeeting("m-oldest"))).toEqual(UNAVAILABLE);
    hosts.meetings.legacy = false;
    expect(await answer(await aliceCaller(), onMeeting("m-oldest"))).toBe("yes");
  });
});

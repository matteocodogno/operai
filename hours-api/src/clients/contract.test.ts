/**
 * What EVERY owner client shares (specs/029 T11; plan § Entries "the id rule", AC-2.10, AC-2.11,
 * AC-4.7, risk R7): the caller's own `Authorization` forwarded unchanged, a 2 s timeout, no
 * redirect followed, and one reading of anything but a clean 200: `unavailable`. Never "not found":
 * the entry writes fail closed on it (503, AC-2.11) and the views degrade (AC-4.7), and a client that
 * read a 404 from a route an owner has not deployed yet as "the record is not there" would tell a
 * person their own project does not exist.
 *
 * Each subject is one client call against the fake hosts, with what makes the fake answer it
 * normally. The per-client files carry what is particular to each (parsing, batching, which ids).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { startHosts, tokenShaped, type HostName, type RouteName } from "../test-support/hosts";
import { OWNER_TIMEOUT_MS, type CallOptions } from "./owner";
import { listActivitiesByIds, listDealActivities } from "./activities";
import { resolveDeals } from "./crm";
import { listMeetingsByIds } from "./meetings";
import { resolveProjects } from "./projects";

const hosts = startHosts();
afterAll(() => hosts.stop());

interface Subject {
  readonly name: string;
  readonly route: RouteName;
  readonly host: HostName;
  /** Scripts what lets the fake answer this call normally. */
  readonly arrange: () => void;
  readonly call: (authorization: string, options?: CallOptions) => Promise<{ readonly state: string }>;
}

const SUBJECTS: readonly Subject[] = [
  {
    name: "projects resolve",
    host: "projects",
    route: "projects.resolve",
    arrange: () => hosts.projects.setProject("p1", { label: "Project one", assignees: ["user-alice"] }),
    call: (authorization, options) => resolveProjects(authorization, ["p1"], options),
  },
  {
    name: "crm resolve (deal)",
    host: "crm",
    route: "crm.resolve",
    arrange: () => hosts.crm.setDeal("d1", { label: "Deal one", involved: ["user-alice"] }),
    call: (authorization, options) => resolveDeals(authorization, ["d1"], options),
  },
  {
    name: "activities by ids",
    host: "activities",
    route: "activities.list",
    arrange: () => hosts.activities.add({ id: "a1", subject: "Task one", project: "p1" }),
    call: (authorization, options) => listActivitiesByIds(authorization, ["a1"], options),
  },
  {
    name: "activities of a deal",
    host: "activities",
    route: "activities.list",
    arrange: () => hosts.activities.add({ id: "a1", subject: "Call", type: "call", deal: "d1" }),
    call: (authorization, options) => listDealActivities(authorization, "d1", options),
  },
  {
    name: "meetings by ids",
    host: "meetings",
    route: "meetings.list",
    arrange: () => hosts.meetings.add({ id: "m1", creator: "user-alice" }),
    call: (authorization, options) => listMeetingsByIds(authorization, ["m1"], options),
  },
];

/** A caller's header with something in it a client could mangle if it rebuilt it. */
const CALLER = `Bearer ${tokenShaped({ sub: "user-alice", scope: "a b", note: "x+y/z=" })}`;
/** Short enough for a test, long enough for a local round trip. */
const SHORT = { timeoutMs: 60 } as const;

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  hosts.reset();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe.each(SUBJECTS)("$name", (subject) => {
  it("answers `ok` when the owner answers", async () => {
    subject.arrange();
    expect((await subject.call(CALLER)).state).toBe("ok");
  });

  it("forwards the caller's Authorization exactly as received", async () => {
    subject.arrange();
    await subject.call(CALLER);
    const received = hosts.callsTo(subject.route);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((call) => call.authorization === CALLER)).toBe(true);
  });

  it("uses a 2 s timeout by default", async () => {
    subject.arrange();
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await subject.call(CALLER);
      expect(OWNER_TIMEOUT_MS).toBe(2_000);
      expect(timeout).toHaveBeenCalledWith(OWNER_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it("answers `unavailable` when the owner is too slow", async () => {
    subject.arrange();
    hosts.fail(subject.route, { delayMs: 400 });
    expect((await subject.call(CALLER, SHORT)).state).toBe("unavailable");
  });

  it.each([500, 502, 503])("answers `unavailable` to a %d", async (status) => {
    subject.arrange();
    hosts.fail(subject.route, { status });
    expect((await subject.call(CALLER)).state).toBe("unavailable");
  });

  // R7: a route not deployed yet answers 404, an owner that predates T6-T9 answers 422; neither is "not found".
  it.each([400, 401, 403, 404, 405, 409, 422, 429])("answers `unavailable` to a %d, never to \"not found\"", async (status) => {
    subject.arrange();
    hosts.fail(subject.route, { status });
    expect((await subject.call(CALLER)).state).toBe("unavailable");
  });

  // Not only the status: the BODY is the one the route answers when all is well. Only a 200 is an answer.
  it.each([203, 206, 404, 422, 503])("answers `unavailable` to a perfectly good answer sent under a %d", async (withStatus) => {
    subject.arrange();
    hosts.fail(subject.route, { withStatus });
    expect((await subject.call(CALLER)).state).toBe("unavailable");
  });

  it.each([
    ["text that is not JSON", { rawBody: "<html>bad gateway</html>" }],
    ["an empty body", { rawBody: "" }],
    ["JSON that breaks the contract", { malformed: true }],
    ["JSON null", { body: null }],
    ["an empty object", { body: {} }],
  ])("answers `unavailable` to %s", async (_label, mode) => {
    subject.arrange();
    hosts.fail(subject.route, mode);
    expect((await subject.call(CALLER)).state).toBe("unavailable");
  });

  it("answers `unavailable` to a network error", async () => {
    subject.arrange();
    hosts.sever(subject.host);
    expect((await subject.call(CALLER)).state).toBe("unavailable");
  });

  it("follows no redirect: the caller's token never reaches the target", async () => {
    subject.arrange();
    hosts.fail(subject.route, { redirect: true });
    expect((await subject.call(CALLER)).state).toBe("unavailable");
    expect(hosts.elsewhere).toEqual([]);
  });

  it("never writes a token, an id or an Authorization header to the log", async () => {
    subject.arrange();
    hosts.fail(subject.route, { status: 500 });
    await subject.call(CALLER);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toBe("");
    expect(logged).not.toContain("Bearer");
    expect(logged).not.toContain(CALLER.slice(7, 40));
    expect(logged).not.toMatch(/\b(p1|d1|a1|m1)\b/);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCreatorControl,
  creatorFrozen,
  loadMeetingForVisibility,
  openMeeting,
  resolveAccess,
  type Caller,
  type VisibilityDeps,
  type VisibilityMeeting,
} from "./visibility";
import { ProblemError } from "../lib/problem";
import { startFakeHost } from "../test-support/fakeHost";
import type { Identity } from "../lib/identities";
import { db } from "../lib/db";

// AC-5.2 / AC-5.3 / AC-5.7 / AC-5.11 / AC-5.13 / AC-4.8: who can open a meeting,
// and when the creator's controls are frozen.

const fake = startFakeHost();
afterAll(() => fake.stop());
const hostRegistry = { get: (a: string, t: string) => fake.definitions.find((d) => d.app === a && d.entityType === t) };

/** An unsigned JWT: the fake host reads only `sub`, and meetings-api never inspects the token it forwards. */
const bearer = (sub: string) =>
  `Bearer h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;

let creatorStatus: "active" | "deleted" | "outage";
const identities: VisibilityDeps["requireIdentities"] = async (_auth, ids) => {
  if (creatorStatus === "outage") throw new ProblemError({ status: 503, code: "identity_unavailable", detail: "down" });
  return new Map<string, Identity>(ids.map((id) => [id, { id, name: creatorStatus === "active" ? "Cora" : null, status: creatorStatus === "active" ? "active" : "deleted" }]));
};
const deps: VisibilityDeps = { registry: hostRegistry, requireIdentities: identities };

const meeting = (over: Partial<VisibilityMeeting> = {}): VisibilityMeeting => ({
  id: "m1",
  creatorUserId: "creator",
  hostApp: "testhost",
  hostEntityType: "widget",
  hostEntityId: "w1",
  hostVisible: true,
  participantUserIds: ["pat"],
  ...over,
});
const caller = (userId: string, holdsAccess = true): Caller => ({ userId, authorization: bearer(userId), holdsAccess });

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fake.reset();
  creatorStatus = "active";
  fake.setEntity("widget", "w1", { title: "W1", href: "/testhost/widgets/w1", hostVisible: true });
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe("resolveAccess: the role, or nobody (AC-5.2, AC-4.8)", () => {
  it("the creator is creator, with no host call", async () => {
    expect(await resolveAccess(meeting(), caller("creator"), deps)).toEqual({ role: "creator" });
    expect(fake.resolves).toHaveLength(0);
  });

  it("an Operai participant is participant, with or without meetings:access, with no host call", async () => {
    expect(await resolveAccess(meeting(), caller("pat"), deps)).toEqual({ role: "participant" });
    expect(await resolveAccess(meeting(), caller("pat", false), deps)).toEqual({ role: "participant" });
    expect(fake.resolves).toHaveLength(0);
  });

  it("the creator who is also a participant is creator", async () => {
    expect(await resolveAccess(meeting({ participantUserIds: ["creator"] }), caller("creator"), deps)).toEqual({ role: "creator" });
  });

  it("a host reader needs hostVisible, meetings:access and the host's open + hostVisible answer", async () => {
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: "host_reader" });
    // the caller's own token went to the host
    expect(fake.resolves[0]?.authorization).toBe(bearer("hank"));
    expect(fake.resolves[0]?.body).toEqual({ entityType: "widget", ids: ["w1"] });
  });

  it("not a host reader without meetings:access, and the host is not even asked", async () => {
    expect(await resolveAccess(meeting(), caller("hank", false), deps)).toEqual({ role: null, hostUnavailable: false });
    expect(fake.resolves).toHaveLength(0);
  });

  it("not a host reader when the meeting is not host-visible, and the host is not even asked", async () => {
    expect(await resolveAccess(meeting({ hostVisible: false }), caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
    expect(fake.resolves).toHaveLength(0);
  });

  it("not a host reader on a standalone meeting", async () => {
    const standalone = meeting({ hostApp: null, hostEntityType: null, hostEntityId: null, hostVisible: false });
    expect(await resolveAccess(standalone, caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
  });

  it("not a host reader when the host says the entity is closed to this caller (AC-5.7)", async () => {
    fake.setEntity("widget", "w1", { title: "W1", href: "/x", stateFor: { hank: "closed" } });
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
    expect(await resolveAccess(meeting(), caller("hanna"), deps)).toEqual({ role: "host_reader" });
  });

  it("not a host reader when the host says open but hostVisible false (lacks the financial permission)", async () => {
    fake.setEntity("widget", "w1", { title: "W1", href: "/x", hostVisible: false });
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
  });

  it("not a host reader when the entity is missing", async () => {
    fake.setEntity("widget", "w1", { title: "W1", href: "/x", state: "missing" });
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
  });

  it("access ends on the very next request: no cache between two calls (AC-5.5, AC-5.7)", async () => {
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: "host_reader" });
    fake.setEntity("widget", "w1", { title: "W1", href: "/x", state: "closed" });
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
    expect(fake.resolves).toHaveLength(2);
  });

  it("fails closed when the host is unavailable, and says so", async () => {
    fake.mode.resolve = { status: 503 };
    expect(await resolveAccess(meeting(), caller("hank"), deps)).toEqual({ role: null, hostUnavailable: true });
  });

  it("a creator or participant is unaffected by a host outage (AC-5.7)", async () => {
    fake.mode.resolve = { status: 503 };
    expect(await resolveAccess(meeting(), caller("creator"), deps)).toEqual({ role: "creator" });
    expect(await resolveAccess(meeting(), caller("pat"), deps)).toEqual({ role: "participant" });
  });

  it("a host no longer in the registry grants nothing", async () => {
    const orphan = meeting({ hostApp: "gone", hostEntityType: "thing" });
    expect(await resolveAccess(orphan, caller("hank"), deps)).toEqual({ role: null, hostUnavailable: false });
  });

  it("an admin, an erase holder or any outsider gets nothing: roles never grant reading (AC-4.8)", async () => {
    // Capabilities are not even an input of resolveAccess beyond meetings:access.
    const standalone = meeting({ hostApp: null, hostEntityType: null, hostEntityId: null, hostVisible: false });
    for (const who of ["admin", "eraser", "outsider"]) {
      expect(await resolveAccess(standalone, caller(who), deps)).toEqual({ role: null, hostUnavailable: false });
    }
  });
});

describe("openMeeting: the database row, or an identical 404 (AC-5.3)", () => {
  const ids: string[] = [];
  afterEach(async () => {
    await db.meeting.deleteMany({ where: { id: { in: ids.splice(0) } } });
  });

  async function seed(over: { hostVisible?: boolean; participants?: { userId?: string; externalName?: string }[] } = {}) {
    const row = await db.meeting.create({
      data: {
        title: "Visibility",
        format: "online",
        startsAt: new Date("2026-11-01T10:00:00Z"),
        language: "en",
        source: "recorded",
        creatorUserId: "creator",
        hostApp: "testhost",
        hostEntityType: "widget",
        hostEntityId: "w1",
        hostVisible: over.hostVisible ?? false,
        participants: {
          create: (over.participants ?? []).map((p) => ({ ...p, addedBy: "creator" })),
        },
      },
    });
    ids.push(row.id);
    return row.id;
  }

  it("loads the meeting with its Operai participants only (externals have no account)", async () => {
    const id = await seed({ participants: [{ userId: "pat" }, { externalName: "Ext" }] });
    const loaded = await loadMeetingForVisibility(id);
    expect(loaded?.creatorUserId).toBe("creator");
    expect(loaded?.participantUserIds).toEqual(["pat"]);
  });

  it("opens for creator and participant", async () => {
    const id = await seed({ participants: [{ userId: "pat" }] });
    expect((await openMeeting(id, caller("creator"), deps)).role).toBe("creator");
    expect((await openMeeting(id, caller("pat"), deps)).role).toBe("participant");
  });

  it("opens for a host reader when host-visible", async () => {
    const id = await seed({ hostVisible: true });
    const opened = await openMeeting(id, caller("hank"), deps);
    expect(opened.role).toBe("host_reader");
    expect(opened.meeting.id).toBe(id);
  });

  it("a nonexistent id and a not-visible meeting give byte-identical 404s", async () => {
    const id = await seed();
    const body = async (p: Promise<unknown>) => {
      const err = (await p.then(
        () => null,
        (e: unknown) => e,
      )) as ProblemError;
      expect(err).toBeInstanceOf(ProblemError);
      return { status: err.status, code: err.code, message: err.message, extras: err.extras };
    };
    const hidden = await body(openMeeting(id, caller("outsider"), deps));
    const missing = await body(openMeeting("does-not-exist", caller("outsider"), deps));
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(missing);
    // the same for someone with every capability: nothing here reads capabilities
    expect(await body(openMeeting(id, caller("admin"), deps))).toEqual(missing);
  });

  it("a host outage on a host-visible meeting is the same 404 for an outsider", async () => {
    const id = await seed({ hostVisible: true });
    fake.mode.resolve = { status: 500 };
    const err = (await openMeeting(id, caller("hank"), deps).then(
      () => null,
      (e: unknown) => e,
    )) as ProblemError;
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
  });
});

describe("frozen: derived from the creator's live identity (AC-5.11, AC-5.13)", () => {
  it("display: false when active, true when deactivated, and back on reactivation (no cache)", async () => {
    expect(await creatorFrozen("Bearer x", "creator", deps)).toBe(false);
    creatorStatus = "deleted";
    expect(await creatorFrozen("Bearer x", "creator", deps)).toBe(true);
    creatorStatus = "active";
    expect(await creatorFrozen("Bearer x", "creator", deps)).toBe(false);
  });

  it("display: an identities outage is null (unknown), never a guess", async () => {
    creatorStatus = "outage";
    expect(await creatorFrozen("Bearer x", "creator", deps)).toBeNull();
  });

  it("asks identities with the caller's own Authorization header", async () => {
    const seen: string[] = [];
    await creatorFrozen("Bearer mine", "creator", {
      ...deps,
      requireIdentities: async (auth, ids) => {
        seen.push(auth, ...ids);
        return new Map([["creator", { id: "creator", name: "C", status: "active" as const }]]);
      },
    });
    expect(seen).toEqual(["Bearer mine", "creator"]);
  });
});

describe("assertCreatorControl: creator + not frozen + meetings:access (AC-5.8, AC-5.11)", () => {
  const code = async (p: Promise<unknown>) => {
    const err = (await p.then(
      () => null,
      (e: unknown) => e,
    )) as ProblemError | null;
    return err ? { status: err.status, code: err.code } : null;
  };

  it("passes for an active creator holding meetings:access", async () => {
    expect(await code(assertCreatorControl("creator", caller("creator"), "creator", deps))).toBeNull();
  });

  it("403 creator_only for a participant and for a host reader", async () => {
    expect(await code(assertCreatorControl("participant", caller("pat"), "creator", deps))).toEqual({ status: 403, code: "creator_only" });
    expect(await code(assertCreatorControl("host_reader", caller("hank"), "creator", deps))).toEqual({ status: 403, code: "creator_only" });
  });

  it("403 frozen when the creator is deactivated, for everyone, and the lookup is not skipped", async () => {
    creatorStatus = "deleted";
    expect(await code(assertCreatorControl("creator", caller("creator"), "creator", deps))).toEqual({ status: 403, code: "frozen" });
  });

  it("403 meetings_access_required for a creator who lost the grant (A4)", async () => {
    expect(await code(assertCreatorControl("creator", caller("creator", false), "creator", deps))).toEqual({ status: 403, code: "meetings_access_required" });
  });

  it("503 identity_unavailable when the lookup fails: closed, never open", async () => {
    creatorStatus = "outage";
    expect(await code(assertCreatorControl("creator", caller("creator"), "creator", deps))).toEqual({ status: 503, code: "identity_unavailable" });
  });

  it("a participant is refused before any identity lookup", async () => {
    let asked = 0;
    const counting = { ...deps, requireIdentities: async () => { asked++; return new Map(); } };
    await code(assertCreatorControl("participant", caller("pat"), "creator", counting));
    expect(asked).toBe(0);
  });
});

describe("static: no cache of the gate decisions", () => {
  it("visibility.ts does not use the display identity cache", () => {
    const source = readFileSync(join(import.meta.dir, "visibility.ts"), "utf8");
    expect(source).not.toMatch(/resolveIdentities/);
  });
});

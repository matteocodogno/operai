import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createKit, type Kit } from "../test-support/routeKit";

// AC-4.1, AC-4.3 (specs/021 T24): the consent attestation of a recorded or uploaded meeting.

const kit: Kit = await createKit();
// After the kit: importing a route module first would load the real JWT middleware before the kit mocks it.
const { CONSENT_NOTICE_VERSION } = await import("./consent.routes");

let logs: ReturnType<typeof spyOn>[];
beforeEach(async () => {
  await kit.reset();
  for (const user of ["creator", "pat", "stranger"]) kit.grant(user, "access");
  logs = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

const json = async (res: Response) => (await res.json()) as Record<string, any>;
async function seed(over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: { title: "Budget review", format: "online", startsAt: new Date("2026-11-05T09:00:00.000Z"), language: "en", source: "recorded", creatorUserId: "creator", ...over },
  });
}
const consent = (id: string, noticeVersion: string = CONSENT_NOTICE_VERSION, who = "creator") =>
  kit.call(who, "POST", `/meetings/${id}/consent`, { noticeVersion });

describe("the notice version", () => {
  it("is the one meetings-ui shows", () => {
    expect(CONSENT_NOTICE_VERSION).toBe("2026-11-01");
  });
});

describe("POST /meetings/:id/consent", () => {
  it("stores who, when and which version of the notice, and shows it to everyone who can open the meeting (AC-4.3)", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const before = Date.now();
    const res = await consent(m.id);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["consent"]).toEqual({ by: { id: "creator", name: "Name creator", status: "active" }, at: expect.any(String), noticeVersion: "2026-11-01" });
    expect(new Date(body["consent"].at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ consentUserId: "creator", consentNoticeVersion: "2026-11-01" });

    const asPat = await json(await kit.call("pat", "GET", `/meetings/${m.id}`));
    expect(asPat["consent"]).toMatchObject({ by: { id: "creator" }, noticeVersion: "2026-11-01" });
  });

  it("works for an uploaded meeting too, and confirming again keeps the original attestation", async () => {
    const m = await seed({ source: "uploaded" });
    const first = (await json(await consent(m.id)))["consent"];
    await new Promise((r) => setTimeout(r, 5));
    const again = (await json(await consent(m.id)))["consent"];
    expect(again).toEqual(first);
  });

  it("an attestation of an older version is replaced by the current one", async () => {
    const m = await seed({ consentUserId: "creator", consentAt: new Date("2025-01-01T00:00:00.000Z"), consentNoticeVersion: "2025-01-01" });
    const body = await json(await consent(m.id));
    expect(body["consent"]).toMatchObject({ noticeVersion: "2026-11-01" });
    expect(new Date(body["consent"].at).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("409 notice_outdated when the page showed another version, and nothing is stored", async () => {
    const m = await seed();
    for (const version of ["2025-01-01", "2026-11-01 "]) {
      const res = await consent(m.id, version);
      expect([res.status, (await json(res))["code"]]).toEqual([409, "notice_outdated"]);
    }
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).consentUserId).toBeNull();
  });

  it("a text meeting has no consent: 422 consent_not_applicable, nothing stored (AC-3.4)", async () => {
    const m = await seed({ source: "text" });
    const res = await consent(m.id);
    expect([res.status, (await json(res))["code"]]).toEqual([422, "consent_not_applicable"]);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).consentAt).toBeNull();
  });

  it("422 naming noticeVersion when it is missing or not a string", async () => {
    const m = await seed();
    for (const body of [{}, { noticeVersion: "" }, { noticeVersion: 7 }]) {
      const res = await kit.call("creator", "POST", `/meetings/${m.id}/consent`, body);
      expect(res.status).toBe(422);
      expect((await json(res))["field"]).toBe("noticeVersion");
    }
  });

  it("is the creator's: 403 creator_only, identical 404 for a stranger, 403 frozen, 403 meetings_access_required, 503 auth down", async () => {
    const m = await seed({ participants: { create: [{ userId: "pat", addedBy: "creator" }] } });
    const asPat = await consent(m.id, CONSENT_NOTICE_VERSION, "pat");
    expect([asPat.status, (await json(asPat))["code"]]).toEqual([403, "creator_only"]);
    expect((await consent(m.id, CONSENT_NOTICE_VERSION, "stranger")).status).toBe(404);
    kit.deactivate("creator");
    expect((await json(await consent(m.id)))["code"]).toBe("frozen");
    kit.reactivate("creator");
    kit.grant("creator");
    expect((await json(await consent(m.id)))["code"]).toBe("meetings_access_required");
    kit.setAuthDown(true);
    expect((await consent(m.id)).status).toBe(503);
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).consentUserId).toBeNull();
  });
});

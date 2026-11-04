import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "./lib/db";

// The database enforces what the application also checks (specs/021 plan.md
// § Data model): each constraint is proven by the row it rejects, named, and by
// a control row that differs only in the offending member and is accepted.
// Needs a migrated `meetings_test` database (`bun run db:deploy`).

beforeEach(async () => {
  // TRUNCATE is not blocked by the row-level append-only trigger.
  await db.$executeRawUnsafe(
    'TRUNCATE "meeting", "summary_template", "meeting_deletion", "host_notice", "ai_request" CASCADE',
  );
});
afterAll(async () => {
  await db.$disconnect();
});

const base = {
  title: "Quarterly review",
  format: "online" as const,
  startsAt: new Date("2026-11-04T09:00:00Z"),
  language: "en" as const,
  source: "recorded" as const,
  creatorUserId: "user-1",
};

const meeting = (extra: Record<string, unknown> = {}) => db.meeting.create({ data: { ...base, ...extra } });

/** Rejected by the named constraint (the message carries it; Prisma may wrap the driver error). */
async function rejectedBy(promise: Promise<unknown>, constraint: string) {
  let message = "";
  try {
    await promise;
  } catch (error) {
    message = String((error as Error).message) + JSON.stringify((error as { meta?: unknown }).meta ?? {});
  }
  expect(message).toContain(constraint);
}

describe("meeting CHECKs", () => {
  it("host reference is all or none", async () => {
    await rejectedBy(meeting({ hostApp: "crm" }), "meeting_host_all_or_none");
    await rejectedBy(meeting({ hostApp: "crm", hostEntityType: "deal" }), "meeting_host_all_or_none");
    await rejectedBy(meeting({ hostEntityId: "d1" }), "meeting_host_all_or_none");
    await meeting({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "d1" });
    await meeting();
  });

  it("hostVisible needs a host", async () => {
    await rejectedBy(meeting({ hostVisible: true }), "meeting_host_visible_needs_host");
    await meeting({ hostVisible: true, hostApp: "crm", hostEntityType: "deal", hostEntityId: "d1" });
    await meeting({ hostVisible: false });
  });

  it("consent is all or none", async () => {
    const at = new Date();
    await rejectedBy(meeting({ consentUserId: "user-1" }), "meeting_consent_all_or_none");
    await rejectedBy(meeting({ consentUserId: "user-1", consentAt: at }), "meeting_consent_all_or_none");
    await rejectedBy(meeting({ consentAt: at, consentNoticeVersion: "v1" }), "meeting_consent_all_or_none");
    await meeting({ consentUserId: "user-1", consentAt: at, consentNoticeVersion: "v1" });
  });

  it("a text meeting carries no consent (G1)", async () => {
    const consent = { consentUserId: "user-1", consentAt: new Date(), consentNoticeVersion: "v1" };
    await rejectedBy(meeting({ source: "text", ...consent }), "meeting_no_consent_on_text");
    await meeting({ source: "text" });
    await meeting({ source: "uploaded", ...consent });
    const m = await meeting({ source: "recorded", ...consent });
    // switching to text without clearing the consent is refused too
    await rejectedBy(db.meeting.update({ where: { id: m.id }, data: { source: "text" } }), "meeting_no_consent_on_text");
    await db.meeting.update({
      where: { id: m.id },
      data: { source: "text", consentUserId: null, consentAt: null, consentNoticeVersion: null },
    });
  });

  it("the title is 1..200 characters", async () => {
    await rejectedBy(meeting({ title: "" }), "meeting_title_length");
    await rejectedBy(meeting({ title: "x".repeat(201) }), "meeting_title_length");
    await meeting({ title: "x".repeat(200) });
  });
});

describe("participant CHECKs", () => {
  it("is exactly one of an Operai user or an external", async () => {
    const m = await meeting();
    const p = (data: Record<string, unknown>) => db.meetingParticipant.create({ data: { meetingId: m.id, addedBy: "user-1", ...data } });
    await rejectedBy(p({}), "meeting_participant_kind_xor");
    await rejectedBy(p({ userId: "user-2", externalName: "Ada" }), "meeting_participant_kind_xor");
    await p({ userId: "user-2" });
    await p({ externalName: "Ada", externalOrganisation: "Lovelace Ltd" });
  });

  it("an organisation belongs to an external only", async () => {
    const m = await meeting();
    await rejectedBy(
      db.meetingParticipant.create({ data: { meetingId: m.id, addedBy: "u", userId: "user-2", externalOrganisation: "Acme" } }),
      "meeting_participant_external_org",
    );
  });

  it("external name is 1..100 and organisation at most 100", async () => {
    const m = await meeting();
    const p = (data: Record<string, unknown>) => db.meetingParticipant.create({ data: { meetingId: m.id, addedBy: "u", ...data } });
    await rejectedBy(p({ externalName: "" }), "meeting_participant_external_lengths");
    await rejectedBy(p({ externalName: "n".repeat(101) }), "meeting_participant_external_lengths");
    await rejectedBy(p({ externalName: "n", externalOrganisation: "o".repeat(101) }), "meeting_participant_external_lengths");
    await p({ externalName: "n".repeat(100), externalOrganisation: "o".repeat(100) });
  });

  it("the same Operai user cannot be added twice, externals can share a name", async () => {
    const m = await meeting();
    const p = (data: Record<string, unknown>) => db.meetingParticipant.create({ data: { meetingId: m.id, addedBy: "u", ...data } });
    await p({ userId: "user-2" });
    await rejectedBy(p({ userId: "user-2" }), "meeting_participant_meetingId_userId_key");
    await p({ externalName: "Ada" });
    await p({ externalName: "Ada" });
  });
});

describe("one live recording session", () => {
  it("rejects a second live session and allows a new one once the first ended", async () => {
    const m = await meeting();
    const other = await meeting();
    const first = await db.recordingSession.create({ data: { meetingId: m.id } });
    await rejectedBy(db.recordingSession.create({ data: { meetingId: m.id } }), "recording_session_live_key");
    // another meeting is independent
    await db.recordingSession.create({ data: { meetingId: other.id } });
    await db.recordingSession.update({ where: { id: first.id }, data: { endedAt: new Date(), endReason: "stopped" } });
    await db.recordingSession.create({ data: { meetingId: m.id } });
    // ended sessions pile up freely
    const ended = await db.recordingSession.count({ where: { meetingId: m.id, endedAt: { not: null } } });
    expect(ended).toBe(1);
  });
});

describe("summary templates", () => {
  const tpl = (data: Record<string, unknown>) =>
    db.summaryTemplate.create({
      data: { name: "Minutes", sections: [{ heading: "Decisions", instruction: "" }], createdBy: "u", updatedBy: "u", ...data } as never,
    });

  it("a personal template has an owner and a shared one does not", async () => {
    await rejectedBy(tpl({ scope: "personal" }), "summary_template_owner_scope");
    await rejectedBy(tpl({ scope: "shared", ownerUserId: "user-1" }), "summary_template_owner_scope");
    await tpl({ scope: "personal", ownerUserId: "user-1" });
    await tpl({ scope: "shared" });
  });

  it("a duplicate personal name is rejected for the same owner, case-insensitively, but not across owners", async () => {
    await tpl({ scope: "personal", ownerUserId: "user-1", name: "Weekly" });
    await rejectedBy(tpl({ scope: "personal", ownerUserId: "user-1", name: "weekly" }), "summary_template_personal_name_key");
    await tpl({ scope: "personal", ownerUserId: "user-2", name: "Weekly" });
  });

  it("a duplicate shared name is rejected case-insensitively", async () => {
    await tpl({ scope: "shared", name: "Sales call" });
    await rejectedBy(tpl({ scope: "shared", name: "SALES CALL" }), "summary_template_shared_name_key");
  });

  it("a personal and a shared template may share a name", async () => {
    await tpl({ scope: "shared", name: "Same" });
    await tpl({ scope: "personal", ownerUserId: "user-1", name: "Same" });
  });

  it("the name is 1..80 characters", async () => {
    await rejectedBy(tpl({ scope: "shared", name: "" }), "summary_template_name_length");
    await rejectedBy(tpl({ scope: "shared", name: "n".repeat(81) }), "summary_template_name_length");
  });
});

describe("conversation question length", () => {
  it("is 1..1000 characters", async () => {
    const m = await meeting();
    const turn = (question: string) =>
      db.conversationTurn.create({ data: { meetingId: m.id, userId: "u", question, status: "pending", transcriptVersion: 0 } });
    await rejectedBy(turn(""), "conversation_turn_question_length");
    await rejectedBy(turn("q".repeat(1001)), "conversation_turn_question_length");
    await turn("q".repeat(1000));
  });
});

describe("meeting_deletion is append-only (Tier 1, AC-4.6)", () => {
  it("accepts an insert, refuses UPDATE and DELETE, and survives a failed attempt", async () => {
    const row = await db.meetingDeletion.create({ data: { meetingId: "m1", deletedByUserId: "u1", via: "creator" } });

    await rejectedBy(db.meetingDeletion.update({ where: { id: row.id }, data: { via: "erase" } }), "append-only");
    await rejectedBy(db.meetingDeletion.delete({ where: { id: row.id } }), "append-only");
    await rejectedBy(db.$executeRawUnsafe('DELETE FROM "meeting_deletion"'), "append-only");

    const still = await db.meetingDeletion.findUniqueOrThrow({ where: { id: row.id } });
    expect(still.via).toBe("creator");
  });

  it("has no title column and holds only identifiers and instants", async () => {
    const columns = await db.$queryRawUnsafe<{ column_name: string }[]>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'meeting_deletion' ORDER BY column_name",
    );
    expect(columns.map((c) => c.column_name)).toEqual(["deletedAt", "deletedByUserId", "id", "meetingId", "via"]);
  });
});

describe("deleting a meeting", () => {
  it("cascades to every child table", async () => {
    const m = await meeting();
    await db.meetingParticipant.create({ data: { meetingId: m.id, addedBy: "u", userId: "user-2" } });
    await db.transcriptSegment.create({ data: { meetingId: m.id, ordinal: 0, text: "hello" } });
    await db.summary.create({
      data: { meetingId: m.id, authorUserId: "u", template: {}, language: "en", status: "generating", attemptId: "a", transcriptVersion: 0 },
    });
    await db.meetingJob.create({ data: { kind: "transcribe", meetingId: m.id, maxAttempts: 3 } });
    await db.meeting.delete({ where: { id: m.id } });
    expect(await db.meetingParticipant.count()).toBe(0);
    expect(await db.transcriptSegment.count()).toBe(0);
    expect(await db.summary.count()).toBe(0);
    expect(await db.meetingJob.count()).toBe(0);
  });

  it("leaves the host-notice outbox alone: it outlives the meeting (AC-14.6)", async () => {
    const m = await meeting();
    await db.hostNotice.create({
      data: {
        hostApp: "crm", entityType: "deal", entityId: "d1", meetingId: m.id, seq: 1, event: "deleted",
        creatorUserId: "user-1", policy: "until_delivered",
      },
    });
    await db.meeting.delete({ where: { id: m.id } });
    expect(await db.hostNotice.count({ where: { meetingId: m.id } })).toBe(1);
  });
});

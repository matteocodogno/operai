import { afterEach, describe, expect, it } from "bun:test";
import { CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";
import { setProberForTests, ToolMissingError, type ProbeVerdict } from "../media/probe";

// AC-3.1, AC-3.2, AC-3.3: mint a presigned upload, confirm it with a synchronous
// ffprobe. The prober is stubbed here (the real ffprobe is exercised by
// src/media/probe.test.ts); what is asserted is what the route does with each verdict.

useKit();
afterEach(() => setProberForTests(null));

const MiB = 1024 * 1024;
/** The key each meeting's latest mint pinned (a key is minted per policy: it is only known from the response). */
const stored = new Map<string, string>();
const mint = async (id: string, body: unknown, user = CREATOR) => {
  const res = await call("POST", `/meetings/${id}/upload`, { user, body });
  if (res.status === 200) stored.set(id, ((await res.clone().json()) as { fields: Record<string, string> }).fields["key"]!);
  return res;
};
const confirm = (id: string, user = CREATOR) => call("POST", `/meetings/${id}/upload/confirm`, { user });
const uploaded = (over = {}) => mkMeeting({ source: "uploaded", ...over });
const original = (id: string) => stored.get(id) ?? `meetings/${id}/upload/00000000-0000-4000-8000-000000000000`;

/** A meeting that has minted an upload whose object reached the bucket. */
async function withObject(size = 5 * MiB) {
  const m = await uploaded();
  expect((await mint(m.id, { contentType: "video/mp4", sizeBytes: size })).status).toBe(200);
  kit.storage.put(original(m.id), size, "video/mp4");
  return m;
}
const probes = (verdict: ProbeVerdict | Error) => {
  const seen: string[] = [];
  setProberForTests(async (source) => {
    seen.push(source);
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  return seen;
};

describe("POST /meetings/:id/upload (mint)", () => {
  it("mints one presigned POST at a key of its own and remembers what was announced", async () => {
    const m = await uploaded();
    const res = await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 10 * MiB });
    expect(res.status).toBe(200);
    const body = await json<{ fields: Record<string, string>; expiresAt: string }>(res);
    expect(body.fields["key"]).toBe(original(m.id));
    expect(body.fields["Content-Type"]).toBe("audio/mpeg");
    expect(await db.meetingUpload.findUniqueOrThrow({ where: { meetingId: m.id } })).toMatchObject({
      objectKey: original(m.id), contentType: "audio/mpeg", sizeBytes: 10 * MiB,
    });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
  });

  it("minting again (a retry) replaces the announcement", async () => {
    const m = await uploaded();
    await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 1 * MiB });
    expect((await mint(m.id, { contentType: "video/mp4", sizeBytes: 2 * MiB })).status).toBe(200);
    expect(await db.meetingUpload.findUniqueOrThrow({ where: { meetingId: m.id } })).toMatchObject({ contentType: "video/mp4", sizeBytes: 2 * MiB });
  });

  it("a new mint clears the reason of a refused file, but only on a draft", async () => {
    const m = await uploaded({ failureCode: "too_long" });
    expect((await mint(m.id, { contentType: "audio/mpeg", sizeBytes: MiB })).status).toBe(200);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).failureCode).toBeNull();
  });

  it("does not wipe the failure of a meeting that stopped being a draft while the mint was in flight", async () => {
    const m = await uploaded({ failureCode: "too_long" });
    const original = kit.storage.mintUploadPost;
    // Between the draft check and the writes the meeting is processed and fails for another reason.
    kit.storage.mintUploadPost = async (meetingId, contentType) => {
      await db.meeting.update({ where: { id: meetingId }, data: { status: "failed", failureCode: "audio_unreadable" } });
      return original(meetingId, contentType);
    };
    try {
      await mint(m.id, { contentType: "audio/mpeg", sizeBytes: MiB });
    } finally {
      kit.storage.mintUploadPost = original;
    }
    expect(await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "failed", failureCode: "audio_unreadable" });
  });

  it("an unsupported type is 422 unsupported_type and mints nothing", async () => {
    const m = await uploaded();
    for (const contentType of ["application/pdf", "text/html", "audio/x-unknown", "video/x-flv", ""]) {
      const res = await mint(m.id, { contentType, sizeBytes: 1000 });
      expect(res.status).toBe(422);
    }
    const res = await mint(m.id, { contentType: "application/pdf", sizeBytes: 1000 });
    expect((await json<{ code: string }>(res)).code).toBe("unsupported_type");
    expect(kit.storage.minted).toHaveLength(0);
  });

  it("over 500 MiB is 422 too_large; exactly 500 MiB is fine", async () => {
    const m = await uploaded();
    const res = await mint(m.id, { contentType: "video/mp4", sizeBytes: 500 * MiB + 1 });
    expect(res.status).toBe(422);
    expect((await json<{ code: string }>(res)).code).toBe("too_large");
    expect((await mint(m.id, { contentType: "video/mp4", sizeBytes: 500 * MiB })).status).toBe(200);
    expect((await mint(m.id, { contentType: "video/mp4", sizeBytes: 0 })).status).toBe(422);
    expect((await mint(m.id, { contentType: "video/mp4", sizeBytes: 1.5 })).status).toBe(422);
  });

  it("needs the consent attestation (409 consent_required), the uploaded source and a draft", async () => {
    const noConsent = await uploaded({ consentUserId: null, consentAt: null, consentNoticeVersion: null });
    const res = await mint(noConsent.id, { contentType: "audio/mpeg", sizeBytes: 1000 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("consent_required");

    const recorded = await mkMeeting({ source: "recorded" });
    expect((await json<{ code: string }>(await mint(recorded.id, { contentType: "audio/mpeg", sizeBytes: 1000 }))).code).toBe("wrong_source");

    const processing = await uploaded({ status: "processing" });
    expect((await json<{ code: string }>(await mint(processing.id, { contentType: "audio/mpeg", sizeBytes: 1000 }))).code).toBe("not_draft");
  });

  it("is a creator-control route: stranger 404, participant 403, storage down 503", async () => {
    const m = await uploaded();
    expect((await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 1000 }, OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    expect((await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 1000 }, OTHER)).status).toBe(403);
    kit.storage.failWith(new Error("down"));
    expect((await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 1000 })).status).toBe(503);
  });
});

describe("POST /meetings/:id/upload/confirm", () => {
  it("a valid file: 202 processing, one prepare_audio job, the probe saw a short-lived GET of the original", async () => {
    const m = await withObject();
    const seen = probes({ ok: true, durationMs: 61_000, format: "mov,mp4,m4a,3gp,3g2,mj2" });
    const res = await confirm(m.id);
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ status: "processing", stage: "preparing", durationMs: 61_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(original(m.id));
    expect(seen[0]).toContain("probe=1");
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.processingRequestedBy).toBe(CREATOR);
    expect(row.processingStartedAt).not.toBeNull();
    const queued = await db.meetingJob.findMany({ where: { meetingId: m.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "prepare_audio", state: "queued" });
    expect(kit.storage.keys()).toContain(original(m.id)); // kept for prepare_audio
  });

  it("a duration the probe could not read leaves durationMs null (the normaliser measures it)", async () => {
    const m = await withObject();
    probes({ ok: true, durationMs: null, format: "matroska,webm" });
    expect(await json(await confirm(m.id))).toMatchObject({ status: "processing", durationMs: null });
  });

  it.each(["unsupported_type", "no_audio", "too_long"] as const)(
    "a rejected file (%s): 422 upload_rejected with the reason, object and announcement deleted, still draft (AC-3.2)",
    async (reason) => {
      const m = await withObject();
      probes({ ok: false, reason });
      const res = await confirm(m.id);
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({ code: "upload_rejected", reason });
      expect(kit.storage.keys()).not.toContain(original(m.id));
      expect(await db.meetingUpload.count({ where: { meetingId: m.id } })).toBe(0);
      expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
      expect(await db.meetingJob.count()).toBe(0);
      // and the creator can try again with another file
      expect((await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 1000 })).status).toBe(200);
    },
  );

  it("an object that never arrived is 409 upload_incomplete, and the meeting stays draft (AC-3.3)", async () => {
    const m = await uploaded();
    await mint(m.id, { contentType: "audio/mpeg", sizeBytes: 1000 });
    const seen = probes({ ok: true, durationMs: 1, format: "wav" });
    const res = await confirm(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("upload_incomplete");
    expect(seen).toHaveLength(0);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
  });

  it("confirming with no mint at all is 409 upload_incomplete too", async () => {
    const m = await uploaded();
    const res = await confirm(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("upload_incomplete");
  });

  it("an object larger than the policy allows (it should be impossible) is deleted and 422 too_large", async () => {
    const m = await withObject();
    kit.storage.put(original(m.id), 500 * MiB + 1, "video/mp4");
    probes({ ok: true, durationMs: 1, format: "wav" });
    const res = await confirm(m.id);
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: "upload_rejected", reason: "too_large" });
    expect(kit.storage.keys()).not.toContain(original(m.id));
  });

  it("a missing ffprobe is a 503 media_unavailable: the file is kept and the meeting stays draft", async () => {
    const m = await withObject();
    probes(new ToolMissingError("ffprobe"));
    const res = await confirm(m.id);
    expect(res.status).toBe(503);
    expect((await json<{ code: string }>(res)).code).toBe("media_unavailable");
    expect(kit.storage.keys()).toContain(original(m.id));
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
  });

  it("a storage outage while checking the object is 503 storage_unavailable", async () => {
    const m = await withObject();
    probes({ ok: true, durationMs: 1, format: "wav" });
    kit.storage.failWith(new Error("down"));
    expect((await json<{ code: string }>(await confirm(m.id))).code).toBe("storage_unavailable");
  });

  it("confirming twice does not queue a second job; the repeat answers the same 202", async () => {
    const m = await withObject();
    probes({ ok: true, durationMs: 1000, format: "wav" });
    expect((await confirm(m.id)).status).toBe(202);
    const again = await confirm(m.id);
    expect(again.status).toBe(202);
    expect(await db.meetingJob.count({ where: { meetingId: m.id } })).toBe(1);
  });

  it("a participant is refused (403), a stranger gets 404, and a recorded meeting is 409 wrong_source", async () => {
    const m = await withObject();
    probes({ ok: true, durationMs: 1, format: "wav" });
    expect((await confirm(m.id, OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    expect((await confirm(m.id, OTHER)).status).toBe(403);
    const recorded = await mkMeeting({ source: "recorded" });
    expect((await json<{ code: string }>(await confirm(recorded.id))).code).toBe("wrong_source");
  });
});

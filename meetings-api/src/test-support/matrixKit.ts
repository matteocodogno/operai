/**
 * The assembled-app tests of specs/021-meetings T42 (matrix.test.ts, authz-outage.test.ts,
 * logPrivacy.test.ts) all walk the SAME table: one row per route of the real app, with the
 * request that makes it succeed and what each kind of caller must get. Keeping it in one place
 * is the point: a route added without a row fails the matrix, and the outage and log-privacy
 * tests cannot drift from it.
 *
 *   PERSONAS   nine callers, each defined by their relationship to ONE meeting (ADR-0058) and
 *              their grants: creator, creator who lost `meetings:access` (A4), creator who was
 *              deactivated (frozen, AC-5.11), participant, participant without access (AC-10.4),
 *              an outsider with / without access, an `meeting:erase` + `template:manage`
 *              holder who is no participant (AC-4.8), and nobody.
 *   seedWorld  the rows a persona's world needs, fresh for every cell so an action that
 *              deletes or flips state cannot colour the next one.
 *   ROWS       the route table.
 */

import type { Cap, Kit } from "./routeKit";
// No route module is imported statically: createKit() must register the auth mocks before any loads.

// ─── Personas ────────────────────────────────────────────────────────────────

export const PERSONAS = [
  "creator",
  "creatorNoAccess",
  "frozenCreator",
  "participant",
  "participantNoAccess",
  "outsider",
  "outsiderNoAccess",
  "eraser",
  "anonymous",
  "hostReader",
  "hostReaderNoAccess",
] as const;
export type Persona = (typeof PERSONAS)[number];
/** The personas whose cells are written out; a host reader's follow from a participant's (below). */
type BasePersona = Exclude<Persona, "hostReader" | "hostReaderNoAccess">;

interface PersonaSpec {
  readonly caller: string | null;
  readonly grants: readonly Cap[];
  /** How the caller relates to the seeded meetings. */
  readonly role: "creator" | "participant" | "host" | "none";
  /** `auth` reports this account as deactivated. */
  readonly deactivated?: true;
}

export const SPECS: Record<Persona, PersonaSpec> = {
  creator: { caller: "u-creator", grants: ["access"], role: "creator" },
  creatorNoAccess: { caller: "u-creator-na", grants: [], role: "creator" },
  frozenCreator: { caller: "u-creator-fz", grants: ["access"], role: "creator", deactivated: true },
  participant: { caller: "u-part", grants: ["access"], role: "participant" },
  participantNoAccess: { caller: "u-part-na", grants: [], role: "participant" },
  outsider: { caller: "u-out", grants: ["access"], role: "none" },
  outsiderNoAccess: { caller: "u-out-na", grants: [], role: "none" },
  eraser: { caller: "u-eraser", grants: ["access", "erase", "template"], role: "none" },
  anonymous: { caller: null, grants: [], role: "none" },
  // Opens the meeting only as the reader of its host entity (hostVisible, live, with `meetings:access`).
  hostReader: { caller: "u-host", grants: ["access"], role: "host" },
  hostReaderNoAccess: { caller: "u-host-na", grants: [], role: "host" },
};

/** The creator of every meeting when the caller is not it. Holds `meetings:access`. */
export const OWNER = "u-owner";

// ─── The texts a test can plant ──────────────────────────────────────────────

/** Everything a person writes or says. The log-privacy test swaps these for canaries. */
export interface Texts {
  readonly title: string;
  readonly transcript: string;
  readonly summaryHeading: string;
  readonly summaryBody: string;
  readonly question: string;
  readonly answer: string;
  readonly externalName: string;
  readonly externalOrg: string;
  readonly templateName: string;
  readonly instruction: string;
  readonly speakerLabel: string;
}

export const PLAIN_TEXTS: Texts = {
  title: "Weekly sync",
  transcript: "We agreed to ship on Friday.",
  summaryHeading: "Decisions",
  summaryBody: "Ship on Friday.",
  question: "What was decided?",
  answer: "Shipping on Friday.",
  externalName: "Pat External",
  externalOrg: "Acme",
  templateName: "My template",
  instruction: "List the decisions.",
  speakerLabel: "Pat",
};

// ─── The world ───────────────────────────────────────────────────────────────

/** Which seeded meeting a row addresses. */
export type MeetingKind =
  | "ready" // recorded, ready, audio kept, a transcript, a summary, a conversation
  | "draft" // recorded, consented, nothing captured yet
  | "text" // a text meeting waiting for its text
  | "upload" // an uploaded-source meeting, consented, nothing uploaded yet
  | "live" // recording, a live session with chunk 0 stored
  | "interrupted" // recording whose session has ended
  | "failed"; // processing failed after prepare_audio: chunks kept

export interface World {
  readonly persona: Persona;
  readonly caller: string | null;
  readonly owner: string;
  readonly texts: Texts;
  /** Seeded meeting ids; a kind not requested is absent. */
  readonly m: Partial<Record<MeetingKind, string>>;
  readonly segmentId: string;
  readonly summaryId: string;
  readonly failedSummaryId: string;
  readonly turnId: string;
  readonly failedTurnId: string;
  readonly sessionId: string;
  readonly ownTemplateId: string;
  readonly otherTemplateId: string;
  readonly sharedTemplateId: string;
  readonly consentVersion: string;
}

const DAY = 86_400_000;

/** Resets the kit, applies the persona's grants and seeds the requested meetings. */
export async function seedWorld(kit: Kit, persona: Persona, kinds: readonly MeetingKind[], texts: Texts = PLAIN_TEXTS): Promise<World> {
  await kit.reset();
  await kit.db.$executeRawUnsafe('TRUNCATE "summary_template", "ai_request"');
  const { CONSENT_NOTICE_VERSION } = await import("../meetings/consent.routes");
  const spec = SPECS[persona];
  const caller = spec.caller;
  kit.fake.setEntity("widget", "w1", { title: "Widget one", href: "/testhost/widgets/w1" });
  kit.grant(OWNER, "access");
  if (caller !== null) kit.grant(caller, ...spec.grants);
  if (spec.deactivated && caller !== null) kit.deactivate(caller);

  const owner = spec.role === "creator" && caller !== null ? caller : OWNER;
  const now = new Date();
  const base = {
    title: texts.title,
    format: "online" as const,
    startsAt: new Date(now.getTime() - 3_600_000),
    language: "en" as const,
    creatorUserId: owner,
    // A host reader opens the meeting through the entity it is linked to.
    ...(spec.role === "host" ? { hostApp: "testhost", hostEntityType: "widget", hostEntityId: "w1", hostVisible: true } : {}),
  };
  const consent = { consentUserId: owner, consentAt: now, consentNoticeVersion: CONSENT_NOTICE_VERSION };

  const m: Partial<Record<MeetingKind, string>> = {};
  const create = async (kind: MeetingKind, data: Record<string, unknown>) => {
    if (!kinds.includes(kind)) return;
    const row = await kit.db.meeting.create({ data: { ...base, ...data } as never });
    m[kind] = row.id;
    await kit.db.meetingParticipant.create({ data: { meetingId: row.id, externalName: texts.externalName, externalOrganisation: texts.externalOrg, addedBy: owner } });
    if (spec.role === "participant" && caller !== null) {
      await kit.db.meetingParticipant.create({ data: { meetingId: row.id, userId: caller, addedBy: owner } });
    }
  };

  await create("ready", {
    source: "recorded",
    status: "ready",
    ...consent,
    durationMs: 60_000,
    audioKey: "pending",
    audioBytes: 10,
    audioCreatedAt: now,
    processingStartedAt: new Date(now.getTime() - DAY),
    processedAt: now,
    transcriptVersion: 1,
  });
  await create("draft", { source: "recorded", ...consent });
  await create("text", { source: "text" });
  await create("upload", { source: "uploaded", ...consent });
  await create("live", { source: "recorded", status: "recording", ...consent });
  await create("interrupted", { source: "recorded", status: "recording", ...consent });
  await create("failed", {
    source: "recorded",
    status: "failed",
    failureCode: "audio_unreadable",
    ...consent,
    processingStartedAt: new Date(now.getTime() - DAY),
  });

  // The ready meeting's content: audio object, transcript, summaries, the caller's conversation.
  let segmentId = "none";
  let summaryId = "none";
  let failedSummaryId = "none";
  let turnId = "none";
  let failedTurnId = "none";
  if (m.ready) {
    const key = `meetings/${m.ready}/audio.ogg`;
    await kit.db.meeting.update({ where: { id: m.ready }, data: { audioKey: key } });
    kit.storage.put(key, 10, "audio/ogg", new Uint8Array([1, 2, 3]));
    // Two parts, and speaker s1 spans both: the one transcript every transcript row runs against, so "Separate by part" has a
    // joined key to separate (AC-6.16). The extra segment changes no other row's answer.
    await kit.db.meeting.update({ where: { id: m.ready }, data: { transcriptPartStartsMs: [0, 510_000], transcriptPartEndsMs: [600_000, 1_110_000] } });
    segmentId = (await kit.db.transcriptSegment.create({ data: { meetingId: m.ready, ordinal: 0, startMs: 0, endMs: 2_000, speakerKey: "s1", text: texts.transcript, part: 1 } })).id;
    await kit.db.transcriptSegment.create({ data: { meetingId: m.ready, ordinal: 1, startMs: 520_000, endMs: 522_000, speakerKey: "s1", text: texts.transcript, part: 2 } });
    const snapshot = { source: "personal", templateId: "tpl", name: texts.templateName, sections: [{ heading: texts.summaryHeading, instruction: texts.instruction }], generalInstructions: null };
    const summary = (status: "ready" | "failed") => ({
      meetingId: m.ready!,
      authorUserId: owner,
      template: snapshot,
      language: "en" as const,
      status,
      attemptId: crypto.randomUUID(),
      transcriptVersion: 1,
      ...(status === "ready" ? { sections: [{ heading: texts.summaryHeading, body: texts.summaryBody, notDiscussed: false }], readyAt: now } : { failureCode: "provider_unavailable" }),
    });
    summaryId = (await kit.db.summary.create({ data: summary("ready") })).id;
    failedSummaryId = (await kit.db.summary.create({ data: summary("failed") })).id;
    if (caller !== null) {
      const turn = (status: "answered" | "failed") => ({
        meetingId: m.ready!,
        userId: caller,
        question: texts.question,
        status,
        transcriptVersion: 1,
        ...(status === "answered" ? { answer: { text: texts.answer, citations: [segmentId], notInMeeting: false }, answeredAt: now } : { failureCode: "provider_unavailable" }),
      });
      turnId = (await kit.db.conversationTurn.create({ data: turn("answered") })).id;
      failedTurnId = (await kit.db.conversationTurn.create({ data: turn("failed") })).id;
    }
  }

  // Recording sessions: one live (chunk 0 stored), one ended.
  let sessionId = "none";
  if (m.live) {
    const session = await kit.db.recordingSession.create({ data: { meetingId: m.live, startedAt: now, lastBeatAt: now, lastChunkAt: now } });
    sessionId = session.id;
    const objectKey = `meetings/${m.live}/chunks/000000`;
    await kit.db.recordingChunk.create({ data: { meetingId: m.live, seq: 0, sessionId, objectKey, sizeBytes: 5, durationMs: 1_000, storedAt: now } });
    kit.storage.put(objectKey, 5, "audio/webm");
    kit.storage.put(`meetings/${m.live}/chunks/000001`, 5, "audio/webm");
  }
  if (m.interrupted) {
    const session = await kit.db.recordingSession.create({ data: { meetingId: m.interrupted, startedAt: now, lastBeatAt: now, endedAt: now, endReason: "interrupted" } });
    await kit.db.recordingChunk.create({
      data: { meetingId: m.interrupted, seq: 0, sessionId: session.id, objectKey: `meetings/${m.interrupted}/chunks/000000`, sizeBytes: 5, durationMs: 1_000, storedAt: now },
    });
  }
  if (m.failed) {
    const session = await kit.db.recordingSession.create({ data: { meetingId: m.failed, startedAt: now, lastBeatAt: now, endedAt: now, endReason: "stopped" } });
    await kit.db.recordingChunk.create({
      data: { meetingId: m.failed, seq: 0, sessionId: session.id, objectKey: `meetings/${m.failed}/chunks/000000`, sizeBytes: 5, durationMs: 1_000, storedAt: now },
    });
  }

  // Templates: the caller's own personal one, somebody else's, and a shared one.
  const template = (over: Record<string, unknown>) => ({
    name: texts.templateName,
    sections: [{ heading: texts.summaryHeading, instruction: texts.instruction }],
    createdBy: owner,
    updatedBy: owner,
    ...over,
  });
  const ownTemplateId = (await kit.db.summaryTemplate.create({ data: template({ scope: "personal", ownerUserId: caller ?? OWNER, createdBy: caller ?? OWNER, updatedBy: caller ?? OWNER, name: `${texts.templateName} own` }) as never })).id;
  const otherTemplateId = (await kit.db.summaryTemplate.create({ data: template({ scope: "personal", ownerUserId: "u-someone-else", createdBy: "u-someone-else", updatedBy: "u-someone-else", name: `${texts.templateName} other` }) as never })).id;
  const sharedTemplateId = (await kit.db.summaryTemplate.create({ data: template({ scope: "shared", name: `${texts.templateName} shared` }) as never })).id;

  return { persona, caller, owner, texts, m, segmentId, summaryId, failedSummaryId, turnId, failedTurnId, sessionId, ownTemplateId, otherTemplateId, sharedTemplateId, consentVersion: CONSENT_NOTICE_VERSION };
}

// ─── Expectations ────────────────────────────────────────────────────────────

/** `ok`: the action goes through (the row's own status). A pair is a refusal: status and Problem `code`. */
export type Cell = "ok" | readonly [status: number, code?: string];

export const NOT_FOUND: Cell = [404];
export const UNAUTH: Cell = [401];
const OK: Cell = "ok";

type Cells = Record<BasePersona, Cell>;

/** selfScoped + visibility: anyone who can open the meeting, grant or no grant, deactivated creator included. */
const READ: Cells = {
  creator: OK, creatorNoAccess: OK, frozenCreator: OK, participant: OK, participantNoAccess: OK,
  outsider: NOT_FOUND, outsiderNoAccess: NOT_FOUND, eraser: NOT_FOUND, anonymous: UNAUTH,
};
/** creator-control: creator + not frozen + `meetings:access`, in the plan's order (visibility 404, creator_only, frozen, access). */
const CONTROL: Cells = {
  creator: OK, creatorNoAccess: [403, "meetings_access_required"], frozenCreator: [403, "frozen"],
  participant: [403, "creator_only"], participantNoAccess: [403, "creator_only"],
  outsider: NOT_FOUND, outsiderNoAccess: NOT_FOUND, eraser: NOT_FOUND, anonymous: UNAUTH,
};
/** creator-control (light): the three recording routes skip the live "is the creator deactivated?" lookup (amendment 2026-11-05 #2). */
const LIGHT: Cells = { ...CONTROL, frozenCreator: OK };
/** capability + visibility, frozen allowed: the capability is checked first, so no grant is 403 even for an outsider. */
const CAPVIS: Cells = {
  creator: OK, creatorNoAccess: [403], frozenCreator: OK, participant: OK, participantNoAccess: [403],
  outsider: NOT_FOUND, outsiderNoAccess: [403], eraser: NOT_FOUND, anonymous: UNAUTH,
};
/** capability + visibility + (author or creator). The seeded summary is the creator's. */
const CAPVIS_AUTHOR: Cells = { ...CAPVIS, participant: [403, "author_only"] };
/** Removing content you may open: author or creator, never a grant (AC-7.8). */
const DELETE_CONTENT: Cells = { ...READ, participant: [403, "author_only"], participantNoAccess: [403, "author_only"] };
/** Delete the recording: the creator without a grant (A4), not once deactivated; erase never touches audio. */
const DELETE_AUDIO: Cells = {
  ...CONTROL, creatorNoAccess: OK,
};
/** Delete the meeting: the creator without a grant, or an erase holder; a frozen creator needs the erase right (AC-5.12). */
const DELETE_MEETING: Cells = {
  creator: OK, creatorNoAccess: OK, frozenCreator: [403, "frozen"], participant: [403, "creator_only"], participantNoAccess: [403, "creator_only"],
  outsider: NOT_FOUND, outsiderNoAccess: NOT_FOUND, eraser: OK, anonymous: UNAUTH,
};
/** Not about a meeting: `meetings:access`. */
const NEEDS_ACCESS: Cells = {
  creator: OK, creatorNoAccess: [403], frozenCreator: OK, participant: OK, participantNoAccess: [403],
  outsider: OK, outsiderNoAccess: [403], eraser: OK, anonymous: UNAUTH,
};
/** Not about a meeting: any signed-in user. */
const ANY_USER: Cells = { creator: OK, creatorNoAccess: OK, frozenCreator: OK, participant: OK, participantNoAccess: OK, outsider: OK, outsiderNoAccess: OK, eraser: OK, anonymous: UNAUTH };
/** The erase screen: `meeting:erase`. */
const ERASE_ONLY: Cells = {
  creator: [403], creatorNoAccess: [403], frozenCreator: [403], participant: [403], participantNoAccess: [403],
  outsider: [403], outsiderNoAccess: [403], eraser: OK, anonymous: UNAUTH,
};
/** A template the caller may use, change or delete as its owner / as a manager. */
const TEMPLATE_OWN: Cells = NEEDS_ACCESS;
/** A shared template: changed only with `template:manage`. */
const TEMPLATE_SHARED: Cells = {
  creator: [403, "template_manage_required"], creatorNoAccess: [403], frozenCreator: [403, "template_manage_required"],
  participant: [403, "template_manage_required"], participantNoAccess: [403], outsider: [403, "template_manage_required"],
  outsiderNoAccess: [403], eraser: OK, anonymous: UNAUTH,
};
/** A built-in template is read-only for everyone who may reach the route. */
const TEMPLATE_BUILTIN: Cells = {
  creator: [403, "builtin_readonly"], creatorNoAccess: [403], frozenCreator: [403, "builtin_readonly"],
  participant: [403, "builtin_readonly"], participantNoAccess: [403], outsider: [403, "builtin_readonly"],
  outsiderNoAccess: [403], eraser: [403, "builtin_readonly"], anonymous: UNAUTH,
};
/** Somebody else's personal template does not exist for the caller. */
const TEMPLATE_OTHERS: Cells = {
  creator: [404], creatorNoAccess: [403], frozenCreator: [404], participant: [404], participantNoAccess: [403],
  outsider: [404], outsiderNoAccess: [403], eraser: [404], anonymous: UNAUTH,
};

// ─── The route table ─────────────────────────────────────────────────────────

/** What a route does when `auth` cannot answer `/authz/resolve` (AC-10.6): keep serving, or fail closed with 503. */
export type Outage = "serves" | "unavailable";

export interface RouteRow {
  /** The route as the app registers it, e.g. `PATCH /meetings/:id`. */
  readonly route: string;
  /** Distinguishes two rows of one route (a template that is shared vs one's own). */
  readonly variant?: string;
  /** Which seeded meetings the request needs. */
  readonly needs?: readonly MeetingKind[];
  readonly path: (w: World) => string;
  readonly body?: (w: World) => unknown;
  readonly headers?: Record<string, string>;
  /** The status of a cell that goes through. */
  readonly ok: number;
  readonly cells: Record<Persona, Cell>;
  readonly outage: Outage;
  /** True when the route returns the meeting's own record: its absence of cells for outsiders is checked for byte-identity with a missing id. */
  readonly meetingScoped?: boolean;
}

const sections = (w: World) => [{ heading: w.texts.summaryHeading, instruction: w.texts.instruction }];
const mid = (kind: MeetingKind) => (w: World) => w.m[kind]!;
const M = (kind: MeetingKind, tail = "") => (w: World) => `/meetings/${mid(kind)(w)}${tail}`;

/**
 * A host reader holds what a participant holds on the routes that let a participant in (read, ask,
 * summarise) and is refused where a participant is refused; without `meetings:access` the host's
 * vouching does not count (live), so they are a stranger.
 */
const withHostReaders = (cells: Cells): Record<Persona, Cell> => ({ ...cells, hostReader: cells.participant, hostReaderNoAccess: cells.outsiderNoAccess });

function row(
  route: string,
  kind: MeetingKind | null,
  init: Omit<RouteRow, "route" | "path" | "needs" | "meetingScoped" | "cells"> & { path?: RouteRow["path"]; cells: Cells },
  tail = "",
): RouteRow {
  return {
    route,
    ...(kind ? { needs: [kind], path: init.path ?? M(kind, tail), meetingScoped: true } : { path: init.path! }),
    ...init,
    cells: withHostReaders(init.cells),
  } as RouteRow;
}

export const ROWS: readonly RouteRow[] = [
  // ── Meetings ──────────────────────────────────────────────────────────────
  row("GET /meetings", null, { path: () => "/meetings", ok: 200, cells: ANY_USER, outage: "serves" }),
  row("POST /meetings", null, {
    path: () => "/meetings",
    body: (w) => ({ title: w.texts.title, format: "online", language: "en", source: "recorded" }),
    ok: 201,
    cells: NEEDS_ACCESS,
    outage: "unavailable",
  }),
  row("GET /meetings/:id", "ready", { ok: 200, cells: READ, outage: "serves" }),
  row("PATCH /meetings/:id", "ready", { body: (w) => ({ title: `${w.texts.title} v2` }), ok: 200, cells: CONTROL, outage: "unavailable" }),
  row("DELETE /meetings/:id", "ready", { ok: 204, cells: DELETE_MEETING, outage: "serves" }),
  row("PUT /meetings/:id/participants", "ready", {
    body: (w) => ({ participants: [{ name: w.texts.externalName, organisation: w.texts.externalOrg }] }),
    ok: 200,
    cells: CONTROL,
    outage: "unavailable",
  }, "/participants"),
  row("POST /meetings/:id/consent", "draft", { body: (w) => ({ noticeVersion: w.consentVersion }), ok: 200, cells: CONTROL, outage: "unavailable" }, "/consent"),
  row("POST /meetings/:id/host-notice/retry", "ready", { ok: 200, cells: CONTROL, outage: "unavailable" }, "/host-notice/retry"),

  // ── Hosts ─────────────────────────────────────────────────────────────────
  row("GET /hosts", null, { path: () => "/hosts", ok: 200, cells: ANY_USER, outage: "serves" }),
  row("GET /hosts/:app/:type/:id", null, { path: () => "/hosts/testhost/widget/w1", ok: 200, cells: NEEDS_ACCESS, outage: "unavailable" }),
  row("GET /hosts/:app/:type/:id/meetings", null, { path: () => "/hosts/testhost/widget/w1/meetings", ok: 200, cells: ANY_USER, outage: "serves" }),
  row("GET /hosts/:app/:type/:id/linkable-meetings", null, { path: () => "/hosts/testhost/widget/w1/linkable-meetings", ok: 200, cells: NEEDS_ACCESS, outage: "unavailable" }),

  // ── Capture ───────────────────────────────────────────────────────────────
  row("POST /meetings/:id/recording/start", "draft", { ok: 201, cells: CONTROL, outage: "unavailable" }, "/recording/start"),
  row("POST /meetings/:id/recording/chunks/:seq/confirm", "live", {
    path: (w) => `/meetings/${w.m.live}/recording/chunks/1/confirm`,
    body: (w) => ({ sessionId: w.sessionId, durationMs: 1_000 }),
    ok: 200,
    cells: LIGHT,
    outage: "unavailable",
  }),
  row("POST /meetings/:id/recording/chunks/:seq/upload-url", "live", {
    path: (w) => `/meetings/${w.m.live}/recording/chunks/1/upload-url`,
    body: (w) => ({ sessionId: w.sessionId }),
    ok: 200,
    cells: LIGHT,
    outage: "unavailable",
  }),
  row("POST /meetings/:id/recording/heartbeat", "live", {
    body: (w) => ({ sessionId: w.sessionId, paused: false, capturedMs: 1_000 }),
    ok: 204,
    cells: LIGHT,
    outage: "unavailable",
  }, "/recording/heartbeat"),
  row("POST /meetings/:id/recording/stop", "live", { body: (w) => ({ sessionId: w.sessionId, lastSeq: 0 }), ok: 202, cells: CONTROL, outage: "unavailable" }, "/recording/stop"),
  row("POST /meetings/:id/recording/process", "interrupted", { ok: 202, cells: CONTROL, outage: "unavailable" }, "/recording/process"),
  row("POST /meetings/:id/recording/discard", "interrupted", { ok: 200, cells: CONTROL, outage: "unavailable" }, "/recording/discard"),
  row("PUT /meetings/:id/text", "text", { body: (w) => ({ text: w.texts.transcript }), ok: 200, cells: CONTROL, outage: "unavailable" }, "/text"),
  row("POST /meetings/:id/upload", "upload", { body: () => ({ contentType: "audio/mpeg", sizeBytes: 1_000 }), ok: 200, cells: CONTROL, outage: "unavailable" }, "/upload"),
  // Nothing was uploaded: the gate is passed and the business answer is 409 upload_incomplete (T27's test owns the 2xx).
  row("POST /meetings/:id/upload/confirm", "upload", { ok: 409, cells: CONTROL, outage: "unavailable" }, "/upload/confirm"),
  row("POST /meetings/:id/retry", "failed", { ok: 202, cells: CONTROL, outage: "unavailable" }, "/retry"),
  row("GET /meetings/:id/audio", "ready", { ok: 200, cells: READ, outage: "serves" }, "/audio"),
  row("DELETE /meetings/:id/audio", "ready", { ok: 200, cells: DELETE_AUDIO, outage: "serves" }, "/audio"),

  // ── Transcript ────────────────────────────────────────────────────────────
  row("GET /meetings/:id/transcript", "ready", { ok: 200, cells: READ, outage: "serves" }, "/transcript"),
  row("PATCH /meetings/:id/transcript/segments/:segmentId", "ready", {
    path: (w) => `/meetings/${w.m.ready}/transcript/segments/${w.segmentId}`,
    body: (w) => ({ text: `${w.texts.transcript} (edited)` }),
    headers: { "If-Match": '"1"' },
    ok: 200,
    cells: CONTROL,
    outage: "unavailable",
  }),
  row("PUT /meetings/:id/transcript/speakers/:key", "ready", {
    path: (w) => `/meetings/${w.m.ready}/transcript/speakers/s1`,
    body: (w) => ({ text: w.texts.speakerLabel }),
    ok: 200,
    cells: CONTROL,
    outage: "unavailable",
  }),

  row("POST /meetings/:id/transcript/speakers/:key/separate", "ready", {
    path: (w) => `/meetings/${w.m.ready}/transcript/speakers/s1/separate`,
    ok: 200,
    cells: CONTROL,
    outage: "unavailable",
  }),

  // ── Summaries ─────────────────────────────────────────────────────────────
  row("GET /meetings/:id/summaries", "ready", { ok: 200, cells: READ, outage: "serves" }, "/summaries"),
  row("POST /meetings/:id/summaries", "ready", { body: (w) => ({ templateId: w.sharedTemplateId, language: "en" }), ok: 202, cells: CAPVIS, outage: "unavailable" }, "/summaries"),
  row("POST /meetings/:id/summaries/:sid/regenerate", "ready", {
    path: (w) => `/meetings/${w.m.ready}/summaries/${w.summaryId}/regenerate`,
    ok: 202,
    cells: CAPVIS,
    outage: "unavailable",
  }),
  row("POST /meetings/:id/summaries/:sid/retry", "ready", {
    path: (w) => `/meetings/${w.m.ready}/summaries/${w.failedSummaryId}/retry`,
    ok: 202,
    cells: CAPVIS,
    outage: "unavailable",
  }),
  row("PATCH /meetings/:id/summaries/:sid", "ready", {
    path: (w) => `/meetings/${w.m.ready}/summaries/${w.summaryId}`,
    body: (w) => ({ sections: [{ heading: w.texts.summaryHeading, body: `${w.texts.summaryBody} (edited)` }] }),
    headers: { "If-Match": '"1"' },
    ok: 200,
    cells: CAPVIS_AUTHOR,
    outage: "unavailable",
  }),
  row("DELETE /meetings/:id/summaries/:sid", "ready", {
    path: (w) => `/meetings/${w.m.ready}/summaries/${w.summaryId}`,
    ok: 204,
    cells: DELETE_CONTENT,
    outage: "serves",
  }),

  // ── Conversation ──────────────────────────────────────────────────────────
  row("GET /meetings/:id/conversation", "ready", { ok: 200, cells: READ, outage: "serves" }, "/conversation"),
  row("POST /meetings/:id/conversation/questions", "ready", { body: (w) => ({ question: w.texts.question }), ok: 201, cells: CAPVIS, outage: "unavailable" }, "/conversation/questions"),
  row("POST /meetings/:id/conversation/questions/:tid/retry", "ready", {
    path: (w) => `/meetings/${w.m.ready}/conversation/questions/${w.failedTurnId}/retry`,
    ok: 200,
    cells: CAPVIS,
    outage: "unavailable",
  }),
  row("DELETE /meetings/:id/conversation", "ready", { ok: 204, cells: READ, outage: "serves" }, "/conversation"),

  // ── Templates ─────────────────────────────────────────────────────────────
  row("GET /templates", null, { path: () => "/templates", ok: 200, cells: NEEDS_ACCESS, outage: "unavailable" }),
  row("POST /templates", null, {
    variant: "personal",
    path: () => "/templates",
    body: (w) => ({ scope: "personal", name: `${w.texts.templateName} new`, sections: sections(w) }),
    ok: 201,
    cells: NEEDS_ACCESS,
    outage: "unavailable",
  }),
  row("POST /templates", null, {
    variant: "shared",
    path: () => "/templates",
    body: (w) => ({ scope: "shared", name: `${w.texts.templateName} new shared`, sections: sections(w) }),
    ok: 201,
    cells: TEMPLATE_SHARED,
    outage: "unavailable",
  }),
  ...(["own", "shared", "builtin", "others"] as const).flatMap((which) => {
    const id = (w: World) => ({ own: w.ownTemplateId, shared: w.sharedTemplateId, builtin: "builtin:minutes", others: w.otherTemplateId })[which];
    const cells = { own: TEMPLATE_OWN, shared: TEMPLATE_SHARED, builtin: TEMPLATE_BUILTIN, others: TEMPLATE_OTHERS }[which];
    return [
      row("PATCH /templates/:id", null, {
        variant: which,
        path: (w) => `/templates/${id(w)}`,
        body: (w) => ({ name: `${w.texts.templateName} renamed`, sections: sections(w) }),
        headers: { "If-Match": '"1"' },
        ok: 200,
        cells,
        outage: "unavailable",
      }),
      row("DELETE /templates/:id", null, { variant: which, path: (w) => `/templates/${id(w)}`, ok: 204, cells, outage: "unavailable" }),
    ];
  }),
  row("POST /templates/:id/duplicate", null, { variant: "builtin", path: () => "/templates/builtin:minutes/duplicate", body: () => ({}), ok: 201, cells: NEEDS_ACCESS, outage: "unavailable" }),
  row("POST /templates/:id/duplicate", null, { variant: "others", path: (w) => `/templates/${w.otherTemplateId}/duplicate`, body: () => ({}), ok: 201, cells: TEMPLATE_OTHERS, outage: "unavailable" }),

  // ── Erase ─────────────────────────────────────────────────────────────────
  row("GET /erase/meetings", null, { path: () => "/erase/meetings", ok: 200, cells: ERASE_ONLY, outage: "unavailable" }),
];

/** Served without a token, on purpose. Pinned, so another route cannot hide here. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(["GET /health", "GET /openapi.json", "GET /docs"]);

export const rowName = (r: RouteRow) => (r.variant ? `${r.route} (${r.variant})` : r.route);

/** The kinds of meeting a row needs seeded. */
export const kindsOf = (r: RouteRow): readonly MeetingKind[] => r.needs ?? [];

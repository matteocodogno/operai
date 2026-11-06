/**
 * The `Meeting` a caller sees (specs/021-meetings plan.md § API contracts,
 * § Authorization "Action matrix", amendments A1, A2, A4, G1, G3, ADR-0058).
 *
 *   buildMeetingView   PURE: loaded facts + injected clock in, the contract's
 *                      `Meeting` out. Every derived field (status incl.
 *                      `interrupted`, audio state, `recording.lostMs`, frozen
 *                      passthrough, `capabilities`, every `can` flag) is decided
 *                      here, so the truth tables are testable without a database.
 *   loadMeetingView    the I/O around it: visibility (the identical 404), the
 *                      rows, people (display, soft), the creator's live identity
 *                      (frozen), the host label (soft). Handlers call this.
 *
 * `can` is a HINT for the UI; the server enforces every action again
 * (`assertCreatorControl` and friends). It is deliberately conservative: an
 * unknown fact (frozen: null) withholds a creator control, never grants one.
 */

import { db } from "../lib/db";
import { resolveIdentities as liveDisplayIdentities, requireIdentities as liveIdentities, toPersonRef, type Identity, type PersonRef } from "../lib/identities";
import { resolve as resolveAtHost } from "../hosts/client";
import { hostRegistry } from "../hosts/registry";
import { audioState, derivedStatus, lostMs, retryResume, type DerivedStatus, type LiveSession } from "./derived";
import { oldestSourceAt } from "./sources";
import { openMeeting, type Caller, type MeetingRole, type VisibilityDeps } from "./visibility";
import type { MeetingFormat, MeetingLanguage, MeetingSource, MeetingStatus, NoticeEvent, ProcessingStage } from "../lib/generated/prisma/enums";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ViewCaller extends Caller {
  /** `holds(c, MEETING_ERASE)`: only ever used to delete (never to read). */
  readonly holdsErase: boolean;
  /** Whether `auth` answered (AC-10.6); echoed on the view. */
  readonly capabilities: "resolved" | "unavailable";
}

/** The `meeting` columns the view reads (a Prisma row satisfies it). */
export interface MeetingRecord {
  readonly id: string;
  readonly title: string;
  readonly format: MeetingFormat;
  readonly startsAt: Date;
  readonly language: MeetingLanguage;
  readonly source: MeetingSource;
  readonly status: MeetingStatus;
  readonly stage: ProcessingStage | null;
  readonly failureCode: string | null;
  readonly noSpeech: boolean;
  readonly creatorUserId: string;
  readonly hostApp: string | null;
  readonly hostEntityType: string | null;
  readonly hostEntityId: string | null;
  readonly hostVisible: boolean;
  readonly consentUserId: string | null;
  readonly consentAt: Date | null;
  readonly consentNoticeVersion: string | null;
  readonly durationMs: number | null;
  readonly audioCreatedAt: Date | null;
  readonly audioDeletedAt: Date | null;
  readonly processingStartedAt: Date | null;
  readonly transcriptVersion: number;
}

export interface ParticipantRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly externalName: string | null;
  readonly externalOrganisation: string | null;
}

export interface HostView {
  readonly app: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly state: "open" | "closed" | "missing" | "unavailable";
  readonly title: string | null;
  readonly href: string | null;
}

export interface ViewInput {
  readonly meeting: MeetingRecord;
  readonly role: MeetingRole;
  readonly caller: Pick<ViewCaller, "holdsAccess" | "holdsErase" | "capabilities">;
  /** The creator's live state: `true` deactivated, `false` active, `null` could not be checked. */
  readonly frozen: boolean | null;
  /** Display identities by id; a missing id reads as unknown. */
  readonly people: ReadonlyMap<string, Identity>;
  readonly participants: readonly ParticipantRecord[];
  /** The most recent recording session (with the G3 `capturedMs`), if any. */
  readonly latestSession: (LiveSession & { readonly capturedMs: number | null }) | null;
  /** Σ `durationMs` of STORED chunks, whole meeting. */
  readonly storedMs: number;
  /** Σ `durationMs` of STORED chunks of the latest session. */
  readonly latestSessionStoredMs: number;
  /** Any audio, chunk or text exists (G1: locks the source). */
  readonly hasContent: boolean;
  readonly summaryCount: number;
  readonly host: HostView | null;
  readonly hostVisibleOffered: boolean;
  /** A failed `manual`-policy notice (linked / changed), if any. */
  readonly failedHostNotice: { readonly event: "linked" | "changed" } | null;
  /** What the retry rule needs beyond the meeting row (AC-6.9): `audio.ogg`'s key and the oldest kept source. */
  readonly retry: { readonly audioKey: string | null; readonly oldestSourceAt: Date | null };
}

export interface CanFlags {
  edit: boolean;
  changeSource: boolean;
  changeLanguage: boolean;
  manageParticipants: boolean;
  link: boolean;
  setVisibility: boolean;
  capture: boolean;
  editTranscript: boolean;
  retryProcessing: boolean;
  deleteAudio: boolean;
  deleteMeeting: boolean;
  summarise: boolean;
  ask: boolean;
  retryHostNotice: boolean;
}

export interface MeetingView {
  id: string;
  title: string;
  startsAt: string;
  format: MeetingFormat;
  status: DerivedStatus;
  host: HostView | null;
  summaryCount: number;
  creator: PersonRef;
  language: MeetingLanguage;
  source: MeetingSource;
  stage: ProcessingStage | null;
  failure: { code: string } | null;
  noSpeech: boolean;
  durationMs: number | null;
  role: MeetingRole;
  frozen: boolean | null;
  consent: { by: PersonRef; at: string; noticeVersion: string } | null;
  participants: (
    | { id: string; kind: "operai"; person: PersonRef }
    | { id: string; kind: "external"; name: string; organisation: string | null }
  )[];
  hostVisible: boolean;
  hostVisibleOffered: boolean;
  audio: { state: "kept"; until: string } | { state: "deleted" } | { state: "none" };
  recording: { live: boolean; durationMs: number; lostMs: number | null } | null;
  hostNotice: { state: "failed"; event: "linked" | "changed" } | null;
  transcriptVersion: number;
  capabilities: "resolved" | "unavailable";
  can: CanFlags;
}

// ─── The pure builder ────────────────────────────────────────────────────────

const unknownPerson = (id: string): PersonRef => ({ id, name: null, status: "unknown" });

export function buildMeetingView(input: ViewInput, now: Date): MeetingView {
  const { meeting, role, caller, frozen, latestSession } = input;
  const person = (id: string): PersonRef => {
    const found = input.people.get(id);
    return found ? toPersonRef(found) : unknownPerson(id);
  };

  const status = derivedStatus(meeting.status, latestSession, now);
  const audio = audioState(meeting, now);
  const isCreator = role === "creator";

  const recording: MeetingView["recording"] = latestSession
    ? {
        live: status === "recording",
        durationMs: input.storedMs,
        // The creator's alone (G3); a lower bound, null when the tab never reported.
        lostMs: isCreator ? lostMs(latestSession.capturedMs, input.latestSessionStoredMs) : null,
      }
    : null;

  // ── `can` ──────────────────────────────────────────────────────────────────
  // Creator controls: creator ∧ creator NOT deactivated (unknown = withheld) ∧ meetings:access.
  const creatorOwn = isCreator && frozen === false;
  const creatorControl = creatorOwn && caller.holdsAccess;
  // Summaries and questions do not change the meeting's record: frozen is fine (AC-5.11).
  const entitled = caller.holdsAccess && status === "ready" && !meeting.noSpeech;
  const hasHost = meeting.hostApp !== null;

  const can: CanFlags = {
    edit: creatorControl,
    changeSource: creatorControl && status === "draft" && !input.hasContent,
    changeLanguage: creatorControl && meeting.processingStartedAt === null,
    manageParticipants: creatorControl,
    link: creatorControl,
    setVisibility: creatorControl && hasHost && input.hostVisibleOffered,
    capture: creatorControl && (status === "draft" || status === "recording" || status === "interrupted"),
    editTranscript: creatorControl && status === "ready" && !meeting.noSpeech,
    // The retry route's own rule (AC-6.9): audio kept, or, after a prepare_audio failure, kept sources.
    retryProcessing: creatorControl && status === "failed" && retryResume({ ...input.retry, audioCreatedAt: meeting.audioCreatedAt, audioDeletedAt: meeting.audioDeletedAt }, now) !== null,
    // Removing your own data never depends on a grant (A4), but it never races a live recording or a running job.
    deleteAudio: creatorOwn && audio.state === "kept" && status !== "recording" && status !== "processing",
    deleteMeeting: creatorOwn || caller.holdsErase,
    summarise: entitled,
    ask: entitled,
    retryHostNotice: creatorControl && input.failedHostNotice !== null,
  };

  return {
    id: meeting.id,
    title: meeting.title,
    startsAt: meeting.startsAt.toISOString(),
    format: meeting.format,
    status,
    host: input.host,
    summaryCount: input.summaryCount,
    creator: person(meeting.creatorUserId),
    language: meeting.language,
    source: meeting.source,
    stage: status === "processing" ? meeting.stage : null,
    // On `failed`, and on a `draft` whose uploaded file was refused after processing began (AC-3.2): the reason stays until a new upload is minted.
    failure: (status === "failed" || status === "draft") && meeting.failureCode !== null ? { code: meeting.failureCode } : null,
    noSpeech: meeting.noSpeech,
    durationMs: meeting.durationMs ?? (recording ? recording.durationMs : null),
    role,
    frozen,
    consent:
      meeting.consentUserId !== null && meeting.consentAt !== null && meeting.consentNoticeVersion !== null
        ? { by: person(meeting.consentUserId), at: meeting.consentAt.toISOString(), noticeVersion: meeting.consentNoticeVersion }
        : null,
    participants: input.participants.map((p) =>
      p.userId !== null
        ? { id: p.id, kind: "operai" as const, person: person(p.userId) }
        : { id: p.id, kind: "external" as const, name: p.externalName ?? "", organisation: p.externalOrganisation },
    ),
    hostVisible: meeting.hostVisible,
    hostVisibleOffered: input.hostVisibleOffered,
    audio: audio.state === "kept" ? { state: "kept", until: audio.until.toISOString() } : audio,
    recording,
    hostNotice: isCreator && input.failedHostNotice ? { state: "failed", event: input.failedHostNotice.event } : null,
    transcriptVersion: meeting.transcriptVersion,
    capabilities: caller.capabilities,
    can,
  };
}

// ─── The loader ──────────────────────────────────────────────────────────────

export interface ViewDeps extends VisibilityDeps {
  /** Display lookup (fails soft). */
  readonly resolveIdentities?: typeof liveDisplayIdentities;
}

async function hostViewFor(meeting: MeetingRecord, authorization: string, deps: ViewDeps): Promise<{ host: HostView | null; offered: boolean }> {
  if (meeting.hostApp === null || meeting.hostEntityType === null || meeting.hostEntityId === null) {
    return { host: null, offered: false };
  }
  const ref = { app: meeting.hostApp, entityType: meeting.hostEntityType, entityId: meeting.hostEntityId };
  const definition = (deps.registry ?? hostRegistry()).get(ref.app, ref.entityType);
  const unavailable: HostView = { ...ref, state: "unavailable", title: null, href: null };
  // A host that left the registry cannot label anything.
  if (!definition) return { host: unavailable, offered: false };
  const offered = definition.offersHostVisible;

  // As the caller, live, soft: a label is never worth failing a read for.
  const answer = await (deps.resolveHost ?? resolveAtHost)(definition, authorization, [ref.entityId]);
  if (answer.state === "unavailable") return { host: unavailable, offered };
  const entity = answer.entities.get(ref.entityId);
  if (entity?.state === "open") {
    return { host: { ...ref, state: "open", title: entity.title ?? null, href: entity.href ?? null }, offered };
  }
  return { host: { ...ref, state: entity?.state ?? "unavailable", title: null, href: null }, offered };
}

/**
 * The view of meeting `id` for `caller`, or the identical 404 (AC-5.3).
 * `now` is a parameter so every derived field is testable.
 */
export async function loadMeetingView(id: string, caller: ViewCaller, now: Date, deps: ViewDeps = {}): Promise<MeetingView> {
  const { role } = await openMeeting(id, caller, deps);

  const [row, sessions, chunks, participants, summaryCount, segmentCount, failedNotice] = await Promise.all([
    db.meeting.findUniqueOrThrow({ where: { id } }),
    db.recordingSession.findFirst({ where: { meetingId: id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] }),
    db.recordingChunk.findMany({ where: { meetingId: id }, select: { sessionId: true, durationMs: true, storedAt: true } }),
    db.meetingParticipant.findMany({ where: { meetingId: id }, orderBy: { createdAt: "asc" } }),
    db.summary.count({ where: { meetingId: id } }),
    db.transcriptSegment.count({ where: { meetingId: id } }),
    role === "creator"
      ? db.hostNotice.findFirst({
          where: { meetingId: id, state: "failed", policy: "manual", event: { in: ["linked", "changed"] satisfies NoticeEvent[] } },
          orderBy: { seq: "desc" },
          select: { event: true },
        })
      : Promise.resolve(null),
  ]);

  let storedMs = 0;
  let latestSessionStoredMs = 0;
  for (const chunk of chunks) {
    if (chunk.storedAt === null) continue;
    storedMs += chunk.durationMs;
    if (chunk.sessionId === sessions?.id) latestSessionStoredMs += chunk.durationMs;
  }

  // The creator is looked up uncached and gate-grade: it decides `frozen`, and a
  // deactivated creator must never be shown by a cached name (AC-5.10, AC-5.13).
  let creatorIdentity: Identity | null = null;
  try {
    creatorIdentity = (await (deps.requireIdentities ?? liveIdentities)(caller.authorization, [row.creatorUserId])).get(row.creatorUserId) ?? null;
  } catch {
    creatorIdentity = null;
  }
  const frozen = creatorIdentity?.status === "deleted" ? true : creatorIdentity?.status === "active" ? false : null;

  const personIds = new Set<string>([row.creatorUserId]);
  if (row.consentUserId) personIds.add(row.consentUserId);
  for (const p of participants) if (p.userId) personIds.add(p.userId);
  const people = new Map(await (deps.resolveIdentities ?? liveDisplayIdentities)(caller.authorization, [...personIds]));
  if (creatorIdentity) people.set(row.creatorUserId, creatorIdentity);

  const { host, offered } = await hostViewFor(row, caller.authorization, deps);
  const failedHostNotice = failedNotice && (failedNotice.event === "linked" || failedNotice.event === "changed") ? { event: failedNotice.event } : null;

  return buildMeetingView(
    {
      meeting: row,
      role,
      caller,
      frozen,
      people,
      participants,
      latestSession: sessions,
      storedMs,
      latestSessionStoredMs,
      hasContent: row.audioKey !== null || row.audioCreatedAt !== null || chunks.length > 0 || segmentCount > 0,
      summaryCount,
      host,
      hostVisibleOffered: offered,
      failedHostNotice,
      retry: { audioKey: row.audioKey, oldestSourceAt: row.status === "failed" ? await oldestSourceAt(db, id) : null },
    },
    now,
  );
}

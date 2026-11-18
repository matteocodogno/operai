/**
 * The notice dispatcher (T59; AC-9.7, AC-9.9 to AC-9.15; plan amendment 2026-11-17 G1, G5, G6) against REAL Postgres,
 * with an INJECTED CLOCK and a FAKE notify-api reached through the notify client's own HTTP code (an injected `fetch`
 * that answers like notify-api: 201 then 200 for a repeated idempotency key, 4xx/5xx, a timeout after it stored).
 *
 * The dispatcher claims rows in its own transactions, so these tests need REAL commits, like the "real transactions"
 * groups of `write.routes.test.ts` and `duty.test.ts`: the whole group runs only against a LOCAL database host
 * (`committedTransactionsSkipReason`, T53/F4) and only while the registry holds no version (it seeds versions and, in
 * `afterAll`, removes every row it wrote, turning the append-only triggers off for its own session: acceptable on a
 * throwaway database only). Anywhere else it is skipped, loudly.
 *
 * Only `auth.config` (the session source of the route tests) is mocked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../lib/db";
import { committedTransactionsSkipReason, committedVersionCount, insertSql, validImportRow } from "../testDb";
import { z } from "zod";
import type { LegalEntity } from "../entities";

type FakeSession = { user: { id: string; email: string; name: string }; session: { id: string } } | null;
let currentSession: FakeSession = null;

mock.module("../../auth/auth.config", () => ({
  auth: { api: { getSession: mock(async () => currentSession), handler: mock(async () => new Response("{}")) } },
}));

// ONE module object for the credential and for the calls: other test files `mock.module` the notify client and keep a
// provider of their own, so the token provider must be set on the very instance the calls are made through.
const notifyClient = await import("../../lib/notify");
const notifier = { notification: notifyClient.sendLegalEntityNotification, email: notifyClient.sendLegalEntityEmail };
const dispatcherModule = await import("./dispatcher");
const {
  createNoticeDispatcher,
  retryDelayMs,
  GIVE_UP_AFTER_MS,
  LEASE_MS,
  kickNotices,
  noticeDispatcherStarted,
  RETRY_DELAYS_MINUTES,
  RETRY_REPEAT_MINUTES,
} = dispatcherModule;
const { createLegalEntityRateLimits, createLegalEntityWriteRouter } = await import("../write.routes");
const { emailData, inAppNotice, noticeFacts } = await import("./content");
const { versionOf } = await import("../repo");

// ─── Pure parts (no database) ──────────────────────────────────────────────────────────────────────────────────────

describe("the schedule (plan G6, AC-9.14)", () => {
  test("+1, +3, +5, +10 and +20 minutes after the 1st to 5th failure, then every 30", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((attempts) => retryDelayMs(attempts) / 60_000)).toEqual([1, 3, 5, 10, 20, 30, 30, 30]);
    expect(RETRY_DELAYS_MINUTES).toEqual([1, 3, 5, 10, 20]);
    expect(RETRY_REPEAT_MINUTES).toBe(30);
    expect(GIVE_UP_AFTER_MS).toBe(24 * 3600 * 1000);
  });

  test("the first retry is within 5 minutes of the first failure (AC-9.14)", () => {
    expect(retryDelayMs(1)).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("not started under bun test (plan G6)", () => {
  test("importing the server does not start the dispatcher, and the routes' default kick does nothing", async () => {
    await import("../../index");
    expect(noticeDispatcherStarted()).toBe(false);
    await expect(kickNotices()).resolves.toBeUndefined();
  });

  test("the server's entry starts it only when NODE_ENV is not test, after the notify credential is wired", () => {
    const source = readFileSync(join(import.meta.dir, "../../index.ts"), "utf8");
    expect(source).toMatch(/if \(env\.NODE_ENV !== "test"\) startNoticeDispatcher\(\);/);
    expect(source.indexOf("setNotifyTokenProvider(selfServiceTokenProvider)")).toBeLessThan(source.indexOf("startNoticeDispatcher()"));
  });

  test("the import never reaches the dispatcher or the notice code (AC-9.16)", () => {
    const source = readFileSync(join(import.meta.dir, "../import.ts"), "utf8");
    expect(source).not.toContain("notices/");
  });
});

// ─── Committed fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

const hostSkip = committedTransactionsSkipReason(process.env.DATABASE_URL);
if (hostSkip) console.warn(hostSkip);
const registryIsEmpty = hostSkip === null && (await committedVersionCount()) === 0;
if (hostSkip === null && !registryIsEmpty) {
  console.warn(
    "notices/dispatcher.test.ts: the committed-transaction group is SKIPPED because legal_entity_version already holds rows " +
      "(it needs a database with no registry, and removes its own rows afterwards). Use a fresh test database to run it.",
  );
}
const realSuite = registryIsEmpty ? describe : describe.skip;

const T0 = new Date("2026-11-17T09:12:00.000Z");
const MIN = 60_000;
const RUN_ID = crypto.randomUUID().slice(0, 8);
const createdUserIds = new Set<string>();
const createdRoleIds = new Set<string>();
let counter = 0;

const SENTINEL = {
  legalName: "SentinelLegalNameQx7 SA",
  vat: "CHE-SENTINEL-VAT-0042",
  ibanOld: "CH93SENTINELOLDIBAN7766",
  ibanNew: "CH56SENTINELNEWIBAN5599",
  address: "Sentinel Address Lane 12",
  contacts: "sentinel.contact@example.invalid",
  outside: "outside-sentinel@example.invalid",
  /** The author's account email (D9): allowed only in the J6 places, never in a log line, audit entry, title, subject or key. */
  author: "d9-sentinel-author@operai.test",
  /** The author's display name (D9): allowed nowhere in a notice. */
  displayName: "D9 Sentinel Display Name",
};

async function makeUser(label: string) {
  const user = await db.user.create({
    data: { name: `T59 fixture ${label}`, email: `t59-le-dispatch-${label}-${RUN_ID}-${++counter}@legalentities.test`, entity: null },
  });
  createdUserIds.add(user.id);
  return user;
}

async function makeManager(label: string) {
  const user = await makeUser(label);
  const role = await db.role.create({ data: { name: `t59-le-dispatch-${RUN_ID}-${++counter}` } });
  createdRoleIds.add(role.id);
  await db.permissionRule.create({ data: { roleId: role.id, resource: "legal-entity", action: "manage" } });
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}

interface VersionSeed {
  entity: LegalEntity;
  version: number;
  action: "import" | "save" | "restore";
  restoredFrom?: number | null;
  changedFields: string[];
  iban: string;
  createdAt: Date;
  createdByName?: string | null;
  createdByUserId?: string;
}

async function seedVersion(v: VersionSeed) {
  const by = v.action === "import" ? null : { id: v.createdByUserId ?? "u-seeded", name: v.createdByName === undefined ? SENTINEL.displayName : v.createdByName };
  await db.$executeRaw`
    INSERT INTO legal_entity_version
      ("entity","version","legalName","addressIt","addressEn","vatNumber","iban","contactsIt","contactsEn",
       "action","restoredFrom","changedFields","createdByUserId","createdByName","createdAt")
    VALUES (${v.entity}, ${v.version}, ${SENTINEL.legalName}, ${[SENTINEL.address]}::text[], ${[SENTINEL.address]}::text[],
       ${SENTINEL.vat}, ${v.iban}, ${SENTINEL.contacts}, ${SENTINEL.contacts}, ${v.action},
       ${v.restoredFrom ?? null}, ${v.changedFields}::text[], ${by?.id ?? null}, ${by?.name ?? null}, ${v.createdAt})`;
}

/** welld_ch: v1 import (old IBAN), v2 a save of the IBAN and a contacts line, v3 a restore of v1's name and IBAN; welld_it: v1, v2. */
async function seedRegistry() {
  await seedVersion({ entity: "welld_ch", version: 1, action: "import", changedFields: [], iban: SENTINEL.ibanOld, createdAt: new Date(T0.getTime() - 3_600_000) });
  await seedVersion({ entity: "welld_ch", version: 2, action: "save", changedFields: ["iban", "contacts.en"], iban: SENTINEL.ibanNew, createdAt: T0 });
  await seedVersion({
    entity: "welld_ch",
    version: 3,
    action: "restore",
    restoredFrom: 1,
    changedFields: ["legalName", "iban"],
    iban: SENTINEL.ibanOld,
    createdAt: new Date("2026-07-01T09:12:00Z"),
  });
  await seedVersion({ entity: "welld_it", version: 1, action: "import", changedFields: [], iban: "", createdAt: new Date(T0.getTime() - 3_600_000) });
  await seedVersion({ entity: "welld_it", version: 2, action: "save", changedFields: ["legalName"], iban: "", createdAt: T0 });
}

interface RowSeed {
  entity?: LegalEntity;
  version?: number;
  recipient: string;
  channel: "in_app" | "email";
  createdAt?: Date;
  nextAttemptAt?: Date;
  attempts?: number;
  leaseUntil?: Date | null;
  /** The captured author email; omitted = the sentinel address, null = none on record. */
  authorEmail?: string | null;
}

async function addRow(seed: RowSeed) {
  const createdAt = seed.createdAt ?? T0;
  return db.legalEntityNotice.create({
    data: {
      entity: seed.entity ?? "welld_ch",
      version: seed.version ?? 2,
      recipient: seed.recipient,
      recipientKind: seed.recipient === "outside" ? "outside" : "person",
      channel: seed.channel,
      createdAt,
      nextAttemptAt: seed.nextAttemptAt ?? createdAt,
      ...(seed.attempts !== undefined ? { attempts: seed.attempts } : {}),
      ...(seed.leaseUntil !== undefined ? { leaseUntil: seed.leaseUntil } : {}),
      authorEmail: seed.authorEmail === undefined ? SENTINEL.author : seed.authorEmail,
    },
  });
}

/** Both channels for a person (the shape `duty.ts` writes). */
const addPerson = async (userId: string, over: Partial<RowSeed> = {}) => [
  await addRow({ recipient: userId, channel: "in_app", ...over }),
  await addRow({ recipient: userId, channel: "email", ...over }),
];

const reload = (id: string) => db.legalEntityNotice.findUniqueOrThrow({ where: { id } });
const noticeAudit = () => db.auditLog.findMany({ where: { action: { startsWith: "legal_entity.notice_" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const auditActions = async () => (await noticeAudit()).map((a) => a.action);

// ─── The fake notify-api ───────────────────────────────────────────────────────────────────────────────────────────────

type Behaviour = "ok" | "network" | "store-then-timeout" | { status: number } | { skipped: string } | { failed: string };

interface Call {
  kind: "notification" | "email";
  key: string;
  body: Record<string, unknown>;
  raw: string;
  authorization: string | null;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const NOTIFICATION_KEYS = ["recipientId", "originApp", "severity", "title", "body", "link", "it", "email", "idempotencyKey"];
const EMAIL_KEYS = ["template", "to", "recipientId", "data", "idempotencyKey"];
const DATA_KEYS = ["entity", "action", "restoredFrom", "actorEmail", "storedAt", "version", "protectedChanged", "otherChanged", "iban"];

/** T79's `data.actorEmail`: `z.string().email().max(320).nullable()` (notify-api `emails.schemas.ts`), the very rule. */
const ActorEmailSchema = z.string().email().max(320).nullable();

/** The contract of notify-api's schemas (`notifications.schemas.ts`, `emails.schemas.ts`), strict where they are strict. */
function contractProblem(kind: Call["kind"], body: Record<string, unknown>): string | null {
  const keys = Object.keys(body);
  const key = body["idempotencyKey"];
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) return "idempotencyKey";
  if (kind === "notification") {
    if (keys.some((k) => !NOTIFICATION_KEYS.includes(k))) return "an unknown member";
    if ("email" in body) return "the email is its own call";
    const text = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && v.length <= max;
    const link = body["link"] as { href?: unknown; label?: unknown } | undefined;
    const it = body["it"] as { title?: unknown; body?: unknown } | undefined;
    if (!text(body["recipientId"], 200) || body["originApp"] !== "admin" || !["info", "success", "warning", "error"].includes(String(body["severity"]))) return "envelope";
    if (!text(body["title"], 200) || !text(body["body"], 2000)) return "title or body";
    if (!it || !text(it.title, 200) || !text(it.body, 2000)) return "it";
    if (!link || typeof link.href !== "string" || !link.href.startsWith("/") || link.href.startsWith("//")) return "link";
    if (link.label !== undefined && !text(link.label, 200)) return "link label";
    return null;
  }
  if (keys.some((k) => !EMAIL_KEYS.includes(k))) return "an unknown member";
  if (body["template"] !== "legal_entity_change") return "template";
  if (("to" in body) === ("recipientId" in body)) return "exactly one of to and recipientId";
  const data = body["data"] as Record<string, unknown> | undefined;
  if (!data || Object.keys(data).some((k) => !DATA_KEYS.includes(k))) return "data has an unknown member";
  for (const k of ["entity", "action", "restoredFrom", "actorEmail", "storedAt", "version", "protectedChanged", "otherChanged"]) if (!(k in data)) return `data.${k} missing`;
  if (!["welld_it", "welld_ch"].includes(String(data["entity"]))) return "data.entity";
  if (!ActorEmailSchema.safeParse(data["actorEmail"]).success) return "data.actorEmail";
  if (Number.isNaN(Date.parse(String(data["storedAt"])))) return "data.storedAt";
  const closed = (list: unknown, names: string[], min: number) =>
    Array.isArray(list) && list.length >= min && new Set(list).size === list.length && list.every((n) => names.includes(String(n)));
  if (!closed(data["protectedChanged"], ["legalName", "vatNumber", "iban"], 1)) return "data.protectedChanged";
  if (!closed(data["otherChanged"], ["address.it", "address.en", "contacts.it", "contacts.en"], 0)) return "data.otherChanged";
  if ((data["action"] === "restore") !== (data["restoredFrom"] !== null)) return "data.restoredFrom";
  if (("iban" in data) !== (data["protectedChanged"] as string[]).includes("iban")) return "data.iban presence";
  const token = (t: unknown): boolean => {
    const o = t as { state?: unknown; last4?: unknown };
    if (o.state === "none" || o.state === "set") return Object.keys(o).length === 1;
    return o.state === "tail" && Object.keys(o).length === 2 && /^[A-Z0-9]{4}$/.test(String(o.last4));
  };
  const iban = data["iban"] as { old?: unknown; new?: unknown } | undefined;
  if (iban && (Object.keys(iban).length !== 2 || !token(iban.old) || !token(iban.new))) return "data.iban tokens";
  return null;
}

class FakeNotify {
  calls: Call[] = [];
  /** Created or sent by key, as notify-api's idempotency scope (this caller's) would hold them. */
  stored = new Map<string, Call>();
  behave: (call: Call, n: number) => Behaviour | Promise<Behaviour> = () => "ok";
  latencyMs = 0;
  inFlight = 0;
  maxInFlight = 0;

  reset() {
    this.calls = [];
    this.stored.clear();
    this.behave = () => "ok";
    this.latencyMs = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  storedOf = (kind: Call["kind"]) => [...this.stored.values()].filter((c) => c.kind === kind);
  callsFor = (key: string) => this.calls.filter((c) => c.key === key);

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const kind: Call["kind"] = path === "/system/notifications" ? "notification" : "email";
    if (path !== "/system/notifications" && path !== "/system/emails") return new Response("not found", { status: 404 });
    const raw = String(init?.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const call: Call = { kind, key: String(body["idempotencyKey"]), body, raw, authorization: new Headers(init?.headers).get("authorization") };
    this.calls.push(call);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      if (call.authorization !== "Bearer test-token") return new Response("unauthorised", { status: 401 });
      const problem = contractProblem(kind, body);
      if (problem !== null) return Response.json({ status: 400, detail: problem }, { status: 400 });
      const behaviour = await this.behave(call, this.calls.length);
      if (behaviour === "network") throw new TypeError("Unable to connect");
      if (typeof behaviour === "object" && "status" in behaviour) return new Response("x", { status: behaviour.status });
      if (typeof behaviour === "object" && "skipped" in behaviour) return Response.json({ status: "skipped", reason: behaviour.skipped });
      if (typeof behaviour === "object" && "failed" in behaviour) return Response.json({ status: "failed", reason: behaviour.failed });
      const scoped = `${kind}:${call.key}`;
      const seen = this.stored.has(scoped);
      if (!seen) this.stored.set(scoped, call);
      if (behaviour === "store-then-timeout") throw new DOMException("The operation timed out", "TimeoutError");
      if (kind === "notification") return Response.json({ id: `n-${call.key}` }, { status: seen ? 200 : 201 });
      return Response.json({ deliveryId: `d-${call.key}`, status: "sent" });
    } finally {
      this.inFlight -= 1;
    }
  }) as unknown as typeof fetch;
}

const fake = new FakeNotify();
let clockMs = T0.getTime();
const setClock = (at: Date | number) => void (clockMs = typeof at === "number" ? at : at.getTime());
let outsideAddress: string | undefined = SENTINEL.outside;
let logs: string[] = [];

function makeDispatcher(extra: Partial<Parameters<typeof createNoticeDispatcher>[0]> = {}) {
  return createNoticeDispatcher({
    now: () => new Date(clockMs),
    notifier,
    fetch: fake.fetch,
    outsideAddress: () => outsideAddress,
    log: (event, fields) => void logs.push(`${event} ${JSON.stringify(fields)}`),
    ...extra,
  });
}

const dispatchers: { stop(): void }[] = [];
const track = <T extends { stop(): void }>(d: T): T => {
  dispatchers.push(d);
  return d;
};

async function clearNotices() {
  await db.legalEntityNotice.deleteMany({});
  await db.auditLog.deleteMany({ where: { action: { startsWith: "legal_entity.notice_" } } });
}

async function wipe() {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRawUnsafe("DELETE FROM legal_entity_notice");
    await tx.$executeRawUnsafe("DELETE FROM legal_entity_version");
  });
  await db.auditLog.deleteMany({ where: { targetType: "legal_entity" } });
  await db.auditLog.deleteMany({ where: { actorUserId: { in: Array.from(createdUserIds) } } });
}

realSuite("the dispatcher (committed; the registry and the notices are emptied again afterwards)", () => {
  beforeAll(async () => {
    await wipe();
    await seedRegistry();
    notifyClient.setNotifyTokenProvider({ getToken: async () => "test-token", invalidate: () => {} });
  });
  afterAll(async () => {
    notifyClient.setNotifyTokenProvider(undefined);
    await wipe();
    await db.role.deleteMany({ where: { id: { in: Array.from(createdRoleIds) } } });
    await db.user.deleteMany({ where: { id: { in: Array.from(createdUserIds) } } });
  });
  beforeEach(async () => {
    await clearNotices();
    fake.reset();
    setClock(T0);
    outsideAddress = SENTINEL.outside;
    logs = [];
  });
  afterEach(() => {
    for (const d of dispatchers.splice(0)) d.stop();
  });

  // ─── What is sent ────────────────────────────────────────────────────────────────────────────────────────────────

  describe("delivery (AC-9.11, AC-9.13)", () => {
    test("per person one in-app call (en base, it variant, warning, link) and one email call by recipientId; the outside mailbox by `to`, email only; each with its row's key", async () => {
      const p = await makeUser("deliver");
      const [inApp, email] = await addPerson(p.id);
      const outside = await addRow({ recipient: "outside", channel: "email" });

      await makeDispatcher().sweep();

      expect(fake.calls).toHaveLength(3);
      const facts = noticeFacts((await versionOf("welld_ch", 2))!, await versionOf("welld_ch", 1), SENTINEL.author);
      const notice = inAppNotice(facts);

      const n = fake.calls.find((c) => c.kind === "notification")!;
      expect(n.body).toEqual({
        recipientId: p.id,
        originApp: "admin",
        severity: "warning",
        title: notice.title,
        body: notice.body,
        it: notice.it,
        link: notice.link,
        idempotencyKey: `legal-entity-notice:${inApp!.id}`,
      });
      expect(n.body["title"]).toContain("Legal details of WellD CH changed: IBAN");
      expect(String((n.body["it"] as { title: string }).title)).toContain("Dati legali di WellD CH modificati");
      expect(n.authorization).toBe("Bearer test-token");

      const emails = fake.calls.filter((c) => c.kind === "email");
      const person = emails.find((c) => "recipientId" in c.body)!;
      expect(person.body).toEqual({ template: "legal_entity_change", recipientId: p.id, data: emailData(facts), idempotencyKey: `legal-entity-notice:${email!.id}` });
      const outsideCall = emails.find((c) => "to" in c.body)!;
      expect(outsideCall.body).toEqual({ template: "legal_entity_change", to: SENTINEL.outside, data: emailData(facts), idempotencyKey: `legal-entity-notice:${outside.id}` });
      expect(fake.calls.filter((c) => c.kind === "notification" && c.body["recipientId"] === "outside")).toHaveLength(0);

      for (const id of [inApp!.id, email!.id, outside.id]) {
        expect(await reload(id)).toMatchObject({ status: "delivered", attempts: 1, deliveredAt: T0, leaseUntil: null, firstFailedAt: null });
      }
      // A delivery at the first attempt is not an audit entry (plan G6).
      expect(await noticeAudit()).toHaveLength(0);
      expect(logs.filter((l) => l.startsWith("legal_entity_notice_delivered"))).toHaveLength(3);
    });

    test("a restore says so, and its email data names the version it copied", async () => {
      const p = await makeUser("restore");
      await addPerson(p.id, { version: 3 });
      await makeDispatcher().sweep();
      expect(fake.calls).toHaveLength(2);
      const note = fake.calls.find((c) => c.kind === "notification")!;
      expect(String(note.body["body"])).toContain(`Version 1 restored by the account ${SENTINEL.author}.`);
      expect(String(note.body["body"])).toContain("When: 1 July 2026, 11:12 CEST (Europe/Zurich).");
      expect((note.body["it"] as { body: string }).body).toContain(`Versione 1 ripristinata dall'account ${SENTINEL.author}.`);
      const email = fake.calls.find((c) => c.kind === "email")!;
      expect(email.body["data"]).toMatchObject({ action: "restore", restoredFrom: 1, version: 3, protectedChanged: ["legalName", "iban"] });
    });

    test("the other entity: its label and link", async () => {
      const p = await makeUser("it");
      await addRow({ entity: "welld_it", version: 2, recipient: p.id, channel: "in_app" });
      await makeDispatcher().sweep();
      const call = fake.calls[0]!;
      expect(String(call.body["title"])).toBe("Legal details of WellD IT changed: legal name");
      expect(call.body["link"]).toEqual({ href: "/admin/legal-entities?entity=welld_it&view=history", label: "Open the history" });
    });
  });

  describe("the kick, the sweep and the restart (AC-9.7, AC-9.14)", () => {
    // These saves are stored by the real clock: the dispatcher's clock is a moment just after "now", so their rows are due.
    beforeEach(() => setClock(Date.now() + 5000));
    const manager = async () => {
      const user = await makeManager("route");
      currentSession = { user: { id: user.id, email: user.email, name: user.name }, session: { id: `sess-${user.id}` } };
      return user;
    };
    const DETAILS = {
      legalName: "Route Test SA",
      address: { it: ["Via Prova 1"], en: ["Via Prova 1"] },
      vatNumber: "CHE-111.222.333",
      iban: "CH9300762011623852957",
      contacts: { it: "", en: "" },
    };
    const saveVia = (router: ReturnType<typeof createLegalEntityWriteRouter>, baseVersion: number, details: object) =>
      router.request("/legal-entities/welld_ch/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion, details }),
      });
    const routerWith = (kick: () => unknown) =>
      createLegalEntityWriteRouter({ limits: createLegalEntityRateLimits({ writeLimit: 1_000_000, checkLimit: 1_000_000 }), notices: { kick } });

    /** A registry the route can save into: this group's own, one entity version further than the seeded ones. */
    async function routeBase(): Promise<number> {
      const latest = await db.legalEntityVersion.findMany({ where: { entity: "welld_ch" }, orderBy: { version: "desc" }, take: 1 });
      return latest[0]!.version;
    }

    test("the kick after a real protected save hands the rows over at once and the notice is delivered; the answer does not wait for notify-api", async () => {
      const actor = await manager();
      const dispatcher = makeDispatcher();
      let kicked: Promise<void> = Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      fake.behave = async (): Promise<Behaviour> => {
        await gate;
        return "ok";
      };

      const res = await saveVia(routerWith(() => (kicked = dispatcher.kick())), await routeBase(), { ...DETAILS, iban: "CH5604835012345678009" });
      // The answer is here while notify-api has not answered a single call (the gate is shut).
      expect(res.status).toBe(201);
      await Bun.sleep(30);
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(fake.stored.size).toBe(0);
      const rowsAfterAnswer = await db.legalEntityNotice.findMany({ where: { recipient: actor.id } });
      expect(rowsAfterAnswer.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);

      release();
      await kicked;
      const rows = await db.legalEntityNotice.findMany({ where: { recipient: actor.id } });
      expect(rows.every((r) => r.status === "delivered")).toBe(true);
      expect(fake.storedOf("notification").some((c) => c.body["recipientId"] === actor.id)).toBe(true);
    });

    test("notify-api down: the save answers exactly as with it up, and the rows stay for the retries", async () => {
      await manager();
      const dispatcher = makeDispatcher();
      const kicks: Promise<void>[] = [];
      const router = routerWith(() => kicks.push(dispatcher.kick()));

      fake.behave = () => "network";
      const base = await routeBase();
      const down = await saveVia(router, base, { ...DETAILS, iban: "DE89370400440532013000" });
      await Promise.all(kicks);
      fake.behave = () => "ok";
      const up = await saveVia(router, base + 1, { ...DETAILS, iban: "GB82WEST12345698765432" });
      await Promise.all(kicks);

      expect([down.status, up.status]).toEqual([201, 201]);
      for (const name of ["content-type", "cache-control"]) expect(down.headers.get(name)).toBe(up.headers.get(name));
      const shape = async (r: Response) => {
        const body = (await r.json()) as { version: number; created: boolean; entity: Record<string, unknown> };
        const { iban: _iban, ibanPrint: _print, updatedAt: _at, version: _version, ...rest } = body.entity;
        return { created: body.created, keys: Object.keys(body), rest };
      };
      expect(await shape(down)).toEqual(await shape(up));
      // The down case left its rows for the retries; nothing was lost.
      const pending = await db.legalEntityNotice.findMany({ where: { version: base + 1, entity: "welld_ch" } });
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((r) => r.status === "pending" && r.lastReason === "notify_unreachable")).toBe(true);
    });

    test("a lost kick is covered by the next sweep, the timer's, within the interval; a restart sweeps on start", async () => {
      const actor = await manager();
      // No kick at all (a lost one).
      const res = await saveVia(routerWith(() => undefined), await routeBase(), { ...DETAILS, iban: "FR1420041010050500013M02606" });
      expect(res.status).toBe(201);
      const mine = () => db.legalEntityNotice.findMany({ where: { recipient: actor.id } });
      expect((await mine()).every((r) => r.status === "pending")).toBe(true);

      const dispatcher = track(makeDispatcher({ sweepIntervalMs: 40 }));
      expect(dispatcher.running).toBe(false);
      dispatcher.start();
      expect(dispatcher.running).toBe(true);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !(await mine()).every((r) => r.status === "delivered")) await Bun.sleep(20);
      expect((await mine()).every((r) => r.status === "delivered")).toBe(true);

      // The timer keeps sweeping: a row added later is picked up without any kick.
      // Stored "now" by the real clock: a fixed T0 here would age past the 24 h give-up as the real date moves on.
      const late = await addRow({ recipient: (await makeUser("late")).id, channel: "in_app", createdAt: new Date() });
      const until = Date.now() + 3000;
      while (Date.now() < until && (await reload(late.id)).status !== "delivered") await Bun.sleep(20);
      expect((await reload(late.id)).status).toBe("delivered");
      dispatcher.stop();
      expect(dispatcher.running).toBe(false);
    });

    test("a new dispatcher instance (a restart) sends the rows the old one left pending", async () => {
      const p = await makeUser("restart");
      const [row] = await addPerson(p.id);
      setClock(T0);
      fake.behave = () => "network";
      await makeDispatcher().sweep(); // the first process: notify-api is down, then the process "dies"
      expect((await reload(row!.id)).status).toBe("pending");

      fake.behave = () => "ok";
      setClock(T0.getTime() + MIN); // the first retry is due
      const second = track(makeDispatcher({ sweepIntervalMs: 1_000_000 }));
      second.start(); // sweeps on start
      second.stop();
      const until = Date.now() + 3000;
      while (Date.now() < until && (await reload(row!.id)).status !== "delivered") await Bun.sleep(20);
      expect(await reload(row!.id)).toMatchObject({ status: "delivered", attempts: 2 });
    });

    test("a kick during a run is not lost: the run looks again before it ends", async () => {
      const first = await makeUser("again-1");
      const second = await makeUser("again-2");
      await addRow({ recipient: first.id, channel: "in_app", createdAt: new Date() });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      fake.behave = async (call): Promise<Behaviour> => {
        if (call.body["recipientId"] === first.id) await gate;
        return "ok";
      };
      const dispatcher = makeDispatcher();
      const run1 = dispatcher.kick();
      await Bun.sleep(30);
      const late = await addRow({ recipient: second.id, channel: "in_app", createdAt: new Date() });
      const run2 = dispatcher.kick();
      release();
      await Promise.all([run1, run2]);
      expect((await reload(late.id)).status).toBe("delivered");
    });
  });

  // ─── Retries ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe("retries (AC-9.14, AC-9.15)", () => {
    test("the schedule: first retry at +1 min, then +3, +5, +10, +20, then every 30 min; given up at 24 h; one notice_failed and one notice_given_up", async () => {
      const p = await makeUser("schedule");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      fake.behave = () => ({ status: 503 });
      const dispatcher = makeDispatcher();

      const attemptsAt: number[] = [];
      for (let guard = 0; guard < 200; guard++) {
        const before = fake.calls.length;
        await dispatcher.sweep();
        if (fake.calls.length > before) attemptsAt.push((clockMs - T0.getTime()) / MIN);
        const now = await reload(row.id);
        if (now.status === "given_up") break;
        // Not due a second early: nothing is sent one second before nextAttemptAt.
        setClock(now.nextAttemptAt.getTime() - 1000);
        const calls = fake.calls.length;
        await dispatcher.sweep();
        expect(fake.calls.length).toBe(calls);
        setClock(now.nextAttemptAt);
      }

      expect(attemptsAt.slice(0, 7)).toEqual([0, 1, 4, 9, 19, 39, 69]);
      for (let i = 6; i < attemptsAt.length; i++) expect(attemptsAt[i]! - attemptsAt[i - 1]!).toBe(30);
      const last = await reload(row.id);
      expect(last).toMatchObject({ status: "given_up", lastReason: "notify_error", givenUpAt: new Date(T0.getTime() + GIVE_UP_AFTER_MS), leaseUntil: null });
      expect(attemptsAt.at(-1)!).toBeLessThan(24 * 60);
      expect(fake.calls).toHaveLength(attemptsAt.length);
      // Every attempt carried the same key: the receiver can make the repeat safe.
      expect(new Set(fake.calls.map((c) => c.key))).toEqual(new Set([`legal-entity-notice:${row.id}`]));
      // Exactly one notice_failed (the first failure), then one notice_given_up.
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_given_up"]);
      const [failed, gaveUp] = await noticeAudit();
      expect(failed!.data).toEqual({ version: 2, recipient: "person", userId: p.id, channel: "in_app", reason: "notify_error", at: T0.toISOString() });
      expect(gaveUp!.data).toEqual({ version: 2, recipient: "person", userId: p.id, channel: "in_app", reason: "notify_error", at: new Date(T0.getTime() + GIVE_UP_AFTER_MS).toISOString() });
      expect(gaveUp).toMatchObject({ actorUserId: null, targetType: "legal_entity", targetId: "welld_ch" });
      expect((await reload(row.id)).firstFailedAt).toEqual(T0);
    });

    test("a failure that ends after the 24 h gives the row up with its own reason", async () => {
      const p = await makeUser("late-failure");
      const row = await addRow({ recipient: p.id, channel: "email", nextAttemptAt: new Date(T0.getTime() + GIVE_UP_AFTER_MS - MIN) });
      setClock(T0.getTime() + GIVE_UP_AFTER_MS - MIN);
      fake.behave = () => {
        setClock(T0.getTime() + GIVE_UP_AFTER_MS + 1000); // the call outlasts the deadline
        return { status: 429 };
      };
      await makeDispatcher().sweep();
      expect(await reload(row.id)).toMatchObject({ status: "given_up", lastReason: "notify_refused" });
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_given_up"]);
    });

    test("a row never attempted within 24 h (the dispatcher was down) is given up as expired, nothing sent", async () => {
      const p = await makeUser("expired");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      setClock(T0.getTime() + GIVE_UP_AFTER_MS + 5 * 3600_000);
      await makeDispatcher().sweep();
      expect(fake.calls).toHaveLength(0);
      expect(await reload(row.id)).toMatchObject({ status: "given_up", lastReason: "expired", attempts: 1 });
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_given_up"]);
      expect(((await noticeAudit())[0]!.data as { reason: string }).reason).toBe("expired");
    });

    test("a row that had failed and is found past 24 h is given up with its last reason, nothing sent", async () => {
      const p = await makeUser("expired-after-failure");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      fake.behave = () => ({ status: 500 });
      const dispatcher = makeDispatcher();
      await dispatcher.sweep();
      fake.reset();
      setClock(T0.getTime() + GIVE_UP_AFTER_MS + 3600_000);
      await dispatcher.sweep();
      expect(fake.calls).toHaveLength(0);
      expect(await reload(row.id)).toMatchObject({ status: "given_up", lastReason: "notify_error" });
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_given_up"]);
    });

    test("failed more than once, then delivered: one notice_failed, one notice_delivered", async () => {
      const p = await makeUser("then-ok");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      const dispatcher = makeDispatcher();
      fake.behave = () => ({ status: 500 });
      await dispatcher.sweep();
      setClock(T0.getTime() + MIN);
      await dispatcher.sweep();
      setClock(T0.getTime() + 4 * MIN);
      fake.behave = () => "ok";
      await dispatcher.sweep();
      expect(await reload(row.id)).toMatchObject({ status: "delivered", attempts: 3, deliveredAt: new Date(T0.getTime() + 4 * MIN) });
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_delivered"]);
      const [, delivered] = await noticeAudit();
      expect(delivered!.data).toEqual({ version: 2, recipient: "person", userId: p.id, channel: "in_app", at: new Date(T0.getTime() + 4 * MIN).toISOString() });
    });

    test("a timeout after notify-api stored, then an idempotent 200: one notification, the same key both times", async () => {
      const p = await makeUser("timeout");
      const [inApp] = await addPerson(p.id);
      let first = true;
      fake.behave = (call) => {
        if (call.kind === "notification" && first) {
          first = false;
          return "store-then-timeout";
        }
        return "ok";
      };
      const dispatcher = makeDispatcher();
      await dispatcher.sweep();
      expect(await reload(inApp!.id)).toMatchObject({ status: "pending", lastReason: "notify_unreachable", attempts: 1 });
      expect(fake.storedOf("notification")).toHaveLength(1); // notify-api has it already

      setClock(T0.getTime() + MIN);
      await dispatcher.sweep();
      expect(await reload(inApp!.id)).toMatchObject({ status: "delivered", attempts: 2 });
      const repeats = fake.callsFor(`legal-entity-notice:${inApp!.id}`);
      expect(repeats).toHaveLength(2);
      expect(fake.storedOf("notification")).toHaveLength(1); // still one notification: the repeat answered 200
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_delivered"]);
    });

    test("a real timeout: notify-api that never answers does not hold the sweep past the call's timeout", async () => {
      const p = await makeUser("real-timeout");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      const hanging = (async (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
        })) as unknown as typeof fetch;
      const started = Date.now();
      await makeDispatcher({ fetch: hanging, sendTimeoutMs: 50 }).sweep();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await reload(row.id)).toMatchObject({ status: "pending", lastReason: "notify_unreachable" });
    });

    test("`skipped` answers are failures with their reason and are retried; one notice_failed, then notice_delivered", async () => {
      const p = await makeUser("skipped");
      const [, email] = await addPerson(p.id);
      const answers: Behaviour[] = [{ skipped: "recipient_inactive" }, { skipped: "not_configured" }, { failed: "contact_lookup_failed" }, "ok"];
      fake.behave = (call) => (call.kind === "email" ? answers.shift()! : "ok");
      const dispatcher = makeDispatcher();
      const reasons: (string | null)[] = [];
      for (const minutes of [0, 1, 4, 9]) {
        setClock(T0.getTime() + minutes * MIN);
        await dispatcher.sweep();
        reasons.push((await reload(email!.id)).lastReason);
      }
      expect(reasons).toEqual(["recipient_inactive", "email_not_configured", "notify_error", "notify_error"]);
      expect(await reload(email!.id)).toMatchObject({ status: "delivered", attempts: 4 });
      expect((await noticeAudit()).filter((a) => a.action === "legal_entity.notice_failed")).toHaveLength(1);
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_delivered"]);
    });

    test("an old notify-api that answers 400 to the new template is retried like any failure (G15)", async () => {
      const p = await makeUser("old-notify");
      const [, email] = await addPerson(p.id);
      fake.behave = (call) => (call.kind === "email" ? { status: 400 } : "ok");
      const dispatcher = makeDispatcher();
      await dispatcher.sweep();
      expect(await reload(email!.id)).toMatchObject({ status: "pending", lastReason: "notify_refused" });
      fake.behave = () => "ok";
      setClock(T0.getTime() + MIN);
      await dispatcher.sweep();
      expect((await reload(email!.id)).status).toBe("delivered");
    });
  });

  // ─── Independence, leases, concurrency ──────────────────────────────────────────────────────────────────────────────

  describe("one call per row, however many dispatchers (AC-9.14)", () => {
    test("one recipient's failure does not delay another's call (they are sent side by side)", async () => {
      const a = await makeUser("slow-fail");
      const b = await makeUser("fast");
      const rowA = await addRow({ recipient: a.id, channel: "in_app" });
      const rowB = await addRow({ recipient: b.id, channel: "in_app" });
      let bCalledWhileAWaits = false;
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => (releaseA = resolve));
      fake.behave = async (call) => {
        if (call.body["recipientId"] === a.id) {
          await Promise.race([gateA, Bun.sleep(1500)]);
          bCalledWhileAWaits = fake.calls.some((c) => c.body["recipientId"] === b.id);
          return { status: 500 };
        }
        releaseA();
        return "ok";
      };
      await makeDispatcher().sweep();
      expect(bCalledWhileAWaits).toBe(true);
      expect(await reload(rowA.id)).toMatchObject({ status: "pending", lastReason: "notify_error" });
      expect((await reload(rowB.id)).status).toBe("delivered");
    });

    test("a failing channel does not stop the other channel of the same person", async () => {
      const p = await makeUser("channels");
      const [inApp, email] = await addPerson(p.id);
      fake.behave = (call) => (call.kind === "email" ? { status: 500 } : "ok");
      await makeDispatcher().sweep();
      expect((await reload(inApp!.id)).status).toBe("delivered");
      expect(await reload(email!.id)).toMatchObject({ status: "pending", lastReason: "notify_error" });
    });

    test("never more than four calls at once", async () => {
      for (let i = 0; i < 12; i++) await addRow({ recipient: (await makeUser(`wide-${i}`)).id, channel: "in_app" });
      fake.latencyMs = 20;
      await makeDispatcher().sweep();
      expect(fake.calls).toHaveLength(12);
      expect(fake.maxInFlight).toBeLessThanOrEqual(4);
      expect(fake.maxInFlight).toBeGreaterThan(1);
    });

    test("two dispatchers on one database: one call per row, every row delivered once", async () => {
      for (let i = 0; i < 20; i++) await addPerson((await makeUser(`pair-${i}`)).id);
      fake.latencyMs = 5;
      const a = makeDispatcher({ batchSize: 4 });
      const b = makeDispatcher({ batchSize: 4 });
      await Promise.all([a.sweep(), b.sweep(), a.kick(), b.kick()]);
      const rows = await db.legalEntityNotice.findMany();
      expect(rows).toHaveLength(40);
      expect(fake.calls).toHaveLength(40);
      expect(new Set(fake.calls.map((c) => c.key)).size).toBe(40);
      expect(rows.every((r) => r.status === "delivered" && r.attempts === 1)).toBe(true);
    });

    test("two separate processes' worth of claims never take the same row (the statement itself, not the in-process guard)", async () => {
      // Two dispatchers with a one-row batch and no in-process serialisation between them.
      for (let i = 0; i < 12; i++) await addRow({ recipient: (await makeUser(`claim-${i}`)).id, channel: "in_app" });
      fake.latencyMs = 3;
      await Promise.all(Array.from({ length: 4 }, () => makeDispatcher({ batchSize: 1 }).sweep()));
      expect(fake.calls).toHaveLength(12);
      expect(new Set(fake.calls.map((c) => c.key)).size).toBe(12);
    });

    test("a row leased by another process is left alone until its lease runs out, then taken (a crashed owner)", async () => {
      const p = await makeUser("lease");
      const row = await addRow({ recipient: p.id, channel: "in_app", attempts: 1, leaseUntil: new Date(T0.getTime() + LEASE_MS) });
      const dispatcher = makeDispatcher();
      setClock(T0.getTime() + LEASE_MS - 1000);
      await dispatcher.sweep();
      expect(fake.calls).toHaveLength(0);
      setClock(T0.getTime() + LEASE_MS + 1000);
      await dispatcher.sweep();
      expect(fake.calls).toHaveLength(1);
      expect(await reload(row.id)).toMatchObject({ status: "delivered", attempts: 2 });
    });

    test("a claimed row carries a 60 s lease while it is sent, so a sweep on another replica leaves it", async () => {
      const p = await makeUser("lease-while-sending");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let during: Awaited<ReturnType<typeof reload>> | undefined;
      fake.behave = async (): Promise<Behaviour> => {
        during = await reload(row.id);
        await gate;
        return "ok";
      };
      const first = makeDispatcher().sweep();
      await Bun.sleep(50);
      setClock(T0.getTime() + 30_000);
      await makeDispatcher().sweep(); // another replica, 30 s later: the lease holds
      expect(fake.calls).toHaveLength(1);
      release();
      await first;
      expect(during).toMatchObject({ attempts: 1, leaseUntil: new Date(T0.getTime() + LEASE_MS) });
    });

    test("a row not yet due, and rows already delivered or given up, are not touched", async () => {
      const [a, b, c] = [await makeUser("n-1"), await makeUser("n-2"), await makeUser("n-3")];
      const notDue = await addRow({ recipient: a.id, channel: "in_app", nextAttemptAt: new Date(T0.getTime() + 5 * MIN) });
      const done = await addRow({ recipient: b.id, channel: "in_app" });
      const gone = await addRow({ recipient: c.id, channel: "in_app" });
      await db.legalEntityNotice.update({ where: { id: done.id }, data: { status: "delivered", deliveredAt: T0, authorEmail: null } });
      await db.legalEntityNotice.update({ where: { id: gone.id }, data: { status: "given_up", givenUpAt: T0, authorEmail: null } });
      await makeDispatcher().sweep();
      expect(fake.calls).toHaveLength(0);
      expect((await reload(notDue.id)).attempts).toBe(0);
    });
  });

  // ─── Recipients and the outside mailbox ───────────────────────────────────────────────────────────────────────────────

  describe("recipients at send time (AC-9.8, AC-9.10)", () => {
    test("a person deleted after the version was stored is never sent to: given up, recipient_deleted, audited", async () => {
      const gone = await makeUser("deleted");
      const hard = `ghost-${RUN_ID}`;
      const stays = await makeUser("stays");
      const goneRows = await addPerson(gone.id);
      const ghostRows = await addPerson(hard);
      const stayRows = await addPerson(stays.id);
      await db.user.update({ where: { id: gone.id }, data: { deletedAt: new Date(T0.getTime() - 1000) } });
      await makeDispatcher().sweep();
      expect(fake.calls.map((c) => c.body["recipientId"])).toEqual(expect.arrayContaining([stays.id]));
      expect(fake.calls.every((c) => c.body["recipientId"] === stays.id)).toBe(true);
      expect(fake.calls).toHaveLength(2);
      for (const row of [...goneRows, ...ghostRows]) expect(await reload(row.id)).toMatchObject({ status: "given_up", lastReason: "recipient_deleted", attempts: 1 });
      for (const row of stayRows) expect((await reload(row.id)).status).toBe("delivered");
      const audit = await noticeAudit();
      expect(audit.filter((a) => a.action === "legal_entity.notice_failed")).toHaveLength(4);
      expect(audit.filter((a) => a.action === "legal_entity.notice_given_up")).toHaveLength(4);
      expect(audit.every((a) => (a.data as { reason?: string }).reason === "recipient_deleted")).toBe(true);
    });

    test("the outside mailbox: the address is read when the row is sent, and an unset one gives the row up as outside_address_unset", async () => {
      const first = await addRow({ recipient: "outside", channel: "email" });
      const second = await addRow({ recipient: "outside", channel: "email", version: 3, createdAt: T0, nextAttemptAt: T0 });
      const dispatcher = makeDispatcher();
      outsideAddress = "first-address@example.invalid";
      await dispatcher.sweep();
      // Both rows were due; the first sweep sent both to the address set then.
      expect(fake.calls.map((c) => c.body["to"])).toEqual(["first-address@example.invalid", "first-address@example.invalid"]);

      // A new row, the variable unset between store and send:
      const third = await addRow({ recipient: "outside", channel: "email", entity: "welld_it", version: 2 });
      outsideAddress = undefined;
      fake.calls = [];
      await dispatcher.sweep();
      expect(fake.calls).toHaveLength(0);
      expect(await reload(third.id)).toMatchObject({ status: "given_up", lastReason: "outside_address_unset", attempts: 1 });
      expect(await auditActions()).toEqual(["legal_entity.notice_failed", "legal_entity.notice_given_up"]);
      const [failed] = await noticeAudit();
      expect(failed!.data).toEqual({ version: 2, recipient: "outside", channel: "email", reason: "outside_address_unset", at: T0.toISOString() });
      expect([(await reload(first.id)).status, (await reload(second.id)).status]).toEqual(["delivered", "delivered"]);
    });
  });

  // ─── AC-9.12: no value anywhere ──────────────────────────────────────────────────────────────────────────────────────

  describe("no value anywhere (AC-9.12)", () => {
    test("the sentinel name, VAT number, addresses, contacts and IBANs, and the outside address, are in no row, audit entry or log line, and in no request but the tails and the one `to`", async () => {
      const p = await makeUser("sentinel");
      const gone = await makeUser("sentinel-gone");
      await addPerson(p.id, { version: 2 });
      await addPerson(p.id, { version: 3 });
      await addPerson(gone.id, { version: 2 });
      await addRow({ recipient: "outside", channel: "email" });
      await db.user.update({ where: { id: gone.id }, data: { deletedAt: T0 } });
      // Some failures, some deliveries, one give-up: every kind of record.
      let n = 0;
      fake.behave = () => (++n % 3 === 0 ? { status: 500 } : n % 5 === 0 ? "network" : "ok");
      const dispatcher = makeDispatcher();
      for (const minutes of [0, 1, 4, 9, 19, 39]) {
        setClock(T0.getTime() + minutes * MIN);
        await dispatcher.sweep();
      }
      setClock(T0.getTime() + GIVE_UP_AFTER_MS + 1);
      await dispatcher.sweep();

      const forbidden = [
        SENTINEL.legalName,
        "SentinelLegalName",
        SENTINEL.vat,
        SENTINEL.address,
        SENTINEL.contacts,
        SENTINEL.ibanOld,
        SENTINEL.ibanNew,
        SENTINEL.ibanOld.slice(0, -4),
        SENTINEL.ibanNew.slice(0, -4),
        // D9: no display name anywhere (the versions and the notices' recipients were seeded with it).
        SENTINEL.displayName,
        "Sentinel Display",
      ];
      const requests = fake.calls.map((c) => c.raw).join("\n");
      const stored = JSON.stringify(await db.legalEntityNotice.findMany());
      const audit = JSON.stringify(await noticeAudit());
      const logged = logs.join("\n");
      expect(fake.calls.length).toBeGreaterThan(5);
      for (const [where, text] of [["a request", requests], ["a row", stored], ["an audit entry", audit], ["a log line", logged]] as const) {
        for (const value of forbidden) expect([where, value, text.includes(value)]).toEqual([where, value, false]);
        if (where !== "a request") expect([where, text.includes(SENTINEL.outside)]).toEqual([where, false]);
      }
      // D9: the author's address is notice content only (plan J6). Rows hold it (the outbox column); no audit entry or
      // log line does; and no request carries it outside a body (in-app `body`, `it.body`) or the email's `actorEmail`.
      expect(audit).not.toContain(SENTINEL.author);
      expect(logged).not.toContain(SENTINEL.author);
      // Every row is terminal after the sweeps, so the stored rows no longer hold it (D9-1); the sends did carry it.
      expect(stored).not.toContain(SENTINEL.author);
      expect(fake.calls.some((c) => c.raw.includes(SENTINEL.author))).toBe(true);
      const bodiesOnly = fake.calls.map((c) => {
        const copy = JSON.parse(c.raw) as Record<string, any>;
        if (c.kind === "notification") {
          delete copy["body"];
          delete copy["it"].body;
        } else {
          delete copy["data"].actorEmail;
        }
        return JSON.stringify(copy);
      });
      for (const text of bodiesOnly) expect(text).not.toContain(SENTINEL.author);
      const withAuthor = fake.calls.filter((c) => c.raw.includes(SENTINEL.author));
      expect(withAuthor.length).toBeGreaterThan(0);
      expect(fake.calls.filter((c) => c.kind === "notification").every((c) => String(c.body["title"]).includes("@") === false)).toBe(true);
      // What a notice may carry of an IBAN is there: the last four characters.
      expect(requests).toContain("7766");
      expect(requests).toContain("5599");
      // The address is in the one place it belongs: the outside email's `to`.
      const withAddress = fake.calls.filter((c) => c.raw.includes(SENTINEL.outside));
      expect(withAddress.length).toBeGreaterThan(0);
      expect(withAddress.every((c) => c.kind === "email" && c.body["to"] === SENTINEL.outside)).toBe(true);
      // Nor the token, in any record.
      for (const text of [stored, audit, logged]) expect(text).not.toContain("test-token");
    });

    test("the log lines name the row, the entity, the version, the channel and a closed reason, nothing else", async () => {
      const p = await makeUser("logs");
      const [row] = await addPerson(p.id);
      fake.behave = () => ({ status: 500 });
      await makeDispatcher().sweep();
      const failed = logs.find((l) => l.startsWith("legal_entity_notice_failed") && l.includes(row!.id))!;
      expect(JSON.parse(failed.slice(failed.indexOf("{")))).toEqual({ id: row!.id, entity: "welld_ch", version: 2, channel: "in_app", reason: "notify_error", attempts: 1 });
    });

    test("a version whose notice cannot be built is logged by its error class only and left to the lease and the 24 h", async () => {
      const p = await makeUser("unbuildable");
      // Version 1 of welld_it is an import: a notice for it is a fault (AC-9.16), never a value in a log.
      const row = await addRow({ entity: "welld_it", version: 1, recipient: p.id, channel: "in_app", createdAt: new Date(T0.getTime() - 1000) });
      await makeDispatcher().sweep();
      expect(fake.calls).toHaveLength(0);
      const line = logs.find((l) => l.startsWith("legal_entity_notice_error"))!;
      expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual({ id: row.id, entity: "welld_it", version: 1, channel: "in_app", error: "NoticeContentError" });
      expect(await reload(row.id)).toMatchObject({ status: "pending", attempts: 1 });
      // A day later it is given up, not retried for ever.
      setClock(T0.getTime() + GIVE_UP_AFTER_MS);
      await makeDispatcher().sweep();
      expect((await reload(row.id)).status).toBe("given_up");
    });
  });

  // ─── D9: the notice states the captured author email ────────────────────────────────────────────────────────────────

  describe("the author's account email (AC-9.11, AC-9.12, AC-9.13; plan D9 J4, J6, J8, R-D9a)", () => {
    const emailOf = (call: Call) => (call.body["data"] as { actorEmail: string | null }).actorEmail;
    const logFor = (event: string) => logs.filter((l) => l.startsWith(event));

    test("the in-app body (en, it) and the email data state the row's address, once; titles, keys and links never do; the outside row's data carries the same address", async () => {
      const p = await makeUser("author");
      await addPerson(p.id);
      await addRow({ recipient: "outside", channel: "email" });
      await makeDispatcher().sweep();

      const note = fake.calls.find((c) => c.kind === "notification")!;
      expect(String(note.body["body"]).split("\n")[1]).toBe(`Change saved by the account ${SENTINEL.author}.`);
      const it = note.body["it"] as { title: string; body: string };
      expect(it.body.split("\n")[1]).toBe(`Modifica salvata dall'account ${SENTINEL.author}.`);
      expect(String(note.body["body"]).split(SENTINEL.author)).toHaveLength(2);
      expect(it.body.split(SENTINEL.author)).toHaveLength(2);
      expect([note.body["title"], it.title, note.body["link"], note.body["idempotencyKey"]].join("\n")).not.toContain(SENTINEL.author);

      const emails = fake.calls.filter((c) => c.kind === "email");
      expect(emails).toHaveLength(2);
      expect(emails.map(emailOf)).toEqual([SENTINEL.author, SENTINEL.author]);
      expect(emails.some((c) => "to" in c.body)).toBe(true);
      for (const call of emails) {
        expect(JSON.stringify({ ...(call.body["data"] as object), actorEmail: null })).not.toContain(SENTINEL.author);
        expect(String(call.body["idempotencyKey"])).not.toContain(SENTINEL.author);
        expect(call.raw).not.toContain(SENTINEL.displayName);
        expect(call.body["data"]).not.toHaveProperty("actorName");
      }
      expect(logs.join("\n")).not.toContain(SENTINEL.author);
    });

    test("a row with no address on record (null) sends null and the no-email sentence in both languages, and is delivered", async () => {
      const p = await makeUser("noemail");
      const rows = await addPerson(p.id, { authorEmail: null });
      await makeDispatcher().sweep();
      const note = fake.calls.find((c) => c.kind === "notification")!;
      expect(String(note.body["body"]).split("\n")[1]).toBe("Change saved by an account with no email address on record.");
      expect((note.body["it"] as { body: string }).body.split("\n")[1]).toBe("Modifica salvata da un account senza indirizzo email registrato.");
      expect(emailOf(fake.calls.find((c) => c.kind === "email")!)).toBeNull();
      for (const row of rows) expect((await reload(row.id)).status).toBe("delivered");
      expect(logFor("legal_entity_notice_author_email_unusable")).toHaveLength(0);
    });

    test("an unusable stored address (R-D9a) is sent as null, once per attempt a line WITHOUT the value, and the row is delivered, not refused in a loop", async () => {
      const p = await makeUser("unusable");
      const BAD = "not an email, d9-bad-author-value";
      const [inApp, email] = await addPerson(p.id, { authorEmail: BAD });
      const outside = await addRow({ recipient: "outside", channel: "email", authorEmail: `${BAD}\nBcc: x@y.z` });
      await makeDispatcher().sweep();

      // The fake enforces notify-api's strict `actorEmail` rule: a raw value would have been a 400 (notify_refused).
      for (const row of [inApp!, email!, outside]) expect(await reload(row.id)).toMatchObject({ status: "delivered", attempts: 1, firstFailedAt: null });
      expect(emailOf(fake.calls.find((c) => c.kind === "email" && "recipientId" in c.body)!)).toBeNull();
      expect(emailOf(fake.calls.find((c) => c.kind === "email" && "to" in c.body)!)).toBeNull();
      const note = fake.calls.find((c) => c.kind === "notification")!;
      expect(String(note.body["body"]).split("\n")[1]).toBe("Change saved by an account with no email address on record.");

      const lines = logFor("legal_entity_notice_author_email_unusable");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines.find((l) => l.includes(inApp!.id))!.slice(lines[0]!.indexOf("{")))).toEqual({
        id: inApp!.id,
        entity: "welld_ch",
        version: 2,
        channel: "in_app",
      });
      for (const text of [logs.join("\n"), fake.calls.map((c) => c.raw).join("\n"), JSON.stringify(await noticeAudit())]) {
        expect(text).not.toContain("d9-bad-author-value");
        expect(text).not.toContain("Bcc:");
      }
      expect(await noticeAudit()).toHaveLength(0);
    });

    test("the actor's email and name change and the actor is soft-deleted after the version is stored: other recipients still read the captured address, a retry sends the same words, the actor's own rows end given_up", async () => {
      const actor = await makeUser("actor");
      await db.user.update({ where: { id: actor.id }, data: { name: SENTINEL.displayName } });
      await seedVersion({ entity: "welld_it", version: 3, action: "save", changedFields: ["vatNumber"], iban: "", createdAt: T0, createdByUserId: actor.id });
      const captured = actor.email;
      const other = await makeUser("reader");
      const rows = [
        ...(await addPerson(other.id, { entity: "welld_it", version: 3, authorEmail: captured })),
        ...(await addPerson(actor.id, { entity: "welld_it", version: 3, authorEmail: captured })),
        await addRow({ entity: "welld_it", version: 3, recipient: "outside", channel: "email", authorEmail: captured }),
      ];
      const sentOf = (reader: string) => fake.calls.filter((c) => c.body["recipientId"] === reader || (reader === "outside" && "to" in c.body));

      // The account changes under the notice, then is deleted.
      await db.user.update({ where: { id: actor.id }, data: { email: `changed-${actor.email}`, name: "Somebody Else Entirely", deletedAt: new Date(T0.getTime() + 1000) } });
      fake.behave = (call) => (call.kind === "notification" ? { status: 500 } : "ok");
      const dispatcher = makeDispatcher();
      setClock(T0.getTime() + 2000);
      await dispatcher.sweep();
      const firstTry = sentOf(other.id).find((c) => c.kind === "notification")!;

      // The reader's own address changes too before the retry.
      await db.user.update({ where: { id: other.id }, data: { name: "Renamed Reader" } });
      fake.behave = () => "ok";
      setClock(T0.getTime() + 2000 + MIN);
      await dispatcher.sweep();

      const readerCalls = sentOf(other.id);
      const note = readerCalls.filter((c) => c.kind === "notification");
      expect(note).toHaveLength(2);
      for (const call of note) expect(String(call.body["body"]).split("\n")[1]).toBe(`Change saved by the account ${captured}.`);
      // A retry sends the same words (the request is identical, key included).
      expect(note[1]!.raw).toBe(firstTry.raw);
      expect(emailOf(readerCalls.find((c) => c.kind === "email")!)).toBe(captured);
      expect(emailOf(sentOf("outside").find((c) => c.kind === "email")!)).toBe(captured);
      expect(fake.calls.some((c) => c.raw.includes(`changed-${actor.email}`) || c.raw.includes("Somebody Else") || c.raw.includes(SENTINEL.displayName))).toBe(false);

      // The deleted actor is never sent to.
      expect(fake.calls.some((c) => c.body["recipientId"] === actor.id)).toBe(false);
      for (const row of [rows[2]!, rows[3]!]) expect(await reload(row.id)).toMatchObject({ status: "given_up", lastReason: "recipient_deleted" });
      expect((await reload(rows[0]!.id)).status).toBe("delivered");
      expect((await reload(rows[1]!.id)).status).toBe("delivered");
      expect((await reload(rows[4]!.id)).status).toBe("delivered");
    });

    test("`authorEmail` is read for every send, kept byte-identical across retries, and cleared in the same update as the terminal status (delivered or given_up)", async () => {
      const p = await makeUser("immutable");
      const gone = await makeUser("immutable-gone");
      const retried = await addRow({ recipient: p.id, channel: "in_app" });
      const doomed = await addRow({ recipient: p.id, channel: "email", authorEmail: "keep.me@operai.test" });
      const goneRow = await addRow({ recipient: gone.id, channel: "in_app" });
      await db.user.update({ where: { id: gone.id }, data: { deletedAt: T0 } });
      // The notification fails twice, then succeeds; the email always fails (retry, then give up at 24 h).
      let notifications = 0;
      fake.behave = (call) => (call.kind === "email" ? { status: 500 } : ++notifications <= 2 ? { status: 500 } : "ok");
      const dispatcher = makeDispatcher();
      const seen: Array<string | null> = [];
      for (const minutes of [0, 1, 4]) {
        setClock(T0.getTime() + minutes * MIN);
        await dispatcher.sweep();
        seen.push((await reload(retried.id)).authorEmail);
        // A row still pending keeps the captured value untouched.
        expect((await reload(doomed.id)).authorEmail).toBe("keep.me@operai.test");
      }
      // Attempts 1 and 2 failed (value kept), attempt 3 delivered (value cleared with the status).
      expect(seen).toEqual([SENTINEL.author, SENTINEL.author, null]);
      expect(await reload(retried.id)).toMatchObject({ status: "delivered", authorEmail: null });
      const notes = fake.calls.filter((c) => c.kind === "notification" && c.body["recipientId"] === p.id);
      expect(notes).toHaveLength(3);
      for (const call of notes) expect(String(call.body["body"])).toContain(SENTINEL.author);
      expect(notes[1]!.raw).toBe(notes[0]!.raw);
      expect(notes[2]!.raw).toBe(notes[0]!.raw);

      setClock(T0.getTime() + GIVE_UP_AFTER_MS + 1);
      await dispatcher.sweep();
      expect(await reload(doomed.id)).toMatchObject({ status: "given_up", authorEmail: null });
      // A row given up without any send (the recipient is deleted) is cleared too.
      expect(await reload(goneRow.id)).toMatchObject({ status: "given_up", lastReason: "recipient_deleted", authorEmail: null });
      // The audit entries and logs never carry the address.
      expect(JSON.stringify(await noticeAudit())).not.toContain("keep.me@operai.test");

      // Only the two terminal updates write the column, and only to null; the claim statement never names it in SET.
      const source = readFileSync(join(import.meta.dir, "dispatcher.ts"), "utf8");
      for (const block of source.split("updateMany(").slice(1)) {
        const data = block.slice(block.indexOf("data:"), block.indexOf("});"));
        for (const match of data.matchAll(/authorEmail:\s*([^,}\s]+)/g)) expect(match[1]).toBe("null");
      }
      const set = source.slice(source.indexOf('SET "leaseUntil"'), source.indexOf("WHERE n.\"id\" IN"));
      expect(set).not.toContain("authorEmail");
    });

    test("the database allows `authorEmail` to change only to null on a row that is terminal after the update, and holds no address on a terminal row", async () => {
      const p = await makeUser("guard");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      const attempt = async (data: Record<string, unknown>) => await db.legalEntityNotice.update({ where: { id: row.id }, data });
      await expect(attempt({ authorEmail: "other@operai.test" })).rejects.toThrow(); // rewritten while pending
      await expect(attempt({ authorEmail: null })).rejects.toThrow(); // cleared while pending
      await expect(attempt({ status: "delivered", deliveredAt: T0 })).rejects.toThrow(); // terminal still holding it
      await expect(attempt({ status: "delivered", deliveredAt: T0, authorEmail: "other@operai.test" })).rejects.toThrow();
      expect((await reload(row.id)).authorEmail).toBe(SENTINEL.author);
      await attempt({ status: "given_up", givenUpAt: T0, authorEmail: null });
      await expect(attempt({ authorEmail: SENTINEL.author })).rejects.toThrow(); // never set again
      expect(await reload(row.id)).toMatchObject({ status: "given_up", authorEmail: null });
    });

    test("a pre-D9 row (the column was never written) reads null: the notice says so and names no one", async () => {
      const p = await makeUser("legacy");
      const row = await db.legalEntityNotice.create({
        data: { entity: "welld_ch", version: 2, recipient: p.id, recipientKind: "person", channel: "in_app", createdAt: T0, nextAttemptAt: T0 },
      });
      expect(row.authorEmail).toBeNull();
      await makeDispatcher().sweep();
      const note = fake.calls[0]!;
      expect(String(note.body["body"])).toContain("Change saved by an account with no email address on record.");
      expect(note.raw).not.toContain(SENTINEL.displayName);
    });
  });

  describe("the sweep reports what is overdue", () => {
    test("rows pending more than 5 minutes after their version was stored are counted by a sweep, not by a kick", async () => {
      const p = await makeUser("overdue");
      await addRow({ recipient: p.id, channel: "in_app", nextAttemptAt: new Date(T0.getTime() + 3600_000) });
      setClock(T0.getTime() + 4 * MIN);
      const dispatcher = makeDispatcher();
      await dispatcher.sweep();
      expect(logs.filter((l) => l.startsWith("legal_entity_notice_overdue"))).toHaveLength(0);
      setClock(T0.getTime() + 6 * MIN);
      await dispatcher.kick();
      expect(logs.filter((l) => l.startsWith("legal_entity_notice_overdue"))).toHaveLength(0);
      await dispatcher.sweep();
      expect(logs.filter((l) => l.startsWith("legal_entity_notice_overdue"))).toEqual(['legal_entity_notice_overdue {"count":1}']);
    });

    test("a failure in a sweep is logged by class and never rejects", async () => {
      const broken = createNoticeDispatcher({
        notifier,
        now: () => {
          throw new RangeError("the clock broke");
        },
        fetch: fake.fetch,
        log: (event, fields) => void logs.push(`${event} ${JSON.stringify(fields)}`),
      });
      await expect(broken.sweep()).resolves.toBeUndefined();
      await expect(broken.kick()).resolves.toBeUndefined();
      expect(logs.some((l) => l.startsWith("legal_entity_notice_sweep_error"))).toBe(true);
    });
  });

  describe("the time zone of the process does not move a notice or a retry", () => {
    test("the stored timestamps round-trip as the instants they were (the claim passes them as UTC timestamps)", async () => {
      const p = await makeUser("tz");
      const row = await addRow({ recipient: p.id, channel: "in_app" });
      fake.behave = () => ({ status: 500 });
      const odd = new Date("2026-03-29T01:00:00.123Z"); // the minute the clocks change, with milliseconds
      setClock(odd);
      await db.legalEntityNotice.update({ where: { id: row.id }, data: { createdAt: new Date(odd.getTime() - 1000), nextAttemptAt: new Date(odd.getTime() - 1000) } });
      await makeDispatcher().sweep();
      expect(await reload(row.id)).toMatchObject({ firstFailedAt: odd, nextAttemptAt: new Date(odd.getTime() + MIN) });
    });
  });
});

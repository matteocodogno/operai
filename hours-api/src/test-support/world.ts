/**
 * Test world for hours-api route tests (specs/029): a request helper over the ASSEMBLED app with a
 * signed-in persona, direct inserts of an entry on every target (so a test can set up what a
 * route would otherwise have to be driven for), the seeded lists by id, and a reset between tests.
 *
 * It knows nothing about the other services. The fake hosts that play projects-api, crm-api,
 * activities-api, meetings-api and `auth` over real HTTP are test-support/hosts.ts (T11), which
 * registers its own reset here with `onReset`, so neither file edits the other.
 *
 * The environment is set by the `bun test` preload (./env.ts) before this module, or anything it
 * imports, reads `src/lib/env`.
 *
 * TRAP: get `app`, `MAX_REQUEST_BODY_BYTES`, `db` and `env` from HERE, and never import
 * `../index` (or a module that imports `../auth/jwt.middleware`) in a test file ABOVE this one.
 * The harness replaces the JWT middleware with `mock.module`, which only affects modules loaded
 * afterwards: a test file that loads `index.ts` first runs against the REAL middleware when it is
 * run alone, and passes only when an earlier file in the same `bun test` process installed the
 * mock. Run every new test file alone before trusting it.
 */

import { setupTestAuth } from "./testAuth";
import type { Prisma } from "../lib/generated/prisma/client";

const harness = setupTestAuth();
await harness.init();

const { app, MAX_REQUEST_BODY_BYTES } = await import("../index");
const { db } = await import("../lib/db");
const { env } = await import("../lib/env");

export { app, db, env, MAX_REQUEST_BODY_BYTES };

// ─── The seeded lists (A15, AC-3.7) ──────────────────────────────────────────

/** The ids the init migration gives the initial lists, so a test can name a seeded row. */
export const SEED = {
  categories: {
    training: "tc-training",
    talkPreparation: "tc-talk-preparation",
    administration: "tc-administration",
    /** Requires a note (A7). */
    other: "tc-other",
  },
  workTypes: {
    project: {
      development: "wt-project-development",
      analysis: "wt-project-analysis",
      projectManagement: "wt-project-management",
      support: "wt-project-support",
    },
    deal: {
      analysis: "wt-deal-analysis",
      estimate: "wt-deal-estimate",
      demo: "wt-deal-demo",
      offer: "wt-deal-offer",
    },
  },
} as const;

/** The rows as the migration leaves them: what `resetWorld` puts back after a test renamed or retired one. */
const SEED_CATEGORY_ROWS = [
  { id: SEED.categories.training, name: "Training", requiresNote: false },
  { id: SEED.categories.talkPreparation, name: "Talk preparation", requiresNote: false },
  { id: SEED.categories.administration, name: "Administration", requiresNote: false },
  { id: SEED.categories.other, name: "Other", requiresNote: true },
] as const;
const SEED_WORK_TYPE_ROWS = [
  { id: SEED.workTypes.project.development, list: "project", name: "Development" },
  { id: SEED.workTypes.project.analysis, list: "project", name: "Analysis" },
  { id: SEED.workTypes.project.projectManagement, list: "project", name: "Project management" },
  { id: SEED.workTypes.project.support, list: "project", name: "Support" },
  { id: SEED.workTypes.deal.analysis, list: "deal", name: "Analysis" },
  { id: SEED.workTypes.deal.estimate, list: "deal", name: "Estimate" },
  { id: SEED.workTypes.deal.demo, list: "deal", name: "Demo" },
  { id: SEED.workTypes.deal.offer, list: "deal", name: "Offer" },
] as const;

let counter = 0;
const next = (prefix: string) => `${prefix}-${++counter}`;

/** A category an admin added (not a seeded one). `retired` retires it as `PATCH {retired:true}` would. */
export function makeCategory(name = next("Category"), options: { requiresNote?: boolean; retired?: boolean } = {}) {
  return db.timeCategory.create({
    data: { name, requiresNote: options.requiresNote ?? false, retiredAt: options.retired ? new Date() : null, createdBy: "user-admin" },
  });
}

/** A work type an admin added to `list` (not a seeded one). */
export function makeWorkType(list: "project" | "deal" = "project", name = next("Work type"), options: { retired?: boolean } = {}) {
  return db.workType.create({ data: { list, name, retiredAt: options.retired ? new Date() : null, createdBy: "user-admin" } });
}

// ─── Entries, inserted directly ──────────────────────────────────────────────

/** What every entry has, whatever it is on. The defaults make a valid 1 h entry of `alice` on a past day. */
export interface EntryOptions {
  /** The author. Default `alice`. */
  readonly userId?: string;
  /** `YYYY-MM-DD`. Default 2026-11-02. */
  readonly day?: string;
  /** Default 60. */
  readonly minutes?: number;
  readonly note?: string | null;
  /** Lets a test order two entries of one day. */
  readonly createdAt?: Date;
}

/** What only a project or a deal entry may carry (the CHECKs refuse it on a meeting or on no entity). */
export interface PointingEntryOptions extends EntryOptions {
  readonly workTypeId?: string | null;
  readonly activityId?: string | null;
}

const base = (options: EntryOptions) => ({
  userId: options.userId ?? PERSONAS.alice.sub,
  day: new Date(`${options.day ?? "2026-11-02"}T00:00:00Z`),
  minutes: options.minutes ?? 60,
  note: options.note ?? null,
  ...(options.createdAt ? { createdAt: options.createdAt } : {}),
});

const insert = (data: Prisma.TimeEntryUncheckedCreateInput) => db.timeEntry.create({ data });

/** An entry on a project. The route's checks (bookability, the work type's list) are NOT run: that is the point. */
export function makeProjectEntry(projectId: string, options: PointingEntryOptions = {}) {
  return insert({
    ...base(options),
    target: "project",
    projectId,
    workTypeId: options.workTypeId ?? null,
    activityId: options.activityId ?? null,
  });
}

/** An entry on a deal. */
export function makeDealEntry(dealId: string, options: PointingEntryOptions = {}) {
  return insert({
    ...base(options),
    target: "deal",
    dealId,
    workTypeId: options.workTypeId ?? null,
    activityId: options.activityId ?? null,
  });
}

/** An entry on a meeting: no work type and no activity pointer, as the schema requires. */
export function makeMeetingEntry(meetingId: string, options: EntryOptions = {}) {
  return insert({ ...base(options), target: "meeting", meetingId });
}

/** An entry on no entity (shown as "Other work"): a category, never a work type. Default category Training. */
export function makeNoEntityEntry(categoryId: string = SEED.categories.training, options: EntryOptions = {}) {
  return insert({ ...base(options), target: "none", categoryId });
}

// ─── Personas and requests ───────────────────────────────────────────────────

export interface Persona {
  readonly sub: string;
}

/**
 * The callers every test file uses. They are only identities: what each one may do is decided by
 * what the fake `auth` of T11 answers for it. By convention `holder` holds `time-entry:read-all`,
 * `manager` holds `time-list:manage`, and `admin` has the admin role, which holds neither unless a
 * test grants it (AC-3.3).
 */
export const PERSONAS = {
  alice: { sub: "user-alice" },
  bob: { sub: "user-bob" },
  carol: { sub: "user-carol" },
  admin: { sub: "user-admin" },
  holder: { sub: "user-holder" },
  manager: { sub: "user-manager" },
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

const tokens = new Map<string, string>();
async function tokenFor(name: PersonaName, permEpoch?: number): Promise<string> {
  const key = `${name}:${permEpoch ?? ""}`;
  const cached = tokens.get(key);
  if (cached) return cached;
  const token = await harness.signToken({
    sub: PERSONAS[name].sub,
    email: `${name}@welld.test`,
    name: `Name of ${name}`,
    ...(permEpoch !== undefined ? { permEpoch } : {}),
  });
  tokens.set(key, token);
  return token;
}

export interface CallOptions {
  /** A persona, or null for no Authorization header. Default alice. */
  readonly as?: PersonaName | null;
  /** The token's `perm_epoch` claim: a new value is a new grant picture (the 30 s refusal caches key on it). */
  readonly permEpoch?: number;
  /** Serialised as JSON. */
  readonly body?: unknown;
  /** Sent as is, with a JSON content type: for malformed bodies. */
  readonly rawBody?: string;
  readonly headers?: Record<string, string>;
}

export async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { ...options.headers };
  const as = options.as === undefined ? "alice" : options.as;
  if (as) headers["Authorization"] = `Bearer ${await tokenFor(as, options.permEpoch)}`;
  const payload = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await res.text();
  // Only a JSON answer is parsed: `/docs` is HTML and a stray 404 may be plain text, and neither
  // may crash the helper before the test can say what it expected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined;
  return { status: res.status, json, text, headers: res.headers };
}

/** The Authorization header a persona's request carries, for asserting what an owner received. */
export async function bearerOf(name: PersonaName, permEpoch?: number): Promise<string> {
  return `Bearer ${await tokenFor(name, permEpoch)}`;
}

// ─── Reset ───────────────────────────────────────────────────────────────────

const resetHooks: Array<() => void | Promise<void>> = [];

/** Runs `hook` at the end of every `resetWorld`: how the fake hosts (T11) put themselves back. */
export function onReset(hook: () => void | Promise<void>): void {
  resetHooks.push(hook);
}

/**
 * Puts the world back to its start: no entries, no list rows but the seeded ones, and those as the
 * migration made them (a test may have renamed, retired or restored one), then every registered hook.
 */
export async function resetWorld(): Promise<void> {
  await db.timeEntry.deleteMany();
  await db.timeCategory.deleteMany({ where: { id: { notIn: SEED_CATEGORY_ROWS.map((row) => row.id) } } });
  await db.workType.deleteMany({ where: { id: { notIn: SEED_WORK_TYPE_ROWS.map((row) => row.id) } } });
  await db.$transaction([
    ...SEED_CATEGORY_ROWS.map((row) =>
      db.timeCategory.update({ where: { id: row.id }, data: { name: row.name, requiresNote: row.requiresNote, retiredAt: null, createdBy: "system:migration" } }),
    ),
    ...SEED_WORK_TYPE_ROWS.map((row) =>
      db.workType.update({ where: { id: row.id }, data: { list: row.list, name: row.name, retiredAt: null, createdBy: "system:migration" } }),
    ),
  ]);
  for (const hook of resetHooks) await hook();
}

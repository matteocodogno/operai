/**
 * Route-test kit for the media lane (capture, transcript, audio; specs/021-meetings).
 * Boots the REAL assembled app (`src/index.ts`) against the real test database,
 * with the JWT/resolve mocks (testAuth), an in-memory storage, and a stubbed
 * `auth POST /authz/users/identities`.
 *
 * Import this module FIRST in a test file (it registers the auth mocks before any
 * route module loads) and use `useKit()` once at the top level.
 */

import { afterEach, beforeEach, spyOn } from "bun:test";
import { setupTestAuth } from "./testAuth";
import { createFakeStorage, type FakeStorage } from "./fakeStorage";
import type { ResolveResponse } from "../authz/resolveClient";
import type { Prisma } from "../lib/generated/prisma/client";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("../index");
const { db } = await import("../lib/db");
const { setStorageForTests } = await import("../lib/storage");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { __resetIdentityCacheForTests } = await import("../lib/identities");

export { app, db };

export const CREATOR = "creator-1";
export const OTHER = "other-1";

export type IdentityStatus = "active" | "deleted" | "outage";

export interface Kit {
  storage: FakeStorage;
  /** Status `auth` reports per user id; unlisted ids are `active`. `outage` makes the lookup fail. */
  identities: Map<string, IdentityStatus>;
  /** Permissions `auth` resolves for a caller; default `meetings:access`. */
  grants: Map<string, [string, string][]>;
  authOutage: boolean;
  tokens: Map<string, string>;
}

export const kit: Kit = {
  storage: createFakeStorage(),
  identities: new Map(),
  grants: new Map(),
  authOutage: false,
  tokens: new Map(),
};

const resolveFor = (sub: string): ResolveResponse => ({
  sub,
  epoch: 0,
  permissions: (kit.grants.get(sub) ?? [["meetings", "access"]]).map(([resource, action]) => ({ resource, action, conditions: null })),
  entity: null,
  jobTitle: null,
});

async function tokenFor(sub: string): Promise<string> {
  const cached = kit.tokens.get(sub);
  if (cached) return cached;
  const token = await harness.signToken({ sub, email: `${sub}@example.test`, permEpoch: 1 });
  kit.tokens.set(sub, token);
  return token;
}

export async function resetDb(): Promise<void> {
  await db.meetingJob.deleteMany();
  await db.meeting.deleteMany();
}

/** Registers the per-test setup: fresh storage, identities, grants, database, spies. */
export function useKit(): void {
  let fetchSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  beforeEach(async () => {
    kit.storage = createFakeStorage();
    setStorageForTests(kit.storage);
    kit.identities.clear();
    kit.grants.clear();
    kit.authOutage = false;
    __resetAuthzCacheForTests();
    __resetIdentityCacheForTests();
    harness.setResolve(async (authorization) => {
      if (kit.authOutage) throw new Error("auth is down");
      // the token's sub is not parsed here: tests that need per-user grants key on the header
      const sub = [...kit.tokens.entries()].find(([, t]) => `Bearer ${t}` === authorization)?.[0] ?? CREATOR;
      return resolveFor(sub);
    });
    const realFetch = globalThis.fetch;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
      if (!String(url).endsWith("/authz/users/identities")) return realFetch(url as string, init);
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      if (ids.some((id) => kit.identities.get(id) === "outage")) return new Response("{}", { status: 503 });
      return Response.json({
        users: ids.map((id) => {
          const status = kit.identities.get(id) === "deleted" ? "deleted" : "active";
          return { id, status, name: `Name of ${id}` };
        }),
      });
    }) as unknown as typeof fetch);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await resetDb();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    errorSpy.mockRestore();
  });
}

export interface ReqOptions {
  user?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function call(method: string, path: string, options: ReqOptions = {}): Promise<Response> {
  const user = options.user === undefined ? CREATOR : options.user;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (user) headers["Authorization"] = `Bearer ${await tokenFor(user)}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    ...(options.body !== undefined ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {}),
  });
}

export const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

/** A meeting row the creator owns, consented, a recorded source, in `draft` unless told otherwise. */
export async function mkMeeting(over: Partial<Prisma.MeetingUncheckedCreateInput> = {}) {
  return db.meeting.create({
    data: {
      title: "Weekly sync",
      format: "online",
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: CREATOR,
      consentUserId: CREATOR,
      consentAt: new Date("2026-11-05T09:00:00.000Z"),
      consentNoticeVersion: "v1",
      ...over,
    },
  });
}

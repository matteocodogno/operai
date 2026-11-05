/**
 * Route-test kit for the meeting routes (specs/021-meetings): the REAL assembled app
 * (src/index.ts) over the REAL Postgres (`meetings_test`), with everything outside the
 * service faked at its edge:
 *
 *   - `auth`: the JWT and `/authz/resolve` mocks of testAuth.ts, grants per user (`grant`);
 *     `POST /authz/users/identities` answered by a `fetch` wrapper, every other URL
 *     passing through to the real network (the fake host is on 127.0.0.1);
 *   - hosts: the fake host, registered as `testhost/widget`, `quiethost/gadget` AND a
 *     CRM-shaped `crm/deal` pointing at the same fake (so the production definition goes
 *     through the same adapter);
 *   - notify-api: a recording notifier; host-notice credentials: a static token;
 *   - storage: the in-memory fake.
 *
 * Call `await createKit()` once at the top of a test file, then `await kit.reset()` in `beforeEach`.
 */

import { afterAll, spyOn } from "bun:test";
import { setupTestAuth } from "./testAuth";
import { startFakeHost, type FakeHost } from "./fakeHost";
import { createFakeStorage, type FakeStorage } from "./fakeStorage";
import type { ResolveResponse } from "../authz/resolveClient";
import type { Identity } from "../lib/identities";
import type { NotifyEvent } from "../lib/notify";

export type Cap = "access" | "erase" | "template";
const CAPS: Record<Cap, [string, string]> = {
  access: ["meetings", "access"],
  erase: ["meeting", "erase"],
  template: ["template", "manage"],
};

const subOf = (authorization: string): string =>
  (JSON.parse(Buffer.from(authorization.split(" ")[1]!.split(".")[1]!, "base64url").toString("utf8")) as { sub: string }).sub;

export async function createKit() {
  const harness = setupTestAuth();
  await harness.init();

  const { app } = await import("../index");
  const { db } = await import("../lib/db");
  const { env } = await import("../lib/env");
  const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
  const { __resetIdentityCacheForTests } = await import("../lib/identities");
  const { buildRegistry, setRegistryForTests } = await import("../hosts/registry");
  const { setNotifierForTests } = await import("../lib/notify");
  const { setStorageForTests } = await import("../lib/storage");
  const { setNoticeDepsForTests } = await import("../hosts/notices");

  const fake: FakeHost = startFakeHost();
  const storage: FakeStorage = createFakeStorage();
  const notified: NotifyEvent[] = [];
  setNotifierForTests({
    async notify(event) {
      notified.push(event);
    },
  });
  setStorageForTests(storage);
  setNoticeDepsForTests({
    tokens: {
      async getToken() {
        return "service-token";
      },
      invalidate() {},
    },
  });
  setRegistryForTests(buildRegistry({ production: false, crmApiUrl: `${fake.url}/testhost`, testHosts: fake.definitions }));

  // ── auth ──────────────────────────────────────────────────────────────────
  const grants = new Map<string, Set<Cap>>();
  let authDown = false;
  harness.setResolve(async (authorization): Promise<ResolveResponse> => {
    if (authDown) throw new Error("auth GET /authz/resolve responded with HTTP 503");
    const sub = subOf(authorization);
    return {
      sub,
      epoch: 0,
      permissions: [...(grants.get(sub) ?? [])].map((cap) => ({ resource: CAPS[cap][0], action: CAPS[cap][1], conditions: null })),
      entity: null,
      jobTitle: null,
    };
  });

  const deactivated = new Set<string>();
  let identitiesDown = false;
  const identityCalls: string[][] = [];
  const realFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${env.AUTH_BASE_URL}/authz/users/identities`) {
      if (identitiesDown) return new Response("down", { status: 503 });
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      identityCalls.push(ids);
      const users: Identity[] = ids.map((id) =>
        deactivated.has(id) || id.startsWith("gone-")
          ? { id, name: null, status: "deleted" }
          : { id, name: `Name ${id}`, status: "active" },
      );
      return Response.json({ users });
    }
    return realFetch(input, init);
  }) as typeof fetch);

  afterAll(async () => {
    await fake.stop();
    setRegistryForTests(null);
    setNotifierForTests(null);
    setStorageForTests(null);
    setNoticeDepsForTests(null);
    fetchSpy.mockRestore();
  });

  const tokens = new Map<string, string>();
  async function tokenFor(sub: string): Promise<string> {
    let token = tokens.get(sub);
    if (!token) {
      token = await harness.signToken({ sub, email: `${sub}@x.test` });
      tokens.set(sub, token);
    }
    return token;
  }

  async function call(
    sub: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const auth = sub === null ? {} : { Authorization: `Bearer ${await tokenFor(sub)}` };
    return app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  return {
    app,
    db,
    fake,
    storage,
    notified,
    harness,
    identityCalls,
    call,
    tokenFor,
    /** Gives `sub` exactly these capabilities (replacing earlier ones). */
    grant(sub: string, ...caps: Cap[]) {
      grants.set(sub, new Set(caps));
      __resetAuthzCacheForTests();
    },
    /** `auth` stops answering `/authz/resolve`: capability routes answer 503. */
    setAuthDown(down: boolean) {
      authDown = down;
      __resetAuthzCacheForTests();
    },
    /** `auth` reports this user as deactivated (an id starting `gone-` always is). */
    deactivate(id: string) {
      deactivated.add(id);
    },
    reactivate(id: string) {
      deactivated.delete(id);
    },
    setIdentitiesDown(down: boolean) {
      identitiesDown = down;
    },
    async reset() {
      grants.clear();
      deactivated.clear();
      identitiesDown = false;
      authDown = false;
      identityCalls.length = 0;
      notified.length = 0;
      fake.reset();
      for (const key of storage.keys()) await storage.deleteObject(key);
      storage.failWith(null);
      __resetAuthzCacheForTests();
      __resetIdentityCacheForTests();
      await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting", "host_notice", "meeting_deletion" CASCADE');
    },
  };
}

export type Kit = Awaited<ReturnType<typeof createKit>>;

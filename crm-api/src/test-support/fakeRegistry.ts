/**
 * Fakes of the legal-entity registry for crm-api tests (specs/20261117-legal-entities T25).
 *
 * Two levels, so a test fakes as little as it needs:
 *
 *   `fakeRegistryClient()`   a `LegalEntityRegistry` held in memory: what route and generation tests (T26 on) pass where
 *                            the wired `legalEntities` is used. It has no cache: it answers what it holds, and
 *                            `unavailable()` makes every read fail with the client's own 503 `legal_entities_unavailable`.
 *   `fakeAuth()`             a `fetch` that answers as auth's `GET /system/legal-entities` and `POST /system/service-token`
 *                            do, over a table the test changes (`save`), with a fake monotonic clock; the REAL client
 *                            (`createLegalEntityRegistry`) runs on top of it. This is what proves the cache rule.
 *
 * The details are built from the shared contract fixture `specs/20261117-legal-entities/fixtures/legal-entities.json`
 * (the very bytes auth's serializer test compares), so a fake cannot drift from the answer shape.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITIES, type Entity } from "../authz/conditions";
import {
  createLegalEntityRegistry,
  LEGAL_ENTITIES_UNAVAILABLE,
  parseLegalEntities,
  type LegalEntityDetails,
  type LegalEntityRegistry,
  type RegistrySnapshot,
} from "../lib/legalEntities";
import { ProblemError } from "../lib/problem";
import type { ServiceTokenProvider } from "../lib/serviceToken";

export const FIXTURE_PATH = join(import.meta.dir, "../../../specs/20261117-legal-entities/fixtures/legal-entities.json");

/** The raw fixture, as auth serves it. */
export function legalEntitiesFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

/** The fixture's entities, parsed by the client's own parser. */
export function fixtureEntities(): Record<Entity, LegalEntityDetails> {
  const parsed = parseLegalEntities(legalEntitiesFixture());
  if (parsed === null) throw new Error("the shared fixture legal-entities.json is not parsed by crm-api's client");
  return parsed;
}

/** A complete entity, version 1 by default: the fixture's `welld_ch`, renamed to `entity`, with `patch` on top. */
export function completeEntity(entity: Entity, patch: Partial<Omit<LegalEntityDetails, "entity">> = {}): LegalEntityDetails {
  const base = fixtureEntities().welld_ch;
  return { ...base, entity, ...patch };
}

/** An entity the registry judges incomplete: `missing` names what is empty. */
export function incompleteEntity(entity: Entity, missing: string[] = ["vatNumber"], patch: Partial<Omit<LegalEntityDetails, "entity">> = {}): LegalEntityDetails {
  return completeEntity(entity, { complete: false, missing, vatNumber: "", ...patch });
}

// ─── A clock ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeClock {
  /** Monotonic ms; starts at 1 000 000 so no age is ever "since the epoch". */
  now(): number;
  advance(ms: number): void;
}

export function fakeClock(start = 1_000_000): FakeClock {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
    },
  };
}

// ─── The client, in memory ──────────────────────────────────────────────────────────────────────────────────────────

export interface FakeRegistryClient extends LegalEntityRegistry {
  /** Replace one entity's details (the rest as they are). */
  set(details: LegalEntityDetails): void;
  /** Every read fails with 503 `legal_entities_unavailable` while on. */
  unavailable(on?: boolean): void;
  /** How many times `invalidate()` was called (the pin retry). */
  readonly invalidations: number;
  /** How many reads were asked, failed ones included. */
  readonly reads: number;
}

export function fakeRegistryClient(initial: Partial<Record<Entity, LegalEntityDetails>> = {}): FakeRegistryClient {
  const held: Record<Entity, LegalEntityDetails> = { welld_ch: completeEntity("welld_ch"), welld_it: completeEntity("welld_it", { legalName: "wellD S.r.l." }), ...initial };
  let down = false;
  let invalidations = 0;
  let reads = 0;
  const snapshot = (): RegistrySnapshot => {
    reads += 1;
    if (down) {
      throw new ProblemError({ status: 503, code: LEGAL_ENTITIES_UNAVAILABLE, detail: "The legal entities registry is unavailable; try again shortly" });
    }
    return { entities: { ...held }, sentAt: 0 };
  };
  return {
    async all() {
      return snapshot();
    },
    async get(entity) {
      return snapshot().entities[entity];
    },
    invalidate() {
      invalidations += 1;
    },
    set(details) {
      held[details.entity] = details;
    },
    unavailable(on = true) {
      down = on;
    },
    get invalidations() {
      return invalidations;
    },
    get reads() {
      return reads;
    },
  };
}

// ─── Auth, as a fetch ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AuthCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  /** The clock when the call arrived. */
  readonly at: number;
}

export type AuthMode =
  /** answers the table */
  | "ok"
  /** the connection fails */
  | "down"
  /** answers 503 */
  | "error"
  /** never answers (until aborted) */
  | "hang"
  /** answers 200 with something that is not the contract's */
  | "garbage";

export interface FakeAuth {
  readonly fetch: typeof fetch;
  readonly tokens: ServiceTokenProvider;
  readonly clock: FakeClock;
  /** The calls to `GET /system/legal-entities`, in order. */
  readonly calls: AuthCall[];
  /** The tokens `getToken` handed out, in order, and the ones `invalidate` dropped. */
  readonly issued: string[];
  readonly invalidated: string[];
  mode: AuthMode;
  /** The clock advances this long inside each call (the answer arrives this much after the request was sent). */
  latencyMs: number;
  /** The next N calls answer 401 (a token auth no longer accepts). */
  unauthorizedNext: number;
  /** Commit a change to one entity: its version rises by one, and from now on every answer holds it. */
  save(entity: Entity, patch?: Partial<Omit<LegalEntityDetails, "entity" | "version">>): number;
  /** The table's version of an entity, and when (clock) it was last committed. */
  version(entity: Entity): number;
  savedAt(entity: Entity): number;
}

export function fakeAuth(options: { clock?: FakeClock; baseUrl?: string } = {}): FakeAuth {
  const clock = options.clock ?? fakeClock();
  const baseUrl = options.baseUrl ?? "http://auth.test";
  const table = new Map<Entity, LegalEntityDetails>();
  const committed = new Map<Entity, number>();
  for (const entity of ENTITIES) {
    table.set(entity, fixtureEntities()[entity]);
    committed.set(entity, clock.now());
  }
  const calls: AuthCall[] = [];
  const issued: string[] = [];
  const invalidated: string[] = [];
  let tokenSeq = 0;
  let current: string | null = null;

  // As the real provider: one token is cached until it is invalidated.
  const tokens: ServiceTokenProvider = {
    async getToken() {
      if (current === null) {
        tokenSeq += 1;
        current = `token-${tokenSeq}`;
        issued.push(current);
      }
      return current;
    },
    invalidate(token) {
      invalidated.push(token);
      if (current === token) current = null;
    },
  };

  const auth: FakeAuth = {
    mode: "ok",
    latencyMs: 0,
    unauthorizedNext: 0,
    clock,
    calls,
    issued,
    invalidated,
    tokens,
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      calls.push({ url, method: init?.method ?? "GET", authorization, at: clock.now() });
      if (url !== `${baseUrl}/system/legal-entities`) return new Response("not found", { status: 404 });
      if (auth.mode === "down") throw new TypeError("fetch failed");
      if (auth.mode === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      // The table is read when the call arrives; the answer comes `latencyMs` later.
      const body = { items: ENTITIES.map((entity) => table.get(entity)!) };
      clock.advance(auth.latencyMs);
      if (auth.unauthorizedNext > 0) {
        auth.unauthorizedNext -= 1;
        return Response.json({ status: 401, title: "Unauthorized" }, { status: 401 });
      }
      if (auth.mode === "error") return Response.json({ status: 503 }, { status: 503 });
      if (auth.mode === "garbage") return Response.json({ items: [{ entity: "welld_ch" }] });
      return Response.json(body, { headers: { "Cache-Control": "no-store" } });
    }) as typeof fetch,
    save(entity, patch = {}) {
      const before = table.get(entity)!;
      const version = before.version + 1;
      table.set(entity, { ...before, ...patch, version, updatedAt: new Date(clock.now()).toISOString() });
      committed.set(entity, clock.now());
      return version;
    },
    version: (entity) => table.get(entity)!.version,
    savedAt: (entity) => committed.get(entity)!,
  };
  return auth;
}

/** The real client over a fake auth, on its clock. */
export function registryOver(auth: FakeAuth, options: { baseUrl?: string; timeoutMs?: number } = {}): LegalEntityRegistry {
  return createLegalEntityRegistry({
    baseUrl: options.baseUrl ?? "http://auth.test",
    tokens: auth.tokens,
    fetchImpl: auth.fetch,
    now: auth.clock.now,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

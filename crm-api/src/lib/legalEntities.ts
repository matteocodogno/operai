/**
 * crm-api's client of the legal-entity registry in auth (specs/20261117-legal-entities T25; AC-1.5, AC-3.2, AC-3.3,
 * AC-5.5; plan decision 7 and amendment E14; ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-…).
 *
 * The issuer's legal name, address, VAT number and IBAN are the registry's, not the CRM's. This module reads
 * `GET {AUTH_BASE_URL}/system/legal-entities` as crm-api itself (the scoped service JWT of `serviceToken.ts`, scope
 * `legal-entities:read`, configured on the service client in auth) and holds the answer under ONE rule, the consumer
 * cache rule of the ADR:
 *
 *   - ONE entry per process: the list of both entities, stamped with the monotonic time its request was SENT (not when
 *     the answer arrived, not when it was parsed);
 *   - age < 30 s: used, no call;
 *   - otherwise refreshed: single flight, 5 s in all, no redirects, a body of at most 64 KiB;
 *   - the refresh fails and the entry's age is <= 60 s: the old entry is used and `registry_stale_used` is logged;
 *   - the refresh fails and the age is > 60 s, or there is no entry: 503 `legal_entities_unavailable` (the caller
 *     answers it with `Retry-After: 5`, see `LEGAL_ENTITIES_RETRY_AFTER_SECONDS`). No document is made from older details.
 *
 * Why the proof holds (AC-3.3, AC-5.5): a document started at t uses an entry sent at >= t - 60 s. When a save
 * committed at T < t - 60 s, that request was sent after the commit, so auth read the table after it. Nothing older
 * than 60 s is ever used.
 *
 * Fail closed (E14): without a service client (`SERVICE_CLIENT_ID`/`SECRET` missing, so no token provider) every read
 * fails with the same 503 and one warning is logged at startup. It never falls back to a default or to the CRM's own
 * columns.
 *
 * A 401 from auth drops the cached service token and retries once; a second 401 is a failed refresh.
 *
 * `invalidate()` forgets the entry (the pin retry of decision 8: letterhead-api answered 409 `legal_entity_version_mismatch`),
 * so the next read goes to auth and the refresh that was already in flight, sent before the invalidation, is neither
 * joined nor cached.
 *
 * Nothing here logs a token, the secret, a body or a value: statuses and error names only.
 *
 * `legalEntities` (bottom) is the one wired from the environment; tests build their own with a stubbed `fetch` and clock.
 */

import { z } from "zod";
import { ENTITIES, type Entity } from "../authz/conditions";
import { env } from "./env";
import { ProblemError } from "./problem";
import { createServiceTokenProvider, serviceTokens, type ServiceTokenProvider } from "./serviceToken";

export const LEGAL_ENTITIES_UNAVAILABLE = "legal_entities_unavailable";
/** The `Retry-After` of the 503, in seconds (plan § API contracts); `ProblemError` carries no headers, the route adds it. */
export const LEGAL_ENTITIES_RETRY_AFTER_SECONDS = 5;

/** An entry younger than this is used without a call. */
export const REGISTRY_FRESH_MS = 30_000;
/** The oldest entry that may be used when a refresh fails. */
export const REGISTRY_USABLE_MS = 60_000;
/** The whole refresh: the token, the call and the one retry. */
export const REGISTRY_TIMEOUT_MS = 5_000;
/** The largest answer that is read. */
export const REGISTRY_MAX_BODY_BYTES = 64 * 1024;

// ─── The answer (plan § API contracts "Details", the shared fixture legal-entities.json) ──────────────────────────────

const Lines = z.array(z.string());

const InvalidItem = z.object({
  field: z.string(),
  line: z.number().int().optional(),
  reason: z.string(),
  limit: z.number().int().optional(),
});

const LegalEntitySchema = z.object({
  entity: z.string(),
  /** 0: not moved yet (empty values). */
  version: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  legalName: z.string(),
  address: z.object({ it: Lines, en: Lines }),
  vatNumber: z.string(),
  /** Electronic form; "" when empty. */
  iban: z.string(),
  /** Groups of four, for print; "" when empty. */
  ibanPrint: z.string(),
  contacts: z.object({ it: z.string(), en: z.string() }),
  complete: z.boolean(),
  missing: z.array(z.string()),
  invalid: z.array(InvalidItem),
});

const ListSchema = z.object({ items: z.array(LegalEntitySchema) });

/** One entity's details as the registry serves them. */
export type LegalEntityDetails = Omit<z.infer<typeof LegalEntitySchema>, "entity"> & { readonly entity: Entity };

/** What one read returns: both entities of ONE answer, and when its request was sent (the monotonic clock's ms). */
export interface RegistrySnapshot {
  readonly entities: Readonly<Record<Entity, LegalEntityDetails>>;
  readonly sentAt: number;
}

/**
 * The entities of an answer, or `null` when it is not the contract's: not the list shape, a field of the wrong type, an
 * entity twice, or one of the group's entities absent. An entity this CRM does not know is ignored.
 */
export function parseLegalEntities(body: unknown): Record<Entity, LegalEntityDetails> | null {
  const parsed = ListSchema.safeParse(body);
  if (!parsed.success) return null;
  const found = new Map<Entity, LegalEntityDetails>();
  for (const item of parsed.data.items) {
    if (!(ENTITIES as readonly string[]).includes(item.entity)) continue;
    const entity = item.entity as Entity;
    if (found.has(entity)) return null;
    found.set(entity, { ...item, entity });
  }
  const out: Partial<Record<Entity, LegalEntityDetails>> = {};
  for (const entity of ENTITIES) {
    const details = found.get(entity);
    if (details === undefined) return null;
    out[entity] = details;
  }
  return out as Record<Entity, LegalEntityDetails>;
}

// ─── The client ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LegalEntityRegistry {
  /** Both entities, under the cache rule. Rejects with 503 `legal_entities_unavailable`. */
  all(): Promise<RegistrySnapshot>;
  /** One entity's details (the same read, the same rule). */
  get(entity: Entity): Promise<LegalEntityDetails>;
  /** Forget the entry: the next read asks auth (the pin retry). */
  invalidate(): void;
}

export interface LegalEntityRegistryOptions {
  readonly baseUrl: string;
  /** `null`: no service client, every read fails closed (E14). */
  readonly tokens: ServiceTokenProvider | null;
  /** Looked up per call (default: the global `fetch`) so a spied global is honoured. */
  readonly fetchImpl?: typeof fetch;
  /** A MONOTONIC clock in ms (default `performance.now`): ages and send times are differences of it. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

const unavailable = (): ProblemError =>
  new ProblemError({
    status: 503,
    code: LEGAL_ENTITIES_UNAVAILABLE,
    detail: "The legal entities registry is unavailable; try again shortly",
  });

/** A refresh that did not produce an answer. The message names a status or an error kind, never a value. */
class RefreshError extends Error {}

export function createLegalEntityRegistry(options: LegalEntityRegistryOptions): LegalEntityRegistry {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const tokens = options.tokens;

  let entry: RegistrySnapshot | null = null;
  let inflight: Promise<RegistrySnapshot> | null = null;
  /** Bumped by `invalidate()`: a refresh begun in an earlier epoch is not cached. */
  let epoch = 0;

  /** `promise`, or a failure when `signal` aborts first. */
  function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new RefreshError("timeout"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** The body as text, refusing more than the limit (by the announced length first, then by what is actually read). */
  async function readBody(res: Response): Promise<string> {
    const announced = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(announced) && announced > REGISTRY_MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new RefreshError("body too large");
    }
    if (res.body === null) throw new RefreshError("empty body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REGISTRY_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RefreshError("body too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  async function request(signal: AbortSignal): Promise<RegistrySnapshot> {
    if (tokens === null) throw new RefreshError("no service client");
    const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    let retried = false;
    for (;;) {
      let token: string;
      try {
        token = await within(tokens.getToken(), signal);
      } catch (error) {
        throw new RefreshError(error instanceof RefreshError ? error.message : "no service token");
      }
      // Stamped as the call goes out: auth reads the table after this instant (the proof of AC-3.3).
      const sentAt = now();
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/system/legal-entities`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal,
          redirect: "error",
        });
      } catch (error) {
        throw new RefreshError(`request failed (${error instanceof Error ? error.name : "unknown error"})`);
      }
      if (res.status === 401 && !retried) {
        await res.body?.cancel().catch(() => {});
        tokens.invalidate(token);
        retried = true;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new RefreshError(`HTTP ${res.status}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(await within(readBody(res), signal));
      } catch (error) {
        throw new RefreshError(error instanceof RefreshError ? error.message : "unreadable body");
      }
      const entities = parseLegalEntities(body);
      if (entities === null) throw new RefreshError("unexpected body");
      return { entities, sentAt };
    }
  }

  async function refresh(): Promise<RegistrySnapshot> {
    const startedIn = epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fresh = await request(controller.signal);
      if (startedIn === epoch) entry = fresh;
      return fresh;
    } finally {
      clearTimeout(timer);
    }
  }

  async function snapshot(): Promise<RegistrySnapshot> {
    if (tokens === null) throw unavailable();
    const held = entry;
    const heldIn = epoch;
    if (held !== null && now() - held.sentAt < REGISTRY_FRESH_MS) return held;

    let flight = inflight;
    if (flight === null) {
      const started: Promise<RegistrySnapshot> = refresh().finally(() => {
        if (inflight === started) inflight = null;
      });
      inflight = started;
      flight = started;
    }
    try {
      return await flight;
    } catch (error) {
      const reason = error instanceof RefreshError ? error.message : "unexpected error";
      const age = held === null ? null : now() - held.sentAt;
      // A held entry that was invalidated while the refresh ran is not used: the caller asked for a newer one.
      if (held !== null && age !== null && age <= REGISTRY_USABLE_MS && heldIn === epoch) {
        console.warn(`[legal-entities] registry_stale_used age_ms=${Math.round(age)} (refresh failed: ${reason})`);
        return held;
      }
      console.error(`[legal-entities] legal_entities_unavailable (refresh failed: ${reason})`);
      throw unavailable();
    }
  }

  return {
    all: snapshot,
    async get(entity) {
      return (await snapshot()).entities[entity];
    },
    invalidate() {
      entry = null;
      inflight = null;
      epoch += 1;
    },
  };
}

/**
 * The token provider of the registry reads: the shared one when the CRM has it, else one of its own from the same
 * service client (a CRM with a client but none of the URLs that build `serviceTokens` still reads), else none.
 */
const tokensForRegistry: ServiceTokenProvider | null =
  serviceTokens ??
  (env.SERVICE_CLIENT_ID && env.SERVICE_CLIENT_SECRET
    ? createServiceTokenProvider({ baseUrl: env.AUTH_BASE_URL, clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET })
    : null);

if (tokensForRegistry === null && env.NODE_ENV !== "test") {
  console.warn(
    "[legal-entities] SERVICE_CLIENT_ID / SERVICE_CLIENT_SECRET are not set: every read of the legal entities registry fails closed (503 legal_entities_unavailable)",
  );
}

/** The client wired from the environment: what the routes call. */
export const legalEntities: LegalEntityRegistry = createLegalEntityRegistry({
  baseUrl: env.AUTH_BASE_URL,
  tokens: tokensForRegistry,
});

/**
 * Save and restore of the legal-entity registry (specs/20261117-legal-entities, T8; AC-1.2 to AC-1.5, AC-2.1,
 * AC-2.4 to AC-2.7, AC-4.2; plan sequences "Save" and "Restore"; amendments D4, D6, E1, E5):
 *
 *   POST /legal-entities/{entity}/versions                 { baseVersion, details }   save
 *   POST /legal-entities/{entity}/versions/{n}/restore     { baseVersion }            restore version n
 *
 * The registry is append-only: there is no PUT, PATCH or DELETE under `/legal-entities` and no route that could
 * change a stored version (`routerTable.test.ts` reads the real router table). A save or a restore only ever
 * appends version current + 1.
 *
 * A soft-deleted person is refused at the 403 step whatever grants remain (F2, `activeUserProfile`).
 *
 * ORDER of refusals (nothing is written by any of them):
 *   401 no session -> 403 `forbidden` (no `legal-entity:manage` covering any entity) -> 404 `unknown_legal_entity`
 *   -> 403 (a grant that does not cover THIS entity: AC-4.2) -> 429 `too_many_requests` (per person, F3: save and
 *   restore share one window, counted here and before the body is read) -> 413 `request_too_large` (16 KiB, before any parse)
 *   -> 422 `invalid_request` (not exactly the shape; nothing of the request is echoed) -> 422 `invalid_legal_entity`
 *   (every problem at once; for a restore the rules judge the stored version: D4) -> in the transaction, under the
 *   entity's advisory lock: 409 `legal_entity_not_moved` -> 409 `version_conflict` + `currentVersion` -> details
 *   equal to the current version: 200 `created: false`, no row, no audit row -> insert + audit row -> 201.
 *   A person with no grant at all therefore learns nothing about which entities or versions exist.
 *
 * What is persisted is `normalise(details)`, never the raw body (AC-1.4, AC-2.1). The rules are `rules.ts`'s alone;
 * the restore guard is `restorable`, the very function behind `restorable` in the history (E1).
 *
 * CONCURRENCY: `pg_advisory_xact_lock(hashtext('legal_entity:<entity>'))` is taken first inside the audit
 * transaction, the key `repo.lockKey` that the import script (T9) uses too; the current version is read after the
 * lock, so two saves on the same base cannot both pass the conflict check and versions stay contiguous (AC-2.6).
 * The version row and its `audit_log` row are written by `withAudit` in ONE transaction: a failure after the insert
 * leaves neither (AC-2.5).
 *
 * CSRF posture (as `/admin/*`): the session cookie is only honoured behind the CORS allowlist with credentials, and
 * the body is read only when it says it is JSON (anything else is 422 `invalid_request`), which a cross-site form
 * cannot send without a preflight. Every answer carries `Cache-Control: no-store`.
 *
 * Nothing the request or the registry holds is logged or put in an error: the 500 body is a constant and the log
 * line names only the error class and a database code.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { Session, User } from "better-auth";
import { Effect } from "effect";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { type AuditEntryInput, withAudit } from "../authz/audit";
import { resolveEffectivePermissions } from "../authz/resolver";
import { env } from "../lib/env";
import { db } from "../lib/db";
import { createSlidingWindowRateLimiter, type RateLimiter } from "../lib/rateLimiter";
import type { Prisma } from "../lib/generated/prisma/client";
import { readBodyCapped } from "../system/boundedBody";
import { activeUserProfile, coveredEntities } from "./coverage";
import { LEGAL_ENTITIES, type LegalEntity } from "./entities";
import { FORBIDDEN_BODY, parseVersion, VERSION_NOT_FOUND_BODY } from "./history.routes";
import { isLegalEntity, NO_STORE, unknownLegalEntity } from "./read.routes";
import { appendVersion, type HistoryRow, latestVersion, lockEntity, type Reader, versionOf } from "./repo";
import { kickNotices } from "./notices/dispatcher";
import { hasNoRecipient, type NoticeDutyOptions, noRecipientsEntry, recordNoticeDuty } from "./notices/duty";
import { changedFields, type Field, type LegalDetails, normalise, problems, protectedChanged, restorable } from "./rules";
import { detailsOf, serializeEntity } from "./serialize";

/** Body bound of the two POSTs (plan: 16 KiB). */
export const MAX_WRITE_BODY_BYTES = 16 * 1024;
/** A submitted address array is capped here (E5): more is `invalid_request`, so `too_many_lines` covers 5 to 16. */
export const MAX_SUBMITTED_ADDRESS_LINES = 16;
const INT4_MAX = 2_147_483_647;

const PROBLEM_JSON = "application/problem+json";

function problemBody<T extends Record<string, unknown>>(status: number, title: string, code: string, detail: string, extra?: T) {
  return Object.freeze({ type: `https://httpstatuses.com/${status}`, title, status, code, detail, ...extra });
}

/** 413: the body is over 16 KiB. Constant. */
export const REQUEST_TOO_LARGE_BODY = problemBody(413, "Payload Too Large", "request_too_large", "The request body is too large");
/** 422: not the shape of the contract (missing or unknown member, wrong type, not JSON). Constant: no member name. */
export const INVALID_REQUEST_BODY = problemBody(
  422,
  "Unprocessable Entity",
  "invalid_request",
  "The request body is not in the expected shape",
);
/** 409: the entity has no version yet; the move (import) has not run. Constant. */
export const NOT_MOVED_BODY = problemBody(
  409,
  "Conflict",
  "legal_entity_not_moved",
  "This legal entity has no version yet: its details have not been moved into the registry",
);
/** 500: constant, nothing of the request or the registry in it. */
export const INTERNAL_BODY = problemBody(500, "Internal Server Error", "internal_error", "An unexpected error occurred");

/** The 409 of a stale `baseVersion` (AC-2.6): carries the version that is current. */
export const versionConflictBody = (currentVersion: number) =>
  problemBody(409, "Conflict", "version_conflict", "The legal entity was changed by someone else since it was read", {
    currentVersion,
  });

/** The 422 of details that break AC-1.2 to AC-1.4: every problem, as `{ field, line?, reason, limit? }`. */
export const invalidLegalEntityBody = (list: readonly ReturnType<typeof problems>[number][]) =>
  problemBody(422, "Unprocessable Entity", "invalid_legal_entity", "The details do not satisfy the rules of a legal entity", {
    problems: list.map((p) => ({
      field: p.field,
      ...(p.line !== undefined ? { line: p.line } : {}),
      reason: p.reason,
      ...(p.limit !== undefined ? { limit: p.limit } : {}),
    })),
  });

/**
 * 429 (F3, plan G9): constant, nothing of the request in it. `code` is `too_many_requests` (not the `/system`
 * routes' `rate_limited`): the registry's own refusal, which admin-ui tells apart from a conflict.
 */
export const TOO_MANY_REQUESTS_BODY = problemBody(
  429,
  "Too Many Requests",
  "too_many_requests",
  "Too many requests. Try again later.",
);

export interface LegalEntityRateLimits {
  /** Save and restore of one person share this limiter. */
  write: RateLimiter;
  /** The dry-run check (T55) has its own. */
  check: RateLimiter;
}

/** The registry's limiters, per process, from the env unless a test passes its own numbers (plan G9). */
export function createLegalEntityRateLimits(
  config: { writeLimit?: number; checkLimit?: number; windowMs?: number } = {},
): LegalEntityRateLimits {
  const windowMs = config.windowMs ?? env.LEGAL_ENTITY_RATE_WINDOW_MS;
  return {
    write: createSlidingWindowRateLimiter({ limit: config.writeLimit ?? env.LEGAL_ENTITY_WRITE_RATE_LIMIT, windowMs }),
    check: createSlidingWindowRateLimiter({ limit: config.checkLimit ?? env.LEGAL_ENTITY_CHECK_RATE_LIMIT, windowMs }),
  };
}

/**
 * Counts one attempt of `userId` in `limiter`: null when admitted, else the 429 (`Retry-After` in whole seconds, at
 * least 1). A refused attempt is not recorded by the limiter, so retrying does not extend the refusal.
 */
export function throttle(limiter: RateLimiter, userId: string, c: Context): Response | null {
  const result = limiter.consume(userId);
  if (result.allowed) return null;
  return c.body(JSON.stringify(TOO_MANY_REQUESTS_BODY), 429, {
    "Content-Type": PROBLEM_JSON,
    "Cache-Control": NO_STORE,
    "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
  });
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** `baseVersion`: the version the client read; 0 is "none" (and is refused as not moved or as a conflict). */
const BaseVersionSchema = z.number().int().min(0).max(INT4_MAX);
const AddressSchema = z.array(z.string()).max(MAX_SUBMITTED_ADDRESS_LINES);

const DetailsSchema = z.strictObject({
  legalName: z.string(),
  address: z.strictObject({ it: AddressSchema, en: AddressSchema }),
  vatNumber: z.string(),
  iban: z.string(),
  contacts: z.strictObject({ it: z.string(), en: z.string() }),
});

export const SaveBodySchema = z.strictObject({ baseVersion: BaseVersionSchema, details: DetailsSchema });
export const RestoreBodySchema = z.strictObject({ baseVersion: BaseVersionSchema });

// ─── The write ────────────────────────────────────────────────────────────────

/** The seam of the audit transaction: `withAudit`, unless a test replaces it (to fail after the insert, to isolate). */
export type Audited = typeof withAudit;

/** Thrown inside the transaction to roll it back with a refusal (no audit row, nothing written). */
class Refusal extends Error {
  constructor(
    readonly kind: "not_moved" | "conflict",
    readonly currentVersion?: number,
  ) {
    super(kind);
    this.name = "Refusal";
  }
}

type Outcome =
  | { kind: "created"; row: HistoryRow; before: LegalDetails; changed: Field[]; noRecipients: boolean; noticed: boolean }
  | { kind: "same"; row: HistoryRow };

interface WriteRequest {
  entity: LegalEntity;
  actor: { id: string; name: string };
  baseVersion: number;
  /** Already `normalise`d. */
  details: LegalDetails;
  action: "save" | "restore";
  restoredFrom: number | null;
}

/** One value of a version as the audit row records it. */
function auditValue(d: LegalDetails, f: Field): string | string[] {
  switch (f) {
    case "legalName":
      return d.legalName;
    case "address.it":
      return [...d.address.it];
    case "address.en":
      return [...d.address.en];
    case "vatNumber":
      return d.vatNumber;
    case "iban":
      return d.iban;
    case "contacts.it":
      return d.contacts.it;
    case "contacts.en":
      return d.contacts.en;
  }
}

/** What the notice duty needs from the router (T58): the recipients (injectable) and the outside mailbox, read per save. */
interface NoticeDeps extends NoticeDutyOptions {
  outsideMailbox: () => boolean;
  /** After a protected change commits: hands the rows to the dispatcher (T59). Never awaited, never throws into the answer. */
  kick: () => unknown;
}

async function write(audited: Audited, req: WriteRequest, notices: NoticeDeps): Promise<Outcome> {
  return audited<Outcome>({
    affectedUserIds: [],
    mutate: async (tx) => {
      await lockEntity(tx, req.entity);
      const current = await latestVersion(req.entity, tx);
      if (current === null) throw new Refusal("not_moved");
      if (current.version !== req.baseVersion) throw new Refusal("conflict", current.version);

      const before = detailsOf(current);
      const changed = changedFields(before, req.details);
      if (changed.length === 0) return { kind: "same", row: current };

      const row = await appendVersion(tx, {
        entity: req.entity,
        version: current.version + 1,
        details: req.details,
        action: req.action,
        restoredFrom: req.restoredFrom,
        changedFields: changed,
        createdByUserId: req.actor.id,
        createdByName: req.actor.name,
      });

      // A protected change is a duty to tell people (US-9): the rows are written here, in the version's transaction,
      // with the recipients as they are NOW (AC-9.8). Nothing is sent from the request; an import never gets here.
      let noRecipients = false;
      let noticed = false;
      if (protectedChanged(changed).length > 0) {
        noticed = true;
        const duty = await recordNoticeDuty(
          tx,
          {
            entity: req.entity,
            version: row.version,
            action: req.action,
            actorUserId: req.actor.id,
            storedAt: row.createdAt,
            outsideMailbox: notices.outsideMailbox(),
          },
          notices,
        );
        noRecipients = hasNoRecipient(duty);
      }
      return { kind: "created", row, before, changed, noRecipients, noticed };
    },
    // A no-op writes no audit row (AC-2.1): an empty list is "nothing to record".
    entry: (result) => {
      if (result.kind === "same") return [];
      const after = detailsOf(result.row);
      const changes: Record<string, { before: string | string[]; after: string | string[] }> = {};
      for (const f of result.changed) changes[f] = { before: auditValue(result.before, f), after: auditValue(after, f) };
      const saved: AuditEntryInput = {
        actorUserId: req.actor.id,
        action: `legal_entity.${req.action}`,
        targetType: "legal_entity",
        targetId: req.entity,
        summary:
          `${req.action === "save" ? "Saved" : "Restored"} version ${result.row.version} of ${req.entity}` +
          `${req.restoredFrom !== null ? ` from version ${req.restoredFrom}` : ""}: ${result.changed.join(", ")}`,
        data: {
          version: result.row.version,
          baseVersion: req.baseVersion,
          ...(req.restoredFrom !== null ? { restoredFrom: req.restoredFrom } : {}),
          changes,
        } satisfies Prisma.InputJsonObject,
      };
      // A protected change nobody could be told about says so in the audit log (AC-9.15), in the same transaction.
      return result.noRecipients ? [saved, noRecipientsEntry({ entity: req.entity, version: result.row.version })] : saved;
    },
  });
}

/** What is safe to log about an unexpected error: its class and a database code, never its message (it can carry a row). */
export function safeErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null && typeof current === "object"; depth++) {
    const e = current as { name?: unknown; code?: unknown; meta?: { code?: unknown } };
    if (depth === 0 && typeof e.name === "string") parts.push(e.name);
    for (const code of [e.code, e.meta?.code]) {
      if ((typeof code === "string" || typeof code === "number") && !parts.includes(`code ${code}`)) parts.push(`code ${code}`);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(", ") : "unexpected error";
}

// ─── Router ───────────────────────────────────────────────────────────────────

export type Env = { Variables: { user: User | null; session: Session | null } };

/** The entities the caller covers, from the authorisation step to the handler (keyed by the request, never shared). */
const coveredOf = new WeakMap<Request, LegalEntity[]>();

export const respond = (c: Context<Env>, status: 200 | 201 | 403 | 404 | 409 | 413 | 422 | 500, body: object): Response =>
  c.body(JSON.stringify(body), status, {
    "Content-Type": status === 200 || status === 201 ? "application/json" : PROBLEM_JSON,
    "Cache-Control": NO_STORE,
  });

/** The entities the caller's grants cover (empty -> 403: a person with no grant learns nothing). */
export const authorize: MiddlewareHandler<Env> = async (c, next) => {
  const userId = c.get("user")!.id;
  const [profile, permissions] = await Promise.all([
    activeUserProfile(userId),
    Effect.runPromise(resolveEffectivePermissions(userId)),
  ]);
  // A missing or soft-deleted person is refused whatever grants remain (F2); the session may outlive the delete.
  const covered = profile === null ? [] : coveredEntities(permissions, { entity: profile.entity });
  if (covered.length === 0) return respond(c, 403, FORBIDDEN_BODY);
  coveredOf.set(c.req.raw, covered);
  return next();
};

/** `no-store` first, so the 401 and 403 carry it too. */
export const noStore: MiddlewareHandler<Env> = async (c, next) => {
  c.header("Cache-Control", NO_STORE);
  await next();
};

/**
 * The entity of the path, or the refusal: 404 when it is not one, 403 when no grant covers it (AC-4.2). Runs after
 * `authorize` (it reads what that step recorded for this request).
 */
export const entityOf = (c: Context<Env>): { entity: LegalEntity } | { response: Response } => {
  const name = (c.req.param() as Record<string, string>)["entity"] ?? "";
  if (!isLegalEntity(name)) return { response: unknownLegalEntity(c) };
  if (!(coveredOf.get(c.req.raw) ?? []).includes(name)) return { response: respond(c, 403, FORBIDDEN_BODY) };
  return { entity: name };
};

/** Reads the capped JSON body and checks it against `schema`: the parsed value, or the refusal to answer. */
export async function readBody<S extends z.ZodType>(c: Context<Env>, schema: S): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: Response }> {
  const body = await readBodyCapped(c.req.raw, MAX_WRITE_BODY_BYTES);
  if (!body.ok) return { ok: false, response: respond(c, 413, REQUEST_TOO_LARGE_BODY) };
  // Only a body that says it is JSON is parsed (the CSRF posture above).
  if (!/^application\/(?:[\w.+-]*\+)?json\b/i.test(c.req.header("Content-Type") ?? "")) {
    return { ok: false, response: respond(c, 422, INVALID_REQUEST_BODY) };
  }
  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return { ok: false, response: respond(c, 422, INVALID_REQUEST_BODY) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, response: respond(c, 422, INVALID_REQUEST_BODY) };
  return { ok: true, value: parsed.data };
}

/** `kick` after commit: not awaited, and nothing it throws or rejects with can reach the answer. */
function kickAndForget(kick: () => unknown): void {
  try {
    void Promise.resolve(kick()).catch(() => undefined);
  } catch {
    // a failed hand-over is the sweep's to make up
  }
}

/** Runs the write and maps its refusals; the success answer is `{ version, created, entity }` (201 or 200). */
async function answer(c: Context<Env>, audited: Audited, req: WriteRequest, notices: NoticeDeps): Promise<Response> {
  let outcome: Outcome;
  try {
    outcome = await write(audited, req, notices);
  } catch (error) {
    if (error instanceof Refusal) {
      return error.kind === "not_moved"
        ? respond(c, 409, NOT_MOVED_BODY)
        : respond(c, 409, versionConflictBody(error.currentVersion as number));
    }
    console.error(`[legal-entities] ${req.action} failed: ${safeErrorText(error)}`);
    return respond(c, 500, INTERNAL_BODY);
  }
  const created = outcome.kind === "created";
  // The transaction has committed: the notice duty is on disk. Hand it to the dispatcher at once, without waiting for
  // it (AC-9.7); a lost kick is covered by the next sweep, and the answer is the same whatever notify-api does (AC-9.14).
  if (outcome.kind === "created" && outcome.noticed) kickAndForget(notices.kick);
  return respond(c, created ? 201 : 200, {
    version: outcome.row.version,
    created,
    entity: serializeEntity(req.entity, outcome.row),
  });
}

const SAVE_PATH = "/legal-entities/:entity/versions";
const RESTORE_PATH = "/legal-entities/:entity/versions/:n/restore";

export interface WriteRouterOptions {
  /** The audit transaction; `withAudit` unless a test replaces it (to run in a rolled-back transaction, to fail after the insert). */
  audited?: Audited;
  /** The client a restore reads the stored version it restores through; `db` unless a test reads through its rolled-back transaction. */
  client?: Reader;
  /** The throttle (F3); the env's limits, a fresh pair per router, unless a test passes its own. */
  limits?: LegalEntityRateLimits;
  /**
   * The notice duty (T58): the recipients (`resolveRecipients`) and the outside mailbox (the env's) unless a test injects;
   * and (T59) the hand-over to the dispatcher after commit (`kickNotices`: nothing until the server started it).
   */
  notices?: NoticeDutyOptions & { outsideMailbox?: () => boolean; kick?: () => unknown };
}

export function createLegalEntityWriteRouter({
  audited = withAudit,
  client = db,
  limits = createLegalEntityRateLimits(),
  notices = {},
}: WriteRouterOptions = {}) {
  const router = new OpenAPIHono<Env>();
  const duty: NoticeDeps = {
    ...(notices.recipients !== undefined ? { recipients: notices.recipients } : {}),
    outsideMailbox: notices.outsideMailbox ?? (() => env.LEGAL_ENTITY_NOTICE_EMAIL !== undefined),
    kick: notices.kick ?? kickNotices,
  };

  // POST only, per exact path (never `/legal-entities/*`): the GETs of T5 and T7 carry their own authentication.
  router.on("POST", SAVE_PATH, noStore, sessionMiddleware, requireAuth, authorize, async (c) => {
    const target = entityOf(c);
    if ("response" in target) return target.response;
    // F3: counted per person after the authorisation above and before the body is read.
    const throttled = throttle(limits.write, c.get("user")!.id, c);
    if (throttled !== null) return throttled;
    const body = await readBody(c, SaveBodySchema);
    if (!body.ok) return body.response;
    const { baseVersion, details } = body.value;

    // The rules judge the SUBMITTED arrays (E5: `line` is the position the client sent); what is stored is normalised.
    const submitted: LegalDetails = {
      legalName: details.legalName,
      address: { it: details.address.it, en: details.address.en },
      vatNumber: details.vatNumber,
      iban: details.iban,
      contacts: { it: details.contacts.it, en: details.contacts.en },
    };
    const found = problems(submitted);
    if (found.length > 0) return respond(c, 422, invalidLegalEntityBody(found));

    const user = c.get("user")!;
    return answer(c, audited, {
      entity: target.entity,
      actor: { id: user.id, name: user.name },
      baseVersion,
      details: normalise(submitted),
      action: "save",
      restoredFrom: null,
    }, duty);
  });

  router.on("POST", RESTORE_PATH, noStore, sessionMiddleware, requireAuth, authorize, async (c) => {
    const target = entityOf(c);
    if ("response" in target) return target.response;
    const throttled = throttle(limits.write, c.get("user")!.id, c);
    if (throttled !== null) return throttled;
    const body = await readBody(c, RestoreBodySchema);
    if (!body.ok) return body.response;

    const n = parseVersion((c.req.param() as Record<string, string>)["n"] ?? "");
    // A stored version never changes, so reading it outside the transaction is safe; only the current version is
    // read under the lock.
    const row = n === null ? null : await versionOf(target.entity, n, client);
    if (n === null || row === null) return respond(c, 404, VERSION_NOT_FOUND_BODY);

    // D4: a version that fails today's rules (an incomplete or invalid imported one) is refused as a save would be.
    const stored = detailsOf(row);
    if (!restorable(stored)) return respond(c, 422, invalidLegalEntityBody(problems(stored)));

    const user = c.get("user")!;
    return answer(c, audited, {
      entity: target.entity,
      actor: { id: user.id, name: user.name },
      baseVersion: body.value.baseVersion,
      details: normalise(stored),
      action: "restore",
      restoredFrom: n,
    }, duty);
  });

  // Documentation only: the handlers above read the body themselves (the 16 KiB bound comes before any parse).
  const problemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), code: z.string(), detail: z.string() });
  const refusals = {
    401: { description: "No valid session" },
    403: { description: "`forbidden`: no `legal-entity:manage` covering the entity (nothing written)" },
    404: { description: "`unknown_legal_entity`, or (restore) `version_not_found`" },
    409: { description: "`version_conflict` (+ `currentVersion`) or `legal_entity_not_moved`" },
    429: { description: "`too_many_requests` (+ `Retry-After`): save and restore share one per-person window" },
    413: { description: "`request_too_large`: body over 16 KiB" },
    422: {
      description:
        "`invalid_request` (shape; no member name echoed) or `invalid_legal_entity` + `problems: [{ field, line?, reason, limit? }]`",
      content: { "application/problem+json": { schema: problemSchema } },
    },
  };
  const saved = {
    description: "The version now current",
    content: { "application/json": { schema: z.object({ version: z.number().int(), created: z.boolean(), entity: z.object({}).loose() }) } },
  };
  router.openAPIRegistry.registerPath({
    method: "post",
    path: "/legal-entities/{entity}/versions",
    tags: ["Legal entities"],
    summary: "Save the details of an entity as the next version (needs `legal-entity:manage` covering it)",
    request: {
      params: z.object({ entity: z.enum(LEGAL_ENTITIES) }),
      body: { required: true, content: { "application/json": { schema: SaveBodySchema } } },
    },
    responses: {
      201: { ...saved, description: "Created: version `baseVersion + 1`" },
      200: { ...saved, description: "`created: false`: equal to the current version, nothing written" },
      ...refusals,
    },
  });
  router.openAPIRegistry.registerPath({
    method: "post",
    path: "/legal-entities/{entity}/versions/{n}/restore",
    tags: ["Legal entities"],
    summary: "Restore version n as the next version (needs `legal-entity:manage` covering the entity)",
    request: {
      params: z.object({ entity: z.enum(LEGAL_ENTITIES), n: z.string() }),
      body: { required: true, content: { "application/json": { schema: RestoreBodySchema } } },
    },
    responses: {
      201: { ...saved, description: "Created: a new version equal to version n, `restoredFrom: n`" },
      200: { ...saved, description: "`created: false`: version n equals the current version" },
      ...refusals,
    },
  });

  return router;
}

/**
 * The ONE pair of limiters of the running app (plan G9): the write router below and the check router
 * (`check.routes.ts`, T55) are both built on it, so a person's windows are counted once per process, not once per router.
 */
export const legalEntityRateLimits = createLegalEntityRateLimits();

export const legalEntityWriteRouter = createLegalEntityWriteRouter({ limits: legalEntityRateLimits });

/**
 * The dry run of a save (specs/20261117-legal-entities, T55; AC-9.1, AC-9.5, AC-9.17; plan G1.7, G2, G5, G12):
 *
 *   POST /legal-entities/{entity}/versions/check   { baseVersion, details }
 *     -> 200 { baseVersion, outcome: "change" | "same", changedFields, protectedChanges: [{ field, before, after }] }
 *
 * admin-ui asks it before a save, so the confirmation of a protected change (legal name, VAT number, IBAN) is shown
 * only when the save would change one. Registry rule, not a client one: the rules (NFC, trim, IBAN without spaces and
 * in capitals) live in `rules.ts` alone, so a spacing- or case-only IBAN edit, an address edit or a contacts edit
 * answers `protectedChanges: []` (AC-9.5).
 *
 * It answers EXACTLY as the save would up to the point of writing, so a refusal comes before the confirmation:
 *   401 -> 403 `forbidden` -> 404 `unknown_legal_entity` -> 403 (grant not covering this entity) -> 429
 *   `too_many_requests` (the check's own per-person window, counted after authorisation and before the body is read)
 *   -> 413 -> 422 `invalid_request` -> 422 `invalid_legal_entity` (every problem at once, the save's body) -> 409
 *   `legal_entity_not_moved` -> 409 `version_conflict` + `currentVersion` -> 200.
 * A deleted person is refused at the 403 step (`authorize`, shared with the save). Nothing the request sent is
 * echoed in a refusal; the 200 carries only values a person who may save can already read (AC-3.1) and the normalised
 * form of what they typed.
 *
 * READ-ONLY: one SELECT of the current version, no transaction, no advisory lock, no version row, no audit row. The
 * answer is advisory (the save re-checks `baseVersion` under the lock), so reading without the lock is correct.
 *
 * `before` and `after` are both the stored (normalised) form, so a listed pair always differs as text: legal name and
 * VAT trimmed and NFC, the IBAN in print form (groups of four), "" for empty. Both come through `normalise`, so a
 * stored value written by the import in some other spacing is shown in the same form as the typed one.
 *
 * Routing (G12, D1): `router.on("POST", <exact path>)`, never a wildcard. It shares no pattern with a GET guard (the
 * `/versions/:n` guards are GET-only) and is not a save: the save's path `/legal-entities/:entity/versions` does not
 * match it, as the router matches whole segments.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { db } from "../lib/db";
import {
  authorize,
  type Env,
  entityOf,
  INTERNAL_BODY,
  invalidLegalEntityBody,
  legalEntityRateLimits,
  type LegalEntityRateLimits,
  NOT_MOVED_BODY,
  noStore,
  readBody,
  respond,
  SaveBodySchema,
  safeErrorText,
  throttle,
  versionConflictBody,
} from "./write.routes";
import { requireAuth, sessionMiddleware } from "../auth/auth.middleware";
import { LEGAL_ENTITIES } from "./entities";
import { latestVersion, type Reader } from "./repo";
import { changedFields, ibanPrint, type LegalDetails, normalise, PROTECTED_FIELDS, type ProtectedField, problems, protectedChanged } from "./rules";
import { detailsOf } from "./serialize";

const CHECK_PATH = "/legal-entities/:entity/versions/check";

/** One protected detail the save would change, in stored form ("" = empty; the IBAN in print form). */
export interface ProtectedChange {
  field: ProtectedField;
  before: string;
  after: string;
}

export interface CheckAnswer {
  baseVersion: number;
  outcome: "change" | "same";
  changedFields: string[];
  protectedChanges: ProtectedChange[];
}

/** The value of a protected field as the confirmation shows it. `d` is already normalised. */
function shown(d: LegalDetails, field: ProtectedField): string {
  switch (field) {
    case "legalName":
      return d.legalName;
    case "vatNumber":
      return d.vatNumber;
    case "iban":
      return ibanPrint(d.iban);
  }
}

/** What a save of `submitted` over `current` would change (pure; `submitted` already passed `problems`). */
export function checkAnswer(baseVersion: number, current: LegalDetails, submitted: LegalDetails): CheckAnswer {
  const before = normalise(current);
  const after = normalise(submitted);
  const changed = changedFields(before, after);
  return {
    baseVersion,
    outcome: changed.length === 0 ? "same" : "change",
    changedFields: changed,
    protectedChanges: protectedChanged(changed).map((field) => ({ field, before: shown(before, field), after: shown(after, field) })),
  };
}

export interface CheckRouterOptions {
  /** The client the current version is read through; `db` unless a test reads through its rolled-back transaction. */
  client?: Reader;
  /** The throttle; the app's one pair (`legalEntityRateLimits`) unless a test passes its own. Only `check` is used. */
  limits?: LegalEntityRateLimits;
}

export function createLegalEntityCheckRouter({ client = db, limits = legalEntityRateLimits }: CheckRouterOptions = {}) {
  const router = new OpenAPIHono<Env>();

  router.on("POST", CHECK_PATH, noStore, sessionMiddleware, requireAuth, authorize, async (c) => {
    const target = entityOf(c);
    if ("response" in target) return target.response;
    const throttled = throttle(limits.check, c.get("user")!.id, c);
    if (throttled !== null) return throttled;
    const body = await readBody(c, SaveBodySchema);
    if (!body.ok) return body.response;
    const { baseVersion, details } = body.value;

    // The rules judge the SUBMITTED arrays (E5), exactly as the save does.
    const submitted: LegalDetails = {
      legalName: details.legalName,
      address: { it: details.address.it, en: details.address.en },
      vatNumber: details.vatNumber,
      iban: details.iban,
      contacts: { it: details.contacts.it, en: details.contacts.en },
    };
    const found = problems(submitted);
    if (found.length > 0) return respond(c, 422, invalidLegalEntityBody(found));

    let current;
    try {
      current = await latestVersion(target.entity, client);
    } catch (error) {
      console.error(`[legal-entities] check failed: ${safeErrorText(error)}`);
      return respond(c, 500, INTERNAL_BODY);
    }
    if (current === null) return respond(c, 409, NOT_MOVED_BODY);
    if (current.version !== baseVersion) return respond(c, 409, versionConflictBody(current.version));

    return respond(c, 200, checkAnswer(baseVersion, detailsOf(current), submitted));
  });

  // Documentation only: the handler reads the body itself (the 16 KiB bound comes before any parse).
  const problemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), code: z.string(), detail: z.string() });
  router.openAPIRegistry.registerPath({
    method: "post",
    path: "/legal-entities/{entity}/versions/check",
    tags: ["Legal entities"],
    summary: "What a save would change, protected details listed; writes nothing (needs `legal-entity:manage` covering the entity)",
    request: {
      params: z.object({ entity: z.enum(LEGAL_ENTITIES) }),
      body: { required: true, content: { "application/json": { schema: SaveBodySchema } } },
    },
    responses: {
      200: {
        description: "`outcome`, `changedFields` and the protected details that would change, in stored form",
        content: {
          "application/json": {
            schema: z.object({
              baseVersion: z.number().int(),
              outcome: z.enum(["change", "same"]),
              changedFields: z.array(z.string()),
              protectedChanges: z.array(z.object({ field: z.enum(PROTECTED_FIELDS), before: z.string(), after: z.string() })),
            }),
          },
        },
      },
      401: { description: "No valid session" },
      403: { description: "`forbidden`: no `legal-entity:manage` covering the entity (nothing written)" },
      404: { description: "`unknown_legal_entity`" },
      409: { description: "`version_conflict` (+ `currentVersion`) or `legal_entity_not_moved`" },
      413: { description: "`request_too_large`: body over 16 KiB" },
      422: {
        description: "`invalid_request` (shape) or `invalid_legal_entity` + `problems`, as the save",
        content: { "application/problem+json": { schema: problemSchema } },
      },
      429: { description: "`too_many_requests` (+ `Retry-After`): the check has its own per-person window" },
    },
  });

  return router;
}

export const legalEntityCheckRouter = createLegalEntityCheckRouter();

/**
 * Letterhead, place of issue and standard terms of each wellD entity (the legal details live in the registry, AC-6.1)
 * (specs/20261101-crm-sales-flow O2; specs/20261102-crm-offer-document US-2).
 *
 *   GET  /entity-profiles                           deal:financials (the terms are commercial)
 *   PUT  /entity-profiles/{entity}                  deal:manage covering that entity
 *   POST /entity-profiles/{entity}/letterhead       deal:manage covering that entity: a presigned POST (PDF ≤ 5 MiB)
 *   POST /entity-profiles/{entity}/letterhead/confirm   the same: validate the upload, swap the key
 *   GET  /entity-profiles/{entity}/letterhead       deal:financials: a 60 s presigned GET
 *
 * With the switch on (`LETTERHEAD_SERVICE_ENABLED`) the three letterhead routes answer 410 `letterhead_upload_retired`
 * (specs/20261116-letterhead-service AC-10.11); the retirement script then deletes the stored files and the references.
 *
 * One row per entity, replaced whole on PUT (the letterhead columns are not part
 * of it: only the upload flow moves them; the legacy legal columns neither). Not an audit record: the offers
 * snapshot what they printed, so changing the letterhead never rewrites one.
 *
 * The letterhead upload is two-phase like the deal attachments (ADR 20260716-eu-object-storage-refund-attachments
 * posture): the browser POSTs straight to the EU bucket under
 * `letterheads/<entity>/<uuid>.pdf`, then confirm reads the object, checks it
 * with pdf-lib (one A4 page) and only then points the profile at it. A key
 * outside that entity's prefix is refused BEFORE anything is read or deleted,
 * so confirm can never be used to inspect or remove another object (no IDOR on
 * keys). Confirm then stores a COPY of the bytes it checked under a fresh key that
 * was never given an upload policy and deletes the upload key, so a stored letterhead
 * is exactly what was checked and never changes (specs/20261115-crm-offer-wizard DD-75,
 * security M-4); every later use of it is checked once per process (`letterheadUse.ts`, DD-76).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { DEAL_FINANCIALS, DEAL_MANAGE, authorized, dealScope, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { db } from "../lib/db";
import { env } from "../lib/env";
import {
  EntitySchema,
  PersonRefSchema,
  commonErrors,
  pdfCheckErrors,
  optionalText,
  type HeaderSource,
} from "../lib/http";
import { loadPeople } from "../lib/people";
import { ProblemError, notFound, unprocessable, validationHook } from "../lib/problem";
import { MAX_LETTERHEAD_BYTES, requireStorage } from "../lib/storage";
import { assertInScope } from "../deals/deals.routes";
import { acquireCheckSlot, checkLetterheadIsolated } from "./isolatedPdfCheck";
import { assertLetterheadUsable, rememberUsableLetterhead } from "./letterheadUse";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

/**
 * The issuer's legal details moved to the legal-entity registry in auth (specs/20261117-legal-entities AC-6.1): this body
 * carries only the CRM's own values. During the switch push an old crm-ui still sends the four legacy keys, so they are
 * ACCEPTED AND IGNORED, whatever they hold (nothing of them is stored, so a NUL or an oversized value reaches no insert); any
 * other unknown key is refused as before (`.strict()`). The tolerance goes with the columns, in the contract step (plan, step 6).
 */
const legacyKey = z.unknown().optional().openapi({ deprecated: true, description: "Ignored: the legal details are kept in Legal entities" });

const ProfileBodySchema = z
  .object({
    legalName: legacyKey,
    addressLines: legacyKey,
    vatNumber: legacyKey,
    iban: legacyKey,
    offerTermsEn: optionalText(10_000),
    offerTermsIt: optionalText(10_000),
    placeOfIssue: optionalText(100),
  })
  .strict();

const ProfileSchema = z.object({
  entity: EntitySchema,
  offerTermsEn: z.string().nullable(),
  offerTermsIt: z.string().nullable(),
  /** Printed beside the date of an offer; null means the default, "Lugano". */
  placeOfIssue: z.string().nullable(),
  /** Who uploaded the current letterhead and when; null when there is none. */
  letterhead: z.object({ uploadedBy: PersonRefSchema, uploadedAt: z.string() }).nullable(),
  updatedAt: z.string(),
});

const EntityParams = z.object({ entity: EntitySchema });
const manage = [...authorized, requireCapability(DEAL_MANAGE)];

export const LETTERHEAD_UPLOAD_RETIRED = "letterhead_upload_retired";

/**
 * With the switch on (`LETTERHEAD_SERVICE_ENABLED`) the letterhead is the layout service's and an uploaded PDF is not read by
 * anything (AC-10.11): the routes that start, confirm or read an upload answer 410 `letterhead_upload_retired`, and so
 * `letterhead_unusable` can no longer be answered. It runs after the guards (a caller who may not use the route still gets
 * 401/403) and before the params and body are read, so a malformed request answers 410 too. Read at the request, never
 * cached at import. A 410 is cacheable by default, so it says it is not to be kept: switching back must not leave it behind.
 */
const uploadRetired: MiddlewareHandler = async (c, next) => {
  if (env.LETTERHEAD_SERVICE_ENABLED) {
    c.header("Cache-Control", "no-store");
    throw new ProblemError({
      status: 410,
      code: LETTERHEAD_UPLOAD_RETIRED,
      detail: "Uploading a letterhead is retired: the letterhead is configured in Letterheads",
    });
  }
  await next();
};

const listRoute = createRoute({
  method: "get",
  path: "/entity-profiles",
  tags: ["Settings"],
  summary: "Letterhead and offer terms per entity (deal:financials)",
  middleware: [...authorized, requireCapability(DEAL_FINANCIALS)],
  responses: { 200: { description: "Profiles", ...json(z.object({ items: z.array(ProfileSchema) })) }, ...commonErrors },
});

const putRoute = createRoute({
  method: "put",
  path: "/entity-profiles/{entity}",
  tags: ["Settings"],
  summary: "Replace an entity's offer details (deal:manage over that entity); the letterhead is untouched",
  middleware: manage,
  request: {
    params: EntityParams,
    body: { content: { "application/json": { schema: ProfileBodySchema } }, required: true },
  },
  responses: { 200: { description: "Saved", ...json(ProfileSchema) }, ...commonErrors },
});

const letterheadStartRoute = createRoute({
  method: "post",
  path: "/entity-profiles/{entity}/letterhead",
  tags: ["Settings"],
  summary: "Start a letterhead upload: a presigned POST for a PDF of at most 5 MiB (deal:manage over that entity); 410 with the switch on",
  middleware: [...manage, uploadRetired],
  request: { params: EntityParams },
  responses: {
    ...commonErrors,
    201: {
      description: "Upload to `upload.url` with `upload.fields`, then confirm with `key`",
      ...json(z.object({ key: z.string(), upload: z.object({ url: z.string(), fields: z.record(z.string(), z.string()) }) })),
    },
    403: { description: "out_of_scope" },
    409: { description: "entity_profile_missing" },
    410: { description: "letterhead_upload_retired (switch on: the letterhead is the layout service's)" },
  },
});

const LetterheadConfirmSchema = z.object({ key: z.string().min(1).max(300) }).strict();

const letterheadConfirmRoute = createRoute({
  method: "post",
  path: "/entity-profiles/{entity}/letterhead/confirm",
  tags: ["Settings"],
  summary: "Confirm a letterhead upload: one readable A4 page, else the object is deleted (deal:manage over that entity); 410 with the switch on",
  middleware: [...manage, uploadRetired],
  request: {
    params: EntityParams,
    body: { content: { "application/json": { schema: LetterheadConfirmSchema } }, required: true },
  },
  responses: {
    ...commonErrors,
    ...pdfCheckErrors,
    200: { description: "The profile, with the new letterhead", ...json(ProfileSchema) },
    403: { description: "out_of_scope" },
    409: { description: "entity_profile_missing / upload_missing" },
    410: { description: "letterhead_upload_retired (switch on)" },
    422: {
      description:
        "letterhead_invalid (`reason`: not_pdf, page_count, not_a4, unembeddable, too_large, " +
        "too_complex, decoded_too_large, image_too_large, unbounded_stream) / letterhead_key_invalid. " +
        "The upload is deleted; on 200 the profile points at a copy of the checked bytes under a fresh key.",
    },
  },
});

const letterheadDownloadRoute = createRoute({
  method: "get",
  path: "/entity-profiles/{entity}/letterhead",
  tags: ["Settings"],
  summary: "A 60 s download link for the entity's letterhead (deal:financials); `Cache-Control: no-store`; 410 with the switch on",
  middleware: [...authorized, requireCapability(DEAL_FINANCIALS), uploadRetired],
  request: { params: EntityParams },
  responses: {
    ...commonErrors,
    ...pdfCheckErrors,
    200: { description: "Presigned URL", ...json(z.object({ url: z.string() })) },
    404: { description: "No letterhead" },
    410: { description: "letterhead_upload_retired (switch on)" },
    409: {
      description:
        "letterhead_unusable (switch off only; with it on the route answers 410): the stored letterhead fails the check (`entity`, `reason`: not_pdf, page_count, not_a4, " +
        "unembeddable, too_complex, decoded_too_large, image_too_large, unbounded_stream); no link is minted, " +
        "`Cache-Control: no-store`. Upload the letterhead again.",
      ...json(
        z.object({
          code: z.literal("letterhead_unusable"),
          entity: EntitySchema,
          reason: z.enum([
            "not_pdf",
            "page_count",
            "not_a4",
            "unembeddable",
            "too_complex",
            "decoded_too_large",
            "image_too_large",
            "unbounded_stream",
          ]),
        }),
      ),
    },
  },
});

export const entityProfilesRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({
  defaultHook: validationHook,
});

type ProfileRow = Awaited<ReturnType<typeof db.entityProfile.findUniqueOrThrow>>;

async function toViews(c: HeaderSource, rows: readonly ProfileRow[]) {
  const { person } = await loadPeople(c, rows.map((row) => row.letterheadBy));
  return rows.map((row) => ({
    entity: row.entity,
    offerTermsEn: row.offerTermsEn,
    offerTermsIt: row.offerTermsIt,
    placeOfIssue: row.placeOfIssue,
    letterhead:
      row.letterheadKey && row.letterheadAt && row.letterheadBy
        ? { uploadedBy: person(row.letterheadBy), uploadedAt: row.letterheadAt.toISOString() }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

const profileMissing = (entity: string) =>
  new ProblemError({
    status: 409,
    code: "entity_profile_missing",
    detail: "Save the entity's offer details before uploading its letterhead",
    extras: { entity },
  });

entityProfilesRouter.openapi(listRoute, async (c) => {
  const rows = await db.entityProfile.findMany({ orderBy: { entity: "asc" } });
  return c.json({ items: await toViews(c, rows) }, 200);
});

entityProfilesRouter.openapi(putRoute, async (c) => {
  const { entity } = c.req.valid("param");
  const body = c.req.valid("json");
  assertInScope(dealScope(c), entity);
  // The legacy legal keys are dropped here, never copied: an existing row keeps the values it has (the columns stay until
  // step 6) and a new row takes the column defaults.
  const data = {
    offerTermsEn: body.offerTermsEn ?? null,
    offerTermsIt: body.offerTermsIt ?? null,
    placeOfIssue: body.placeOfIssue ?? null,
    updatedBy: c.get("userId"),
  };
  const row = await db.entityProfile.upsert({ where: { entity }, create: { entity, ...data }, update: data });
  return c.json((await toViews(c, [row]))[0]!, 200);
});

/** `letterheads/<entity>/<uuid>.pdf`, the only shape this service ever mints. */
const letterheadKeyPattern = (entity: string) =>
  new RegExp(`^letterheads/${entity}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`);

entityProfilesRouter.openapi(letterheadStartRoute, async (c) => {
  const { entity } = c.req.valid("param");
  assertInScope(dealScope(c), entity);
  if (!(await db.entityProfile.findUnique({ where: { entity }, select: { entity: true } }))) throw profileMissing(entity);
  const key = `letterheads/${entity}/${crypto.randomUUID()}.pdf`;
  const upload = await requireStorage().mintPresignedPost(key, "application/pdf", MAX_LETTERHEAD_BYTES);
  return c.json({ key, upload }, 201);
});

async function deleteQuietly(key: string): Promise<void> {
  try {
    await requireStorage().deleteObject(key);
  } catch (error) {
    console.error("[letterhead] could not delete the object:", key, error instanceof Error ? error.message : error);
  }
}

entityProfilesRouter.openapi(letterheadConfirmRoute, async (c) => {
  const { entity } = c.req.valid("param");
  const { key } = c.req.valid("json");
  assertInScope(dealScope(c), entity);
  const profile = await db.entityProfile.findUnique({ where: { entity } });
  if (!profile) throw profileMissing(entity);
  // Before anything is read or deleted: only this entity's own upload keys.
  if (!letterheadKeyPattern(entity).test(key)) {
    throw unprocessable("The key is not a letterhead upload of this entity", { field: "key" }, "letterhead_key_invalid");
  }
  const storage = requireStorage();
  const head = await storage.headObject(key);
  if (!head) throw new ProblemError({ status: 409, code: "upload_missing", detail: "The file has not reached storage yet" });

  const invalid = async (reason: string): Promise<never> => {
    await deleteQuietly(key);
    throw unprocessable(
      "The letterhead must be a readable PDF of exactly one A4 page",
      { field: "key", reason },
      "letterhead_invalid",
    );
  };
  if (head.sizeBytes > MAX_LETTERHEAD_BYTES) return invalid("too_large");
  // The place for the check is taken before the bytes are read (503 `pdf_check_busy` has read nothing, the upload stays for a retry) and
  // one user holds a bounded share of the queue (security L-13).
  const slot = await acquireCheckSlot(c.get("userId"));
  let checked: Uint8Array;
  let verdict: Awaited<ReturnType<typeof checkLetterheadIsolated>>;
  try {
    checked = await storage.getObject(key, MAX_LETTERHEAD_BYTES);
    verdict = await checkLetterheadIsolated(checked, { slot });
  } finally {
    slot.release();
  }
  if (!verdict.ok) return invalid(verdict.reason);

  // Store a copy of exactly the bytes that were checked, under a key nobody holds an upload policy for: the upload key
  // can still be written by whoever holds its POST policy (it stays valid for 60 s from the mint), so it is never stored
  // (DD-75, security M-4 F-4). A failed copy leaves the upload and the profile as they were, for a retry.
  const stored = `letterheads/${entity}/${crypto.randomUUID()}.pdf`;
  await storage.putObject(stored, checked, "application/pdf");
  const previous = profile.letterheadKey;
  let row: ProfileRow;
  try {
    row = await db.entityProfile.update({
      where: { entity },
      data: { letterheadKey: stored, letterheadBy: c.get("userId"), letterheadAt: new Date() },
    });
  } catch (error) {
    await deleteQuietly(stored);
    throw error;
  }
  rememberUsableLetterhead(stored);
  await deleteQuietly(key);
  if (previous && previous !== key) await deleteQuietly(previous);
  return c.json((await toViews(c, [row]))[0]!, 200);
});

entityProfilesRouter.openapi(letterheadDownloadRoute, async (c) => {
  const { entity } = c.req.valid("param");
  const profile = await db.entityProfile.findUnique({ where: { entity }, select: { letterheadKey: true } });
  if (!profile?.letterheadKey) throw notFound("No letterhead has been uploaded for this entity");
  // A bearer link or a refusal about a letterhead: never kept by a cache (DD-54).
  c.header("Cache-Control", "no-store");
  // The stored file is checked once per key per process before a link to it is minted (DD-76).
  await assertLetterheadUsable(requireStorage(), entity, profile.letterheadKey);
  const url = await requireStorage().mintPresignedGet(profile.letterheadKey, {
    contentType: "application/pdf",
    fileName: `letterhead-${entity}.pdf`,
  });
  // It is not logged: the request logger writes the path only.
  return c.json({ url }, 200);
});

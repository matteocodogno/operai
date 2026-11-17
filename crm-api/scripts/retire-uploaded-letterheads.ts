/**
 * Retires the uploaded letterhead PDFs at the CRM switch (specs/20261116-letterhead-service T30; AC-10.11, AC-10.12, O5).
 *
 *   bun scripts/retire-uploaded-letterheads.ts            # dry run: lists what it would do, changes nothing
 *   bun scripts/retire-uploaded-letterheads.ts --apply    # deletes the objects and clears the references
 *
 * For each entity profile that still holds a letterhead it deletes the object from the CRM's bucket and sets
 * `letterheadKey`, `letterheadBy` and `letterheadAt` to null. There is NO rollback to the uploaded letterhead (owner, O5).
 *
 * It refuses, and changes nothing, unless
 *   1. the check passes: `scripts/check-letterhead-service.ts` (both entities have an active letterhead in the service),
 *   2. with `--apply`, the switch is on in this environment (`LETTERHEAD_SERVICE_ENABLED=true`): with it off the CRM still
 *      draws its own pages from the uploaded PDF, and deleting it would give offers a plain page, and
 *   3. a small sample PDF of EACH entity renders through crm-api's own letterhead client (the one the offers use, with its
 *      credential and scope). The check proves an active version is listed, not that a render works (an asset missing from
 *      the bucket still lists), and nothing says the script's own environment is the deployed CRM's (security review F10). It
 *      runs in the dry run too, before anything is acted on, and only when there is something to retire.
 *
 * The delete is permanent, so keep a recoverable copy first (bucket versioning, or a copy of `letterheads/` to an archive
 * prefix): infra/README.md § "The CRM switch".
 *
 * Order, so a failure in the middle can be re-run: the object is deleted first, then the reference is cleared. A delete of
 * a missing object is not an error, so a re-run finishes what a failed one left; a run with nothing left to retire does
 * nothing and calls neither the bucket nor the service.
 *
 * It deletes only `letterheads/<entity>/<uuid>.pdf` of the profile's own entity, the one shape the upload ever minted. A
 * reference of any other shape (an offer PDF, another entity's file, anything) is reported and left alone, with its
 * reference: offers never read the letterhead object and their stored PDFs are never touched here.
 *
 * It logs the entity and the object key it deleted, never a link, a credential, bytes or a storage error's text (the error's
 * class only). Exit 0: done, or a dry run, or nothing to do. Exit 1: refused, or at least one entity could not be retired
 * (re-run it). Exit 2: not configured, or a bad argument.
 */

import { ENTITIES } from "../src/authz/conditions";
import { db } from "../src/lib/db";
import type { LetterheadClient } from "../src/lib/letterheadClient";
import type { Storage } from "../src/lib/storage";
import { CONTENT_VERSION, type LetterheadContent } from "../src/offers/blocks";
import { runSwitchCheck, type Io } from "./check-letterhead-service";

export interface RetireOptions {
  /** Only `deleteObject` is reachable: the script cannot read or write an object. */
  readonly storage: Pick<Storage, "deleteObject">;
  /** The release check (`runSwitchCheck`, wired by the caller): its exit code. */
  readonly check: () => Promise<number>;
  /**
   * Renders a small sample PDF of the entity through crm-api's own client and throws when it cannot (`sampleRenderer`,
   * wired by the caller). Called for every entity before anything is deleted.
   */
  readonly renderSample: (entity: Entity) => Promise<void>;
  /** `LETTERHEAD_SERVICE_ENABLED` as this process sees it. */
  readonly switchOn: boolean;
  readonly apply: boolean;
  readonly io: Io;
}

type Entity = (typeof ENTITIES)[number];

/** One heading and one line: the smallest document that still draws the letterhead's header, footer and assets. */
export const sampleContent = (entity: Entity): LetterheadContent => ({
  contentVersion: CONTENT_VERSION,
  entity,
  language: "en",
  blocks: [
    { type: "heading", level: 1, text: "Letterhead retirement check" },
    { type: "paragraph", runs: [{ text: "This page proves the layout service draws this entity's letterhead." }] },
  ],
});

/** The `renderSample` of the real run: the client's `pdf` (the offers' own call), which already refuses anything but a PDF. */
export const sampleRenderer =
  (client: Pick<LetterheadClient, "pdf">) =>
  async (entity: Entity): Promise<void> => {
    const rendered = await client.pdf(sampleContent(entity));
    if (rendered.pageCount < 1 || rendered.bytes.byteLength === 0) throw new Error("empty render");
  };

/** What a failed render says: the problem's code (a closed list of the client's) or the error's class, never its text. */
const whyNot = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.name : "error";

/** `letterheads/<entity>/<uuid>.pdf`, the only shape the upload mints (`entityProfiles.routes.ts`). */
const ownLetterheadKey = (entity: string) =>
  new RegExp(`^letterheads/${entity}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`);

const pad = (entity: string) => entity.padEnd(9);

/** Returns the process exit code. */
export async function runRetire({ storage, check, renderSample, switchOn, apply, io }: RetireOptions): Promise<number> {
  const checked = await check();
  if (checked !== 0) {
    io.error("Refused: the switch check does not pass, so nothing was changed.");
    return checked === 2 ? 2 : 1;
  }
  if (apply && !switchOn) {
    io.error("Refused: LETTERHEAD_SERVICE_ENABLED is not true in this environment, so the CRM still draws its own pages from the uploaded letterhead. Enable the switch first. Nothing was changed.");
    return 1;
  }
  if (!apply && !switchOn) io.log("Note: the switch is off in this environment, so --apply would refuse.");

  const holders = await db.entityProfile.findMany({
    where: { OR: [{ letterheadKey: { not: null } }, { letterheadBy: { not: null } }, { letterheadAt: { not: null } }] },
    select: { entity: true, letterheadKey: true },
    orderBy: { entity: "asc" },
  });
  if (holders.length === 0) {
    io.log("Nothing to retire: no entity profile holds an uploaded letterhead.");
    return 0;
  }

  // Before anything is acted on, the dry run's list included: both entities must draw a page through the client the offers use.
  let unrendered = 0;
  for (const entity of ENTITIES) {
    try {
      await renderSample(entity);
    } catch (error) {
      io.error(`${pad(entity)} sample PDF did NOT render (${whyNot(error)}).`);
      unrendered += 1;
    }
  }
  if (unrendered > 0) {
    io.error("Refused: the layout service cannot draw a sample PDF for every entity, so deleting the uploaded letterheads could leave offers without one. Nothing was changed.");
    return 1;
  }
  io.log(`Sample PDF rendered for ${ENTITIES.join(" and ")}.`);

  let failures = 0;
  for (const { entity, letterheadKey } of holders) {
    if (letterheadKey !== null && !ownLetterheadKey(entity).test(letterheadKey)) {
      // Not something the upload minted: it is not deleted and the reference is not cleared, for a person to look at.
      io.error(`${pad(entity)} SKIPPED the stored reference is not a letterhead object of this entity: nothing was deleted or changed.`);
      failures += 1;
      continue;
    }
    if (!apply) {
      io.log(`${pad(entity)} would delete ${letterheadKey ?? "(no object)"} and clear the letterhead reference`);
      continue;
    }
    if (letterheadKey !== null) {
      try {
        await storage.deleteObject(letterheadKey);
      } catch (error) {
        io.error(`${pad(entity)} FAILED to delete ${letterheadKey} (${error instanceof Error ? error.name : "error"}): the reference is kept; re-run.`);
        failures += 1;
        continue;
      }
    }
    // Only the reference that was deleted: an entity whose letterhead changed meanwhile is left for the next run.
    const cleared = await db.entityProfile.updateMany({
      where: { entity, letterheadKey },
      data: { letterheadKey: null, letterheadBy: null, letterheadAt: null },
    });
    if (cleared.count === 0) {
      io.error(`${pad(entity)} CHANGED while it was being retired: the reference was left as it is; re-run.`);
      failures += 1;
      continue;
    }
    io.log(`${pad(entity)} deleted ${letterheadKey ?? "(no object)"} and cleared the letterhead reference`);
  }

  if (failures > 0) {
    io.error(`${failures} entity(ies) could not be retired. Re-run the script: it finishes what is left.`);
    return 1;
  }
  io.log(apply ? "Done: the uploaded letterheads are retired. Offer PDFs were not touched." : "Dry run: nothing was changed. Re-run with --apply to retire them.");
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) {
    console.error("Usage: bun scripts/retire-uploaded-letterheads.ts [--apply]");
    process.exit(2);
  }
  const { env } = await import("../src/lib/env");
  const { letterhead } = await import("../src/lib/letterheadClient");
  const { createServiceTokenProvider } = await import("../src/lib/serviceToken");
  const { requireStorage } = await import("../src/lib/storage");
  let storage: Storage;
  try {
    storage = requireStorage();
  } catch {
    console.error("CRM_S3_* is not set: nothing was changed.");
    process.exit(2);
  }
  const io: Io = { log: (l) => console.log(l), error: (l) => console.error(l) };
  const tokens =
    env.LETTERHEAD_API_URL && env.SERVICE_CLIENT_ID && env.SERVICE_CLIENT_SECRET
      ? createServiceTokenProvider({ baseUrl: env.AUTH_BASE_URL, clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET })
      : null;
  const code = await runRetire({
    storage,
    check: () => runSwitchCheck({ baseUrl: env.LETTERHEAD_API_URL, tokens, io }),
    renderSample: sampleRenderer(letterhead),
    switchOn: env.LETTERHEAD_SERVICE_ENABLED,
    apply: args.includes("--apply"),
    io,
  });
  await db.$disconnect();
  process.exit(code);
}

/**
 * What the two service-preview routes share (specs/20261116-letterhead-service T28; AC-10.3, AC-10.7, AC-10.8, AC-10.14;
 * plan § API contracts "crm-api", amendments G1 and G7):
 *
 *   POST /deals/{id}/offer-draft/preview?pages=…          the wizard's preview (offerDrafts.routes.ts)
 *   POST /offer-templates/{id}/try-preview?pages=…        "Try the wizard", no deal (offerTemplates.routes.ts)
 *
 * Both turn what the person sees into content version 2 (`blocks.ts`: no `entityData`, the issuer is the registry's, pinned by `legalEntityVersion`), ask letterhead-api for the pages through the client
 * of T27 and answer the service's preview unchanged, plus `missingFields`. Neither stores anything: the answer is made of
 * the request and the database as they are, and goes back to the browser with `Cache-Control: no-store`.
 *
 * This file holds the three things that must be the same in both, so the two cannot drift:
 *
 *   - the `pages` query and the answer's schema;
 *   - the switch (`requireLetterheadService`): with `LETTERHEAD_SERVICE_ENABLED` off the routes do not exist (404, as an
 *     unmounted route answers), so the CRM that has not made the switch cannot be told anything about the service;
 *   - the one place a service refusal that the client reports as "unavailable" becomes the frame's overflow (409
 *     `letterhead_overflow`, T27's note): a legal-details value too long for the header or the footer is something the person can
 *     fix, a service that is down is not.
 *
 * `overflowOf` is exported for the third caller, the generation of the PDF (`generation.ts`, T29): the frame's overflow is the same
 * answer whether it is found while previewing or while generating.
 *
 * It holds NO content validator: the content comes from `blocks.ts`, and the service validates every request it gets. A
 * refusal of the content (`invalid_content` and its kin) is a defect of crm-api, reported by the client as unavailable
 * with the service's code in the log, never an answer a person can act on.
 */

import { z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { env } from "../lib/env";
import { LAYOUT_SERVICE_UNAVAILABLE, letterhead } from "../lib/letterheadClient";
import { ProblemError, problem } from "../lib/problem";
import type { DraftBlocks, Entity } from "./blocks";

// ─── The switch ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * With the switch off the preview routes answer 404, in the words of a route that is not mounted. Not 409: a conflict says
 * "your state is wrong, change it", and the caller can change nothing; it would also sit beside `letterhead_not_configured`
 * (409), which the UI turns into a link to the configurator. Not 503 `*_unconfigured`: that is for a service the CRM is meant
 * to have and does not (a bucket, EstimAI); here the CRM has chosen not to use it yet.
 *
 * It is the LAST route guard: a caller without `crm:access` or the deal capabilities gets the 401 or 403 they always got, so
 * the switch's state is told only to a person the CRM already trusts with the same fact (`GET /scope`). It runs before the
 * body is read, so a malformed body answers 404 too when the switch is off. Read at the request, never cached at import.
 *
 * With the switch on it is also where the per-person cap of in-flight previews is taken (`previewCap`, security review F1):
 * the one place both routes pass through, so the cap is the same for both and wired without touching either route.
 */
export const requireLetterheadService: MiddlewareHandler = async (c, next) => {
  if (!env.LETTERHEAD_SERVICE_ENABLED) {
    throw new ProblemError({ status: 404, detail: `${c.req.method} ${c.req.path} does not exist` });
  }
  // `userId` is the token's `sub`, set by the JWT guard that precedes this one on both routes. Were it ever missing the
  // requests would share one key: stricter, never looser.
  const release = previewCap.acquire(String(c.get("userId") ?? ""));
  if (release === null) {
    const busy = problem({ status: 429, code: PREVIEW_BUSY, detail: "Too many previews are being drawn for you at once: wait a moment and try again" }, c.req.path);
    busy.headers.set("Retry-After", "1");
    busy.headers.set("Cache-Control", "no-store");
    return busy;
  }
  try {
    return await next();
  } finally {
    // After the handler is done, whatever it ended in (an answer, a thrown problem, an aborted client: a disconnect does not
    // cancel the request, so the service call it made is still counted until it ends).
    release();
  }
};

// ─── The per-person cap ──────────────────────────────────────────────────────────────────────────────────────────────

/** At most this many previews of one person (across both routes) are in flight at once; the next is 429 `preview_busy`. */
export const MAX_PREVIEWS_IN_FLIGHT_PER_PERSON = 2;
export const PREVIEW_BUSY = "preview_busy";

export interface InflightCap {
  /** A release function (idempotent) when `key` has a free slot, `null` when it is at its cap. Synchronous: no race. */
  acquire(key: string): (() => void) | null;
  /** The slots `key` holds now. */
  inflight(key: string): number;
}

/**
 * An in-process counter per key. One crm-api process counts its own; with several instances the cap is per instance, so
 * one person's share of the service is bounded by `max` times the instances. A key with nothing in flight is dropped, so
 * the map holds only people who are previewing right now.
 */
export function createInflightCap(max: number): InflightCap {
  const held = new Map<string, number>();
  return {
    acquire(key) {
      const n = held.get(key) ?? 0;
      if (n >= max) return null;
      held.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (held.get(key) ?? 1) - 1;
        if (left <= 0) held.delete(key);
        else held.set(key, left);
      };
    },
    inflight: (key) => held.get(key) ?? 0,
  };
}

export const previewCap = createInflightCap(MAX_PREVIEWS_IN_FLIGHT_PER_PERSON);

// ─── The query and the answer ────────────────────────────────────────────────────────────────────────────────────────

/** The service renders at most 300 pages (`too_many_pages`): a request for a later one is refused here, not sent. */
const MAX_PAGE = 300;

/**
 * `?pages=1,2,3` as page numbers: sorted, each once. `null` when it is not a comma list of whole numbers from 1 to 300
 * (no sign, no blank, no `1e2`, no leading zero), so the client never sees a value it would throw on.
 */
export function parsePages(raw: string): number[] | null {
  if (!/^[1-9]\d{0,2}(,[1-9]\d{0,2})*$/.test(raw)) return null;
  const pages = [...new Set(raw.split(",").map(Number))];
  return pages.every((page) => page <= MAX_PAGE) ? pages.sort((a, b) => a - b) : null;
}

/** The `pages` query: absent means every page. */
export const PagesQuery = z
  .string()
  .refine((value) => parsePages(value) !== null, `Page numbers from 1 to ${MAX_PAGE}, separated by commas`)
  .optional()
  .describe("1-based pages to return, e.g. `1,2`; absent: all of them");

export const PreviewQuerySchema = z.object({ pages: PagesQuery });

const PreviewPageSchema = z.object({ n: z.number().int(), image: z.string().describe("A base64 PNG"), text: z.string().describe("The page's text in reading order") });

/** The service's preview answer, member for member (plan § API contracts), and what the person still owes. */
export const PreviewResponseSchema = z.object({
  letterheadVersion: z.number().int(),
  pageCount: z.number().int(),
  missingPlaceholders: z.array(z.string()),
  unprintableCharacters: z.number().int(),
  pages: z.array(PreviewPageSchema),
  missingFields: z
    .array(z.object({ name: z.string(), label: z.string().nullable(), step: z.string() }))
    .describe("What the draft still lacks, from the offer engine: names and the template's labels, never a value"),
});
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

// ─── The call ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LETTERHEAD_OVERFLOW = "letterhead_overflow";

/**
 * 409 `letterhead_overflow` when the service refused the document because a value of the issuer's legal details makes the header or the
 * footer taller than its margin (`header_overflow` / `footer_overflow`, AC-5.3). The client reports it as the unavailable
 * answer carrying the service's code as `reason` (it never repeats the service's text); anything else is not touched. The
 * frame and the entity are named, never the value.
 */
export function overflowOf(error: unknown, entity: Entity): ProblemError | null {
  if (!(error instanceof ProblemError) || error.code !== LAYOUT_SERVICE_UNAVAILABLE) return null;
  const reason = error.extras["reason"];
  if (reason !== "header_overflow" && reason !== "footer_overflow") return null;
  const frame = reason === "header_overflow" ? "header" : "footer";
  return new ProblemError({
    status: 409,
    code: LETTERHEAD_OVERFLOW,
    detail: `A value of the issuer's legal details does not fit the letterhead's ${frame}: shorten it in the legal entities settings, or change the letterhead`,
    extras: { frame, entity },
  });
}

export const SECTION_TOO_LONG = "section_too_long";

/**
 * 422 `section_too_long` when the engine says a unit of the offer (a section, the opening, an annex) is over the length
 * limit, as generation refuses it (inside `offer_incomplete`). The engine stops building such a unit short of its end, so
 * drawing what is left would show a document that is not the one generate refuses (T50). The units are named by the
 * engine's own `name` (`section:<key>`, `opening`, `annex:<designation>`) and the template's heading, never a value.
 */
export function sectionTooLong(blocks: DraftBlocks): ProblemError | null {
  const sections = blocks.invalid.filter((issue) => issue.code === SECTION_TOO_LONG).map(({ name, label }) => ({ name, label }));
  if (sections.length === 0) return null;
  return new ProblemError({
    status: 422,
    code: SECTION_TOO_LONG,
    detail: "A section of the offer is longer than the 20 000 characters it may hold; shorten it before previewing",
    extras: { sections },
  });
}

/**
 * The service's preview of `blocks` (`pages`: those only, absent: all), as the routes answer it. Refused before any call:
 * 422 `section_too_long` (what generate refuses, so the preview is never a truncated draw). Failures: 409
 * `letterhead_not_configured` (the entity has no active letterhead, AC-10.8), 409 `letterhead_overflow` with `frame`, 503
 * `layout_service_unavailable` for everything else (unreachable, 5xx, `busy`, a timeout: AC-10.7; the registry of the issuer's
 * details unreadable at the service; an old service that does not know content version 2). A service that prints another
 * version of the issuer's details than the blocks were built from throws `LegalEntityVersionMismatch` (also a 503), which the
 * route's `withIssuerPin` answers by rebuilding the blocks from the registry once (AC-6.2).
 */
export async function previewThroughService(blocks: DraftBlocks, pages: string | undefined): Promise<PreviewResponse> {
  const tooLong = sectionTooLong(blocks);
  if (tooLong) throw tooLong;
  try {
    const answer = await letterhead.preview(blocks.content, pages === undefined ? {} : { pages: parsePages(pages) ?? [] });
    return {
      letterheadVersion: answer.letterheadVersion,
      pageCount: answer.pageCount,
      missingPlaceholders: [...answer.missingPlaceholders],
      unprintableCharacters: answer.unprintableCharacters,
      pages: answer.pages.map(({ n, image, text }) => ({ n, image, text })),
      missingFields: blocks.missing.map(({ name, label, step }) => ({ name, label, step })),
    };
  } catch (error) {
    throw overflowOf(error, blocks.content.entity) ?? error;
  }
}

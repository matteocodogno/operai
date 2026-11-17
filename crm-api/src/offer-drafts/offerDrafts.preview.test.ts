/**
 * The wizard's preview through the layout service, and the switch (specs/20261116-letterhead-service T28; AC-10.3,
 * AC-10.7, AC-10.8; plan § API contracts "crm-api", amendments G7 and 2026-11-17 item 3): `POST /deals/{id}/offer-draft/preview`,
 * `letterheadService` in `GET /scope`, and `LETTERHEAD_SERVICE_ENABLED` read as the literal "true".
 *
 * The service is an in-process fake behind the REAL client of T27 (`createLetterheadClient` with a stub `fetch`), so the
 * error mapping under test is the one that ships: what the fake answers is what letterhead-api's contract says. Real Postgres
 * (compose), the assembled app. The switch is flipped on the `env` object, which the routes read at the request.
 *
 * The `GET /scope` and `env` tests live here because T28's touch list names no other test file for them.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
// The test world first: it sets the environment the other modules read when they load.
import { bucket, call, db, makeDraftTemplate, readyDealWithProfiles, registry, resetWorld, DRAFT_SOURCE, type PersonaName } from "../test-support/world";
import { incompleteEntity } from "../test-support/fakeRegistry";
import { env } from "../lib/env";
import { Hono } from "hono";
import { ProblemError } from "../lib/problem";
import { MAX_PREVIEWS_IN_FLIGHT_PER_PERSON, createInflightCap, previewCap, requireLetterheadService } from "../offers/contentSchema";
import { createLetterheadClient, letterhead } from "../lib/letterheadClient";
import type { ServiceTokenProvider } from "../lib/serviceToken";

beforeEach(resetWorld);

// ─── The fake service ────────────────────────────────────────────────────────────────────────────────────────────────

type Answer = Response | "network-error" | "hang";

const fake = {
  /** Every request that reached the service: the path with its query, the bearer and the JSON body. */
  calls: [] as { path: string; authorization: string | null; body: any }[],
  /** What it answers, in order (the last one repeats); empty: a preview of two pages. */
  answers: [] as Answer[],
  timeoutMs: 35_000,
  /** While set, a request that reached the service waits for it before it is answered (the in-flight cap's tests). */
  gate: null as Promise<void> | null,
};

const previewBody = (pages: number[] = [1, 2]) => ({
  letterheadVersion: 4,
  pageCount: 2,
  missingPlaceholders: [] as string[],
  unprintableCharacters: 0,
  pages: pages.map((n) => ({ n, image: `IMAGE-${n}`, text: `text of page ${n}` })),
});
const ok = (body: unknown = previewBody()) => Response.json(body, { status: 200 });
const refusal = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ status, code, detail: "SECRET-SERVICE-DETAIL: the service's own words" }), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });

let spy: { mockRestore(): void } | null = null;

function installFakeService(): void {
  fake.calls = [];
  fake.answers = [];
  fake.timeoutMs = 35_000;
  fake.gate = null;
  const tokens: ServiceTokenProvider = { getToken: async () => "svc-token", invalidate() {} };
  let served = 0;
  spy = spyOn(letterhead, "preview").mockImplementation((content, options) =>
    createLetterheadClient({
      baseUrl: "http://letterhead.test",
      tokens,
      timeoutMs: fake.timeoutMs,
      sleep: async () => {},
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        const href = new URL(String(url));
        fake.calls.push({ path: `${href.pathname}${href.search}`, authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
        if (fake.gate) await fake.gate;
        const answer = fake.answers.length === 0 ? ok() : fake.answers[Math.min(served, fake.answers.length - 1)]!;
        served += 1;
        if (answer === "network-error") throw new TypeError("fetch failed SECRET-NETWORK-DETAIL");
        if (answer === "hang") {
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        }
        return answer.clone();
      }) as typeof fetch,
    }).preview(content, options),
  );
}

const switchWas = env.LETTERHEAD_SERVICE_ENABLED;
beforeEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = true;
  installFakeService();
});
afterEach(() => {
  env.LETTERHEAD_SERVICE_ENABLED = switchWas;
  spy?.mockRestore();
  spy = null;
});

// ─── A draft ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const noMatch = { "If-None-Match": "*" };
/** A template with a field the person has not answered (NOTA) and one that the estimate fills (EPICI). */
const SOURCE = `${DRAFT_SOURCE.replace("Giorni: [GIORNI]", "Giorni: [GIORNI]\n\nNota: [NOTA]")}\n@@field NOTA\nlabel: Nota\n`;

interface Setup {
  dealId: string;
  templateId: string;
  draft: { answers: any; version: number; templateVersion: number };
}

async function startDraft(source = SOURCE, entity: "welld_ch" | "welld_it" = "welld_ch"): Promise<Setup> {
  const { deal } = await readyDealWithProfiles({ entity });
  const template = await makeDraftTemplate({ source, entity });
  const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch });
  if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
  return { dealId: deal.id, templateId: template.id, draft: created.json };
}

/** The PUT body of the stored draft with `change` applied: what the browser sends to preview what it has typed. */
const bodyOf = (s: Setup, change: (answers: any) => void = () => {}, over: Record<string, unknown> = {}) => {
  const answers = structuredClone(s.draft.answers);
  change(answers);
  return { templateVersion: s.draft.templateVersion, target: { kind: "new" }, answers, ...over };
};

const preview = (s: { dealId: string }, body: unknown, over: { as?: PersonaName | null; query?: string } = {}) =>
  call("POST", `/deals/${s.dealId}/offer-draft/preview${over.query ?? ""}`, { as: over.as === undefined ? "admin" : over.as, body });

/**
 * T50, found by T34's end-to-end run: 140 paragraphs of about 150 characters make one section of more than 20 000. One
 * field holds at most 20 000 itself, so the section reaches the limit with two fields (70 paragraphs each).
 */
const longText = (paragraphs = 70) => Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i + 1} ${"x".repeat(140)}`).join("\n\n");
const tooLong = (a: any) => {
  a.fields.EPICI = longText();
  a.fields.FASI = longText();
};

describe("a section over the length limit (T50; AC-10.3, AC-10.4)", () => {
  it("is 422 section_too_long naming the section, as generate refuses it, and the service is never called", async () => {
    const s = await startDraft();
    const body = bodyOf(s, tooLong);
    expect(body.answers.fields.EPICI.length + body.answers.fields.FASI.length).toBeGreaterThan(20_000);

    const res = await preview(s, body);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("section_too_long");
    expect(res.json.sections).toEqual([{ name: "section:OGGETTO#0", label: "OGGETTO" }]);
    expect(JSON.stringify(res.json)).not.toContain("Paragraph");
    expect(fake.calls).toEqual([]);

    // the stored draft takes the same text, and generate refuses it for the same section
    const saved = await call("PUT", `/deals/${s.dealId}/offer-draft`, { body, ifMatch: s.draft.version });
    expect(saved.status).toBe(200);
    const gen = await call("POST", `/deals/${s.dealId}/offer-draft/generate`, { ifMatch: saved.json.version });
    expect(gen.status).toBe(422);
    expect(gen.json.invalid.map((i: { name: string; code: string }) => [i.name, i.code])).toContainEqual(["section:OGGETTO#0", "section_too_long"]);
  });

  it("refuses before the service whatever `pages` asks for, and a section under the limit is still drawn", async () => {
    const s = await startDraft();
    const over = bodyOf(s, tooLong);
    expect((await preview(s, over, { query: "?pages=1" })).status).toBe(422);
    expect(fake.calls).toEqual([]);

        const fits = bodyOf(s, (a) => {
      a.fields.EPICI = "y".repeat(9_000);
      a.fields.FASI = "y".repeat(9_000);
    });
    const res = await preview(s, fits);
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("POST /deals/{id}/offer-draft/preview", () => {
  it("answers the service's preview unchanged plus the missing fields, and sends the draft as content version 1 (AC-10.3, AC-10.10)", async () => {
    const s = await startDraft();
    const res = await preview(s, bodyOf(s));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({ ...previewBody(), missingFields: [{ name: "NOTA", label: "Nota", step: expect.any(String) }] });

    expect(fake.calls).toHaveLength(1);
    const [sent] = fake.calls;
    expect(sent!.path).toBe("/v1/render/preview");
    expect(sent!.authorization).toBe("Bearer svc-token");
    expect(sent!.body).toMatchObject({
      contentVersion: 1,
      entity: "welld_ch",
      language: "it",
      // the entity profile at this moment (AC-10.10)
      entityData: { legalName: "wellD SA", addressLines: ["Via Example 1", "6900 Lugano"], vat: "CHE-123.456.789 MWST", iban: "CH00 0000 0000 0000 0000 0" },
    });
    // the active version is the service's default
    expect(sent!.body).not.toHaveProperty("letterheadVersion");
    expect(sent!.body.blocks.length).toBeGreaterThan(5);
    const wire = JSON.stringify(sent!.body);
    expect(wire).toContain("Acme Holding SA");
    // an offer that has no number yet says so; the unanswered field is a highlighted run with its label (AC-10.4)
    expect(wire).toContain("NNNN/AAAA");
    expect(sent!.body.blocks.flatMap((b: any) => b.runs ?? [])).toContainEqual({ text: "Nota", style: "missing" });
  });

  it("draws the answers the browser sends, not the stored ones, and stores nothing (AC-10.3)", async () => {
    const s = await startDraft();
    const before = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    const sequences = await db.offerSequence.findMany();
    const offers = await db.dealOffer.count();

    const res = await preview(
      s,
      bodyOf(s, (a) => {
        a.fields.EPICI = "UNSAVED-EPIC-TEXT";
        a.fields.NOTA = "UNSAVED-NOTE";
      }),
    );
    expect(res.status).toBe(200);
    const wire = JSON.stringify(fake.calls[0]!.body);
    expect(wire).toContain("UNSAVED-EPIC-TEXT");
    expect(wire).toContain("UNSAVED-NOTE");
    // with its note answered, nothing is missing any more
    expect(res.json.missingFields).toEqual([]);

    expect(await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } })).toEqual(before);
    expect(await db.offerSequence.findMany()).toEqual(sequences);
    expect(await db.dealOffer.count()).toBe(offers);
    expect(bucket.objects.size).toBe(0);
    const stored = await call("GET", `/deals/${s.dealId}/offer-draft`);
    expect(stored.json.version).toBe(s.draft.version);
    expect(JSON.stringify(stored.json.answers)).not.toContain("UNSAVED");
  });

  it("takes the pages asked for, sorted and once each, and refuses anything else before the service is called", async () => {
    const s = await startDraft();
    expect((await preview(s, bodyOf(s), { query: "?pages=2" })).status).toBe(200);
    expect((await preview(s, bodyOf(s), { query: "?pages=2,1,2" })).status).toBe(200);
    expect((await preview(s, bodyOf(s), { query: "?pages=300" })).status).toBe(200);
    expect(fake.calls.map((c) => c.path)).toEqual(["/v1/render/preview?pages=2", "/v1/render/preview?pages=1,2", "/v1/render/preview?pages=300"]);

    fake.calls = [];
    for (const bad of ["0", "301", "-1", "1,,2", "1,", "abc", "1e2", "01", "1.5", "", "%20"]) {
      const res = await preview(s, bodyOf(s), { query: `?pages=${bad}` });
      expect({ bad, status: res.status, field: res.json.field }).toEqual({ bad, status: 422, field: "pages" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("is the draft GET's gate and scope: no token 401, no crm:access 403, financials and manage both needed, another entity's deal 403, no deal 404 (AC-6.2)", async () => {
    const s = await startDraft();
    const body = bodyOf(s);
    expect((await preview(s, body, { as: null })).status).toBe(401);
    for (const as of ["outsider", "consultant", "managerNoMoney"] as const) {
      expect({ as, status: (await preview(s, body, { as })).status }).toEqual({ as, status: 403 });
    }
    expect((await preview({ dealId: "no-such-deal" }, body)).status).toBe(404);
    expect((await preview(s, body, { as: "salesCh" })).status).toBe(200);

    // a caller outside the entity is refused the same way with or without a draft: nothing says whether one exists
    const other = await startDraft(SOURCE, "welld_it");
    const withDraft = await preview(other, bodyOf(other), { as: "salesCh" });
    await call("DELETE", `/deals/${other.dealId}/offer-draft`, { ifMatch: other.draft.version });
    const without = await preview(other, bodyOf(other), { as: "salesCh" });
    expect([withDraft.status, withDraft.json.code]).toEqual([403, "out_of_scope"]);
    expect([without.status, without.json.code]).toEqual([403, "out_of_scope"]);
    // an admin, who is in scope, learns there is no draft
    const none = await preview(other, bodyOf(other));
    expect([none.status, none.json.code]).toEqual([404, "draft_not_found"]);
    // only the one allowed call reached the service
    expect(fake.calls).toHaveLength(1);
  });

  it("checks the body as a save would, and sends nothing to the service when a save would refuse it (AC-10.3)", async () => {
    const s = await startDraft();
    const reserved = await preview(s, bodyOf(s, (a) => (a.fields.NOTA = "bad ⟦ text")));
    expect(reserved.status).toBe(422);
    expect(reserved.json).toMatchObject({ code: "answers_invalid", path: "fields.NOTA", reason: "reserved_character" });
    expect(JSON.stringify(reserved.json)).not.toContain("bad ⟦ text");

    const target = await preview(s, bodyOf(s, () => {}, { target: { kind: "edit", offerId: "some-offer" } }));
    expect([target.status, target.json.code, target.json.path]).toEqual([422, "answers_invalid", "target"]);
    const ahead = await preview(s, bodyOf(s, () => {}, { templateVersion: s.draft.templateVersion + 1 }));
    expect([ahead.status, ahead.json.code, ahead.json.path]).toEqual([422, "answers_invalid", "templateVersion"]);
    const unknown = await preview(s, { ...bodyOf(s), extra: 1 });
    expect([unknown.status, unknown.json.code]).toEqual([422, "answers_invalid"]);
    expect(fake.calls).toEqual([]);
  });

  it("prints the reference of an edit, which keeps it, where a new offer prints the pending one", async () => {
    const { deal } = await readyDealWithProfiles();
    const template = await makeDraftTemplate();
    const first = (await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: noMatch })).json;
    // The offer to edit is made the way offers were made before the switch: this test is about the preview, and since T29 a
    // generation with the switch on asks the (here unfaked) service for the PDF.
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const generated = await call("POST", `/deals/${deal.id}/offer-draft/generate`, { ifMatch: first.version });
    env.LETTERHEAD_SERVICE_ENABLED = true;
    expect(generated.status).toBe(201);
    const edit = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { target: { kind: "edit", offerId: generated.json.id } }, headers: noMatch });
    expect(edit.status).toBe(201);

    const s = { dealId: deal.id, templateId: template.id, draft: edit.json } as Setup;
    const res = await preview(s, bodyOf(s, () => {}, { target: { kind: "edit", offerId: generated.json.id } }));
    expect(res.status).toBe(200);
    const wire = JSON.stringify(fake.calls[0]!.body);
    expect(wire).toContain(generated.json.reference);
    expect(wire).not.toContain("NNNN/AAAA");
  });

  it("is 409 legal_entity_incomplete naming what is missing, as generation is, without calling the service (AC-6.3, AC-10.10)", async () => {
    const s = await startDraft();
    registry.set(incompleteEntity("welld_ch", ["legalName"], { legalName: "  " }));
    const blank = await preview(s, bodyOf(s));
    expect([blank.status, blank.json.code, blank.json.entity, blank.json.missing]).toEqual([409, "legal_entity_incomplete", "welld_ch", ["legalName"]]);
    registry.set(incompleteEntity("welld_ch", ["vatNumber", "address.en"]));
    const partial = await preview(s, bodyOf(s));
    expect([partial.status, partial.json.code, partial.json.missing]).toEqual([409, "legal_entity_incomplete", ["vatNumber", "address.en"]]);
    expect(fake.calls).toEqual([]);
  });

  it("never answers entity_profile_missing: a missing profile row is drawn with place Lugano (E4)", async () => {
    const s = await startDraft();
    await db.entityProfile.delete({ where: { entity: "welld_ch" } });
    const res = await preview(s, bodyOf(s));
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("is 503 legal_entities_unavailable with Retry-After: 5 when the registry cannot be read, without calling the service", async () => {
    const s = await startDraft();
    registry.unavailable();
    const res = await preview(s, bodyOf(s));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("legal_entities_unavailable");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(fake.calls).toEqual([]);
  });

  describe("when the service cannot draw the pages", () => {
    const failure = async (answers: Answer[], timeoutMs?: number) => {
      const s = await startDraft();
      fake.answers = answers;
      if (timeoutMs !== undefined) fake.timeoutMs = timeoutMs;
      const res = await preview(s, bodyOf(s, (a) => (a.fields.NOTA = "SECRET-ANSWER-TEXT")));
      // never the service's words, the person's text or a token (§ Security)
      const wire = JSON.stringify(res.json);
      for (const secret of ["SECRET-SERVICE-DETAIL", "SECRET-NETWORK-DETAIL", "SECRET-ANSWER-TEXT", "svc-token"]) expect(wire).not.toContain(secret);
      // the wizard stays usable (AC-10.7): the draft is as it was and can still be saved
      const saved = await call("PUT", `/deals/${s.dealId}/offer-draft`, { ifMatch: s.draft.version, body: bodyOf(s, (a) => (a.fields.NOTA = "typed anyway")) });
      expect(saved.status).toBe(200);
      return res;
    };

    it("is 503 layout_service_unavailable when it is unreachable, answers an error, is busy twice or times out (AC-10.7)", async () => {
      for (const answers of [["network-error"], [refusal(500, "boom")], [refusal(502, "bad_gateway")], [refusal(504, "render_timeout")], [refusal(429, "busy", { "Retry-After": "1" })], [refusal(401, "x")]] as Answer[][]) {
        const res = await failure(answers);
        expect([res.status, res.json.code]).toEqual([503, "layout_service_unavailable"]);
      }
      // busy is retried once, as the client says; an answer that is not the contract's is the same 503
      expect(fake.calls.length).toBeGreaterThan(6);
      const odd = await failure([ok({ nope: true })]);
      expect([odd.status, odd.json.code]).toEqual([503, "layout_service_unavailable"]);
      const hung = await failure(["hang"], 40);
      expect([hung.status, hung.json.code]).toEqual([503, "layout_service_unavailable"]);
    });

    it("is 503 for a content the service refuses: crm-api's defect, nothing a person can fix", async () => {
      for (const code of ["invalid_content", "content_too_large", "too_many_pages", "request_too_large", "unsupported_content_version"]) {
        const res = await failure([refusal(code === "request_too_large" ? 413 : 422, code)]);
        expect({ code, status: res.status, answer: res.json.code }).toEqual({ code, status: 503, answer: "layout_service_unavailable" });
      }
    });

    it("is 409 letterhead_not_configured, naming the entity, when it has no active letterhead (AC-10.8)", async () => {
      const res = await failure([refusal(409, "letterhead_not_configured")]);
      expect([res.status, res.json.code, res.json.entity]).toEqual([409, "letterhead_not_configured", "welld_ch"]);
    });

    it("is 409 letterhead_overflow, naming the frame, when a profile value does not fit the header or the footer", async () => {
      const header = await failure([refusal(422, "header_overflow")]);
      expect([header.status, header.json.code, header.json.frame, header.json.entity]).toEqual([409, "letterhead_overflow", "header", "welld_ch"]);
      const footer = await failure([refusal(422, "footer_overflow")]);
      expect([footer.status, footer.json.code, footer.json.frame]).toEqual([409, "letterhead_overflow", "footer"]);
      // the value that is too long is never repeated
      expect(JSON.stringify(header.json)).not.toContain("Via Example");
    });
  });
});

/** Waits until `ok()` holds (the in-flight requests have reached the fake service), or fails the test. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
}

describe("at most 2 previews in flight per person (security review F1)", () => {
  /** Holds the service: every preview that gets there waits for `open()`. */
  function hold(): { open(): void } {
    let open!: () => void;
    fake.gate = new Promise<void>((resolve) => (open = resolve));
    opened.push(open);
    return { open };
  }
  // a test that fails while it holds the service must not leave its slots taken for the next one
  const opened: (() => void)[] = [];
  afterEach(async () => {
    for (const open of opened.splice(0)) open();
    await until(() => previewCap.inflight("user-admin") === 0 && previewCap.inflight("user-sales-ch") === 0, "the slots to be freed");
  });

  it("answers the third at once with 429 preview_busy and Retry-After: 1, and never calls the service for it", async () => {
    const s = await startDraft();
    const gate = hold();
    const first = preview(s, bodyOf(s));
    const second = preview(s, bodyOf(s));
    await until(() => fake.calls.length === MAX_PREVIEWS_IN_FLIGHT_PER_PERSON, "two previews at the service");
    expect(previewCap.inflight("user-admin")).toBe(2);

    const third = await preview(s, bodyOf(s));
    expect(third.status).toBe(429);
    expect(third.json.code).toBe("preview_busy");
    expect(third.headers.get("Retry-After")).toBe("1");
    expect(third.headers.get("Cache-Control")).toBe("no-store");
    // nothing of the draft or the service in the refusal
    expect(JSON.stringify(third.json)).not.toMatch(/SECRET|IMAGE-|svc-token/);
    expect(fake.calls).toHaveLength(2);

    gate.open();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect(fake.calls).toHaveLength(2);
    expect(previewCap.inflight("user-admin")).toBe(0);
  });

  it("frees the slot when a preview ends, whatever it ends in: an answer, a refusal of the service, a body a save would refuse", async () => {
    const s = await startDraft();
    // three failures in a row of each kind never use the person up
    fake.answers = [refusal(500, "boom")];
    for (let i = 0; i < 3; i++) expect((await preview(s, bodyOf(s))).status).toBe(503);
    fake.answers = [];
    for (let i = 0; i < 3; i++) expect((await preview(s, { nonsense: true })).status).toBe(422);
    for (let i = 0; i < 3; i++) expect((await preview(s, bodyOf(s), { query: "?pages=abc" })).status).toBe(422);
    expect(previewCap.inflight("user-admin")).toBe(0);
    expect((await preview(s, bodyOf(s))).status).toBe(200);
    // and after the cap was reached, once one ends the next goes through
    const gate = hold();
    const before = fake.calls.length;
    const a = preview(s, bodyOf(s));
    const b = preview(s, bodyOf(s));
    await until(() => fake.calls.length === before + 2, "two previews at the service");
    expect((await preview(s, bodyOf(s))).status).toBe(429);
    gate.open();
    await Promise.all([a, b]);
    fake.gate = null;
    expect((await preview(s, bodyOf(s))).status).toBe(200);
    expect(previewCap.inflight("user-admin")).toBe(0);
  }, 20_000);

  it("frees the slot when the handler throws, and keeps counting a preview whose client went away until its work ends", async () => {
    // The middleware on its own, behind a stub of the JWT guard: the abort and the throw are the parts the routes cannot stage.
    const mini = new Hono<{ Variables: { userId: string } }>();
    mini.onError((err, c) => (err instanceof ProblemError ? err.toResponse(c.req.path) : c.text("boom", 500)));
    let finish!: () => void;
    let work: Promise<void> = Promise.resolve();
    mini.use("*", async (c, next) => {
      c.set("userId", "user-mini");
      await next();
    });
    mini.post("/p", requireLetterheadService, async (c) => {
      await work;
      if (c.req.query("fail") !== undefined) throw new Error("handler failed");
      return c.text("ok");
    });
    const post = (query = "", init: RequestInit = {}) => mini.request(`/p${query}`, { method: "POST", ...init });

    work = new Promise<void>((resolve) => (finish = resolve));
    const abort = new AbortController();
    const gone = Promise.resolve(post("", { signal: abort.signal })).catch(() => null);
    const second = post("");
    await until(() => previewCap.inflight("user-mini") === 2, "two requests in flight");
    abort.abort();
    // the abandoned request's work is still running, so it still counts
    expect(previewCap.inflight("user-mini")).toBe(2);
    expect((await post("")).status).toBe(429);
    finish();
    await Promise.all([gone, second]);
    expect(previewCap.inflight("user-mini")).toBe(0);

    work = Promise.resolve();
    for (let i = 0; i < 5; i++) expect((await post("?fail")).status).toBe(500);
    expect(previewCap.inflight("user-mini")).toBe(0);
    expect((await post("")).status).toBe(200);
  });

  it("is per person: one person at the cap does not slow another down", async () => {
    const s = await startDraft();
    const gate = hold();
    const a = preview(s, bodyOf(s));
    const b = preview(s, bodyOf(s));
    await until(() => fake.calls.length === 2, "two previews at the service");
    expect((await preview(s, bodyOf(s))).status).toBe(429);
    const other = preview(s, bodyOf(s), { as: "salesCh" });
    await until(() => fake.calls.length === 3, "the other person's preview at the service");
    expect(previewCap.inflight("user-sales-ch")).toBe(1);
    gate.open();
    expect((await other).status).toBe(200);
    await Promise.all([a, b]);
  });

  it("does not count a caller the guards refused, and says nothing of the cap when the switch is off", async () => {
    const s = await startDraft();
    const gate = hold();
    const a = preview(s, bodyOf(s));
    const b = preview(s, bodyOf(s));
    await until(() => fake.calls.length === 2, "two previews at the service");
    // the person at the cap who lacks the capability still gets the 403, an anonymous caller the 401
    expect((await preview(s, bodyOf(s), { as: null })).status).toBe(401);
    expect((await preview(s, bodyOf(s), { as: "consultant" })).status).toBe(403);
    // the switch off: the route does not exist, cap or not
    env.LETTERHEAD_SERVICE_ENABLED = false;
    expect((await preview(s, bodyOf(s))).status).toBe(404);
    env.LETTERHEAD_SERVICE_ENABLED = true;
    gate.open();
    await Promise.all([a, b]);
  });

  describe("the counter", () => {
    it("holds each key to its cap, releases once however often release is called, and forgets a key with nothing in flight", () => {
      const cap = createInflightCap(2);
      const one = cap.acquire("p")!;
      const two = cap.acquire("p")!;
      expect(cap.acquire("p")).toBeNull();
      expect(cap.acquire("q")).not.toBeNull();
      one();
      one();
      one();
      expect(cap.inflight("p")).toBe(1);
      expect(cap.acquire("p")).not.toBeNull();
      expect(cap.acquire("p")).toBeNull();
      two();
      expect(cap.inflight("p")).toBe(1);
    });
  });
});

describe("with the switch off", () => {
  it("the preview does not exist: 404 for a person who may use it, whatever the body, and the service is never called", async () => {
    const s = await startDraft();
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const valid = await preview(s, bodyOf(s));
    expect(valid.status).toBe(404);
    expect(valid.json.detail).toBe(`POST /deals/${s.dealId}/offer-draft/preview does not exist`);
    expect(valid.json.code).toBeUndefined();
    // before the body, the query and the deal are read
    expect((await preview(s, { nonsense: true })).status).toBe(404);
    expect((await preview(s, bodyOf(s), { query: "?pages=abc" })).status).toBe(404);
    expect((await preview({ dealId: "no-such-deal" }, bodyOf(s))).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it("tells nothing to a caller the CRM does not already refuse: 401 and 403 are what they always were", async () => {
    const s = await startDraft();
    env.LETTERHEAD_SERVICE_ENABLED = false;
    expect((await preview(s, bodyOf(s), { as: null })).status).toBe(401);
    expect((await preview(s, bodyOf(s), { as: "outsider" })).status).toBe(403);
    expect((await preview(s, bodyOf(s), { as: "consultant" })).status).toBe(403);
    expect((await preview(s, bodyOf(s), { as: "managerNoMoney" })).status).toBe(403);
  });

  it("changes nothing else: the draft is read, saved and generated as before", async () => {
    const s = await startDraft(DRAFT_SOURCE);
    env.LETTERHEAD_SERVICE_ENABLED = false;
    expect((await call("GET", `/deals/${s.dealId}/offer-draft`)).status).toBe(200);
    const saved = await call("PUT", `/deals/${s.dealId}/offer-draft`, { ifMatch: s.draft.version, body: bodyOf(s, (a) => (a.client.place = "Zurigo")) });
    expect(saved.status).toBe(200);
    const made = await call("POST", `/deals/${s.dealId}/offer-draft/generate`, { ifMatch: saved.json.version });
    expect(made.status).toBe(201);
    expect(fake.calls).toEqual([]);
  });
});

describe("letterheadService in GET /scope (plan amendment G7)", () => {
  it("is false by default and true with the switch on, for every caller alike", async () => {
    for (const on of [false, true]) {
      env.LETTERHEAD_SERVICE_ENABLED = on;
      for (const as of ["admin", "salesCh", "managerNoMoney", "consultant", "colleague"] as const) {
        const res = await call("GET", "/scope", { as });
        expect({ on, as, status: res.status, flag: res.json.letterheadService }).toEqual({ on, as, status: 200, flag: on });
      }
    }
  });

  it("leaves the other members as they were", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = true;
    expect((await call("GET", "/scope", { as: "salesCh" })).json).toEqual({ deal: ["welld_ch"], canErase: false, financials: true, managesAll: false, letterheadService: true });
  });

  it("is still behind the guard: 401 without a token, 403 without crm:access", async () => {
    expect((await call("GET", "/scope", { as: null })).status).toBe(401);
    expect((await call("GET", "/scope", { as: "outsider" })).status).toBe(403);
  });
});

describe("LETTERHEAD_SERVICE_ENABLED is read as the literal \"true\" (env.ts)", () => {
  const crmApi = join(import.meta.dir, "..", "..");
  const BASE = {
    PATH: process.env["PATH"] ?? "",
    DATABASE_URL: "postgresql://x:x@localhost:1/x",
    ALLOWED_ORIGINS: "http://localhost:5173",
    AUTH_JWKS_URL: "http://localhost:3001/auth/jwks",
    AUTH_ISSUER: "http://localhost:3001",
    AUTH_AUDIENCE: "operai-suite",
    AUTH_BASE_URL: "http://localhost:3001",
  };
  const WIRED = { LETTERHEAD_API_URL: "http://localhost:8088", SERVICE_CLIENT_ID: "crm-api", SERVICE_CLIENT_SECRET: "test-secret-test-secret-test-secret-0123" };

  /** `env.ts` evaluated afresh in its own process, as the service starts it. */
  async function boot(extra: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, "-e", "const { env } = await import('./src/lib/env'); console.log(`switch=${env.LETTERHEAD_SERVICE_ENABLED}`);"], {
      cwd: crmApi,
      env: { ...BASE, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: out.trim(), err, code };
  }

  it("is on for \"true\" and off for anything else, a typo included, which says so at startup without the value", async () => {
    const on = await boot({ ...WIRED, LETTERHEAD_SERVICE_ENABLED: "true" });
    expect([on.code, on.out, on.err]).toEqual([0, "switch=true", ""]);

    for (const [value, warned] of [["false", false], ["", false], ["TRUE", true], ["True", true], ["1", true], ["yes", true], [" true", true], ["true ", true]] as const) {
      const off = await boot({ ...WIRED, LETTERHEAD_SERVICE_ENABLED: value });
      expect({ value, code: off.code, out: off.out, warned: off.err.includes("is OFF") }).toEqual({ value, code: 0, out: "switch=false", warned });
      expect(off.err).not.toContain(value === "" ? "\u0000" : `"${value}"`);
    }
    const unset = await boot(WIRED);
    expect([unset.code, unset.out, unset.err]).toEqual([0, "switch=false", ""]);
    const bare = await boot({});
    expect([bare.code, bare.out]).toEqual([0, "switch=false"]);
  });

  it("refuses to start with the switch on and no URL or no service client to reach it", async () => {
    const noUrl = await boot({ LETTERHEAD_SERVICE_ENABLED: "true" });
    expect(noUrl.code).toBe(1);
    expect(noUrl.err).toContain("LETTERHEAD_API_URL: LETTERHEAD_API_URL is required when LETTERHEAD_SERVICE_ENABLED is true");
    const noClient = await boot({ LETTERHEAD_SERVICE_ENABLED: "true", LETTERHEAD_API_URL: "http://localhost:8088" });
    expect(noClient.code).toBe(1);
    expect(noClient.err).toContain("SERVICE_CLIENT_ID");
  });
});

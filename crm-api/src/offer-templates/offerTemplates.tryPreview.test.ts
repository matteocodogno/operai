/**
 * "Try the wizard" through the layout service (specs/20261116-letterhead-service T28; AC-10.14, AC-10.7, AC-10.8; plan
 * amendment G1): `POST /offer-templates/{id}/try-preview`, which needs no deal and stores nothing; and (T53, AC-10.14) its
 * twin for a template that was never saved, `POST /offer-templates/try-preview`, and the relaxed guard of both: the READ
 * guard (`deal:financials`, which carries no entity condition: template reads have no entity scope), so a person who may only read previews it.
 *
 * The service is an in-process fake behind the REAL client of T27 (see offerDrafts.preview.test.ts, which has the same
 * harness and the draft route's tests); real Postgres (compose), the assembled app. The switch is flipped on `env`.
 *
 * The content is version 2 with no `entityData` and a `legalEntityVersion` pin (specs/20261117-legal-entities T28; AC-5.2,
 * AC-6.2); the fake service holds one version of the issuer's details (`fake.issuerVersion`) and answers another pin with the
 * contract's 409, which the route answers by reading the registry again and rebuilding the content once.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
// The test world first: it sets the environment the other modules read when they load.
import { DRAFT_SOURCE, PERSONAS, WIZARD_SOURCE, call, db, makeWizardTemplate, putEntityProfile, registry, resetWorld, worldIssuer, type PersonaName } from "../test-support/world";
import { completeEntity, incompleteEntity } from "../test-support/fakeRegistry";
import { env } from "../lib/env";
import { MAX_PREVIEWS_IN_FLIGHT_PER_PERSON, previewCap } from "../offers/contentSchema";
import { createLetterheadClient, letterhead } from "../lib/letterheadClient";
import type { ServiceTokenProvider } from "../lib/serviceToken";
import { sampleAnswers } from "../offers/engine/answers";
import { parseTemplate } from "../offers/engine/syntax";

beforeEach(resetWorld);

// Readers: `crm:access` + `deal:financials` and NO `deal:manage` (the sales role's grants less the deals), which the world has no persona for.
const READ = [
  { resource: "crm", action: "access", conditions: null },
  { resource: "deal", action: "financials", conditions: null },
] as const;
Object.assign(PERSONAS, {
  readerCh: { sub: "user-reader-ch", entity: "welld_ch", permissions: READ },
  readerIt: { sub: "user-reader-it", entity: "welld_it", permissions: READ },
});
const READER_CH = "readerCh" as PersonaName;
const READER_IT = "readerIt" as PersonaName;

// ─── The fake service ────────────────────────────────────────────────────────────────────────────────────────────────

type Answer = Response | "network-error" | "hang";

const fake = {
  calls: [] as { path: string; authorization: string | null; body: any }[],
  answers: [] as Answer[],
  timeoutMs: 35_000,
  /** While set, a request that reached the service waits for it before it is answered (the in-flight cap's tests). */
  gate: null as Promise<void> | null,
  /** The version of the issuer's details the service holds: another pin is the 409; null: it holds whatever is pinned. */
  issuerVersion: null as number | null,
};

const previewBody = (pages: number[] = [1, 2]) => ({
  letterheadVersion: 4,
  pageCount: 2,
  missingPlaceholders: [] as string[],
  unprintableCharacters: 0,
  pages: pages.map((n) => ({ n, image: `IMAGE-${n}`, text: `text of page ${n}` })),
});
const refusal = (status: number, code: string, extras: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status, code, detail: "SECRET-SERVICE-DETAIL: the service's own words", ...extras }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });

let spy: { mockRestore(): void } | null = null;

function installFakeService(): void {
  fake.calls = [];
  fake.answers = [];
  fake.timeoutMs = 35_000;
  fake.gate = null;
  fake.issuerVersion = null;
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
        const body = JSON.parse(String(init?.body));
        fake.calls.push({ path: `${href.pathname}${href.search}`, authorization: new Headers(init?.headers).get("Authorization"), body });
        if (fake.gate) await fake.gate;
        if (fake.issuerVersion !== null && body.legalEntityVersion !== fake.issuerVersion) {
          return refusal(409, "legal_entity_version_mismatch", { currentVersion: fake.issuerVersion });
        }
        // The service prints the version it was pinned to, and says so.
        const answer = fake.answers.length === 0 ? Response.json({ ...previewBody(), legalEntityVersion: body.legalEntityVersion }) : fake.answers[Math.min(served, fake.answers.length - 1)]!;
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

// ─── A template to try ───────────────────────────────────────────────────────────────────────────────────────────────

/** The text the editor holds: DRAFT_SOURCE with a note field and a heading that the stored template does not have. */
const TYPED = `${DRAFT_SOURCE.replace("Giorni: [GIORNI]", "Giorni: [GIORNI]\n\nNota: [NOTA]\n\n## TYPED-ONLY-SECTION\n@@step scope\nTYPED-ONLY-TEXT")}\n@@field NOTA\nlabel: Nota\n`;

async function template(over: Record<string, unknown> = {}) {
  await putEntityProfile("welld_ch");
  await putEntityProfile("welld_it");
  return makeWizardTemplate({ source: DRAFT_SOURCE, name: `Try ${crypto.randomUUID().slice(0, 6)}`, ...over });
}

/** The body the editor sends for `t` with the text as typed. */
const tryBody = (t: { entity: string; language: string; name: string; description: string; uses: string[] }, over: Record<string, unknown> = {}) => ({
  content: { name: t.name, language: t.language, description: t.description, uses: t.uses, source: TYPED },
  entity: t.entity,
  language: t.language,
  ...over,
});

const tryPreview = (t: { id: string }, body: unknown, over: { as?: PersonaName | null; query?: string } = {}) =>
  call("POST", `/offer-templates/${t.id}/try-preview${over.query ?? ""}`, { as: over.as === undefined ? "admin" : over.as, body });

/** The unsaved twin: the same body, no template row (T53). */
const tryUnsaved = (body: unknown, over: { as?: PersonaName | null; query?: string } = {}) =>
  call("POST", `/offer-templates/try-preview${over.query ?? ""}`, { as: over.as === undefined ? "admin" : over.as, body });

/** The body of a template that exists nowhere: what the editor holds for "New template". */
const unsavedBody = (over: Record<string, unknown> = {}, entity = "welld_ch", language = "it") => ({
  content: { name: "Never saved", language, description: "Typed, not saved", uses: ["Fixed price"], source: TYPED },
  entity,
  language,
  ...over,
});

describe("a section over the length limit (T50; AC-10.14, AC-10.4)", () => {
  it("is 422 section_too_long naming the section, the same refusal as the draft preview, and the service is never called", async () => {
    const t = await template();
    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    // one field holds at most 20 000 characters: the section prints two of 70 paragraphs (140 in all)
    const paragraphs = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1} ${"x".repeat(140)}`).join("\n\n");
    answers.fields.EPICI = paragraphs;
    answers.fields.FASI = paragraphs;

    const res = await tryPreview(t, tryBody(t, { answers }));
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("section_too_long");
    expect(res.json.sections).toEqual([{ name: "section:OGGETTO#0", label: "OGGETTO" }]);
    expect(JSON.stringify(res.json)).not.toContain("Paragraph");
    expect(fake.calls).toEqual([]);
  });
});

describe("POST /offer-templates/{id}/try-preview", () => {
  it("draws the unsaved text with the sample answers and the entity profile, with no deal, and answers as the draft preview does (AC-10.14)", async () => {
    const t = await template();
    expect(await db.deal.count()).toBe(0);
    const res = await tryPreview(t, tryBody(t));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({ ...previewBody(), missingFields: expect.any(Array) });

    expect(fake.calls).toHaveLength(1);
    const [sent] = fake.calls;
    expect(sent!.path).toBe("/v1/render/preview");
    expect(sent!.authorization).toBe("Bearer svc-token");
    expect(sent!.body).toMatchObject({ contentVersion: 2, entity: "welld_ch", language: "it", legalEntityVersion: (await registry.get("welld_ch")).version });
    // the issuer's values are the service's to read: none is sent
    expect(sent!.body).not.toHaveProperty("entityData");
    expect(Object.keys(sent!.body).sort()).toEqual(["blocks", "contentVersion", "entity", "language", "legalEntityVersion"]);
    expect(JSON.stringify(sent!.body)).not.toContain("CHE-123.456.789 MWST");
    expect(sent!.body).not.toHaveProperty("letterheadVersion");
    // the TEXT AS TYPED, not the stored one, and the made-up deal's client
    const wire = JSON.stringify(sent!.body);
    expect(wire).toContain("TYPED-ONLY-TEXT");
    expect(wire).toContain("Cliente di esempio SA");
    expect(wire).toContain("NNNN/AAAA");
  });

  it("stores nothing: the template, the templates, the sequences and the bucket are as they were (AC-10.14)", async () => {
    const t = await template();
    const before = { templates: await db.offerTemplate.findMany({ orderBy: { id: "asc" } }), sequences: await db.offerSequence.findMany(), drafts: await db.offerDraft.count() };
    const res = await tryPreview(t, tryBody(t));
    expect(res.status).toBe(200);
    expect(await db.offerTemplate.findMany({ orderBy: { id: "asc" } })).toEqual(before.templates);
    expect(await db.offerSequence.findMany()).toEqual(before.sequences);
    expect(await db.offerDraft.count()).toBe(before.drafts);
    expect(await db.dealOffer.count()).toBe(0);
    expect(JSON.stringify(await db.offerTemplate.findUniqueOrThrow({ where: { id: t.id } }))).not.toContain("TYPED-ONLY");
    const read = await call("GET", `/offer-templates/${t.id}`);
    expect(read.json.version).toBe(t.version);
    expect(read.json.source).toBe(DRAFT_SOURCE);
  });

  it("takes the editor's sample answers when it sends them and the text's own samples when it does not", async () => {
    const t = await template();
    await tryPreview(t, tryBody(t));
    const own = JSON.stringify(fake.calls[0]!.body);
    expect(own).toContain("Cliente di esempio SA");

    fake.calls = [];
    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    answers.fields.NOTA = "EDITORS-OWN-NOTE";
    answers.client.lines = ["EDITORS-OWN-CLIENT"];
    const res = await tryPreview(t, tryBody(t, { answers }));
    expect(res.status).toBe(200);
    const wire = JSON.stringify(fake.calls[0]!.body);
    expect(wire).toContain("EDITORS-OWN-NOTE");
    expect(wire).toContain("EDITORS-OWN-CLIENT");
    expect(wire).not.toContain("Cliente di esempio SA");
  });

  it("lists what the sample answers still lack, as the draft route does, and draws it highlighted (AC-10.4)", async () => {
    const t = await template();
    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    delete answers.fields.NOTA;
    const res = await tryPreview(t, tryBody(t, { answers }));
    expect(res.status).toBe(200);
    expect(res.json.missingFields).toContainEqual({ name: "NOTA", label: "Nota", step: expect.any(String) });
    expect(fake.calls[0]!.body.blocks.flatMap((b: any) => b.runs ?? [])).toContainEqual({ text: "Nota", style: "missing" });
  });

  it("takes the pages asked for and refuses a bad `pages` before the service is called", async () => {
    const t = await template();
    expect((await tryPreview(t, tryBody(t), { query: "?pages=3,1" })).status).toBe(200);
    expect(fake.calls[0]!.path).toBe("/v1/render/preview?pages=1,3");
    fake.calls = [];
    for (const bad of ["0", "301", "x", "1,,2", ""]) {
      const res = await tryPreview(t, tryBody(t), { query: `?pages=${bad}` });
      expect({ bad, status: res.status, field: res.json.field }).toEqual({ bad, status: 422, field: "pages" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("uses the template editor's read guard: 401, 403 without crm:access / financials, 404 for no template, no entity scope (AC-10.14)", async () => {
    const t = await template();
    const body = tryBody(t);
    expect((await tryPreview(t, body, { as: null })).status).toBe(401);
    for (const as of ["outsider", "consultant", "managerNoMoney"] as const) {
      expect({ as, status: (await tryPreview(t, body, { as })).status }).toEqual({ as, status: 403 });
    }
    expect((await tryPreview({ id: "no-such-template" }, body)).status).toBe(404);
    expect((await tryPreview(t, body, { as: "salesCh" })).status).toBe(200);
    // template reads carry no entity scope (GET /offer-templates/{id} answers either entity's), so neither does the preview
    const it = await template({ entity: "welld_it", name: "Try IT" });
    expect((await tryPreview(it, tryBody(it), { as: "salesCh" })).status).toBe(200);
    // the body still has to be the template's own: another entity named in it is refused as a body, not as a scope
    const lie = await tryPreview(it, tryBody(it, { entity: "welld_ch" }), { as: "salesCh" });
    expect([lie.status, lie.json.field]).toEqual([422, "entity"]);
    expect(fake.calls).toHaveLength(2);
  });

  it("refuses a body that is not the template's: another entity, another language, a text with errors, answers that cannot be saved (nothing is sent)", async () => {
    const t = await template();
    const entity = await tryPreview(t, tryBody(t, { entity: "welld_it" }));
    expect([entity.status, entity.json.field]).toEqual([422, "entity"]);
    const language = await tryPreview(t, tryBody(t, { language: "en" }));
    expect([language.status, language.json.field]).toEqual([422, "language"]);
    const broken = await tryPreview(t, { ...tryBody(t), content: { ...tryBody(t).content, source: "@@salutation x\n\n## A\n@@step nowhere\nbody [UNKNOWN_FIELD]" } });
    expect([broken.status, broken.json.code]).toEqual([422, "template_invalid"]);
    const extra = await tryPreview(t, { ...tryBody(t), surprise: true });
    expect(extra.status).toBe(422);
    const noContent = await tryPreview(t, { entity: t.entity, language: t.language });
    expect(noContent.status).toBe(422);

    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    answers.fields.NOTA = "bad ⟦ text";
    const reserved = await tryPreview(t, tryBody(t, { answers }));
    expect(reserved.status).toBe(422);
    expect(reserved.json).toMatchObject({ code: "answers_invalid", path: "fields.NOTA", reason: "reserved_character" });
    expect(JSON.stringify(reserved.json)).not.toContain("bad ⟦ text");
    expect(fake.calls).toEqual([]);
  });

  it("does not refuse a value outside its field's options: the text moves under the answers while it is typed", async () => {
    const t = await template();
    const source = `${TYPED}\n@@field TIPO\nlabel: Tipo\noptions: Uno | Due\n`.replace("Nota: [NOTA]", "Nota: [NOTA]\n\nTipo: [TIPO]");
    const { ast } = parseTemplate(source);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    answers.fields.TIPO = "Tre";
    const res = await tryPreview(t, { ...tryBody(t), content: { ...tryBody(t).content, source }, answers });
    expect(res.status).toBe(200);
  });

  it("is 409 template_format_mismatch for a legacy template, which has no wizard to try", async () => {
    // the defaults are seeded on the first read of an entity that has no template; read before the wizard template is made
    await call("GET", "/offer-templates?entity=welld_ch");
    const t = await template();
    const legacy = await db.offerTemplate.findFirstOrThrow({ where: { entity: "welld_ch", format: "sections", language: "en" } });
    const res = await tryPreview(legacy, tryBody(t, { language: legacy.language, content: { ...tryBody(t).content, language: legacy.language } }));
    expect([res.status, res.json.code]).toEqual([409, "template_format_mismatch"]);
    expect(fake.calls).toEqual([]);
  });

  it("is 409 legal_entity_incomplete naming what is missing, without calling the service (AC-6.3)", async () => {
    const t = await template();
    registry.set(incompleteEntity("welld_ch", ["legalName"], { legalName: " " }));
    const blank = await tryPreview(t, tryBody(t));
    expect([blank.status, blank.json.code, blank.json.entity, blank.json.missing]).toEqual([409, "legal_entity_incomplete", "welld_ch", ["legalName"]]);
    expect(fake.calls).toEqual([]);
  });

  it("is 503 legal_entities_unavailable with Retry-After: 5 when the registry cannot be read, without calling the service", async () => {
    const t = await template();
    registry.unavailable();
    const res = await tryPreview(t, tryBody(t));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("legal_entities_unavailable");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(fake.calls).toEqual([]);
  });

  it("never answers entity_profile_missing: a missing profile row is drawn (E4)", async () => {
    const t = await template();
    await db.entityProfile.delete({ where: { entity: "welld_ch" } });
    const res = await tryPreview(t, tryBody(t));
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  describe("when the service cannot draw the pages (the draft route's answers, AC-10.7, AC-10.8)", () => {
    const failure = async (answers: Answer[], timeoutMs?: number) => {
      const t = await template();
      fake.answers = answers;
      if (timeoutMs !== undefined) fake.timeoutMs = timeoutMs;
      const res = await tryPreview(t, tryBody(t));
      const wire = JSON.stringify(res.json);
      for (const secret of ["SECRET-SERVICE-DETAIL", "SECRET-NETWORK-DETAIL", "TYPED-ONLY-TEXT", "svc-token"]) expect(wire).not.toContain(secret);
      // the editor keeps working: the template is still savable
      const saved = await call("PUT", `/offer-templates/${t.id}`, {
        ifMatch: t.version,
        body: { name: t.name, language: t.language, description: t.description, uses: t.uses, source: TYPED },
      });
      expect(saved.status).toBe(200);
      return res;
    };

    it("is 503 layout_service_unavailable when it is unreachable, answers an error, is busy or times out", async () => {
      for (const answers of [["network-error"], [refusal(500, "boom")], [refusal(429, "busy")], [refusal(422, "invalid_content")], [Response.json({ nope: true })], [refusal(422, "unsupported_content_version")], [refusal(503, "legal_entities_unavailable")]] as Answer[][]) {
        const res = await failure(answers);
        expect([res.status, res.json.code]).toEqual([503, "layout_service_unavailable"]);
      }
      const hung = await failure(["hang"], 40);
      expect([hung.status, hung.json.code]).toEqual([503, "layout_service_unavailable"]);
    });

    describe("the service prints another version of the issuer's details than crm-api read (AC-6.2)", () => {
      const ISSUER_SOURCE = `${TYPED.replace("Nota: [NOTA]", "ISSUER-LINE: [EMITTENTE] / [INDIRIZZO]\n\nNota: [NOTA]")}\n@@field EMITTENTE\nsource: issuer\n\n@@field INDIRIZZO\nsource: issuerAddress\n`;
      const details = (version: number, legalName: string) => completeEntity("welld_ch", { version, legalName, address: { it: [`${legalName} street`], en: [`${legalName} street`] } });
      const issuerLine = (body: any): string => {
        const texts = (body.blocks as any[]).map((block) => (block.type === "paragraph" ? block.runs.map((run: any) => run.text ?? "").join("") : ""));
        return texts.find((text) => text.startsWith("ISSUER-LINE:")) ?? "(none)";
      };
      function refreshesOnInvalidate(next: ReturnType<typeof details>): { restore(): void } {
        const real = registry.invalidate.bind(registry);
        const hook = spyOn(registry, "invalidate").mockImplementation(() => {
          real();
          registry.set(next);
        });
        return { restore: () => hook.mockRestore() };
      }
      const body = (t: Parameters<typeof tryBody>[0]) => ({ ...tryBody(t), content: { ...tryBody(t).content, source: ISSUER_SOURCE } });

      it("a 409 once: the registry is read again, the content rebuilt from it, ONE retry, and the answer is the retry's (saved and unsaved templates alike)", async () => {
        const t = await template();
        for (const run of [(b: unknown) => tryPreview(t, b), (b: unknown) => tryUnsaved(b)]) {
          fake.calls = [];
          registry.set(details(7, "OLD"));
          fake.issuerVersion = 8;
          const refresh = refreshesOnInvalidate(details(8, "NEW"));
          try {
            const res = await run(body(t));
            expect(res.status, JSON.stringify(res.json)).toBe(200);
            expect(res.headers.get("Cache-Control")).toBe("no-store");
            expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([7, 8]);
            expect(issuerLine(fake.calls[0]!.body)).toBe("ISSUER-LINE: OLD / OLD street");
            expect(issuerLine(fake.calls[1]!.body)).toBe("ISSUER-LINE: NEW / NEW street");
            for (const call of fake.calls) expect(call.body).not.toHaveProperty("entityData");
          } finally {
            refresh.restore();
          }
        }
      });

      it("a 409 twice: 503 layout_service_unavailable after exactly two requests", async () => {
        const t = await template();
        registry.set(details(7, "OLD"));
        fake.issuerVersion = 9;
        const refresh = refreshesOnInvalidate(details(8, "NEW"));
        try {
          const res = await tryPreview(t, body(t));
          expect([res.status, res.json.code]).toEqual([503, "layout_service_unavailable"]);
          expect(JSON.stringify(res.json)).not.toContain("SECRET");
          expect(fake.calls.map((call) => call.body.legalEntityVersion)).toEqual([7, 8]);
        } finally {
          refresh.restore();
        }
      });
    });

    it("is 409 letterhead_not_configured when the entity has no active letterhead", async () => {
      const res = await failure([refusal(409, "letterhead_not_configured")]);
      expect([res.status, res.json.code, res.json.entity]).toEqual([409, "letterhead_not_configured", "welld_ch"]);
    });

    it("is 409 letterhead_overflow with the frame when a profile value does not fit", async () => {
      const header = await failure([refusal(422, "header_overflow")]);
      expect([header.status, header.json.code, header.json.frame]).toEqual([409, "letterhead_overflow", "header"]);
      const footer = await failure([refusal(422, "footer_overflow")]);
      expect([footer.status, footer.json.code, footer.json.frame]).toEqual([409, "letterhead_overflow", "footer"]);
    });
  });
});

/** Waits until `ok()` holds, or fails the test. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
}

describe("at most 2 previews in flight per person, across both preview routes (security review F1)", () => {
  const opened: (() => void)[] = [];
  const hold = () => {
    let open!: () => void;
    fake.gate = new Promise<void>((resolve) => (open = resolve));
    opened.push(open);
    return { open };
  };
  // a test that fails while it holds the service must not leave its slots taken for the next one
  afterEach(async () => {
    for (const open of opened.splice(0)) open();
    await until(() => previewCap.inflight("user-admin") === 0, "the slots to be freed");
  });

  it("answers the third try-preview with 429 preview_busy and Retry-After: 1, without calling the service for it", async () => {
    const t = await template();
    const gate = hold();
    const a = tryPreview(t, tryBody(t));
    const b = tryPreview(t, tryBody(t));
    await until(() => fake.calls.length === MAX_PREVIEWS_IN_FLIGHT_PER_PERSON, "two previews at the service");
    const third = await tryPreview(t, tryBody(t));
    expect(third.status).toBe(429);
    expect(third.json.code).toBe("preview_busy");
    expect(third.headers.get("Retry-After")).toBe("1");
    expect(JSON.stringify(third.json)).not.toMatch(/SECRET|IMAGE-|svc-token|TYPED-ONLY/);
    expect(fake.calls).toHaveLength(2);
    gate.open();
    expect([(await a).status, (await b).status]).toEqual([200, 200]);
    expect(previewCap.inflight("user-admin")).toBe(0);
    expect((await tryPreview(t, tryBody(t))).status).toBe(200);
  }, 20_000);

  it("is one cap for the person across both routes: two try-previews in flight refuse the wizard's preview too", async () => {
    const t = await template();
    const gate = hold();
    const a = tryPreview(t, tryBody(t));
    const b = tryPreview(t, tryBody(t));
    await until(() => fake.calls.length === 2, "two previews at the service");
    // the cap is taken before the deal is looked up: any deal id gets the refusal, and the service is not called
    const draft = await call("POST", "/deals/any-deal/offer-draft/preview", { body: { nonsense: true } });
    expect([draft.status, draft.json.code, draft.headers.get("Retry-After")]).toEqual([429, "preview_busy", "1"]);
    expect(fake.calls).toHaveLength(2);
    // another person is not held up by it
    expect((await call("POST", "/deals/any-deal/offer-draft/preview", { as: "salesCh", body: { nonsense: true } })).status).toBe(422);
    gate.open();
    await Promise.all([a, b]);
  });
});

describe("a reader previews the template through the service (T53; AC-10.14)", () => {
  it("gets the pages with deal:financials alone: no deal:manage is needed, the service is called as for a manager", async () => {
    const t = await template();
    const res = await tryPreview(t, tryBody(t), { as: READER_CH });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ...previewBody(), missingFields: expect.any(Array) });
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(fake.calls[0]!.body)).toContain("TYPED-ONLY-TEXT");
    // the same answer a manager gets for the same text
    const manager = await tryPreview(t, tryBody(t), { as: "salesCh" });
    expect(manager.json).toEqual(res.json);
  });

  it("still cannot change the template: the editor's write routes stay behind deal:manage", async () => {
    const t = await template();
    const put = await call("PUT", `/offer-templates/${t.id}`, { as: READER_CH, ifMatch: t.version, body: tryBody(t).content });
    expect(put.status).toBe(403);
    expect((await call("POST", "/offer-templates", { as: READER_CH, body: { ...tryBody(t).content, entity: "welld_ch" } })).status).toBe(403);
    expect((await call("POST", `/offer-templates/${t.id}/archive`, { as: READER_CH, ifMatch: t.version })).status).toBe(403);
    expect((await call("POST", `/offer-templates/${t.id}/duplicate`, { as: READER_CH })).status).toBe(403);
  });

  it("has no entity scope, as the template's own read has none: a reader of the other entity gets the pages too", async () => {
    const it = await template({ entity: "welld_it", name: "Try IT" });
    const ch = await template({ name: "Try CH" });
    expect((await call("GET", `/offer-templates/${it.id}`, { as: READER_CH })).status).toBe(200);
    for (const [as, t] of [[READER_CH, it], [READER_IT, ch], [READER_IT, it]] as const) {
      expect({ as, status: (await tryPreview(t, tryBody(t), { as })).status }).toEqual({ as, status: 200 });
    }
    expect(fake.calls).toHaveLength(3);
  });

  it("is refused without deal:financials, with or without deal:manage, and nothing is called", async () => {
    const t = await template();
    for (const as of ["outsider", "consultant", "managerNoMoney"] as const) {
      expect({ as, status: (await tryPreview(t, tryBody(t), { as })).status }).toEqual({ as, status: 403 });
      expect({ as, status: (await tryUnsaved(unsavedBody(), { as })).status }).toEqual({ as, status: 403 });
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("POST /offer-templates/try-preview, a template that was never saved (T53; AC-10.14)", () => {
  it("draws the text as typed with the sample answers and the entity profile, with no deal and no template row, the same pages the saved one gets", async () => {
    await putEntityProfile("welld_ch");
    await putEntityProfile("welld_it");
    expect(await db.deal.count()).toBe(0);
    expect(await db.offerTemplate.count()).toBe(0);
    const res = await tryUnsaved(unsavedBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({ ...previewBody(), missingFields: expect.any(Array) });

    expect(fake.calls).toHaveLength(1);
    const [sent] = fake.calls;
    expect(sent!.path).toBe("/v1/render/preview");
    expect(sent!.authorization).toBe("Bearer svc-token");
    expect(sent!.body).toMatchObject({ contentVersion: 2, entity: "welld_ch", language: "it", legalEntityVersion: (await registry.get("welld_ch")).version });
    expect(sent!.body).not.toHaveProperty("entityData");
    const wire = JSON.stringify(sent!.body);
    expect(wire).toContain("TYPED-ONLY-TEXT");
    expect(wire).toContain("Cliente di esempio SA");

    // the same text on a saved template is drawn from the very same blocks
    const t = await template();
    fake.calls = [];
    await tryPreview(t, tryBody(t));
    expect(fake.calls[0]!.body).toEqual(sent!.body);
  });

  it("draws the other entity's profile for its own body, and takes the editor's sample answers", async () => {
    await putEntityProfile("welld_ch");
    await putEntityProfile("welld_it");
    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    answers.fields.NOTA = "EDITORS-OWN-NOTE";
    const res = await tryUnsaved(unsavedBody({ answers }, "welld_it"));
    expect(res.status).toBe(200);
    // the entity's own registry version, not the other's, and nothing of its details sent
    expect(fake.calls[0]!.body).toMatchObject({ entity: "welld_it", legalEntityVersion: (await registry.get("welld_it")).version });
    expect(fake.calls[0]!.body).not.toHaveProperty("entityData");
    expect(JSON.stringify(fake.calls[0]!.body)).not.toContain("wellD Srl");
    expect(JSON.stringify(fake.calls[0]!.body)).toContain("EDITORS-OWN-NOTE");
  });

  it("stores nothing: no template, sequence, draft or offer appears, and the name it carries stays free", async () => {
    await putEntityProfile("welld_ch");
    const before = { templates: await db.offerTemplate.findMany({ orderBy: { id: "asc" } }), sequences: await db.offerSequence.findMany(), drafts: await db.offerDraft.count() };
    expect((await tryUnsaved(unsavedBody())).status).toBe(200);
    expect(await db.offerTemplate.findMany({ orderBy: { id: "asc" } })).toEqual(before.templates);
    expect(await db.offerSequence.findMany()).toEqual(before.sequences);
    expect(await db.offerDraft.count()).toBe(before.drafts);
    expect(await db.dealOffer.count()).toBe(0);
    const list = await call("GET", "/offer-templates?entity=welld_ch&formats=wizard");
    expect(JSON.stringify(list.json)).not.toContain("Never saved");
    // the name is free: a template of that very name is created afterwards, and a name that is taken does not stop the preview
    const created = await makeWizardTemplate({ name: "Never saved" });
    expect((await tryUnsaved(unsavedBody())).status).toBe(200);
    expect(created.name).toBe("Never saved");
  });

  it("takes the pages asked for and refuses a bad `pages` before the service is called", async () => {
    await putEntityProfile("welld_ch");
    expect((await tryUnsaved(unsavedBody(), { query: "?pages=3,1" })).status).toBe(200);
    expect(fake.calls[0]!.path).toBe("/v1/render/preview?pages=1,3");
    fake.calls = [];
    for (const bad of ["0", "301", "x", "1,,2", ""]) {
      const res = await tryUnsaved(unsavedBody(), { query: `?pages=${bad}` });
      expect({ bad, status: res.status, field: res.json.field }).toEqual({ bad, status: 422, field: "pages" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("uses the read guard: 401, 403 without crm:access / financials; a manager, a reader and an admin get pages, whichever entity the body names", async () => {
    await putEntityProfile("welld_ch");
    await putEntityProfile("welld_it");
    expect((await tryUnsaved(unsavedBody(), { as: null })).status).toBe(401);
    for (const as of ["outsider", "consultant", "managerNoMoney"] as const) {
      expect({ as, status: (await tryUnsaved(unsavedBody(), { as })).status }).toEqual({ as, status: 403 });
    }
    expect(fake.calls).toEqual([]);
    for (const [as, entity] of [["salesCh", "welld_ch"], ["salesCh", "welld_it"], [READER_CH, "welld_ch"], [READER_CH, "welld_it"], [READER_IT, "welld_it"], ["admin", "welld_it"]] as const) {
      expect({ as, entity, status: (await tryUnsaved(unsavedBody({}, entity), { as })).status }).toEqual({ as, entity, status: 200 });
    }
    expect(fake.calls).toHaveLength(6);
  });

  it("refuses a template that a create would refuse, with the create's codes, and sends nothing", async () => {
    await putEntityProfile("welld_ch");
    const base = unsavedBody();
    const content = (over: Record<string, unknown>) => ({ ...base, content: { ...base.content, ...over } });
    const broken = await tryUnsaved(content({ source: "@@salutation x\n\n## A\n@@step nowhere\nbody [UNKNOWN_FIELD]" }));
    expect([broken.status, broken.json.code]).toEqual([422, "template_invalid"]);
    expect(broken.json.problems.length).toBeGreaterThan(0);
    // the create's own answer for the same text
    const created = await call("POST", "/offer-templates", { body: { ...content({ source: "@@salutation x\n\n## A\n@@step nowhere\nbody [UNKNOWN_FIELD]" }).content, entity: "welld_ch" } });
    expect([created.status, created.json.code]).toEqual([422, "template_invalid"]);

    const refused: [string, Record<string, unknown>][] = [
      ["name too long", content({ name: "x".repeat(81) })],
      ["blank name", content({ name: "  " })],
      ["description over two lines", content({ description: "one\ntwo" })],
      ["too many uses", content({ uses: Array.from({ length: 7 }, (_, i) => `use ${i}`) })],
      ["NUL in the source", content({ source: `${TYPED}\u0000` })],
      ["empty source", content({ source: "" })],
      ["source over 150 000 characters", content({ source: "x".repeat(150_001) })],
      ["unknown member of the content", content({ surprise: 1 })],
      ["unknown member of the body", { ...base, surprise: true }],
      ["no content", { entity: "welld_ch", language: "it" }],
      ["unknown entity", { ...base, entity: "welld_xx" }],
      ["no entity", { content: base.content, language: "it" }],
      ["no language", { content: base.content, entity: "welld_ch" }],
      ["a language that is not the text's", { ...base, language: "en" }],
    ];
    for (const [what, body] of refused) {
      const res = await tryUnsaved(body);
      expect({ what, status: res.status }).toEqual({ what, status: 422 });
    }
    const lang = await tryUnsaved({ ...base, language: "en" });
    expect(lang.json.field).toBe("language");

    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    answers.fields.NOTA = "bad ⟦ text";
    const reserved = await tryUnsaved({ ...base, answers });
    expect(reserved.status).toBe(422);
    expect(reserved.json).toMatchObject({ code: "answers_invalid", path: "fields.NOTA", reason: "reserved_character" });
    expect(JSON.stringify(reserved.json)).not.toContain("bad ⟦ text");
    expect(fake.calls).toEqual([]);
    expect(await db.offerTemplate.count()).toBe(0);
  });

  it("does not refuse a value outside its field's options, as the saved route does not", async () => {
    await putEntityProfile("welld_ch");
    const source = `${TYPED}\n@@field TIPO\nlabel: Tipo\noptions: Uno | Due\n`.replace("Nota: [NOTA]", "Nota: [NOTA]\n\nTipo: [TIPO]");
    const { ast } = parseTemplate(source);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    answers.fields.TIPO = "Tre";
    const base = unsavedBody();
    expect((await tryUnsaved({ ...base, content: { ...base.content, source }, answers })).status).toBe(200);
  });

  it("lists what the sample answers still lack and draws it highlighted (AC-10.4)", async () => {
    await putEntityProfile("welld_ch");
    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    delete answers.fields.NOTA;
    const res = await tryUnsaved(unsavedBody({ answers }));
    expect(res.status).toBe(200);
    expect(res.json.missingFields).toContainEqual({ name: "NOTA", label: "Nota", step: expect.any(String) });
    expect(fake.calls[0]!.body.blocks.flatMap((b: any) => b.runs ?? [])).toContainEqual({ text: "Nota", style: "missing" });
  });

  it("is 422 section_too_long for a section over the limit, and the service is never called", async () => {
    await putEntityProfile("welld_ch");
    const { ast } = parseTemplate(TYPED);
    const answers = structuredClone(sampleAnswers(ast, "it")) as any;
    const paragraphs = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1} ${"x".repeat(140)}`).join("\n\n");
    answers.fields.EPICI = paragraphs;
    answers.fields.FASI = paragraphs;
    const res = await tryUnsaved(unsavedBody({ answers }));
    expect([res.status, res.json.code]).toEqual([422, "section_too_long"]);
    expect(res.json.sections).toEqual([{ name: "section:OGGETTO#0", label: "OGGETTO" }]);
    expect(JSON.stringify(res.json)).not.toContain("Paragraph");
    expect(fake.calls).toEqual([]);
  });

  it("is 409 legal_entity_incomplete, or 503 legal_entities_unavailable with Retry-After: 5, without calling the service; a missing profile row is no refusal (E4)", async () => {
    await putEntityProfile("welld_ch");
    registry.set(incompleteEntity("welld_ch", ["legalName"], { legalName: " " }));
    const blank = await tryUnsaved(unsavedBody());
    expect([blank.status, blank.json.code, blank.json.entity, blank.json.missing]).toEqual([409, "legal_entity_incomplete", "welld_ch", ["legalName"]]);
    registry.unavailable();
    const down = await tryUnsaved(unsavedBody());
    expect([down.status, down.json.code, down.headers.get("Retry-After")]).toEqual([503, "legal_entities_unavailable", "5"]);
    expect(fake.calls).toEqual([]);
    registry.unavailable(false);
    registry.set(worldIssuer("welld_ch"));
    await db.entityProfile.delete({ where: { entity: "welld_ch" } });
    expect((await tryUnsaved(unsavedBody())).status).toBe(200);
  });

  it("answers the service's failures as the saved route does: 503, 409 letterhead_not_configured, 409 letterhead_overflow with the frame", async () => {
    await putEntityProfile("welld_ch");
    for (const [answers, status, code] of [
      [["network-error"], 503, "layout_service_unavailable"],
      [[refusal(500, "boom")], 503, "layout_service_unavailable"],
      [[refusal(409, "letterhead_not_configured")], 409, "letterhead_not_configured"],
      [[refusal(422, "header_overflow")], 409, "letterhead_overflow"],
    ] as [Answer[], number, string][]) {
      fake.answers = answers;
      const res = await tryUnsaved(unsavedBody());
      expect([res.status, res.json.code]).toEqual([status, code]);
      const wire = JSON.stringify(res.json);
      for (const secret of ["SECRET-SERVICE-DETAIL", "SECRET-NETWORK-DETAIL", "TYPED-ONLY-TEXT", "svc-token"]) expect(wire).not.toContain(secret);
    }
  });
});

describe("the in-flight cap holds for the unsaved route too (T53, security review F1)", () => {
  const opened: (() => void)[] = [];
  afterEach(async () => {
    for (const open of opened.splice(0)) open();
    await until(() => previewCap.inflight("user-admin") === 0 && previewCap.inflight("user-reader-ch") === 0, "the slots to be freed");
  });
  const hold = () => {
    let open!: () => void;
    fake.gate = new Promise<void>((resolve) => (open = resolve));
    opened.push(open);
    return { open };
  };

  it("answers the third preview with 429 preview_busy whichever routes the first two used, and counts a reader as a person", async () => {
    await putEntityProfile("welld_ch");
    const t = await template();
    const gate = hold();
    const a = tryUnsaved(unsavedBody());
    const b = tryPreview(t, tryBody(t));
    await until(() => fake.calls.length === MAX_PREVIEWS_IN_FLIGHT_PER_PERSON, "two previews at the service");
    const third = await tryUnsaved(unsavedBody());
    expect([third.status, third.json.code, third.headers.get("Retry-After")]).toEqual([429, "preview_busy", "1"]);
    const fourth = await tryPreview(t, tryBody(t));
    expect([fourth.status, fourth.json.code]).toEqual([429, "preview_busy"]);
    expect(JSON.stringify(third.json)).not.toMatch(/SECRET|IMAGE-|svc-token|TYPED-ONLY/);
    expect(fake.calls).toHaveLength(2);
    // another person (a reader) is not held up by it
    const reader = tryUnsaved(unsavedBody(), { as: READER_CH });
    await until(() => fake.calls.length === 3, "the reader's preview at the service");
    gate.open();
    expect([(await a).status, (await b).status, (await reader).status]).toEqual([200, 200, 200]);
    expect(previewCap.inflight("user-admin")).toBe(0);
    expect((await tryUnsaved(unsavedBody())).status).toBe(200);
  }, 20_000);
});

describe("with the switch off", () => {
  it("the route does not exist: 404 to a person who may use it, whatever the body, and the service is never called", async () => {
    const t = await template();
    env.LETTERHEAD_SERVICE_ENABLED = false;
    const res = await tryPreview(t, tryBody(t));
    expect(res.status).toBe(404);
    expect(res.json.detail).toBe(`POST /offer-templates/${t.id}/try-preview does not exist`);
    expect(res.json.code).toBeUndefined();
    expect((await tryPreview(t, { nonsense: true })).status).toBe(404);
    expect((await tryPreview(t, tryBody(t), { query: "?pages=x" })).status).toBe(404);
    expect((await tryPreview({ id: "no-such-template" }, tryBody(t))).status).toBe(404);
    // another entity's template: the switch answers first, so the scope is not probed either
    const it = await template({ entity: "welld_it", name: "Try IT" });
    expect((await tryPreview(it, tryBody(it), { as: "salesCh" })).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it("the unsaved route does not exist either: 404 to a person who may use it, whatever the body, and nothing is called (T53)", async () => {
    env.LETTERHEAD_SERVICE_ENABLED = false;
    for (const as of ["admin", "salesCh", READER_CH] as const) {
      const res = await tryUnsaved(unsavedBody(), { as });
      expect([as, res.status, res.json.detail, res.json.code]).toEqual([as, 404, "POST /offer-templates/try-preview does not exist", undefined]);
    }
    expect((await tryUnsaved({ nonsense: true })).status).toBe(404);
    expect((await tryUnsaved(unsavedBody(), { query: "?pages=x" })).status).toBe(404);
    // another entity's: the switch answers first, so the scope is not probed
    expect((await tryUnsaved(unsavedBody({}, "welld_it"), { as: "salesCh" })).status).toBe(404);
    // and the caller the CRM refuses gets the 401 and the 403 they always got
    expect((await tryUnsaved(unsavedBody(), { as: null })).status).toBe(401);
    for (const as of ["outsider", "consultant", "managerNoMoney"] as const) expect((await tryUnsaved(unsavedBody(), { as })).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("is the 401 and the 403 they always were for a caller the CRM refuses", async () => {
    const t = await template();
    env.LETTERHEAD_SERVICE_ENABLED = false;
    expect((await tryPreview(t, tryBody(t), { as: null })).status).toBe(401);
    for (const as of ["outsider", "consultant", "managerNoMoney"] as const) expect((await tryPreview(t, tryBody(t), { as })).status).toBe(403);
  });

  it("changes nothing else about templates: read, save and archive answer as before", async () => {
    const t = await template({ source: WIZARD_SOURCE });
    env.LETTERHEAD_SERVICE_ENABLED = false;
    expect((await call("GET", `/offer-templates/${t.id}`)).status).toBe(200);
    const saved = await call("PUT", `/offer-templates/${t.id}`, {
      ifMatch: t.version,
      body: { name: t.name, language: t.language, description: "Changed", uses: t.uses, source: WIZARD_SOURCE },
    });
    expect(saved.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });
});

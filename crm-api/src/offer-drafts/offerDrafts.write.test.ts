/**
 * Saving, discarding and re-templating a draft (specs/20261115-crm-offer-wizard T30; AC-1.8, AC-5.1, AC-6.1, AC-6.3,
 * AC-6.5, AC-8.4; DD-8, DD-30, DD-31, DD-38, DD-42, DD-52): `PUT`, `DELETE` and `POST …/template`.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  DRAFT_SOURCE,
  call,
  db,
  makeDraftTemplate,
  readyDealWithProfiles,
  resetWorld,
} from "../test-support/world";

beforeEach(resetWorld);

/** The draft's text with one field that has options. */
const OPTIONS_SOURCE = `${DRAFT_SOURCE.replace("Giorni: [GIORNI]", "Giorni: [GIORNI]\n\nTipo: [TIPO]")}\n@@field TIPO\nlabel: Tipo\noptions: Uno | Due\n`;

interface Setup {
  dealId: string;
  templateId: string;
  draft: { answers: any; version: number; templateVersion: number; target: unknown };
}

async function setup(source = OPTIONS_SOURCE, entity: "welld_ch" | "welld_it" = "welld_ch"): Promise<Setup> {
  const { deal } = await readyDealWithProfiles({ entity });
  const template = await makeDraftTemplate({ source, entity });
  const created = await call("POST", `/deals/${deal.id}/offer-draft`, { body: { templateId: template.id }, headers: { "If-None-Match": "*" } });
  if (created.status !== 201) throw new Error(`draft: ${created.status} ${JSON.stringify(created.json)}`);
  return { dealId: deal.id, templateId: template.id, draft: created.json };
}

/** `PUT` the draft with `change` applied to a copy of its answers. */
const save = (s: Setup, change: (answers: any) => void, over: { ifMatch?: number | string | null; templateVersion?: number; target?: unknown; as?: "admin" | "salesCh" } = {}) => {
  const answers = structuredClone(s.draft.answers);
  change(answers);
  return call("PUT", `/deals/${s.dealId}/offer-draft`, {
    as: over.as ?? "admin",
    ...(over.ifMatch === null ? {} : { ifMatch: over.ifMatch ?? s.draft.version }),
    body: { templateVersion: over.templateVersion ?? s.draft.templateVersion, target: over.target ?? { kind: "new" }, answers },
  });
};

describe("PUT /deals/{id}/offer-draft", () => {
  it("round-trips: the saved answers come back, the version moves, the ETag says so (AC-6.1)", async () => {
    const s = await setup();
    const res = await save(s, (a) => {
      a.fields.EPICI = "Nuove epiche";
      a.client.place = "Zurigo";
      a.lastStep = "scope";
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json.version).toBe(2);
    const got = await call("GET", `/deals/${s.dealId}/offer-draft`);
    expect(got.json.answers.fields.EPICI).toBe("Nuove epiche");
    expect(got.json.answers.client.place).toBe("Zurigo");
    expect(got.json.answers.lastStep).toBe("scope");
    expect(got.json.updatedBy).toMatchObject({ id: "user-admin" });
  });

  it("is 428 without If-Match, 409 for a stale one and the other version stays intact (AC-6.3)", async () => {
    const s = await setup();
    expect((await save(s, () => {}, { ifMatch: null })).status).toBe(428);
    expect((await save(s, (a) => (a.fields.EPICI = "mine"))).status).toBe(200);
    const stale = await save(s, (a) => (a.fields.EPICI = "yours"));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    expect((await call("GET", `/deals/${s.dealId}/offer-draft`)).json.answers.fields.EPICI).toBe("mine");
  });

  it("a body deep-equal to the stored draft is a no-op: 200, same version, updatedAt unchanged (DD-31)", async () => {
    const s = await setup();
    const before = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    await Bun.sleep(5);
    const res = await save(s, () => {});
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(1);
    expect(res.headers.get("ETag")).toBe('"1"');
    const after = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    expect(after.version).toBe(1);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // a step change on its own is a content change here (the client simply does not send one, DD-31)
    expect((await save(s, (a) => (a.lastStep = "costs"))).json.version).toBe(2);
  });

  it("refuses a value outside its field's options when templateVersion is current, accepts it when stale (AC-1.8, DD-38)", async () => {
    const s = await setup();
    const bad = await save(s, (a) => (a.fields.TIPO = "Tre"));
    expect(bad.status).toBe(422);
    expect(bad.json).toMatchObject({ code: "answers_invalid", path: "fields.TIPO" });
    expect((await save(s, (a) => (a.fields.TIPO = "Due"))).status).toBe(200);

    // the template moves on; the person's tab still holds the old version: the save is never refused for that (DD-8)
    await db.offerTemplate.update({ where: { id: s.templateId }, data: { version: { increment: 1 } } });
    const stale = await save({ ...s, draft: { ...s.draft, version: 2 } }, (a) => (a.fields.TIPO = "Tre"), { templateVersion: 1 });
    expect(stale.status).toBe(200);
    expect(stale.json.templateVersion).toBe(1);
  });

  it("refuses a templateVersion the template has not reached", async () => {
    const s = await setup();
    const res = await save(s, () => {}, { templateVersion: 9 });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "answers_invalid", path: "templateVersion" });
  });

  it("the target cannot change by a save", async () => {
    const s = await setup();
    const res = await save(s, () => {}, { target: { kind: "edit", offerId: "x" } });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ code: "answers_invalid", path: "target" });
  });

  it("checks client.date for its shape only: 200 days ahead is saved (the window is the resolver's, DD-42), 2026-02-30 is not", async () => {
    const s = await setup();
    const far = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const ok = await save(s, (a) => (a.client.date = far));
    expect(ok.status).toBe(200);
    expect(ok.json.answers.client.date).toBe(far);
    const bad = await save({ ...s, draft: { ...s.draft, version: 2 } }, (a) => (a.client.date = "2026-02-30"));
    expect(bad.status).toBe(422);
    expect(bad.json).toMatchObject({ code: "answers_invalid", path: "client.date" });
  });

  it("a client.date that is no date at all is the same 422, never a 500 (QE F4)", async () => {
    const s = await setup();
    for (const bad of ["x", "2026-13-45", "2026-00-10"]) {
      const res = await save(s, (a) => (a.client.date = bad));
      expect([bad, res.status]).toEqual([bad, 422]);
      expect(res.json).toMatchObject({ code: "answers_invalid", path: "client.date" });
    }
  });

  it("refuses the reserved characters with their path (DD-30, DD-52)", async () => {
    const s = await setup();
    const key = "OGGETTO#0";
    const edit = (body: string, heading = "OGGETTO") => (a: any) => {
      a.handEdits[key] = { heading, body, sourceHeading: "OGGETTO" };
    };
    const refused = async (change: (a: any) => void, path: string) => {
      const res = await save(s, change);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "answers_invalid", path });
    };
    await refused(edit("testo ⟦Etichetta⟧"), 'handEdits["OGGETTO#0"].body');
    await refused((a) => (a.fields.EPICI = "xy"), "fields.EPICI");
    await refused(edit("ok", "OGGETTO ⟪REF⟫"), 'handEdits["OGGETTO#0"].heading');
    await refused((a) => (a.fields.EPICI = "Rif. ⟪REF⟫"), "fields.EPICI");
    await refused(edit("un ⟫ solitario"), 'handEdits["OGGETTO#0"].body');
    await refused(edit("⟪ref⟫ minuscolo"), 'handEdits["OGGETTO#0"].body');
    // the exact token in a body is the one allowed use (DD-52)
    const allowed = await save(s, edit("Rif. ⟪REF⟫ e ancora ⟪REF⟫"));
    expect(allowed.status).toBe(200);
    expect(allowed.json.answers.handEdits[key].body).toBe("Rif. ⟪REF⟫ e ancora ⟪REF⟫");
    // and in an orphaned edit's body
    const orphan = await save({ ...s, draft: { ...s.draft, version: 2 } }, (a) => (a.orphanedEdits = [{ heading: "h", body: "⟪REF⟫" }]));
    expect(orphan.status).toBe(200);
  });

  it("is 413 draft_too_large over 512 KiB, and nothing changes", async () => {
    const s = await setup();
    const res = await save(s, (a) => (a.fields.EPICI = "x".repeat(600 * 1024)));
    expect(res.status).toBe(413);
    expect(res.json.code).toBe("draft_too_large");
    expect((await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } })).version).toBe(1);
    // a draft a little under it still saves: the cap is the draft's, not the global 64 KiB one
    const big = await save(s, (a) => (a.lists = { L: Array.from({ length: 50 }, () => "y".repeat(2_000)) }));
    expect(big.status).toBe(200);
  });

  it("refuses a shape the caps do not allow, naming the path", async () => {
    const s = await setup();
    const cases: [(a: any) => void, string][] = [
      [(a) => (a.fields.EPICI = "z".repeat(20_001)), "fields.EPICI"],
      [(a) => (a.client.lines = []), "client.lines"],
      [(a) => (a.client.contactIds = ["1", "2", "3", "4", "5", "6"]), "client.contactIds"],
      [(a) => (a.validityDays = 400), "validityDays"],
      [(a) => (a.costs.extra = Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, description: "d", kind: "one_off", unitCents: 1, percentBp: null, quantity: 1 }))), "costs.extra"],
      [(a) => (a.surprise = true), "surprise"],
      [(a) => (a.lastStep = "nowhere"), "lastStep"],
    ];
    for (const [change, path] of cases) {
      const res = await save(s, change);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "answers_invalid", path });
    }
  });

  it("refuses U+0000 in any draft string with 422 answers_invalid and its path, never a 500 (QE D2, L-1)", async () => {
    const s = await setup();
    const NUL = "\u0000";
    const before = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    const cases: [string, (a: any) => void, string][] = [
      ["client.place", (a) => (a.client.place = `Zu${NUL}rigo`), "client.place"],
      ["a client.lines entry", (a) => (a.client.lines = ["Ok", `Via${NUL}x`]), "client.lines[1]"],
      ["a field value", (a) => (a.fields.EPICI = `x${NUL}`), "fields.EPICI"],
      ["a list item", (a) => (a.lists = { L: ["a", `b${NUL}`] }), "lists.L[1]"],
      ["a table cell", (a) => (a.tables = { T: [{ id: "r1", cells: { C: `c${NUL}` } }] }), "tables.T[0].cells.C"],
      ["a table row id", (a) => (a.tables = { T: [{ id: `r${NUL}`, cells: { C: "c" } }] }), "tables.T[0].id"],
      ["a field key", (a) => (a.fields = { [`A${NUL}B`]: "v" }), 'fields["A\\u0000B"]'],
      ["a hand edit body", (a) => (a.handEdits["OGGETTO#0"] = { heading: "OGGETTO", body: `t${NUL}`, sourceHeading: "OGGETTO" }), 'handEdits["OGGETTO#0"].body'],
      ["a hand edit heading", (a) => (a.handEdits["OGGETTO#0"] = { heading: `h${NUL}`, body: "t", sourceHeading: "OGGETTO" }), 'handEdits["OGGETTO#0"].heading'],
      ["a hand edit key", (a) => (a.handEdits[`K${NUL}`] = { heading: "h", body: "t", sourceHeading: "OGGETTO" }), 'handEdits["K\\u0000"]'],
      ["an orphaned edit", (a) => (a.orphanedEdits = [{ heading: "h", body: `t${NUL}` }]), "orphanedEdits[0].body"],
      ["an extra cost description", (a) => (a.costs.extra = [{ id: "e1", description: `d${NUL}`, kind: "one_off", unitCents: 1, percentBp: null, quantity: 1 }]), "costs.extra[0].description"],
      ["a cost line release description", (a) => (a.costs.lines = { fasi: { releases: [{ description: `r${NUL}`, unitCents: 1 }] } }), "costs.lines.fasi.releases[0].description"],
      ["a contact id", (a) => (a.client.contactIds = [`c${NUL}`]), "client.contactIds[0]"],
      ["an attachment id", (a) => (a.attachmentIds = [`a${NUL}`]), "attachmentIds[0]"],
    ];
    const logged: string[] = [];
    const spies = (["error", "warn", "log"] as const).map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))));
    try {
      const wrong: string[] = [];
      for (const [name, change, path] of cases) {
        const res = await save(s, change);
        if (res.status !== 422 || res.json.code !== "answers_invalid" || res.json.path !== path || JSON.stringify(res.json).includes(NUL)) {
          wrong.push(`${name}: ${res.status} ${res.json?.code ?? ""} ${res.json?.path ?? ""}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(logged.filter((line) => line.includes(NUL) || line.includes("[uncaught]"))).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const after = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    expect(after.version).toBe(before.version);
    expect(after.answers).toEqual(before.answers);
  });

  it("refuses U+0000 in a templateId and in the deal id of every draft route with 422, never a 500 (QE D7, L-3)", async () => {
    const NUL = "\u0000";
    const s = await setup();
    const fresh = await readyDealWithProfiles({ entity: "welld_ch" });
    const enc = encodeURIComponent(`x${NUL}`);
    const before = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    const own = { templateVersion: s.draft.templateVersion, target: { kind: "new" }, answers: s.draft.answers };
    const cases: [string, Promise<{ status: number; json: any }>][] = [
      ["create templateId", call("POST", `/deals/${fresh.deal.id}/offer-draft`, { body: { templateId: `x${NUL}` }, headers: { "If-None-Match": "*" } })],
      ["switch templateId", call("POST", `/deals/${s.dealId}/offer-draft/template`, { ifMatch: s.draft.version, body: { templateId: `x${NUL}` } })],
      ["create target.offerId", call("POST", `/deals/${fresh.deal.id}/offer-draft`, { body: { target: { kind: "edit", offerId: `o${NUL}` } }, headers: { "If-None-Match": "*" } })],
      ["GET context :id", call("GET", `/deals/${enc}/offer-wizard/context`)],
      ["GET draft :id", call("GET", `/deals/${enc}/offer-draft`)],
      ["GET summary :id", call("GET", `/deals/${enc}/offer-draft/summary`)],
      ["POST draft :id", call("POST", `/deals/${enc}/offer-draft`, { body: {}, headers: { "If-None-Match": "*" } })],
      ["PUT draft :id", call("PUT", `/deals/${enc}/offer-draft`, { ifMatch: 1, body: own })],
      ["DELETE draft :id", call("DELETE", `/deals/${enc}/offer-draft`, { ifMatch: 1 })],
      ["POST template :id", call("POST", `/deals/${enc}/offer-draft/template`, { ifMatch: 1, body: { templateId: s.templateId } })],
      ["POST generate :id", call("POST", `/deals/${enc}/offer-draft/generate`, { ifMatch: 1 })],
    ];
    const wrong: string[] = [];
    for (const [name, pending] of cases) {
      const res = await pending;
      if (res.status !== 422 || JSON.stringify(res.json).includes(NUL)) wrong.push(`${name}: ${res.status} ${res.json?.code ?? ""}`);
    }
    expect(wrong).toEqual([]);
    expect(await db.offerDraft.count({ where: { dealId: fresh.deal.id } })).toBe(0);
    const after = await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } });
    expect([after.version, after.templateId]).toEqual([before.version, before.templateId]);
  });

  it("is 404 draft_not_found without a draft and 403 out_of_scope outside the caller's entity, whether a draft exists or not", async () => {
    const empty = await readyDealWithProfiles({ entity: "welld_it" });
    const s = await setup(OPTIONS_SOURCE, "welld_it");
    const put = (dealId: string, as: "admin" | "salesCh") =>
      call("PUT", `/deals/${dealId}/offer-draft`, { as, ifMatch: 1, body: { templateVersion: 1, target: { kind: "new" }, answers: s.draft.answers } });
    const without = await put(empty.deal.id, "salesCh");
    const withDraft = await put(s.dealId, "salesCh");
    expect(without.status).toBe(403);
    expect(withDraft.status).toBe(403);
    expect(withDraft.json.code).toBe("out_of_scope");
    expect({ ...without.json, instance: undefined }).toEqual({ ...withDraft.json, instance: undefined });
    const none = await put(empty.deal.id, "admin");
    expect(none.status).toBe(404);
    expect(none.json.code).toBe("draft_not_found");
  });
});

describe("DELETE /deals/{id}/offer-draft", () => {
  it("discards with the draft's version: 204; stale 409 and the draft stays; no header 428; none 404", async () => {
    const s = await setup();
    expect((await call("DELETE", `/deals/${s.dealId}/offer-draft`)).status).toBe(428);
    await save(s, (a) => (a.fields.EPICI = "new"));
    const stale = await call("DELETE", `/deals/${s.dealId}/offer-draft`, { ifMatch: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("version_conflict");
    expect(await db.offerDraft.count()).toBe(1);
    expect((await call("DELETE", `/deals/${s.dealId}/offer-draft`, { ifMatch: 2 })).status).toBe(204);
    expect(await db.offerDraft.count()).toBe(0);
    const again = await call("DELETE", `/deals/${s.dealId}/offer-draft`, { ifMatch: 2 });
    expect(again.status).toBe(404);
    expect(again.json.code).toBe("draft_not_found");
  });

  it("is refused to a caller outside the scope, and leaves the draft", async () => {
    const s = await setup(OPTIONS_SOURCE, "welld_it");
    const res = await call("DELETE", `/deals/${s.dealId}/offer-draft`, { as: "salesCh", ifMatch: 1 });
    expect(res.status).toBe(403);
    expect(await db.offerDraft.count()).toBe(1);
  });
});

describe("POST /deals/{id}/offer-draft/template (switchTemplate, AC-6.5)", () => {
  it("keeps the client lines, contacts, place and date and starts everything else again", async () => {
    const s = await setup();
    const contact = await call("POST", "/contacts", { body: { companyId: (await db.deal.findUniqueOrThrow({ where: { id: s.dealId } })).companyId, firstName: "Ada", lastName: "Lovelace" } });
    await save(s, (a) => {
      a.client.lines = ["Mia riga", "Seconda"];
      a.client.contactIds = [contact.json.id];
      a.client.place = "Zurigo";
      a.client.date = new Date().toISOString().slice(0, 10);
      a.fields.EPICI = "mie epiche";
      a.fields.TIPO = "Uno";
    });
    const other = await makeDraftTemplate({ source: DRAFT_SOURCE });
    const res = await call("POST", `/deals/${s.dealId}/offer-draft/template`, { ifMatch: 2, body: { templateId: other.id } });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"3"');
    expect(res.json).toMatchObject({ template: { id: other.id }, templateVersion: 1, version: 3, target: { kind: "new" } });
    expect(res.json.answers.client).toEqual({ lines: ["Mia riga", "Seconda"], contactIds: [contact.json.id], place: "Zurigo", date: new Date().toISOString().slice(0, 10) });
    expect(res.json.answers.fields.EPICI).not.toBe("mie epiche");
    expect(res.json.answers.fields.TIPO).toBeUndefined();
    expect((await call("GET", `/deals/${s.dealId}/offer-draft`)).json.template.id).toBe(other.id);
  });

  it("is 428 / 409 as a write, 409 for an archived or non-wizard template, 404 for another entity's, a no-op for the same one", async () => {
    const s = await setup();
    const other = await makeDraftTemplate({ source: DRAFT_SOURCE });
    const to = (templateId: string, ifMatch: number | null = 1) =>
      call("POST", `/deals/${s.dealId}/offer-draft/template`, { ...(ifMatch === null ? {} : { ifMatch }), body: { templateId } });
    expect((await to(other.id, null)).status).toBe(428);
    expect((await to(other.id, 7)).status).toBe(409);
    expect((await to((await makeDraftTemplate({ entity: "welld_it" })).id)).status).toBe(404);
    const legacy = await db.offerTemplate.create({
      data: {
        entity: "welld_ch",
        name: "Legacy",
        language: "en",
        format: "sections",
        salutation: "Dear",
        opening: "Opening",
        sections: [{ heading: "Costs", body: "b", costs: true }],
        costLines: [],
        costColumns: { position: true, unit: false },
        createdBy: "user-admin",
        updatedBy: "user-admin",
      },
    });
    expect((await to(legacy.id)).json.code).toBe("template_format_mismatch");
    const spare = await makeDraftTemplate({ source: DRAFT_SOURCE });
    await call("POST", `/offer-templates/${spare.id}/archive`, { ifMatch: spare.version });
    expect((await to(spare.id)).json).toMatchObject({ code: "template_archived", templateId: spare.id });
    const same = await to(s.templateId);
    expect(same.status).toBe(200);
    expect(same.json.version).toBe(1);
    expect(await db.offerDraft.findUniqueOrThrow({ where: { dealId: s.dealId } })).toMatchObject({ templateId: s.templateId, version: 1 });
  });
});

describe("the read path re-validates the stored answers (ADR 20261115-offer-draft-server-held-generated-from-stored-state § 4)", () => {
  it("a row that no longer fits the shape is 409 draft_invalid, and can still be seen in the summary and discarded", async () => {
    const s = await setup();
    await db.offerDraft.update({ where: { dealId: s.dealId }, data: { answers: { v: 1, surprise: true } } });
    const got = await call("GET", `/deals/${s.dealId}/offer-draft`);
    expect(got.status).toBe(409);
    expect(got.json.code).toBe("draft_invalid");
    expect((await call("GET", `/deals/${s.dealId}/offer-draft/summary`)).json.draft.version).toBe(1);
    expect((await call("DELETE", `/deals/${s.dealId}/offer-draft`, { ifMatch: 1 })).status).toBe(204);
  });
});

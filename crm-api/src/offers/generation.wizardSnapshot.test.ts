/**
 * The snapshot of a wizard offer (specs/20261115-crm-offer-wizard T31; AC-3.2, AC-4.6, AC-6.6, DD-16, DD-20): the 018
 * `ContractSnapshot` with `wizard`, `textAnnexes`, `costs.rows`/`labels` and `handEdited`, built from `resolveOffer`.
 */

import { describe, expect, it } from "bun:test";
import { WELLD_CH_IT_V1 } from "../offer-templates/wizardSeeds/welldChIt";
import "../test-support/world";
import { renderContractPdf } from "./contractPdf";
import { sampleAnswers, sampleContext, setBlock, type WizardAnswers } from "./engine/answers";
import { computeCosts } from "./engine/costs";
import { resolveOffer } from "./engine/resolve";
import { parseTemplate } from "./engine/syntax";
import { wizardSnapshotOf } from "./generation";

const seed = (code: string) => WELLD_CH_IT_V1.find((entry) => entry.code === code)!;
const REFERENCE = "0017/2026";
const PROFILE = { legalName: "wellD Sagl", addressLines: ["Via Pessina 9", "6900 Lugano"], vatNumber: "CHE-1", iban: "CH00", legalEntityVersion: 7 };

function build(code: string, change: (ast: ReturnType<typeof parseTemplate>["ast"], answers: WizardAnswers) => WizardAnswers = (_, a) => a) {
  const { ast } = parseTemplate(seed(code).source);
  const context = sampleContext("it");
  const answers = change(ast, sampleAnswers(ast, "it"));
  const resolved = resolveOffer(ast, answers, context, { reference: REFERENCE });
  const snapshot = wizardSnapshotOf({
    template: { id: "tpl-1", name: seed(code).name },
    templateVersion: 3,
    answers,
    resolved,
    reference: REFERENCE,
    currency: "CHF",
    profile: PROFILE,
    annex: null,
    attachments: [],
    preparedBy: "Ada",
  });
  return { ast, answers, resolved, snapshot };
}

/** Progetto a corpo with its optional lines, the option line and the annex all on. */
const everything = (ast: ReturnType<typeof parseTemplate>["ast"], answers: WizardAnswers) => {
  let next = answers;
  for (const name of ["voce2", "sconto", "voce_scelta", "allegato_a"]) next = setBlock(ast, next, name, true);
  return next;
};

describe("wizardSnapshotOf", () => {
  it("holds the answers and the template version, never the template source (AC-6.6, DD-20)", () => {
    const { answers, snapshot } = build("T1", everything);
    expect(snapshot.kind).toBe("contract");
    expect(snapshot.wizard).toEqual({ templateVersion: 3, answers });
    expect(snapshot.template).toEqual({ id: "tpl-1", name: "Progetto a corpo" });
    const bytes = JSON.stringify(snapshot);
    expect(bytes).not.toContain("@@");
    expect(bytes).not.toContain(seed("T1").source.slice(0, 200));
  });

  it("holds the resolved sections and text annexes in order, with the assigned reference", () => {
    const { resolved, snapshot } = build("T1", everything);
    expect(resolved.annexes.length).toBeGreaterThan(0);
    expect(snapshot.sections.map((s) => [s.heading, s.body, s.costs])).toEqual(resolved.sections.map((s) => [s.heading, s.body, s.costs]));
    expect(snapshot.textAnnexes!.map((a) => a.designation)).toEqual(resolved.annexes.map((a) => a.designation));
    expect(snapshot.textAnnexes![0]).toEqual({
      designation: resolved.annexes[0]!.designation,
      title: resolved.annexes[0]!.title,
      subtitle: resolved.annexes[0]!.subtitle,
      intro: resolved.annexes[0]!.intro,
      sections: resolved.annexes[0]!.sections.map(({ heading, body }) => ({ heading, body })),
    });
    expect(JSON.stringify(snapshot.textAnnexes)).toContain(REFERENCE);
    expect(snapshot.opening).toBe(resolved.opening);
    expect(snapshot.salutation).toBe(resolved.salutation);
    expect(snapshot.clientLines).toEqual(resolved.client.lines);
    expect(snapshot.contacts).toEqual(resolved.client.contacts);
    expect(snapshot.contactIds).toEqual(["sample-contact"]);
    expect(snapshot.language).toBe("it");
    expect(snapshot.reference).toBe(REFERENCE);
    // The print keeps the shape every snapshot has had; the registry's version goes beside it (T27, AC-6.2, AC-6.4).
    expect(snapshot.issuer).toEqual({ legalName: "wellD Sagl", addressLines: ["Via Pessina 9", "6900 Lugano"], vatNumber: "CHE-1", iban: "CH00" });
    expect(snapshot.legalEntityVersion).toBe(7);
    expect(snapshot.preparedBy).toBe("Ada");
    expect(snapshot.place).toBe(resolved.client.place);
  });

  it("stores the printed rows and column labels, and the price the lines give whatever the total rows' places (AC-4.6)", () => {
    const { resolved, snapshot } = build("T1", everything);
    expect(snapshot.costs.rows).toEqual(resolved.costs.rows);
    expect(snapshot.costs.labels).toEqual(resolved.costs.labels);
    expect(snapshot.costs.showTotal).toBe(resolved.costs.showTotals);
    expect(snapshot.costs.columns).toEqual(resolved.costs.columns);
    expect(snapshot.costs.currency).toBe("CHF");
    const lines = resolved.costs.rows.filter((row) => row.type === "line");
    const withoutTotals = computeCosts(lines);
    expect(withoutTotals.oneOffCents).not.toBeNull();
    expect(snapshot.costs.oneOffCents).toBe(withoutTotals.oneOffCents!);
    expect(snapshot.costs.oneOffCents).toBe(computeCosts(resolved.costs.rows).oneOffCents!);
    expect(snapshot.costs.yearlyCents).toBe(withoutTotals.yearlyCents!);
  });

  it("keeps an option line as kind `option`, priced and counted in no total", () => {
    const { snapshot } = build("T1", everything);
    const option = snapshot.costs.lines.filter((line) => line.kind === "option");
    expect(option).toHaveLength(1);
    expect(option[0]!.totalCents).toBeGreaterThan(0);
    const counted = snapshot.costs.lines.filter((line) => line.kind === "one_off").reduce((sum, line) => sum + line.totalCents, 0);
    const discounts = snapshot.costs.lines.filter((line) => line.kind === "discount").reduce((sum, line) => sum + line.totalCents, 0);
    expect(snapshot.costs.oneOffCents).toBe(counted - discounts);
  });

  it("dates the offer on the printed date, the person's or the day (DD-16), and counts its validity from it", () => {
    const today = build("T1");
    expect(today.snapshot.issuedOn).toBe("2026-01-15");
    expect(today.snapshot.validityDays).toBe(30);
    expect(today.snapshot.validUntil).toBe("2026-02-14");
    const chosen = build("T1", (_, answers) => ({ ...answers, client: { ...answers.client, date: "2026-01-20" }, validityDays: 10 }));
    expect(chosen.snapshot.issuedOn).toBe("2026-01-20");
    expect(chosen.snapshot.validUntil).toBe("2026-01-30");
  });

  it("flags a hand-edited section, and only that one", () => {
    const { ast } = parseTemplate(seed("T1").source);
    const key = ast.sections.find((section) => section.costs === null)!.key;
    const { resolved, snapshot } = build("T1", (_, answers) => ({
      ...answers,
      handEdits: { [key]: { heading: "A mano", body: "Testo a mano.", sourceHeading: "x" } },
    }));
    const flagged = snapshot.sections.filter((section) => section.handEdited);
    expect(flagged.map((section) => section.heading)).toEqual(["A mano"]);
    expect(resolved.sections.filter((section) => section.handEdited)).toHaveLength(1);
  });

  it("the effort annex and the attachments come in as the server read them", () => {
    const { ast } = parseTemplate(seed("T1").source);
    const answers = sampleAnswers(ast, "it");
    const resolved = resolveOffer(ast, answers, sampleContext("it"), { reference: REFERENCE });
    const annex = { aiAssisted: false, releases: [], manDaysTenths: 0 };
    const attachments = [{ id: "a1", fileName: "x.pdf", sizeBytes: 3 }];
    const snapshot = wizardSnapshotOf({
      template: { id: "t", name: "T" }, templateVersion: 1, answers, resolved, reference: REFERENCE, currency: "CHF" as const, profile: PROFILE, annex, attachments, preparedBy: null,
    });
    expect(snapshot.annex).toEqual(annex);
    expect(snapshot.attachments).toEqual(attachments);
    expect(snapshot.aiAssisted).toBe(resolved.aiAssisted);
    expect(snapshot.preparedBy).toBeNull();
  });

  it("renders to a PDF without error, for a table with total rows, an option line and a text annex", async () => {
    for (const code of ["T1", "T3"]) {
      const { snapshot } = build(code, code === "T1" ? everything : (_, a) => a);
      const bytes = await renderContractPdf(snapshot, { letterhead: null, attachments: [] });
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    }
  });

  it("has no legalEntityVersion when the caller has no registry behind it (a sample render), and never puts it in `issuer`", () => {
    const { ast } = parseTemplate(seed("T1").source);
    const answers = sampleAnswers(ast, "it");
    const resolved = resolveOffer(ast, answers, sampleContext("it"), { reference: REFERENCE });
    const { legalEntityVersion: _version, ...bare } = PROFILE;
    const input = { template: { id: "t", name: "T" }, templateVersion: 1, answers, resolved, reference: REFERENCE, currency: "CHF" as const, annex: null, attachments: [], preparedBy: null };
    const without = wizardSnapshotOf({ ...input, profile: bare });
    expect("legalEntityVersion" in without).toBe(false);
    expect(JSON.stringify(without)).not.toContain("legalEntityVersion");
    const withVersion = wizardSnapshotOf({ ...input, profile: PROFILE });
    expect(Object.keys(withVersion.issuer).sort()).toEqual(["addressLines", "iban", "legalName", "vatNumber"]);
  });

  it("refuses a resolved offer that is not complete: no printed date, or a cost with no amount", () => {
    const { ast } = parseTemplate(seed("T1").source);
    const answers = sampleAnswers(ast, "it");
    const resolved = resolveOffer(ast, answers, sampleContext("it"), { reference: REFERENCE });
    const input = { template: { id: "t", name: "T" }, templateVersion: 1, answers, reference: REFERENCE, currency: "CHF" as const, profile: PROFILE, annex: null, attachments: [], preparedBy: null };
    expect(() => wizardSnapshotOf({ ...input, resolved: { ...resolved, client: { ...resolved.client, date: null } } })).toThrow();
    expect(() => wizardSnapshotOf({ ...input, resolved: { ...resolved, costs: { ...resolved.costs, result: { ...resolved.costs.result, oneOffCents: null } } } })).toThrow();
  });
});

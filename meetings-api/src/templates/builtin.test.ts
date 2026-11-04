import { describe, expect, it } from "bun:test";
import { BUILTIN_TEMPLATES, TEMPLATE_LIMITS, builtinIds, builtinSnapshot, builtinView, parseAcceptLanguage } from "./builtin";
import { buildRegistry } from "../hosts/registry";

// AC-8.1 (four built-ins, en + it, read-only), AC-8.6 (built-in headings in the output language).

describe("the four built-in templates (AC-8.1)", () => {
  it("are, in order, minutes, sales discovery, 1:1 and action items, with stable ids", () => {
    expect(builtinIds()).toEqual(["builtin:minutes", "builtin:sales-discovery", "builtin:one-on-one", "builtin:action-items"]);
  });

  it("have the names the spec gives, in both languages", () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name.en)).toEqual(["Meeting minutes", "Sales discovery call", "1:1", "Action items"]);
    expect(BUILTIN_TEMPLATES.map((t) => t.name.it)).toEqual([
      "Verbale della riunione",
      "Chiamata di discovery commerciale",
      "1:1",
      "Azioni da intraprendere",
    ]);
  });

  it("have parity: the same number of sections and the same shape in English and Italian", () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(template.sections.it.length, template.id).toBe(template.sections.en.length);
      expect(template.generalInstructions.it === null, template.id).toBe(template.generalInstructions.en === null);
      for (const language of ["en", "it"] as const) {
        template.sections[language].forEach((section) => {
          expect(section.heading.trim().length).toBeGreaterThan(0);
          expect(section.instruction.trim().length).toBeGreaterThan(0);
        });
      }
    }
  });

  it("obey the same limits a user's template does (so a duplicate of one is always valid)", () => {
    for (const template of BUILTIN_TEMPLATES) {
      for (const language of ["en", "it"] as const) {
        expect(template.name[language].length).toBeLessThanOrEqual(TEMPLATE_LIMITS.name);
        const sections = template.sections[language];
        expect(sections.length).toBeGreaterThanOrEqual(1);
        expect(sections.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.sections);
        for (const section of sections) {
          expect(section.heading.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.heading);
          expect(section.instruction.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.instruction);
        }
        expect((template.generalInstructions[language] ?? "").length).toBeLessThanOrEqual(TEMPLATE_LIMITS.generalInstructions);
      }
    }
  });

  it("have unique headings inside each template, so a reader can tell sections apart", () => {
    for (const template of BUILTIN_TEMPLATES) {
      for (const language of ["en", "it"] as const) {
        const headings = template.sections[language].map((s) => s.heading.toLowerCase());
        expect(new Set(headings).size, `${template.id} ${language}`).toBe(headings.length);
      }
    }
  });

  it("are really translated: every instruction differs, and so do the headings (bar loanwords like 'Feedback')", () => {
    const loanwords = new Set(["Feedback"]);
    for (const template of BUILTIN_TEMPLATES) {
      template.sections.en.forEach((s, i) => {
        const it = template.sections.it[i]!;
        expect(it.instruction, `${template.id} #${i}`).not.toBe(s.instruction);
        if (!loanwords.has(s.heading)) expect(it.heading, `${template.id} #${i}`).not.toBe(s.heading);
      });
    }
  });

  it("are the templates the host registry recommends: every recommended id exists", () => {
    const registry = buildRegistry({ production: true, crmApiUrl: "http://crm.test" });
    for (const host of registry.all()) {
      for (const id of host.recommendedTemplates) expect(builtinIds(), `${host.app}/${host.entityType}`).toContain(id);
    }
  });
});

describe("views in a language (AC-8.6)", () => {
  it("renders the name, headings and instructions in the asked language", () => {
    const en = builtinView("builtin:sales-discovery", "en")!;
    const it = builtinView("builtin:sales-discovery", "it")!;
    expect(en.name).toBe("Sales discovery call");
    expect(it.name).toBe("Chiamata di discovery commerciale");
    expect(en.sections[0]!.heading).not.toBe(it.sections[0]!.heading);
  });

  it("is undefined for an id that is not a built-in, however it is spelt", () => {
    for (const id of ["builtin:nope", "minutes", "BUILTIN:MINUTES", "", "builtin:", "builtin:minutes "]) {
      expect(builtinView(id, "en"), id).toBeUndefined();
    }
  });

  it("makes the snapshot a summary keeps (AC-7.5): the language's headings, source builtin", () => {
    const snapshot = builtinSnapshot("builtin:action-items", "it")!;
    expect(snapshot).toMatchObject({ source: "builtin", templateId: "builtin:action-items", name: "Azioni da intraprendere" });
    expect(snapshot.sections).toEqual(builtinView("builtin:action-items", "it")!.sections);
  });

  it("returns copies: nobody can edit a built-in by mutating a view", () => {
    const view = builtinView("builtin:minutes", "en")!;
    view.sections[0]!.heading = "HACKED";
    view.sections.pop();
    expect(builtinView("builtin:minutes", "en")!.sections[0]!.heading).not.toBe("HACKED");
    expect(builtinView("builtin:minutes", "en")!.sections.length).toBe(BUILTIN_TEMPLATES[0]!.sections.en.length);
  });
});

describe("Accept-Language", () => {
  it("picks Italian or English by preference and defaults to English", () => {
    expect(parseAcceptLanguage("it")).toBe("it");
    expect(parseAcceptLanguage("it-IT,it;q=0.9,en;q=0.8")).toBe("it");
    expect(parseAcceptLanguage("en-GB,en;q=0.9,it;q=0.8")).toBe("en");
    expect(parseAcceptLanguage("fr-CH, it;q=0.7, en;q=0.5")).toBe("it");
    expect(parseAcceptLanguage("en;q=0.4, it;q=0.9")).toBe("it");
    expect(parseAcceptLanguage("de, fr")).toBe("en");
    expect(parseAcceptLanguage(undefined)).toBe("en");
    expect(parseAcceptLanguage("")).toBe("en");
    expect(parseAcceptLanguage("*;q=0.5")).toBe("en");
    expect(parseAcceptLanguage("it;q=0, en")).toBe("en"); // q=0 means "not acceptable"
  });
});

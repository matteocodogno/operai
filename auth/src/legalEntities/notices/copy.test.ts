/**
 * The in-app notice's copy (T59; design.md N1; AC-9.11, AC-9.12, AC-9.13): en/it parity, the slots, and that no key
 * can take a value that is not a closed one.
 */

import { describe, expect, test } from "bun:test";
import { fill, joinList, NOTICE_COPY, NOTICE_COPY_KEYS, NOTICE_LANGUAGES, slotsOf } from "./copy";

describe("parity of the two languages (AC-9.13)", () => {
  test("both languages define exactly the same keys, none empty", () => {
    for (const language of NOTICE_LANGUAGES) {
      expect(Object.keys(NOTICE_COPY[language]).sort()).toEqual([...NOTICE_COPY_KEYS].sort());
      for (const key of NOTICE_COPY_KEYS) expect(NOTICE_COPY[language][key].trim()).not.toBe("");
    }
  });

  test("every key has the same slots in English and Italian", () => {
    for (const key of NOTICE_COPY_KEYS) {
      expect([key, slotsOf(NOTICE_COPY.it[key]).sort()]).toEqual([key, slotsOf(NOTICE_COPY.en[key]).sort()]);
    }
  });

  test("the sentences of the body end in a full stop in both languages (the centre may show breaks as spaces)", () => {
    const lines = ["notice.lead", "notice.byAction.save", "notice.byAction.restore", "notice.when", "notice.version", "notice.changed", "notice.ibanOld", "notice.ibanNew", "notice.alsoChanged", "notice.access", "notice.unexpected"] as const;
    for (const language of NOTICE_LANGUAGES) for (const key of lines) expect([key, NOTICE_COPY[language][key].endsWith(".")]).toEqual([key, true]);
  });

  test("the Italian copy is Italian, not the English one repeated (apart from the words that are the same in both)", () => {
    const same = new Set(["notice.entity.welld_it", "notice.entity.welld_ch", "notice.name.iban", "notice.dateTime"]);
    for (const key of NOTICE_COPY_KEYS) if (!same.has(key)) expect([key, NOTICE_COPY.it[key] === NOTICE_COPY.en[key]]).toEqual([key, false]);
  });
});

describe("the slots are closed (AC-9.12)", () => {
  test("the only slots are the closed ones: no key takes a legal name, a VAT number, an address, a contacts line or an IBAN", () => {
    const allowed = new Set(["entity", "details", "actor", "from", "date", "n", "list", "token", "day", "month", "year", "time", "zone"]);
    for (const language of NOTICE_LANGUAGES) {
      for (const key of NOTICE_COPY_KEYS) for (const slot of slotsOf(NOTICE_COPY[language][key])) expect([key, allowed.has(slot)]).toEqual([key, true]);
    }
  });

  test("fill refuses a slot the template lacks and a slot left empty (no hole, no value that silently goes nowhere)", () => {
    expect(() => fill("en", "notice.version", { n: 3, legalName: "Secret SA" })).toThrow("no slot legalName");
    expect(() => fill("en", "notice.version", {})).toThrow("needs a value for n");
    expect(fill("it", "notice.version", { n: 3 })).toBe("Nuova versione: 3.");
  });

  test("a value is inserted as it is: `$` patterns and `{slot}` look-alikes in it are not interpreted", () => {
    expect(fill("en", "notice.byAction.save", { actor: "A $& {from} $1 Rossi" })).toBe("Change saved by A $& {from} $1 Rossi.");
  });
});

describe("lists (design N1)", () => {
  test("a, b and c in English; a, b e c in Italian; one and two items", () => {
    expect(joinList("en", [])).toBe("");
    expect(joinList("en", ["IBAN"])).toBe("IBAN");
    expect(joinList("en", ["legal name", "IBAN"])).toBe("legal name and IBAN");
    expect(joinList("en", ["legal name", "VAT number", "IBAN"])).toBe("legal name, VAT number and IBAN");
    expect(joinList("it", ["ragione sociale", "IBAN"])).toBe("ragione sociale e IBAN");
    expect(joinList("it", ["ragione sociale", "partita IVA", "IBAN"])).toBe("ragione sociale, partita IVA e IBAN");
  });
});

describe("the texts of design N1", () => {
  test("the English and Italian sentences are the designed ones", () => {
    expect(fill("en", "notice.title", { entity: "WellD CH", details: "IBAN" })).toBe("Legal details of WellD CH changed: IBAN");
    expect(fill("it", "notice.title", { entity: "WellD CH", details: "IBAN" })).toBe("Dati legali di WellD CH modificati: IBAN");
    expect(fill("en", "notice.byAction.restore", { from: 5, actor: "Anna Rossi" })).toBe("Version 5 restored by Anna Rossi.");
    expect(fill("it", "notice.byAction.restore", { from: 5, actor: "Anna Rossi" })).toBe("Versione 5 ripristinata da Anna Rossi.");
    expect(fill("en", "notice.ibanNew", { token: "none" })).toBe("New IBAN: none.");
    expect(fill("it", "notice.ibanOld", { token: "nessuno" })).toBe("IBAN precedente: nessuno.");
    expect(fill("en", "notice.open")).toBe("Open the history");
    expect(fill("it", "notice.open")).toBe("Apri la cronologia");
  });
});

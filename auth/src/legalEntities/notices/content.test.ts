/**
 * What the change notice says (T59; AC-9.11, AC-9.12, AC-9.13; design.md N1): pure tests of `content.ts`, no database.
 */

import { describe, expect, test } from "bun:test";
import type { HistoryRow } from "../repo";
import type { Field } from "../rules";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  emailData,
  formatStoredAt,
  historyHref,
  inAppNotice,
  isUnusableAuthorEmail,
  type NoticeFacts,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  NoticeContentError,
  noticeAuthorEmail,
  noticeFacts as noticeFactsOf,
  noticeText,
  usableAuthorEmail,
} from "./content";

const EMAIL = "anna.rossi@welld.ch";
/** The display name on every fixture version: it must appear in no notice, no data, nowhere (D9, AC-9.12). */
const DISPLAY_NAME = "D9 Sentinel Display Name";
const noticeFacts = (current: HistoryRow, prev: HistoryRow | null, authorEmail: string | null = EMAIL) => noticeFactsOf(current, prev, authorEmail);

const SENTINEL = {
  legalName: "SentinelLegalNameQx7 SA",
  vat: "CHE-SENTINEL-VAT-0042",
  ibanOld: "CH93SENTINELOLDIBAN7766",
  ibanNew: "CH56SENTINELNEWIBAN5599",
  address: "Sentinel Address Lane 12",
  contacts: "sentinel.contact@example.invalid",
};

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    entity: "welld_ch",
    version: 8,
    legalName: SENTINEL.legalName,
    addressIt: [SENTINEL.address],
    addressEn: [SENTINEL.address],
    vatNumber: SENTINEL.vat,
    iban: SENTINEL.ibanNew,
    contactsIt: SENTINEL.contacts,
    contactsEn: SENTINEL.contacts,
    createdAt: new Date("2026-11-17T09:12:00.000Z"),
    action: "save",
    restoredFrom: null,
    changedFields: ["iban"] as Field[],
    createdByUserId: "u1",
    createdByName: DISPLAY_NAME,
    ...over,
  };
}
const previous = (over: Partial<HistoryRow> = {}) => row({ version: 7, iban: SENTINEL.ibanOld, changedFields: [], ...over });

describe("the worked example of design N1 (AC-9.11)", () => {
  test("English: title and body, in the designed order and words", () => {
    const facts = noticeFacts(row({ iban: "", changedFields: ["iban", "contacts.en"] as Field[] }), previous({ iban: "CH9300762011623852957" }));
    const text = noticeText(facts, "en");
    expect(text.title).toBe("Legal details of WellD CH changed: IBAN");
    expect(text.body).toBe(
      [
        "The legal details of WellD CH were changed.",
        "Change saved by the account anna.rossi@welld.ch.",
        "When: 17 November 2026, 10:12 CET (Europe/Zurich).",
        "New version: 8.",
        "Details changed: IBAN.",
        "Old IBAN: …2957.",
        "New IBAN: none.",
        "Also changed: contacts line (English).",
        "Only people who may see this history can open the link.",
        "If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator.",
      ].join("\n"),
    );
  });

  test("a restore names the version it copied, in the same place, in Italian, on a summer date", () => {
    const facts = noticeFacts(
      row({ action: "restore", restoredFrom: 5, createdAt: new Date("2026-07-01T09:12:00Z"), changedFields: ["legalName", "iban"] as Field[] }),
      previous({ iban: "" }),
    );
    const it = noticeText(facts, "it");
    expect(it.title).toBe("Dati legali di WellD CH modificati: ragione sociale e IBAN");
    const lines = it.body.split("\n");
    expect(lines[1]).toBe("Versione 5 ripristinata dall'account anna.rossi@welld.ch.");
    expect(lines[2]).toBe("Quando: 1 luglio 2026, 11:12 CEST (Europe/Zurich).");
    expect(lines[4]).toBe("Dati modificati: ragione sociale e IBAN.");
    expect(lines[5]).toBe("IBAN precedente: nessuno.");
    expect(lines[6]).toBe("Nuovo IBAN: …5599.");
  });

  test("the lines of a save without an IBAN change or other changes leave out the IBAN and 'also changed' lines", () => {
    const facts = noticeFacts(row({ changedFields: ["vatNumber"] as Field[] }), previous());
    const lines = noticeText(facts, "en").body.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.some((l) => l.includes("IBAN"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Also changed"))).toBe(false);
    expect(noticeText(facts, "en").title).toBe("Legal details of WellD CH changed: VAT number");
  });

  test("English and Italian say the same things: the same number of lines in both", () => {
    for (const changed of [["legalName"], ["iban", "address.it"], ["legalName", "vatNumber", "iban", "address.it", "address.en", "contacts.it", "contacts.en"]] as Field[][]) {
      const facts = noticeFacts(row({ changedFields: changed }), previous());
      expect(noticeText(facts, "it").body.split("\n")).toHaveLength(noticeText(facts, "en").body.split("\n").length);
    }
  });
});

describe("the IBAN token (AC-9.11, T54's rule)", () => {
  const tokenOf = (oldIban: string, newIban: string) => {
    const facts = noticeFacts(row({ iban: newIban }), previous({ iban: oldIban }));
    const lines = noticeText(facts, "en").body.split("\n");
    return { old: lines.find((l) => l.startsWith("Old IBAN"))!, new: lines.find((l) => l.startsWith("New IBAN"))! };
  };

  test("empty is none; 8 characters or fewer is set, with no character shown; 9 or more shows the last 4", () => {
    expect(tokenOf("", "CH9300762011623852957").old).toBe("Old IBAN: none.");
    expect(tokenOf("ABCD1234", "").old).toBe("Old IBAN: set (not shown).");
    expect(tokenOf("ABCD1234", "").new).toBe("New IBAN: none.");
    expect(tokenOf("ABCD12345", "ABCDEFGH").old).toBe("Old IBAN: …2345.");
    expect(tokenOf("ABCD12345", "ABCDEFGH").new).toBe("New IBAN: set (not shown).");
  });

  test("the spacing and case a person typed do not change the token", () => {
    expect(tokenOf("ch93 0076 2011 6238 5295 7", "").old).toBe("Old IBAN: …2957.");
  });

  test("a tail that is not four of A-Z or 0-9 is never printed", () => {
    expect(tokenOf("CH9300762011623852‮éé", "").old).toBe("Old IBAN: set (not shown).");
  });

  test("the first version of an entity has no previous: its old IBAN is none", () => {
    const facts = noticeFacts(row({ version: 2 }), null);
    expect(facts.iban?.old).toEqual({ state: "none" });
  });
});

describe("the time (design N1, R-d, DR-15)", () => {
  test("winter is CET and summer is CEST, in both languages, 24-hour, no seconds", () => {
    expect(formatStoredAt(new Date("2026-11-17T09:12:45.678Z"), "en")).toBe("17 November 2026, 10:12 CET (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-07-01T09:12:00Z"), "en")).toBe("1 July 2026, 11:12 CEST (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-11-17T09:12:00Z"), "it")).toBe("17 novembre 2026, 10:12 CET (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-07-01T09:12:00Z"), "it")).toBe("1 luglio 2026, 11:12 CEST (Europe/Zurich)");
  });

  test("the changes of the clock: the minute before and the minute of the switch, both ways", () => {
    expect(formatStoredAt(new Date("2026-03-29T00:59:00Z"), "en")).toBe("29 March 2026, 01:59 CET (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-03-29T01:00:00Z"), "en")).toBe("29 March 2026, 03:00 CEST (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-10-25T00:59:00Z"), "en")).toBe("25 October 2026, 02:59 CEST (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-10-25T01:00:00Z"), "en")).toBe("25 October 2026, 02:00 CET (Europe/Zurich)");
  });

  test("midnight is 00:xx (never 24:xx) and the date is Zurich's, not UTC's", () => {
    expect(formatStoredAt(new Date("2026-12-31T23:30:00Z"), "en")).toBe("1 January 2027, 00:30 CET (Europe/Zurich)");
    expect(formatStoredAt(new Date("2026-06-30T22:05:00Z"), "it")).toBe("1 luglio 2026, 00:05 CEST (Europe/Zurich)");
  });

  test("an invalid date is a content error, not 'Invalid Date' in a notice", () => {
    expect(() => formatStoredAt(new Date("nope"), "en")).toThrow(NoticeContentError);
  });
});

describe("the author's account email, the one personal slot (AC-9.11, AC-9.12; plan D9 J4)", () => {
  const SAVE = { en: "Change saved by the account d9-sentinel-author@operai.test.", it: "Modifica salvata dall'account d9-sentinel-author@operai.test." };
  const ADDRESS = "d9-sentinel-author@operai.test";

  test("the save line and the restore line carry the address verbatim, in English and in Italian", () => {
    const save = noticeFacts(row(), previous(), ADDRESS);
    expect(noticeText(save, "en").body.split("\n")[1]).toBe(SAVE.en);
    expect(noticeText(save, "it").body.split("\n")[1]).toBe(SAVE.it);
    const restore = noticeFacts(row({ action: "restore", restoredFrom: 5 }), previous(), ADDRESS);
    expect(noticeText(restore, "en").body.split("\n")[1]).toBe("Version 5 restored by the account d9-sentinel-author@operai.test.");
    expect(noticeText(restore, "it").body.split("\n")[1]).toBe("Versione 5 ripristinata dall'account d9-sentinel-author@operai.test.");
  });

  test("the address is stated as stored: no lowercasing or rewriting", () => {
    const facts = noticeFacts(row(), previous(), "Anna.Rossi+Tag@WellD.ch");
    expect(noticeText(facts, "en").body).toContain("the account Anna.Rossi+Tag@WellD.ch.");
    expect(emailData(facts).actorEmail).toBe("Anna.Rossi+Tag@WellD.ch");
  });

  test("it appears once, in the body, never in a title; the email's data carries it as the one member", () => {
    const facts = noticeFacts(row(), previous(), ADDRESS);
    for (const language of ["en", "it"] as const) {
      const text = noticeText(facts, language);
      expect(text.title).not.toContain("sentinel-author");
      expect(text.body.match(/d9-sentinel-author@operai\.test/g)).toHaveLength(1);
    }
    const notice = inAppNotice(facts);
    expect(notice.title).not.toContain(ADDRESS);
    expect(notice.it.title).not.toContain(ADDRESS);
    expect(notice.link.href).not.toContain(ADDRESS);
    expect(emailData(facts).actorEmail).toBe(ADDRESS);
    // The address is the only place in the data it is found.
    expect(JSON.stringify({ ...emailData(facts), actorEmail: "" })).not.toContain("sentinel-author");
  });

  test("null gives the no-email sentence in both languages, with the rest of the list intact; the data says null", () => {
    for (const [action, restoredFrom] of [["save", null], ["restore", 5]] as const) {
      const withEmail = noticeFacts(row({ action, restoredFrom }), previous(), EMAIL);
      const without = noticeFacts(row({ action, restoredFrom }), previous(), null);
      for (const language of ["en", "it"] as const) {
        const a = noticeText(withEmail, language).body.split("\n");
        const b = noticeText(without, language).body.split("\n");
        expect(b).toHaveLength(a.length);
        expect(b.filter((_, i) => i !== 1)).toEqual(a.filter((_, i) => i !== 1));
        expect(noticeText(without, language).title).toBe(noticeText(withEmail, language).title);
      }
      expect(noticeText(without, "en").body.split("\n")[1]).toBe(
        action === "save" ? "Change saved by an account with no email address on record." : "Version 5 restored by an account with no email address on record.",
      );
      expect(noticeText(without, "it").body.split("\n")[1]).toBe(
        action === "save" ? "Modifica salvata da un account senza indirizzo email registrato." : "Versione 5 ripristinata da un account senza indirizzo email registrato.",
      );
      expect(emailData(without).actorEmail).toBeNull();
    }
  });

  test("an unusable address (R-D9a) reads as no address on record and is never stated or sent", () => {
    const unusable = [
      "not an email",
      "",
      " anna@welld.ch",
      "anna@welld.ch ",
      "anna@welld.ch\nBcc: x@y.z",
      "anna@welld.ch\u0000",
      "an\u202ena@welld.ch",
      "anna@@welld.ch",
      "anna",
      `${"a".repeat(312)}@welld.ch`,
      "Anna Rossi <anna@welld.ch>",
    ];
    const none = noticeFacts(row(), previous(), null);
    for (const value of unusable) {
      expect([value, isUnusableAuthorEmail(value) || value === ""]).toEqual([value, true]);
      expect(usableAuthorEmail(value)).toBeNull();
      const facts = noticeFacts(row(), previous(), value);
      expect(facts.authorEmail).toBeNull();
      expect(noticeText(facts, "en")).toEqual(noticeText(none, "en"));
      expect(noticeText(facts, "it")).toEqual(noticeText(none, "it"));
      expect(emailData(facts).actorEmail).toBeNull();
    }
  });

  test("the rule is the rule of notify-api's `to`: an address, at most 320 characters", () => {
    expect(noticeAuthorEmail.safeParse("anna.rossi@welld.ch").success).toBe(true);
    expect(isUnusableAuthorEmail(null)).toBe(false);
    expect(isUnusableAuthorEmail(undefined)).toBe(false);
    expect(usableAuthorEmail(undefined)).toBeNull();
    const longest = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}`;
    expect(longest).toHaveLength(320);
    expect(noticeAuthorEmail.safeParse(longest).success).toBe(true);
    expect(noticeAuthorEmail.safeParse(`${longest}e`).success).toBe(false);
  });

  test("no display name anywhere: the version's name is in no text, no data and no fact (AC-9.12)", () => {
    for (const email of [EMAIL, null, "garbage"]) {
      const facts = noticeFacts(row({ action: "restore", restoredFrom: 4 }), previous(), email);
      const everything = JSON.stringify([facts, inAppNotice(facts), emailData(facts), noticeText(facts, "en"), noticeText(facts, "it")]);
      expect(everything).not.toContain(DISPLAY_NAME);
      expect(everything).not.toContain("Sentinel Display");
    }
    // Even a version with no name at all, or a name that looks like an address, changes nothing: it is never read.
    const a = noticeFacts(row({ createdByName: null }), previous(), EMAIL);
    const b = noticeFacts(row({ createdByName: "someone.else@welld.ch" }), previous(), EMAIL);
    expect(noticeText(b, "en")).toEqual(noticeText(a, "en"));
    expect(JSON.stringify(emailData(b))).not.toContain("someone.else");
  });

  test("static: no source file of the notice code reads the display name (the version's name column)", () => {
    const sources = readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources).toEqual(expect.arrayContaining(["content.ts", "copy.ts", "dispatcher.ts", "duty.ts", "recipients.ts"]));
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dir, file), "utf8");
      expect([file, /createdByName|actorName|sanitizeActorName|unknownActor/.test(text)]).toEqual([file, false]);
    }
  });
});

describe("the limits of notify-api hold in the longest case (T51's done-when; design N1, plan J4)", () => {
  /** 320 characters, the most `noticeAuthorEmail` accepts. */
  const LONGEST = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}`;
  const longestFacts = () =>
    noticeFacts(
      row({
        action: "restore",
        restoredFrom: 2147483646,
        version: 2147483647,
        createdAt: new Date("2026-07-01T09:12:00Z"),
        changedFields: ["legalName", "address.it", "address.en", "vatNumber", "iban", "contacts.it", "contacts.en"] as Field[],
      }),
      previous({ version: 2147483646 }),
      LONGEST,
    );

  test("three protected and four other names, a 320-character address, a restore, the largest version, a summer date", () => {
    expect(LONGEST).toHaveLength(320);
    expect(noticeAuthorEmail.safeParse(LONGEST).success).toBe(true);
    const notice = inAppNotice(longestFacts());
    for (const text of [{ title: notice.title, body: notice.body }, notice.it]) {
      expect(text.title.length).toBeLessThanOrEqual(NOTICE_TITLE_MAX);
      expect(text.body.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
      // The address is in the body once and whole, never in the title.
      expect(text.body.split(LONGEST)).toHaveLength(2);
      expect(text.title).not.toContain("aaaa");
    }
    // The design's figures for the longest case (N1, recomputed for D9): well inside the limits.
    expect(notice.title.length).toBe(66);
    expect(notice.it.title.length).toBe(71);
    expect(notice.body.length).toBe(854);
    expect(notice.it.body.length).toBe(909);
  });

  test("the push JSON of notify-api ({v,id,title,body,originApp,href}) is far under 3000 bytes, so the address is never cut", () => {
    const notice = inAppNotice(longestFacts());
    const push = JSON.stringify({ v: 1, id: crypto.randomUUID(), title: notice.title, body: notice.body, originApp: "admin", href: notice.link.href });
    expect(new TextEncoder().encode(push).length).toBeLessThan(1300);
    expect(push).toContain(LONGEST);
  });

  test("the email's data carries the longest address whole", () => {
    expect(emailData(longestFacts()).actorEmail).toBe(LONGEST);
  });

  test("no address, and the longest list: still within the limits", () => {
    const facts = { ...longestFacts(), authorEmail: null };
    expect(() => inAppNotice(facts)).not.toThrow();
  });
});

describe("the in-app notice as notify-api takes it (G5)", () => {
  test("English is the base, Italian the `it` variant, and the link is relative to the entity's history", () => {
    const notice = inAppNotice(noticeFacts(row(), previous()));
    expect(Object.keys(notice).sort()).toEqual(["body", "it", "link", "title"]);
    expect(Object.keys(notice.it).sort()).toEqual(["body", "title"]);
    expect(notice.title.startsWith("Legal details of WellD CH changed")).toBe(true);
    expect(notice.it.title.startsWith("Dati legali di WellD CH modificati")).toBe(true);
    expect(notice.link).toEqual({ href: "/admin/legal-entities?entity=welld_ch&view=history", label: "Open the history" });
    expect(historyHref("welld_it")).toBe("/admin/legal-entities?entity=welld_it&view=history");
  });
});

describe("the email's data (G5; the shape of notify-api's strict legal_entity_change)", () => {
  test("a save: closed names, the time as an ISO instant, the IBAN tokens only, restoredFrom null", () => {
    const data = emailData(noticeFacts(row({ changedFields: ["iban", "address.en", "contacts.it"] as Field[] }), previous()));
    expect(data).toEqual({
      entity: "welld_ch",
      action: "save",
      restoredFrom: null,
      actorEmail: EMAIL,
      storedAt: "2026-11-17T09:12:00.000Z",
      version: 8,
      protectedChanged: ["iban"],
      otherChanged: ["address.en", "contacts.it"],
      iban: { old: { state: "tail", last4: "7766" }, new: { state: "tail", last4: "5599" } },
    });
  });

  test("a restore names its source; `iban` is present if and only if the IBAN changed", () => {
    const data = emailData(noticeFacts(row({ action: "restore", restoredFrom: 3, changedFields: ["legalName", "vatNumber"] as Field[] }), previous()));
    expect(data.action).toBe("restore");
    expect(data.restoredFrom).toBe(3);
    expect(data.protectedChanged).toEqual(["legalName", "vatNumber"]);
    expect("iban" in data).toBe(false);
  });
});

describe("no value leaves in any notice (AC-9.12)", () => {
  test("the sentinel legal name, VAT number, addresses, contacts and IBANs (whole, or all but their last 4) appear in no text and no data", () => {
    const facts = noticeFacts(
      row({ changedFields: ["legalName", "vatNumber", "iban", "address.it", "address.en", "contacts.it", "contacts.en"] as Field[] }),
      previous({ legalName: "Previous Sentinel Name", vatNumber: "CHE-PREVIOUS-VAT" }),
    );
    const everything = JSON.stringify([inAppNotice(facts), emailData(facts), noticeText(facts, "en"), noticeText(facts, "it")]);
    const forbidden = [
      SENTINEL.legalName,
      "SentinelLegalName",
      SENTINEL.vat,
      SENTINEL.address,
      SENTINEL.contacts,
      SENTINEL.ibanOld,
      SENTINEL.ibanNew,
      SENTINEL.ibanOld.slice(0, -4),
      SENTINEL.ibanNew.slice(0, -4),
      "Previous Sentinel",
      "CHE-PREVIOUS",
    ];
    for (const value of forbidden) expect([value, everything.includes(value)]).toEqual([value, false]);
    expect(everything).toContain("7766");
    expect(everything).toContain("5599");
  });
});

describe("what cannot be noticed", () => {
  test("an import, a version without a protected change and a restore without a source are content errors", () => {
    expect(() => noticeFacts(row({ action: "import", createdByUserId: null, createdByName: null }), null)).toThrow(NoticeContentError);
    expect(() => noticeFacts(row({ changedFields: ["address.it"] as Field[] }), previous())).toThrow("no protected change");
    expect(() => noticeFacts(row({ action: "restore", restoredFrom: null }), previous())).toThrow(NoticeContentError);
  });

  test("the facts carry no value: their keys are the closed ones", () => {
    const facts: NoticeFacts = noticeFacts(row(), previous());
    expect(Object.keys(facts).sort()).toEqual(["action", "authorEmail", "entity", "iban", "otherNames", "protectedNames", "restoredFrom", "storedAt", "version"]);
  });
});

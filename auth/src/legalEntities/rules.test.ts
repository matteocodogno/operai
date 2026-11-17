import { describe, expect, test } from "bun:test";
import {
  EMPTY_DETAILS,
  type LegalDetails,
  changedFields,
  complete,
  ibanChecksumOk,
  ibanPrint,
  invalid,
  missing,
  normalise,
  normaliseIban,
  PROTECTED_FIELDS,
  problems,
  protectedChanged,
  restorable,
  sameDetails,
} from "./rules";

const CH_IBAN = "CH9300762011623852957";
const IT_IBAN = "IT60X0542811101000000123456";
// Reference IBANs of the national registries' own examples.
const REFERENCE_IBANS = [
  "GB82WEST12345698765432",
  "DE89370400440532013000",
  "FR1420041010050500013M02606",
];

/** Valid IBAN of an exact length: pads the BBAN with digits and computes the check digits (ISO 7064). */
function ibanOfLength(length: number): string {
  const country = "XX";
  const bban = "1".repeat(length - 4);
  const digits = (s: string) => [...s].map((c) => (c >= "A" ? String(c.charCodeAt(0) - 55) : c)).join("");
  let r = 0;
  for (const d of digits(bban + country + "00")) r = (r * 10 + Number(d)) % 97;
  return `${country}${String(98 - r).padStart(2, "0")}${bban}`;
}

function details(over: Partial<LegalDetails> = {}): LegalDetails {
  return {
    legalName: "wellD SA",
    address: { it: ["Via Nassa 1", "6900 Lugano"], en: ["Via Nassa 1", "6900 Lugano"] },
    vatNumber: "CHE-123.456.789 IVA",
    iban: CH_IBAN,
    contacts: { it: "Tel. +41 91 000 00 00", en: "Phone +41 91 000 00 00" },
    ...over,
  };
}
const withName = (legalName: string) => details({ legalName });
const withVat = (vatNumber: string) => details({ vatNumber });
const withIban = (iban: string) => details({ iban });
const withContacts = (it: string, en = "") => details({ contacts: { it, en } });
const withAddressIt = (it: string[]) => details({ address: { it, en: ["x"] } });

const cp = (n: number) => "a".repeat(n);

describe("fixtures", () => {
  test("a complete set of details has no problem", () => {
    expect(problems(details())).toEqual([]);
    expect(complete(details())).toBe(true);
    expect(missing(details())).toEqual([]);
    expect(restorable(details())).toBe(true);
  });
  test("helper builds valid IBANs of exact length", () => {
    expect(ibanChecksumOk(ibanOfLength(34))).toBe(true);
    expect(ibanOfLength(34)).toHaveLength(34);
  });
});

describe("AC-1.2 required values", () => {
  test.each([
    ["legalName", details({ legalName: "" })],
    ["legalName", details({ legalName: "  　\t " })],
    ["vatNumber", details({ vatNumber: "" })],
    ["vatNumber", details({ vatNumber: "　 " })],
    ["address.it", details({ address: { it: [], en: ["x"] } })],
    ["address.it", details({ address: { it: ["", "  ", " ", "　"], en: ["x"] } })],
    ["address.en", details({ address: { it: ["x"], en: ["　"] } })],
  ] as const)("%s empty or only blanks → required, no line", (field, d) => {
    expect(problems(d)).toEqual([{ field, reason: "required" }]);
    expect(complete(d)).toBe(false);
    expect(missing(d)).toEqual([field]);
  });

  test("everything missing is reported at once, in field order", () => {
    const d = { ...EMPTY_DETAILS, address: { it: [], en: [] } };
    expect(problems(d).map((p) => p.field)).toEqual(["legalName", "address.it", "address.en", "vatNumber"]);
    expect(missing(d)).toEqual(["legalName", "address.it", "address.en", "vatNumber"]);
  });

  test("IBAN and contacts may be empty", () => {
    const d = details({ iban: "", contacts: { it: "", en: "" } });
    expect(problems(d)).toEqual([]);
    expect(complete(d)).toBe(true);
  });

  test("a value that is only U+0085 is not blank (it is a line break)", () => {
    expect(problems(withName("\u0085"))).toEqual([{ field: "legalName", reason: "line_break" }]);
  });
});

describe("AC-1.3 limits (code points)", () => {
  test("legal name 200 / 201", () => {
    expect(problems(withName(cp(200)))).toEqual([]);
    expect(problems(withName(cp(201)))).toEqual([{ field: "legalName", reason: "too_long", limit: 200 }]);
  });
  test("VAT 40 / 41", () => {
    expect(problems(withVat(cp(40)))).toEqual([]);
    expect(problems(withVat(cp(41)))).toEqual([{ field: "vatNumber", reason: "too_long", limit: 40 }]);
  });
  test("contacts 200 / 201 per language", () => {
    expect(problems(withContacts(cp(200), cp(200)))).toEqual([]);
    expect(problems(withContacts(cp(201), cp(200)))).toEqual([
      { field: "contacts.it", reason: "too_long", limit: 200 },
    ]);
    expect(problems(withContacts(cp(200), cp(201)))).toEqual([
      { field: "contacts.en", reason: "too_long", limit: 200 },
    ]);
  });
  test("address line 120 / 121", () => {
    expect(problems(withAddressIt([cp(120)]))).toEqual([]);
    expect(problems(withAddressIt([cp(121)]))).toEqual([
      { field: "address.it", line: 0, reason: "too_long", limit: 120 },
    ]);
  });
  test("address 4 / 5 lines", () => {
    expect(problems(withAddressIt(["a", "b", "c", "d"]))).toEqual([]);
    expect(problems(withAddressIt(["a", "b", "c", "d", "e"]))).toEqual([
      { field: "address.it", reason: "too_many_lines", limit: 4 },
    ]);
  });
  test("blank lines do not count towards the 4 lines", () => {
    expect(problems(withAddressIt(["a", "", "b", " ", "c", "　", "d", ""]))).toEqual([]);
  });
  test("too_many_lines carries no line; 16 lines is still just too_many_lines", () => {
    const lines = Array.from({ length: 16 }, (_, i) => `l${i}`);
    expect(problems(withAddressIt(lines))).toEqual([{ field: "address.it", reason: "too_many_lines", limit: 4 }]);
  });
  test("an emoji counts as one character", () => {
    expect(problems(withName("😀".repeat(200)))).toEqual([]);
    expect(problems(withName("😀".repeat(201)))).toEqual([{ field: "legalName", reason: "too_long", limit: 200 }]);
    expect("😀".repeat(200).length).toBe(400); // UTF-16 units would have refused it
  });
  test("the limit applies after trimming and NFC", () => {
    expect(problems(withName(`  ${cp(200)}  `))).toEqual([]);
    // 120 decomposed e + combining acute = 240 code points raw, 120 after NFC
    expect(problems(withAddressIt(["é".repeat(120)]))).toEqual([]);
  });
  test("IBAN 34 / 35 after removing spaces", () => {
    const i34 = ibanOfLength(34);
    expect(problems(withIban(i34))).toEqual([]);
    const spaced = i34.replace(/(.{4})/g, "$1 ");
    expect(problems(withIban(spaced))).toEqual([]);
    expect(problems(withIban(ibanOfLength(35)))).toEqual([{ field: "iban", reason: "too_long", limit: 34 }]);
    expect(problems(withIban(ibanOfLength(35).replace(/(.{4})/g, "$1 ")))).toEqual([
      { field: "iban", reason: "too_long", limit: 34 },
    ]);
  });
});

describe("AC-1.3 line breaks and control characters", () => {
  test.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["NEL U+0085", "\u0085"],
    ["LS U+2028", "\u2028"],
    ["PS U+2029", "\u2029"],
  ])("%s inside a one-line value → line_break", (_n, ch) => {
    const v = `a${ch}b`;
    expect(problems(withName(v))).toEqual([{ field: "legalName", reason: "line_break" }]);
    expect(problems(withVat(v))).toEqual([{ field: "vatNumber", reason: "line_break" }]);
    expect(problems(withContacts(v, v))).toEqual([
      { field: "contacts.it", reason: "line_break" },
      { field: "contacts.en", reason: "line_break" },
    ]);
    expect(problems(withAddressIt(["ok", v]))).toEqual([{ field: "address.it", line: 1, reason: "line_break" }]);
  });

  test.each([
    ["tab", "\t"],
    ["NUL U+0000", "\u0000"],
    ["DEL U+007F", "\u007f"],
    ["C1 U+009F", "\u009f"],
    ["ESC", "\u001b"],
    ["lone high surrogate", "\ud83d"],
    ["lone low surrogate", "\ude00"],
  ])("%s inside a value → control_character", (_n, ch) => {
    const v = `a${ch}b`;
    expect(problems(withName(v))).toEqual([{ field: "legalName", reason: "control_character" }]);
    expect(problems(withAddressIt([v]))).toEqual([{ field: "address.it", line: 0, reason: "control_character" }]);
    expect(problems(withContacts(v))).toEqual([{ field: "contacts.it", reason: "control_character" }]);
  });

  test("a paired surrogate (an emoji) is fine", () => {
    expect(problems(withName("wellD 😀"))).toEqual([]);
  });

  test("a line break is not also a control character; both kinds are reported when both are present", () => {
    expect(problems(withName("a\nb\tc"))).toEqual([
      { field: "legalName", reason: "line_break" },
      { field: "legalName", reason: "control_character" },
    ]);
  });

  test("a trailing newline or tab is trimmed, not refused", () => {
    expect(problems(withName("wellD SA\n"))).toEqual([]);
    expect(normalise(withName("\twellD SA\r\n")).legalName).toBe("wellD SA");
  });

  test("a break and an over-long value are both reported", () => {
    expect(problems(withName(`${cp(201)}\nx`))).toEqual([
      { field: "legalName", reason: "line_break" },
      { field: "legalName", reason: "too_long", limit: 200 },
    ]);
  });
});

describe("E5 line positions", () => {
  test("a blank line at 1 and an over-long line at 2 → line 2", () => {
    expect(problems(withAddressIt(["Via Nassa 1", "", cp(121)]))).toEqual([
      { field: "address.it", line: 2, reason: "too_long", limit: 120 },
    ]);
  });
  test("each language is judged on its own array", () => {
    const d = details({ address: { it: ["ok"], en: ["", "ok", "bad\tline"] } });
    expect(problems(d)).toEqual([{ field: "address.en", line: 2, reason: "control_character" }]);
  });
  test("several refused lines are all reported, in line order", () => {
    expect(problems(withAddressIt([cp(121), "", "x\ny", cp(130)])).map((p) => [p.line, p.reason])).toEqual([
      [0, "too_long"],
      [2, "line_break"],
      [3, "too_long"],
    ]);
  });
  test("required carries no line", () => {
    const p = problems(withAddressIt(["", " "]));
    expect(p).toEqual([{ field: "address.it", reason: "required" }]);
    expect("line" in p[0]!).toBe(false);
  });
  test("all problems of different fields come at once, in field order", () => {
    const d = details({
      legalName: cp(201),
      vatNumber: "",
      iban: "CH93 0076 2011 6238 5295 8",
      contacts: { it: "a\nb", en: "" },
    });
    expect(problems(d).map((p) => `${p.field}:${p.reason}`)).toEqual([
      "legalName:too_long",
      "vatNumber:required",
      "iban:iban_check_digits",
      "contacts.it:line_break",
    ]);
  });
  test("does not mutate its input", () => {
    const d = details({ address: { it: ["", "a"], en: ["b"] }, iban: " ch93 0076 " });
    const copy = structuredClone(d);
    problems(d);
    normalise(d);
    expect(d).toEqual(copy);
  });
});

describe("AC-1.4 IBAN", () => {
  test("typed with spaces, lower case and edge blanks → stored in electronic form", () => {
    expect(normaliseIban(" ch93 0076 2011 6238 5295 7 ")).toBe(CH_IBAN);
    expect(normalise(withIban(" ch93 0076 2011 6238 5295 7 ")).iban).toBe(CH_IBAN);
    expect(problems(withIban(" ch93 0076 2011 6238 5295 7 "))).toEqual([]);
  });
  test("every kind of whitespace is removed (NBSP, ideographic, newline, NEL)", () => {
    expect(normaliseIban("CH93 0076　2011\n6238\u008552957")).toBe(CH_IBAN);
  });
  test("a CH and an IT IBAN are accepted", () => {
    expect(problems(withIban(CH_IBAN))).toEqual([]);
    expect(problems(withIban(IT_IBAN))).toEqual([]);
    expect(problems(withIban("it60 x054 2811 1010 0000 0123 456"))).toEqual([]);
  });
  test.each(REFERENCE_IBANS)("reference IBAN %s is accepted", (iban) => {
    expect(problems(withIban(iban))).toEqual([]);
  });
  test.each([
    ["last digit", "CH9300762011623852958"],
    ["a check digit", "CH9400762011623852957"],
    ["two swapped digits", "CH9300762011623852975"],
    ["IT last char", "IT60X0542811101000000123457"],
  ])("one wrong character (%s) → iban_check_digits", (_n, iban) => {
    expect(problems(withIban(iban))).toEqual([{ field: "iban", reason: "iban_check_digits" }]);
  });
  test("CH93-… → iban_format", () => {
    expect(problems(withIban("CH93-0076-2011-6238-5295-7"))).toEqual([{ field: "iban", reason: "iban_format" }]);
  });
  test.each([
    ["too short (14)", "CH930076201162"],
    ["no country", "1293007620116238529"],
    ["check digits not numeric", "CHAB00762011623852957"],
    ["non-ASCII letter", "CH93007620116238529ß7"],
    ["full-width digits", "CH９３00762011623852957"],
    ["just a country", "CH"],
  ])("%s → iban_format", (_n, iban) => {
    expect(problems(withIban(iban))).toEqual([{ field: "iban", reason: "iban_format" }]);
  });
  test("ß is not upper-cased into SS", () => {
    expect(normaliseIban("ß")).toBe("ß");
  });
  test("a control character in an IBAN → control_character", () => {
    expect(problems(withIban(`${CH_IBAN}\u0000`))).toEqual([{ field: "iban", reason: "control_character" }]);
    expect(problems(withIban("CH93\t0076 2011 6238 5295 7"))).toEqual([]); // a tab is whitespace: removed like a space
  });
  test("whitespace-only IBAN is empty, so accepted", () => {
    expect(problems(withIban("   "))).toEqual([]);
    expect(normalise(withIban("   ")).iban).toBe("");
  });
  test("ibanPrint groups of four", () => {
    expect(ibanPrint(CH_IBAN)).toBe("CH93 0076 2011 6238 5295 7");
    expect(ibanPrint(IT_IBAN)).toBe("IT60 X054 2811 1010 0000 0123 456");
    expect(ibanPrint("CH93")).toBe("CH93");
    expect(ibanPrint("")).toBe("");
  });
});

describe("invalid (E6) — a moved value, stored index, no required", () => {
  test("a complete in-rule entity has none", () => {
    expect(invalid(details())).toEqual([]);
  });
  test("5-line address, 121-character line, bad IBAN; required is not repeated", () => {
    const stored = details({
      legalName: "",
      address: { it: ["a", cp(121), "c", "d", "e"], en: [] },
      iban: "CH9300762011623852958",
    });
    expect(invalid(stored)).toEqual([
      { field: "address.it", line: 1, reason: "too_long", limit: 120 },
      { field: "address.it", reason: "too_many_lines", limit: 4 },
      { field: "iban", reason: "iban_check_digits" },
    ]);
    expect(missing(stored)).toEqual(["legalName", "address.en"]);
    expect(complete(stored)).toBe(false);
  });
  test("a moved IBAN of 50 characters", () => {
    expect(invalid(withIban("A".repeat(50)))).toEqual([{ field: "iban", reason: "too_long", limit: 34 }]);
  });
  test("a moved value with a line break", () => {
    expect(invalid(withName("wellD\nSA"))).toEqual([{ field: "legalName", reason: "line_break" }]);
  });
});

describe("restorable (E1)", () => {
  test("false for an incomplete version", () => {
    expect(restorable(details({ vatNumber: "" }))).toBe(false);
    expect(restorable({ ...EMPTY_DETAILS, address: { it: [], en: [] } })).toBe(false);
  });
  test("false for an out-of-rule version", () => {
    expect(restorable(withName(cp(201)))).toBe(false);
    expect(restorable(withAddressIt(["a", "b", "c", "d", "e"]))).toBe(false);
    expect(restorable(withIban("CH9300762011623852958"))).toBe(false);
  });
  test("true for a complete valid one, even with edge blanks", () => {
    expect(restorable(details())).toBe(true);
    expect(restorable(withName("  wellD SA  "))).toBe(true);
  });
});

describe("AC-2.1 equivalence and changedFields", () => {
  const base = details();
  test("identical → no change", () => {
    expect(changedFields(base, structuredClone(base))).toEqual([]);
    expect(sameDetails(base, structuredClone(base))).toBe(true);
  });
  test.each([
    ["IBAN spaces and case", details({ iban: "ch93 0076 2011 6238 5295 7" })],
    ["trailing blanks", details({ legalName: "wellD SA  ", vatNumber: " CHE-123.456.789 IVA　" })],
    [
      "a blank address line",
      details({ address: { it: ["Via Nassa 1", "", "6900 Lugano", "  "], en: ["Via Nassa 1", "6900 Lugano"] } }),
    ],
    ["NFD vs NFC", details({ legalName: "wellD SA" })],
  ])("equivalent body (%s) → same", (_n, other) => {
    expect(sameDetails(base, other)).toBe(true);
    expect(changedFields(base, other)).toEqual([]);
  });
  test("NFD vs NFC is the same value", () => {
    const nfc = withName("Società Zürich");
    const nfd = withName("Società Zürich");
    expect(nfd.legalName).not.toBe(nfc.legalName);
    expect(sameDetails(nfc, nfd)).toBe(true);
    expect(normalise(nfd).legalName).toBe(nfc.legalName);
  });
  test("each field is detected on its own, in closed-set order", () => {
    expect(changedFields(base, withName("Other SA"))).toEqual(["legalName"]);
    expect(changedFields(base, details({ address: { it: ["x"], en: base.address.en } }))).toEqual(["address.it"]);
    expect(changedFields(base, details({ address: { it: base.address.it, en: ["x"] } }))).toEqual(["address.en"]);
    expect(changedFields(base, withVat("IT1"))).toEqual(["vatNumber"]);
    expect(changedFields(base, withIban(IT_IBAN))).toEqual(["iban"]);
    expect(changedFields(base, details({ contacts: { it: "x", en: base.contacts.en } }))).toEqual(["contacts.it"]);
    expect(changedFields(base, details({ contacts: { it: base.contacts.it, en: "x" } }))).toEqual(["contacts.en"]);
    expect(changedFields(base, details({ iban: IT_IBAN, legalName: "Z", contacts: { it: "q", en: "r" } }))).toEqual([
      "legalName",
      "iban",
      "contacts.it",
      "contacts.en",
    ]);
  });
  test("address line order and count matter", () => {
    const reordered = details({ address: { it: ["6900 Lugano", "Via Nassa 1"], en: base.address.en } });
    expect(changedFields(base, reordered)).toEqual(["address.it"]);
    const fewer = details({ address: { it: ["Via Nassa 1"], en: base.address.en } });
    expect(changedFields(base, fewer)).toEqual(["address.it"]);
  });
  test("a case change of a non-IBAN value is a change", () => {
    expect(changedFields(base, withName("WELLD SA"))).toEqual(["legalName"]);
  });
  test("first version: every non-empty field", () => {
    expect(changedFields(null, base)).toEqual([
      "legalName",
      "address.it",
      "address.en",
      "vatNumber",
      "iban",
      "contacts.it",
      "contacts.en",
    ]);
    expect(changedFields(null, details({ iban: "", contacts: { it: "", en: "" } }))).toEqual([
      "legalName",
      "address.it",
      "address.en",
      "vatNumber",
    ]);
    expect(changedFields(null, { ...EMPTY_DETAILS, address: { it: [], en: [] } })).toEqual([]);
  });
  test("normalise is idempotent", () => {
    const messy = details({
      legalName: " Società ",
      address: { it: [" a ", "", "b"], en: ["c"] },
      iban: "ch93 0076 2011 6238 5295 7",
    });
    const once = normalise(messy);
    expect(normalise(once)).toEqual(once);
  });
});

describe("G2 protectedChanged (AC-9.1, AC-9.5)", () => {
  const base = details();
  const protectedOf = (next: LegalDetails) => protectedChanged(changedFields(base, next));

  test("the protected set is the legal name, the VAT number and the IBAN, in closed-set order", () => {
    expect([...PROTECTED_FIELDS]).toEqual(["legalName", "vatNumber", "iban"]);
  });
  test("each protected field on its own, and all of them in closed-set order", () => {
    expect(protectedOf(withName("Other SA"))).toEqual(["legalName"]);
    expect(protectedOf(withVat("IT1"))).toEqual(["vatNumber"]);
    expect(protectedOf(withIban(IT_IBAN))).toEqual(["iban"]);
    expect(protectedOf(details({ iban: IT_IBAN, vatNumber: "IT1", legalName: "Z" }))).toEqual(["legalName", "vatNumber", "iban"]);
  });
  test("filling an empty IBAN and emptying a filled one are protected changes", () => {
    expect(protectedChanged(changedFields(withIban(""), base))).toEqual(["iban"]);
    expect(protectedOf(withIban(""))).toEqual(["iban"]);
  });
  test("only the other fields (addresses, contacts) are not protected", () => {
    expect(protectedOf(details({ address: { it: ["x"], en: base.address.en } }))).toEqual([]);
    expect(protectedOf(details({ address: { it: base.address.it, en: ["x"] } }))).toEqual([]);
    expect(protectedOf(details({ contacts: { it: "x", en: "y" } }))).toEqual([]);
    expect(protectedOf(details({ address: { it: ["x"], en: ["y"] }, contacts: { it: "q", en: "r" } }))).toEqual([]);
  });
  test("a mixed change lists the protected part only", () => {
    expect(protectedOf(details({ iban: IT_IBAN, contacts: { it: "q", en: "r" } }))).toEqual(["iban"]);
  });
  test("a different spacing or case of the same IBAN, trailing blanks and NFD are not protected changes (AC-9.5)", () => {
    expect(protectedOf(details({ iban: "ch93 0076 2011 6238 5295 7" }))).toEqual([]);
    expect(protectedOf(details({ iban: " CH93\u00a00076 2011 6238\n5295 7 " }))).toEqual([]);
    expect(protectedOf(details({ legalName: "wellD SA  ", vatNumber: " CHE-123.456.789 IVA\u3000" }))).toEqual([]);
    const accented = details({ legalName: "Societ\u00e0 SA" });
    expect(protectedChanged(changedFields(accented, details({ legalName: "Societa\u0300 SA" })))).toEqual([]);
  });
  test("no change, no protected change; the empty list of fields is the empty answer", () => {
    expect(protectedOf(structuredClone(base))).toEqual([]);
    expect(protectedChanged([])).toEqual([]);
  });
  test("the answer keeps the order of PROTECTED_FIELDS whatever the order of the input", () => {
    expect(protectedChanged(["iban", "contacts.en", "legalName"])).toEqual(["legalName", "iban"]);
  });
});

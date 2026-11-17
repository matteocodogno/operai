/**
 * The one serializer (T5, plan § API contracts "Details", E6; AC-1.1, AC-3.1).
 *
 * The central test: its output for the rows below is BYTE-equal to the shared fixture
 * `specs/20261117-legal-entities/fixtures/legal-entities.json`, which crm-api's and letterhead-api's clients parse
 * (CT). The rows are written out here, independently of the serializer, so the fixture is a reviewed contract and
 * not a snapshot of whatever the code does.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { EMPTY_DETAILS } from "./rules";
import { serializeAll, serializeEntity, type VersionRow } from "./serialize";

const FIXTURE = join(import.meta.dir, "../../../specs/20261117-legal-entities/fixtures/legal-entities.json");

// A moved address line one code point over AC-1.3's 120.
const LONG_LINE = "Via della Posta, " + "x".repeat(104);

const MOVED_INVALID: VersionRow = {
  entity: "welld_it",
  version: 1,
  legalName: "wellD S.r.l.",
  addressIt: ["Via Roma 1", "Piano terra", LONG_LINE, "20121 Milano", "Italia"],
  addressEn: ["Via Roma 1", "20121 Milan", "Italy"],
  vatNumber: "IT01234567890",
  // IT60X0542811101000000123456 with the last digit changed: well formed, wrong check digits.
  iban: "IT60X0542811101000000123457",
  contactsIt: "",
  contactsEn: "",
  createdAt: new Date("2026-11-17T09:00:00.000Z"),
};

const COMPLETE: VersionRow = {
  entity: "welld_ch",
  version: 3,
  legalName: "wellD SA",
  addressIt: ["Via Cantonale 1", "6900 Lugano", "Svizzera"],
  addressEn: ["Via Cantonale 1", "6900 Lugano", "Switzerland"],
  vatNumber: "CHE-123.456.789 IVA",
  iban: "CH9300762011623852957",
  contactsIt: "Tel. +41 91 000 00 00 · info@welld.ch",
  contactsEn: "Phone +41 91 000 00 00 · info@welld.ch",
  createdAt: new Date("2026-11-17T10:12:00.000Z"),
};

describe("the shared fixture", () => {
  test("the serializer's output for the fixture's rows byte-equals the fixture file", async () => {
    const text = await readFile(FIXTURE, "utf8");
    // Rows given out of order and with an extra row of an unknown entity: the answer is the registry's order.
    const out = serializeAll([COMPLETE, MOVED_INVALID]);
    expect(JSON.stringify(out, null, 2) + "\n").toBe(text);
  });

  test("the fixture holds both entities: one complete and clean, one moved with three problems (E6)", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as ReturnType<typeof serializeAll>;
    expect(fixture.items.map((i) => i.entity)).toEqual(["welld_it", "welld_ch"]);
    const [moved, clean] = fixture.items;
    expect(clean!.invalid).toEqual([]);
    expect(clean!.complete).toBe(true);
    expect(moved!.address.it).toHaveLength(5);
    expect(moved!.address.it[2]!.length).toBe(121);
    expect(moved!.invalid).toEqual([
      { field: "address.it", line: 2, reason: "too_long", limit: 120 },
      { field: "address.it", reason: "too_many_lines", limit: 4 },
      { field: "iban", reason: "iban_check_digits" },
    ]);
    // Moved, so it keeps the values as they are: complete, only its values break today's rules.
    expect(moved!.complete).toBe(true);
    expect(moved!.missing).toEqual([]);
  });
});

describe("serializeEntity", () => {
  test("a complete row: every member, in the contract's key order", () => {
    const body = serializeEntity("welld_ch", COMPLETE);
    expect(Object.keys(body)).toEqual([
      "entity",
      "version",
      "updatedAt",
      "legalName",
      "address",
      "vatNumber",
      "iban",
      "ibanPrint",
      "contacts",
      "complete",
      "missing",
      "invalid",
    ]);
    expect(body.ibanPrint).toBe("CH93 0076 2011 6238 5295 7");
    expect(body.updatedAt).toBe("2026-11-17T10:12:00.000Z");
    expect(body.complete).toBe(true);
    expect(body.missing).toEqual([]);
    expect(body.invalid).toEqual([]);
  });

  test("no row: version 0, empty values, null updatedAt, the four required values missing, nothing invalid", () => {
    const body = serializeEntity("welld_ch", null);
    expect(body).toEqual({
      entity: "welld_ch",
      version: 0,
      updatedAt: null,
      legalName: "",
      address: { it: [], en: [] },
      vatNumber: "",
      iban: "",
      ibanPrint: "",
      contacts: { it: "", en: "" },
      complete: false,
      missing: ["legalName", "address.it", "address.en", "vatNumber"],
      invalid: [],
    });
  });

  test("the empty answer shares nothing with the frozen empty details (mutating it cannot corrupt the next answer)", () => {
    const first = serializeEntity("welld_it", null);
    first.address.it.push("injected");
    first.address.en.push("injected");
    const second = serializeEntity("welld_it", null);
    expect(second.address).toEqual({ it: [], en: [] });
    expect(EMPTY_DETAILS.address.it).toEqual([]);
  });

  test("the answer shares nothing with the row it was built from", () => {
    const row: VersionRow = { ...COMPLETE, addressIt: [...COMPLETE.addressIt], addressEn: [...COMPLETE.addressEn] };
    const body = serializeEntity("welld_ch", row);
    body.address.it.push("injected");
    expect(row.addressIt).toEqual(COMPLETE.addressIt);
  });

  test("a moved incomplete row: values kept as they are, missing named, no `required` among `invalid`", () => {
    const body = serializeEntity("welld_it", {
      ...MOVED_INVALID,
      vatNumber: "",
      addressEn: [],
      iban: "",
      addressIt: ["Via Roma 1"],
    });
    expect(body.complete).toBe(false);
    expect(body.missing).toEqual(["address.en", "vatNumber"]);
    expect(body.invalid).toEqual([]);
    expect(body.iban).toBe("");
    expect(body.ibanPrint).toBe("");
  });

  test("moved values are returned as stored, never normalised, while the judgement uses the normalised form", () => {
    const body = serializeEntity("welld_it", {
      ...COMPLETE,
      entity: "welld_it",
      legalName: "  wellD SA  ",
      addressIt: ["Via Roma 1", "   ", "20121 Milano"],
    });
    expect(body.legalName).toBe("  wellD SA  ");
    expect(body.address.it).toEqual(["Via Roma 1", "   ", "20121 Milano"]);
    expect(body.complete).toBe(true);
    expect(body.invalid).toEqual([]);
  });

  test("`line` of an invalid item is the index in the stored array, `limit` only where the rule has one", () => {
    const body = serializeEntity("welld_it", {
      ...COMPLETE,
      entity: "welld_it",
      addressEn: ["ok", "bad break", "ok"],
      contactsIt: "x".repeat(201),
    });
    expect(body.invalid).toEqual([
      { field: "address.en", line: 1, reason: "line_break" },
      { field: "contacts.it", reason: "too_long", limit: 200 },
    ]);
  });
});

describe("serializeAll", () => {
  test("always exactly welld_it then welld_ch, whatever rows it is given (AC-1.1)", () => {
    expect(serializeAll([]).items.map((i) => [i.entity, i.version])).toEqual([
      ["welld_it", 0],
      ["welld_ch", 0],
    ]);
    expect(serializeAll([COMPLETE]).items.map((i) => [i.entity, i.version])).toEqual([
      ["welld_it", 0],
      ["welld_ch", 3],
    ]);
    const withStranger = serializeAll([{ ...COMPLETE, entity: "welld_de" }, MOVED_INVALID]);
    expect(withStranger.items.map((i) => [i.entity, i.version])).toEqual([
      ["welld_it", 1],
      ["welld_ch", 0],
    ]);
  });
});

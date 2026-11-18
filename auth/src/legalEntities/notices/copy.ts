/**
 * The words of the in-app change notice (specs/20261117-legal-entities, T59; US-9 AC-9.11 to AC-9.13; design.md N1;
 * plan amendment 2026-11-17 G1 point 6, G5). English is the base text of a notification and Italian its `it` variant
 * (ADR 20261104-bilingual-system-notifications): the reader's language picks one, the sender never does. The email's copy
 * lives with notify-api's template (English only); this catalog is the in-app texts, and both come from the one
 * design section so they say the same thing.
 *
 * The catalog holds templates with `{slots}`. A slot is filled by `fill`, which takes only strings the caller
 * built from CLOSED sets (an entity label, a name from a closed list, a number, a date, an IBAN token) and the
 * author's account email, the one personal slot (`content.ts` accepts it only if it passes `noticeAuthorEmail`: plan
 * amendment D9, J4; no display name is ever a slot). No key takes a legal name, a VAT number, an
 * address, a contacts line or more than the last four characters of an IBAN (AC-9.12): there is nothing here to
 * pass one to.
 *
 * Parity (`copy.test.ts`): both languages have the same keys and the same slots in every key.
 */

export const NOTICE_LANGUAGES = ["en", "it"] as const;
export type NoticeLanguage = (typeof NOTICE_LANGUAGES)[number];

/** The key set; both languages must define every one of them (the type makes a missing key a compile error). */
export const NOTICE_COPY_KEYS = [
  "notice.entity.welld_it",
  "notice.entity.welld_ch",
  "notice.name.legalName",
  "notice.name.vatNumber",
  "notice.name.iban",
  "notice.name.addressIt",
  "notice.name.addressEn",
  "notice.name.contactsIt",
  "notice.name.contactsEn",
  "notice.title",
  "notice.lead",
  "notice.byAction.save",
  "notice.byAction.restore",
  "notice.byAction.saveNoEmail",
  "notice.byAction.restoreNoEmail",
  "notice.when",
  "notice.dateTime",
  "notice.version",
  "notice.changed",
  "notice.ibanOld",
  "notice.ibanNew",
  "notice.none",
  "notice.set",
  "notice.alsoChanged",
  "notice.access",
  "notice.unexpected",
  "notice.open",
  "notice.and",
  "notice.month.1",
  "notice.month.2",
  "notice.month.3",
  "notice.month.4",
  "notice.month.5",
  "notice.month.6",
  "notice.month.7",
  "notice.month.8",
  "notice.month.9",
  "notice.month.10",
  "notice.month.11",
  "notice.month.12",
] as const;
export type NoticeCopyKey = (typeof NOTICE_COPY_KEYS)[number];

type Catalog = Record<NoticeCopyKey, string>;

const en: Catalog = {
  "notice.entity.welld_it": "WellD IT",
  "notice.entity.welld_ch": "WellD CH",
  "notice.name.legalName": "legal name",
  "notice.name.vatNumber": "VAT number",
  "notice.name.iban": "IBAN",
  "notice.name.addressIt": "address (Italian)",
  "notice.name.addressEn": "address (English)",
  "notice.name.contactsIt": "contacts line (Italian)",
  "notice.name.contactsEn": "contacts line (English)",
  "notice.title": "Legal details of {entity} changed: {details}",
  "notice.lead": "The legal details of {entity} were changed.",
  "notice.byAction.save": "Change saved by the account {author}.",
  "notice.byAction.restore": "Version {from} restored by the account {author}.",
  "notice.byAction.saveNoEmail": "Change saved by an account with no email address on record.",
  "notice.byAction.restoreNoEmail": "Version {from} restored by an account with no email address on record.",
  "notice.when": "When: {date}.",
  "notice.dateTime": "{day} {month} {year}, {time} {zone} (Europe/Zurich)",
  "notice.version": "New version: {n}.",
  "notice.changed": "Details changed: {list}.",
  "notice.ibanOld": "Old IBAN: {token}.",
  "notice.ibanNew": "New IBAN: {token}.",
  "notice.none": "none",
  "notice.set": "set (not shown)",
  "notice.alsoChanged": "Also changed: {list}.",
  "notice.access": "Only people who may see this history can open the link.",
  "notice.unexpected":
    "If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator.",
  "notice.open": "Open the history",
  "notice.and": "and",
  "notice.month.1": "January",
  "notice.month.2": "February",
  "notice.month.3": "March",
  "notice.month.4": "April",
  "notice.month.5": "May",
  "notice.month.6": "June",
  "notice.month.7": "July",
  "notice.month.8": "August",
  "notice.month.9": "September",
  "notice.month.10": "October",
  "notice.month.11": "November",
  "notice.month.12": "December",
};

const it: Catalog = {
  "notice.entity.welld_it": "WellD IT",
  "notice.entity.welld_ch": "WellD CH",
  "notice.name.legalName": "ragione sociale",
  "notice.name.vatNumber": "partita IVA",
  "notice.name.iban": "IBAN",
  "notice.name.addressIt": "indirizzo (italiano)",
  "notice.name.addressEn": "indirizzo (inglese)",
  "notice.name.contactsIt": "riga contatti (italiano)",
  "notice.name.contactsEn": "riga contatti (inglese)",
  "notice.title": "Dati legali di {entity} modificati: {details}",
  "notice.lead": "I dati legali di {entity} sono stati modificati.",
  "notice.byAction.save": "Modifica salvata dall'account {author}.",
  "notice.byAction.restore": "Versione {from} ripristinata dall'account {author}.",
  "notice.byAction.saveNoEmail": "Modifica salvata da un account senza indirizzo email registrato.",
  "notice.byAction.restoreNoEmail": "Versione {from} ripristinata da un account senza indirizzo email registrato.",
  "notice.when": "Quando: {date}.",
  "notice.dateTime": "{day} {month} {year}, {time} {zone} (Europe/Zurich)",
  "notice.version": "Nuova versione: {n}.",
  "notice.changed": "Dati modificati: {list}.",
  "notice.ibanOld": "IBAN precedente: {token}.",
  "notice.ibanNew": "Nuovo IBAN: {token}.",
  "notice.none": "nessuno",
  "notice.set": "presente (non mostrato)",
  "notice.alsoChanged": "Modificati anche: {list}.",
  "notice.access": "Solo chi può vedere questa cronologia può aprire il collegamento.",
  "notice.unexpected":
    "Se non ti aspettavi questa modifica, apri la cronologia e ripristina la versione precedente se è sbagliata. Poi avvisa un amministratore.",
  "notice.open": "Apri la cronologia",
  "notice.and": "e",
  "notice.month.1": "gennaio",
  "notice.month.2": "febbraio",
  "notice.month.3": "marzo",
  "notice.month.4": "aprile",
  "notice.month.5": "maggio",
  "notice.month.6": "giugno",
  "notice.month.7": "luglio",
  "notice.month.8": "agosto",
  "notice.month.9": "settembre",
  "notice.month.10": "ottobre",
  "notice.month.11": "novembre",
  "notice.month.12": "dicembre",
};

export const NOTICE_COPY: Readonly<Record<NoticeLanguage, Readonly<Catalog>>> = Object.freeze({ en, it });

/** The slots of a template, in order of appearance (`copy.test.ts` compares them across languages). */
export function slotsOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}

/**
 * The text of `key` in `language` with its slots filled. A slot the template names but the caller did not give, or one
 * the caller gave and the template does not name, is a programming error and throws (a notice with a hole in it, or a
 * value that silently went nowhere, must not ship).
 */
export function fill(language: NoticeLanguage, key: NoticeCopyKey, values: Readonly<Record<string, string | number>> = {}): string {
  const template = NOTICE_COPY[language][key];
  const slots = slotsOf(template);
  for (const name of Object.keys(values)) {
    if (!slots.includes(name)) throw new Error(`notice copy ${key} has no slot ${name}`);
  }
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`notice copy ${key} needs a value for ${name}`);
    return String(value);
  });
}

/** `a`, `a and b`, `a, b and c` (Italian: `a e b`, `a, b e c`), in the order given. */
export function joinList(language: NoticeLanguage, items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  const and = NOTICE_COPY[language]["notice.and"];
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

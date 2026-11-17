/**
 * What a change notice says (specs/20261117-legal-entities, T59; US-9 AC-9.11, AC-9.12, AC-9.13; design.md N1;
 * plan amendment 2026-11-17 G5), rebuilt at SEND time from the two stored versions it is about: the version that was
 * stored (n) and the one before it (n - 1). Both are immutable, so a retry sends the same words, and the outbox row
 * (`legal_entity_notice`) can hold no value at all.
 *
 * The only values a notice may carry (AC-9.12) are the closed ones: the entity, the actor's name (the one free-text
 * slot: controls and bidi characters stripped, bounded to 200), the stored time, two version numbers, names from two
 * closed sets, and an IBAN token that is at most its last four characters (`ibanTail`, T54, the one rule for it).
 * `noticeFacts` is the ONLY place that reads a stored version; everything after it works from those facts, and no
 * fact holds a legal name, a VAT number, an address, a contacts line or an IBAN. That is why no function below can
 * leak one.
 *
 * Two outputs from the same facts: the in-app notice (English as the base and Italian as `it`, link to the entity's
 * history) and the email's typed `data` (notify-api's `legal_entity_change`, English; it renders and bounds it again).
 */

import type { LegalEntity } from "../entities";
import { type IbanTail, ibanTail } from "../ibanTail";
import type { HistoryRow } from "../repo";
import { type Field, type ProtectedField, protectedChanged } from "../rules";
import { fill, joinList, NOTICE_LANGUAGES, type NoticeCopyKey, type NoticeLanguage } from "./copy";

/** notify-api's limits for the in-app notice (`ItVariantSchema`, `SystemNotificationRequestSchema`). */
export const NOTICE_TITLE_MAX = 200;
export const NOTICE_BODY_MAX = 2000;
/** The actor's name as the email's data takes it (`LegalEntityChangeDataSchema`: 1 to 200). */
export const ACTOR_NAME_MAX = 200;

export type OtherField = "address.it" | "address.en" | "contacts.it" | "contacts.en";
/** Closed order = the order a notice lists them in. */
export const OTHER_FIELDS: readonly OtherField[] = ["address.it", "address.en", "contacts.it", "contacts.en"];

/** A stored version that cannot be the subject of a notice (an import, or no protected change): a fault, never a value. */
export class NoticeContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeContentError";
  }
}

export interface NoticeFacts {
  entity: LegalEntity;
  version: number;
  action: "save" | "restore";
  /** The version a restore copied from; null for a save. */
  restoredFrom: number | null;
  /** Controls and bidi characters stripped, at most {@link ACTOR_NAME_MAX} UTF-16 units; null when nothing is left. */
  actorName: string | null;
  storedAt: Date;
  /** Closed order: legalName, vatNumber, iban. At least one. */
  protectedNames: ProtectedField[];
  otherNames: OtherField[];
  /** Present iff the IBAN changed: only the tokens, never the value. */
  iban?: { old: IbanTail; new: IbanTail };
}

/**
 * The actor's name as a notice may show it: line breaks and other control characters become a space, format characters
 * (bidi marks and embeddings, zero-width characters, tags) are dropped, runs of blanks collapse, and the result is cut
 * to 200 UTF-16 units without splitting a character. Empty after all that = null.
 */
export function sanitizeActorName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const cleaned = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  let out = "";
  for (const char of cleaned) {
    if (out.length + char.length > ACTOR_NAME_MAX) break;
    out += char;
  }
  out = out.trim();
  return out === "" ? null : out;
}

/**
 * The facts of a protected change from the stored version `current` and the one it replaced. `changedFields` is what the
 * save stored against its predecessor (for a restore: against the version it replaced, the spec's "version before it").
 */
export function noticeFacts(current: HistoryRow, previous: HistoryRow | null): NoticeFacts {
  if (current.action !== "save" && current.action !== "restore") {
    throw new NoticeContentError("a notice is only written for a save or a restore");
  }
  const changed: readonly Field[] = current.changedFields;
  const protectedNames = protectedChanged(changed);
  if (protectedNames.length === 0) throw new NoticeContentError("the version has no protected change");
  const facts: NoticeFacts = {
    entity: current.entity as LegalEntity,
    version: current.version,
    action: current.action,
    restoredFrom: current.action === "restore" ? current.restoredFrom : null,
    actorName: sanitizeActorName(current.createdByName),
    storedAt: current.createdAt,
    protectedNames,
    otherNames: OTHER_FIELDS.filter((f) => changed.includes(f)),
  };
  if (current.action === "restore" && current.restoredFrom === null) {
    throw new NoticeContentError("a restore names the version it restored");
  }
  if (protectedNames.includes("iban")) {
    facts.iban = { old: ibanTail(previous?.iban ?? ""), new: ibanTail(current.iban) };
  }
  return facts;
}

// ─── Time (design N1, owner reading R-d, DR-15) ──────────────────────────────────────────────────────────────────────

const ZURICH_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/**
 * The stored time as people in Zurich read it: `17 November 2026, 10:12 CET (Europe/Zurich)`, Italian
 * `17 novembre 2026, 10:12 CET (Europe/Zurich)`. 24-hour clock, no seconds. The zone abbreviation is CET when the
 * offset on that date is +01:00 and CEST when it is +02:00: it is computed here, never taken from `Intl`'s short name
 * (which says "GMT+1" in several locales).
 */
export function formatStoredAt(at: Date, language: NoticeLanguage): string {
  if (Number.isNaN(at.getTime())) throw new NoticeContentError("the stored time is not a date");
  const part: Record<string, number> = {};
  for (const p of ZURICH_PARTS.formatToParts(at)) if (p.type !== "literal") part[p.type] = Number(p.value);
  const wall = Date.UTC(part["year"]!, part["month"]! - 1, part["day"]!, part["hour"]!, part["minute"]!);
  const instant = Math.floor(at.getTime() / 60_000) * 60_000;
  const offsetMinutes = (wall - instant) / 60_000;
  const zone = offsetMinutes === 60 ? "CET" : offsetMinutes === 120 ? "CEST" : `UTC${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(2, "0")}`;
  return fill(language, "notice.dateTime", {
    day: part["day"]!,
    month: fill(language, `notice.month.${part["month"]}` as NoticeCopyKey),
    year: part["year"]!,
    time: `${String(part["hour"]).padStart(2, "0")}:${String(part["minute"]).padStart(2, "0")}`,
    zone,
  });
}

// ─── The in-app notice ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `/admin/legal-entities?entity=<e>&view=history` (design E7): relative, so notify-api's open-redirect guard accepts it. */
export function historyHref(entity: LegalEntity): string {
  return `/admin/legal-entities?entity=${entity}&view=history`;
}

const NAME_KEY: Record<ProtectedField | OtherField, NoticeCopyKey> = {
  legalName: "notice.name.legalName",
  vatNumber: "notice.name.vatNumber",
  iban: "notice.name.iban",
  "address.it": "notice.name.addressIt",
  "address.en": "notice.name.addressEn",
  "contacts.it": "notice.name.contactsIt",
  "contacts.en": "notice.name.contactsEn",
};

function ibanToken(language: NoticeLanguage, token: IbanTail): string {
  switch (token.state) {
    case "none":
      return fill(language, "notice.none");
    case "set":
      return fill(language, "notice.set");
    case "tail":
      return `…${token.last4}`;
  }
}

export interface NoticeText {
  title: string;
  body: string;
}

/** One language of the notice: title and body, every body line a whole sentence (the centre may show breaks as spaces). */
export function noticeText(facts: NoticeFacts, language: NoticeLanguage): NoticeText {
  const entity = fill(language, `notice.entity.${facts.entity}`);
  const actor = facts.actorName ?? fill(language, "notice.unknownActor");
  const names = (list: readonly (ProtectedField | OtherField)[]) => joinList(language, list.map((n) => fill(language, NAME_KEY[n])));
  const lines = [
    fill(language, "notice.lead", { entity }),
    facts.action === "restore"
      ? fill(language, "notice.byAction.restore", { from: facts.restoredFrom as number, actor })
      : fill(language, "notice.byAction.save", { actor }),
    fill(language, "notice.when", { date: formatStoredAt(facts.storedAt, language) }),
    fill(language, "notice.version", { n: facts.version }),
    fill(language, "notice.changed", { list: names(facts.protectedNames) }),
    ...(facts.iban
      ? [
          fill(language, "notice.ibanOld", { token: ibanToken(language, facts.iban.old) }),
          fill(language, "notice.ibanNew", { token: ibanToken(language, facts.iban.new) }),
        ]
      : []),
    ...(facts.otherNames.length > 0 ? [fill(language, "notice.alsoChanged", { list: names(facts.otherNames) })] : []),
    fill(language, "notice.access"),
    fill(language, "notice.unexpected"),
  ];
  return {
    title: fill(language, "notice.title", { entity, details: names(facts.protectedNames) }),
    body: lines.join("\n"),
  };
}

export interface InAppNotice {
  title: string;
  body: string;
  it: NoticeText;
  link: { href: string; label: string };
}

/** The in-app notice: English as the base, Italian as `it`; throws when a text would break notify-api's limits. */
export function inAppNotice(facts: NoticeFacts): InAppNotice {
  const [base, italian] = NOTICE_LANGUAGES.map((language) => noticeText(facts, language)) as [NoticeText, NoticeText];
  for (const text of [base, italian]) {
    if (text.title.length > NOTICE_TITLE_MAX || text.body.length > NOTICE_BODY_MAX) {
      throw new NoticeContentError("the notice is longer than notify-api accepts");
    }
  }
  return { ...base, it: italian, link: { href: historyHref(facts.entity), label: fill("en", "notice.open") } };
}

// ─── The email's data ───────────────────────────────────────────────────────────────────────────────────────────────

/** `data` of notify-api's `legal_entity_change` (strict; `emails.schemas.ts`): closed values only. */
export interface LegalEntityChangeEmailData {
  entity: LegalEntity;
  action: "save" | "restore";
  restoredFrom: number | null;
  actorName: string;
  storedAt: string;
  version: number;
  protectedChanged: ProtectedField[];
  otherChanged: OtherField[];
  iban?: { old: IbanTail; new: IbanTail };
}

/** The email is English for everyone (AC-9.13): a person without a name reads the English fallback. */
export function emailData(facts: NoticeFacts): LegalEntityChangeEmailData {
  return {
    entity: facts.entity,
    action: facts.action,
    restoredFrom: facts.restoredFrom,
    actorName: facts.actorName ?? fill("en", "notice.unknownActor"),
    storedAt: facts.storedAt.toISOString(),
    version: facts.version,
    protectedChanged: facts.protectedNames,
    otherChanged: facts.otherNames,
    ...(facts.iban ? { iban: facts.iban } : {}),
  };
}

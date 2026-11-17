/**
 * The duty to tell people about a protected change (specs/20261117-legal-entities, T58; US-9 AC-9.7 to AC-9.10,
 * AC-9.14 to AC-9.17; plan amendment 2026-11-17 G1 point 1-2, G3, G4).
 *
 * `recordNoticeDuty` runs INSIDE the transaction that stores the version (`withAudit`, under the entity's advisory
 * lock), right after `appendVersion`, and only for a protected change (`protectedChanged`, rules.ts): it writes one
 * `legal_entity_notice` row per recipient and channel and nothing else. Nothing is sent here (the dispatcher, T59,
 * sends after commit and from a sweep): the duty is kept together with the version, so a failure here (our own
 * database) fails the whole save as any database error would, and a rollback after it leaves no row.
 *
 *   - a person gets one `in_app` row and one `email` row (`@@unique (entity, version, recipient, channel)` makes a
 *     second impossible);
 *   - the outside mailbox (`LEGAL_ENTITY_NOTICE_EMAIL`, set at this moment) gets one `email` row whose recipient is
 *     the word `outside`: the address itself is never stored;
 *   - the rows hold no value of any detail (AC-9.12): content is rebuilt from the immutable versions at send time;
 *   - a protected change with no recipient at all makes the caller write the audit entry
 *     `legal_entity.notice_no_recipients` (AC-9.15; `noRecipientsEntry`) in the same transaction.
 *
 * The import never reaches this code (AC-9.16): `action` is `save | restore` in the types and refused here at run
 * time for anything else, and `import.ts` does not import this module (a test reads it).
 */

import type { AuditEntryInput } from "../../authz/audit";
import type { Prisma } from "../../lib/generated/prisma/client";
import type { LegalEntity } from "../entities";
import { type RecipientResolver, resolveRecipients } from "./recipients";

export const OUTSIDE_RECIPIENT = "outside";

export interface NoticeDutyRequest {
  entity: LegalEntity;
  version: number;
  /** A save or a restore; an import has no notice (AC-9.16). */
  action: "save" | "restore";
  actorUserId: string;
  /** The version's own `createdAt`: the notice's clock (24 h of retries) starts when the version was stored. */
  storedAt: Date;
  /** Is there an outside mailbox right now (`LEGAL_ENTITY_NOTICE_EMAIL` set)? */
  outsideMailbox: boolean;
}

export interface NoticeDutyOptions {
  /** The recipients; `resolveRecipients` unless a test injects (an empty set, for the no-recipient entry). */
  recipients?: RecipientResolver;
}

export interface NoticeDutyResult {
  /** How many people got rows (each has two). */
  persons: number;
  /** Whether the outside mailbox got its row. */
  outside: boolean;
}

/** No recipient at all: no person and no outside mailbox. */
export const hasNoRecipient = (r: NoticeDutyResult): boolean => r.persons === 0 && !r.outside;

export async function recordNoticeDuty(
  tx: Prisma.TransactionClient,
  req: NoticeDutyRequest,
  { recipients = resolveRecipients }: NoticeDutyOptions = {},
): Promise<NoticeDutyResult> {
  // The import is never noticed (AC-9.16): the types say so, this line keeps it true for a caller that casts.
  if (req.action !== "save" && req.action !== "restore") throw new Error("a notice is only written for a save or a restore");

  const people = [...new Set(await recipients(tx, { entity: req.entity, actorUserId: req.actorUserId }))];
  const base = { entity: req.entity, version: req.version, createdAt: req.storedAt, nextAttemptAt: req.storedAt };
  const rows: Prisma.LegalEntityNoticeCreateManyInput[] = [];
  for (const id of people) {
    rows.push({ ...base, recipient: id, recipientKind: "person", channel: "in_app" });
    rows.push({ ...base, recipient: id, recipientKind: "person", channel: "email" });
  }
  if (req.outsideMailbox) rows.push({ ...base, recipient: OUTSIDE_RECIPIENT, recipientKind: "outside", channel: "email" });
  if (rows.length > 0) await tx.legalEntityNotice.createMany({ data: rows });
  return { persons: people.length, outside: req.outsideMailbox };
}

/** The audit entry of a protected change nobody could be told about (AC-9.15); no value, no address. */
export function noRecipientsEntry(req: { entity: LegalEntity; version: number }): AuditEntryInput {
  return {
    actorUserId: null,
    action: "legal_entity.notice_no_recipients",
    targetType: "legal_entity",
    targetId: req.entity,
    summary: `No recipient for the notice of version ${req.version} of ${req.entity}`,
    data: { version: req.version } satisfies Prisma.InputJsonObject,
  };
}

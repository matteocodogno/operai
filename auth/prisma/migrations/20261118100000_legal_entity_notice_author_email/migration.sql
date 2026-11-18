-- specs/20261117-legal-entities (T80, plan amendment 2026-11-18 D9, J2/J3). Additive: no data changed, no backfill.
-- The author's account email as it was when the version was stored (AC-9.11), written once by notices/duty.ts with
-- the rows and never updated. Personal data: content of the notice only, never a log line or an audit entry.
-- null = none on record. Only a not-empty CHECK, deliberately no CHECK on the form or length of the address: a
-- failing CHECK would turn a valid save into a 500 (the code writes null for an empty string).
ALTER TABLE "legal_entity_notice" ADD COLUMN "authorEmail" TEXT;
ALTER TABLE "legal_entity_notice"
  ADD CONSTRAINT "legal_entity_notice_authorEmail_not_empty" CHECK ("authorEmail" IS NULL OR "authorEmail" <> '');

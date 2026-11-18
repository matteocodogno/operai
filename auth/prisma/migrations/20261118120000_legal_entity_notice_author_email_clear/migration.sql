-- specs/20261117-legal-entities (T88, security review D9-1). The author's email is needed only until the row is
-- terminal (delivered / given_up); the dispatcher now nulls it in the same update as the terminal status.
-- 1. Clear it on rows already terminal (data written before this change). Done before the trigger exists.
UPDATE "legal_entity_notice" SET "authorEmail" = NULL WHERE "status" IN ('delivered', 'given_up') AND "authorEmail" IS NOT NULL;
-- 2. Enforce "written once at capture, cleared once at the terminal status, never otherwise updated": an UPDATE may
--    change "authorEmail" only to NULL and only on a row that is terminal after the update.
CREATE FUNCTION legal_entity_notice_author_email_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."authorEmail" IS DISTINCT FROM OLD."authorEmail"
     AND (NEW."authorEmail" IS NOT NULL OR NEW."status" NOT IN ('delivered', 'given_up')) THEN
    RAISE EXCEPTION 'legal_entity_notice.authorEmail may only be cleared, when the row reaches a terminal status'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "legal_entity_notice_author_email_guard"
  BEFORE UPDATE OF "authorEmail" ON "legal_entity_notice"
  FOR EACH ROW EXECUTE FUNCTION legal_entity_notice_author_email_guard();
-- 3. A terminal row holds no address (the dispatcher's clear, stated as a constraint). NOT VALID is not needed: step 1
--    cleared every existing row.
ALTER TABLE "legal_entity_notice"
  ADD CONSTRAINT "legal_entity_notice_authorEmail_terminal_null" CHECK ("status" = 'pending' OR "authorEmail" IS NULL);

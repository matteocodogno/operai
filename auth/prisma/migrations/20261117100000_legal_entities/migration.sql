-- CreateTable
CREATE TABLE "legal_entity_version" (
    "entity" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "legalName" TEXT NOT NULL,
    "addressIt" TEXT[],
    "addressEn" TEXT[],
    "vatNumber" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "contactsIt" TEXT NOT NULL,
    "contactsEn" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "restoredFrom" INTEGER,
    "changedFields" TEXT[],
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_entity_version_pkey" PRIMARY KEY ("entity","version")
);


-- ── Hand-appended raw SQL (Prisma cannot express CHECKs or triggers), same convention as
-- prisma/migrations/20260804094012_employee_address/migration.sql.
--
-- specs/20261117-legal-entities (T1, plan "Data model"; ADR 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database).
-- No length CHECKs: limits are the rules of a save (AC-1.3), and the move keeps values that break them (D3).
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_entity CHECK (entity IN ('welld_it','welld_ch'));
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_positive CHECK (version >= 1);
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_action CHECK (action IN ('import','save','restore'));
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_import_is_v1_by_system
  CHECK ((action = 'import') = ("createdByUserId" IS NULL) AND (action <> 'import' OR version = 1));
ALTER TABLE legal_entity_version ADD CONSTRAINT legal_entity_version_restore
  CHECK ((action = 'restore') = ("restoredFrom" IS NOT NULL) AND ("restoredFrom" IS NULL OR "restoredFrom" < version));

-- Tier 1 (ADR 20261117-legal-entity-registry-in-auth-...): rows are never changed or removed.
-- Row trigger for UPDATE and DELETE; statement trigger for TRUNCATE (which fires no row trigger).
CREATE FUNCTION legal_entity_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'legal_entity_version_immutable'; END $$;
CREATE TRIGGER legal_entity_version_no_update_delete BEFORE UPDATE OR DELETE ON legal_entity_version
  FOR EACH ROW EXECUTE FUNCTION legal_entity_version_immutable();
CREATE TRIGGER legal_entity_version_no_truncate BEFORE TRUNCATE ON legal_entity_version
  FOR EACH STATEMENT EXECUTE FUNCTION legal_entity_version_immutable();

-- specs/011-refund-settings (T2, ADR-0027/0029) — additive only, no backfill.

-- AlterTable: recipientEmailSnapshot is repurposed from a required
-- compile-time freeze (ADR-0021) to a nullable per-attempt delivery
-- provenance field (ADR-0029) — non-destructive, existing rows keep their
-- current value.
ALTER TABLE "refund_batch" ALTER COLUMN "recipientEmailSnapshot" DROP NOT NULL;

-- CreateTable
CREATE TABLE "refund_setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_setting_key_createdAt_idx" ON "refund_setting"("key", "createdAt");

-- ─── Refund-setting immutability (specs/011-refund-settings, AC-5.2, ADR-0027) ──
--
-- "refund_setting" is append-only at the DATABASE level, mirroring
-- "mileage_rate"'s own trigger (20260720170000_mileage_rate migration,
-- ADR-0018/0024) VERBATIM: a raising BEFORE trigger, not a silent
-- `CREATE RULE ... DO INSTEAD NOTHING`, so any inadvertent write attempt
-- fails loudly rather than being silently no-op'd.
--
-- Never add an UPDATE or DELETE route for "refund_setting" — this trigger is
-- the enforcement backstop, not a substitute for that omission. The only way
-- to change a setting's value going forward is to append a NEW row (AC-1.2/1.4).
CREATE FUNCTION refund_setting_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_setting rows are append-only and cannot be updated or deleted (id=%)', OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refund_setting_no_update
BEFORE UPDATE ON "refund_setting"
FOR EACH ROW EXECUTE FUNCTION refund_setting_immutable();

CREATE TRIGGER refund_setting_no_delete
BEFORE DELETE ON "refund_setting"
FOR EACH ROW EXECUTE FUNCTION refund_setting_immutable();

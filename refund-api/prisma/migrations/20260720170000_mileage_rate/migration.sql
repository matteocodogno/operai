-- AlterTable
ALTER TABLE "refund_line" ADD COLUMN     "appliedRateEntryId" TEXT,
ADD COLUMN     "appliedRateMicros" INTEGER,
ADD COLUMN     "appliedRateValidFrom" DATE;

-- CreateTable
CREATE TABLE "mileage_rate" (
    "id" TEXT NOT NULL,
    "entity" "Entity" NOT NULL,
    "currency" "Currency" NOT NULL,
    "ratePerKmMicros" INTEGER NOT NULL,
    "validFrom" DATE NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mileage_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mileage_rate_entity_validFrom_idx" ON "mileage_rate"("entity", "validFrom");

-- CreateIndex
CREATE INDEX "mileage_rate_entity_createdAt_idx" ON "mileage_rate"("entity", "createdAt");

-- CreateIndex
CREATE INDEX "refund_line_appliedRateEntryId_idx" ON "refund_line"("appliedRateEntryId");

-- AddForeignKey
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_appliedRateEntryId_fkey" FOREIGN KEY ("appliedRateEntryId") REFERENCES "mileage_rate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Mileage-rate immutability (specs/009-mileage-rate, AC-4.7/5.2, ADR-0018) ──
--
-- "mileage_rate" is append-only at the DATABASE level, not merely by the
-- absence of an UPDATE/DELETE route in refund-api itself (AC-4.7: "can never
-- be edited or deleted through the UI or its underlying API, by any user
-- including an admin"; AC-5.2 mirrors this for the rate-change audit
-- history, which this table doubles as — see schema.prisma's MileageRate
-- doc comment). Copies the `refund_audit_entry_immutable()` trigger pattern
-- (0001_init migration, ADR-0018 decision 2) VERBATIM: a raising BEFORE
-- trigger, not a silent `CREATE RULE ... DO INSTEAD NOTHING`, so any
-- inadvertent write attempt (a migration mistake, an ad hoc production
-- query, a future internal tooling script, a disaster-recovery restore)
-- fails loudly rather than being silently no-op'd.
--
-- Never add an UPDATE or DELETE route for "mileage_rate" — this trigger is
-- the enforcement backstop, not a substitute for that omission. The only way
-- to change policy going forward is to add a NEW entry (AC-4.2/4.8).
CREATE FUNCTION mileage_rate_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'mileage_rate rows are append-only and cannot be updated or deleted (id=%)', OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mileage_rate_no_update
BEFORE UPDATE ON "mileage_rate"
FOR EACH ROW EXECUTE FUNCTION mileage_rate_immutable();

CREATE TRIGGER mileage_rate_no_delete
BEFORE DELETE ON "mileage_rate"
FOR EACH ROW EXECUTE FUNCTION mileage_rate_immutable();

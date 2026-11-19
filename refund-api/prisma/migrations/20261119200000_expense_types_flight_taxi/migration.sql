-- specs/20261119-accounting (T58, sign-off round); plan 20261118 § "Accounting sign-off delta
-- (2026-11-19)", decision SO-1 and § Data model step 1.
--
-- Two new expense types, `travel_flight` and `travel_taxi`, placed right after
-- `travel_other_public_transport` (enum order = Settings and select order, AC-2.2). Additive:
-- nothing applied is edited, nothing is rewritten (the existing values and every stored line
-- keep their ids; AC-8.2).
--
-- Both statements position against a value that is already committed
-- (`travel_other_public_transport`), so neither new value is referenced inside this migration's
-- transaction ("unsafe use of new enum value"), and nothing here writes either value. The
-- statements run taxi first, then flight, so the enum reads
--   ... travel_other_public_transport, travel_flight, travel_taxi, company_manuals, ...

-- AlterEnum
ALTER TYPE "ExpenseType" ADD VALUE 'travel_taxi' AFTER 'travel_other_public_transport';

-- AlterEnum
ALTER TYPE "ExpenseType" ADD VALUE 'travel_flight' AFTER 'travel_other_public_transport';

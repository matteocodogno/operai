-- specs/20261117-legal-entities T29 (AC-6.1): the issuer's legal details moved to the registry in auth. A PUT /entity-profiles
-- no longer carries legalName / addressLines, so a profile row must be creatable without them: two column defaults.
-- Nothing is dropped and no row is touched (the four columns go in the contract step, plan step 6, a later release).

-- AlterTable
ALTER TABLE "entity_profile" ALTER COLUMN "legalName" SET DEFAULT '',
ALTER COLUMN "addressLines" SET DEFAULT ARRAY[]::TEXT[];

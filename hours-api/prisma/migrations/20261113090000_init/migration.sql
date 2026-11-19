-- CreateEnum
CREATE TYPE "TimeTarget" AS ENUM ('project', 'deal', 'meeting', 'none');

-- CreateEnum
CREATE TYPE "WorkTypeList" AS ENUM ('project', 'deal');

-- CreateTable
CREATE TABLE "time_entry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "target" "TimeTarget" NOT NULL,
    "projectId" TEXT,
    "dealId" TEXT,
    "meetingId" TEXT,
    "categoryId" TEXT,
    "workTypeId" TEXT,
    "activityId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "retiredAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_type" (
    "id" TEXT NOT NULL,
    "list" "WorkTypeList" NOT NULL,
    "name" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_type_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entry_userId_day_idx" ON "time_entry"("userId", "day");

-- CreateIndex
CREATE INDEX "time_entry_projectId_day_idx" ON "time_entry"("projectId", "day");

-- CreateIndex
CREATE INDEX "time_entry_dealId_day_idx" ON "time_entry"("dealId", "day");

-- CreateIndex
CREATE INDEX "time_entry_meetingId_idx" ON "time_entry"("meetingId");

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "time_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_workTypeId_fkey" FOREIGN KEY ("workTypeId") REFERENCES "work_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Case-insensitive unique names (specs/029 plan § Data model) ─────────────
-- Prisma cannot express an index on an expression. A name is unique per list, whatever its
-- case and whether or not it is retired, so a restore alone can never collide (AC-3.1).
CREATE UNIQUE INDEX "time_category_name_lower_key" ON "time_category" (lower("name"));

CREATE UNIQUE INDEX "work_type_list_name_lower_key" ON "work_type" ("list", lower("name"));

-- ─── CHECK constraints (specs/029 plan § Data model) ─────────────────────────
-- Prisma cannot express these; they are the ENFORCEMENT, and src/db.constraints.test.ts
-- proves each one refuses its violating row.

-- A duration is 30 minutes to 24 hours in whole 30-minute steps (AC-1.2, A9), a duration only,
-- never a start or an end time (AC-1.8).
ALTER TABLE "time_entry"
  ADD CONSTRAINT "time_entry_minutes"
    CHECK ("minutes" BETWEEN 30 AND 1440 AND "minutes" % 30 = 0);

-- A note is at most 1000 characters, counted as characters and not bytes (AC-1.7, A16).
ALTER TABLE "time_entry"
  ADD CONSTRAINT "time_entry_note_length"
    CHECK ("note" IS NULL OR char_length("note") <= 1000);

-- An entry is on exactly one of a project, a deal, a meeting or no entity: it carries exactly
-- that target's id and no other. An entry on no entity must have a category and every other
-- target has none; a meeting and no entity carry no work type, a project or a deal may
-- (AC-2.1, AC-3.5). Whether the work type comes from the list that matches the target is an
-- application rule: it needs the work type's row.
ALTER TABLE "time_entry"
  ADD CONSTRAINT "time_entry_target_shape"
    CHECK (("target" = 'project' AND "projectId" IS NOT NULL AND "dealId" IS NULL AND "meetingId" IS NULL
              AND "categoryId" IS NULL)
        OR ("target" = 'deal' AND "dealId" IS NOT NULL AND "projectId" IS NULL AND "meetingId" IS NULL
              AND "categoryId" IS NULL)
        OR ("target" = 'meeting' AND "meetingId" IS NOT NULL AND "projectId" IS NULL AND "dealId" IS NULL
              AND "categoryId" IS NULL AND "workTypeId" IS NULL)
        OR ("target" = 'none' AND "categoryId" IS NOT NULL AND "workTypeId" IS NULL AND "projectId" IS NULL
              AND "dealId" IS NULL AND "meetingId" IS NULL));

-- An activity pointer exists only on a project or a deal entry (AC-2.7).
ALTER TABLE "time_entry"
  ADD CONSTRAINT "time_entry_activity_target"
    CHECK ("activityId" IS NULL OR "target" IN ('project', 'deal'));

-- ─── The initial lists (A15, AC-3.7) ─────────────────────────────────────────
-- Fixed ids, so a test or a screen can name a seeded row; `createdBy` says the migration made
-- them. "Other" requires a note (A7). Nothing here is ever deleted: nobody can delete a
-- category or a work type (AC-3.2), they are retired.
INSERT INTO "time_category" ("id", "name", "requiresNote", "createdBy", "updatedAt") VALUES
  ('tc-training',         'Training',         false, 'system:migration', CURRENT_TIMESTAMP),
  ('tc-talk-preparation', 'Talk preparation', false, 'system:migration', CURRENT_TIMESTAMP),
  ('tc-administration',   'Administration',   false, 'system:migration', CURRENT_TIMESTAMP),
  ('tc-other',            'Other',            true,  'system:migration', CURRENT_TIMESTAMP);

INSERT INTO "work_type" ("id", "list", "name", "createdBy", "updatedAt") VALUES
  ('wt-project-development', 'project', 'Development',        'system:migration', CURRENT_TIMESTAMP),
  ('wt-project-analysis',    'project', 'Analysis',           'system:migration', CURRENT_TIMESTAMP),
  ('wt-project-management',  'project', 'Project management', 'system:migration', CURRENT_TIMESTAMP),
  ('wt-project-support',     'project', 'Support',            'system:migration', CURRENT_TIMESTAMP),
  ('wt-deal-analysis',       'deal',    'Analysis',           'system:migration', CURRENT_TIMESTAMP),
  ('wt-deal-estimate',       'deal',    'Estimate',           'system:migration', CURRENT_TIMESTAMP),
  ('wt-deal-demo',           'deal',    'Demo',               'system:migration', CURRENT_TIMESTAMP),
  ('wt-deal-offer',          'deal',    'Offer',              'system:migration', CURRENT_TIMESTAMP);

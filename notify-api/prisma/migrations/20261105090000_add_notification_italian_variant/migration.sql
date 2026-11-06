-- AlterTable
-- specs/021-meetings, ADR-0065: optional Italian rendering of a notification,
-- chosen by the reader. Additive and nullable: existing rows and callers are
-- unaffected, and a deploy can roll back by ignoring the columns.
ALTER TABLE "notification" ADD COLUMN     "bodyIt" TEXT,
ADD COLUMN     "titleIt" TEXT;

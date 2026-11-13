/**
 * What the list routes answer (specs/029 plan § Lists): a category and a work type as the screens
 * read them. `retired` is a boolean on the wire; the row keeps the instant (`retiredAt`), which no
 * screen shows.
 */

import { z } from "@hono/zod-openapi";

export type WorkTypeList = "project" | "deal";

export const CategoryViewSchema = z
  .object({
    id: z.string(),
    name: z.string().describe("Exactly as the admin typed it, trimmed only at the ends (AC-3.8)"),
    requiresNote: z.boolean().describe("An entry with this category must carry a note (AC-3.6)"),
    retired: z.boolean(),
  })
  .openapi("CategoryView");

export const WorkTypeViewSchema = z
  .object({
    id: z.string(),
    list: z.enum(["project", "deal"]),
    name: z.string().describe("Exactly as the admin typed it, trimmed only at the ends (AC-3.8)"),
    retired: z.boolean(),
  })
  .openapi("WorkTypeView");

export const TimeListsViewSchema = z
  .object({
    categories: z.array(CategoryViewSchema),
    workTypes: z.object({ project: z.array(WorkTypeViewSchema), deal: z.array(WorkTypeViewSchema) }),
  })
  .openapi("TimeListsView");

export type CategoryView = z.infer<typeof CategoryViewSchema>;
export type WorkTypeView = z.infer<typeof WorkTypeViewSchema>;
export type TimeListsView = z.infer<typeof TimeListsViewSchema>;

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly requiresNote: boolean;
  readonly retiredAt: Date | null;
}

interface WorkTypeRow {
  readonly id: string;
  readonly list: WorkTypeList;
  readonly name: string;
  readonly retiredAt: Date | null;
}

export const toCategoryView = (row: CategoryRow): CategoryView => ({
  id: row.id,
  name: row.name,
  requiresNote: row.requiresNote,
  retired: row.retiredAt !== null,
});

export const toWorkTypeView = (row: WorkTypeRow): WorkTypeView => ({
  id: row.id,
  list: row.list,
  name: row.name,
  retired: row.retiredAt !== null,
});

/**
 * Request and response shapes of the project routes (specs/021-projects, tasks.md § API
 * contracts). The type and state vocabularies live here so the transition and contract
 * routes (T6, T8) reuse them.
 */

import { z } from "@hono/zod-openapi";
import {
  EntitySchema,
  IdSchema,
  PersonSchema,
  pageOf,
  pageQuery,
  requiredText,
} from "../lib/http";

export const PROJECT_TYPES = ["t_and_m", "fixed_price", "maintenance", "saas", "internal"] as const;
export const ProjectTypeSchema = z.enum(PROJECT_TYPES);
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

/** Client projects have one company of their own (AC-1.1); `saas` and `internal` have none. */
export const CLIENT_TYPES: readonly ProjectType[] = ["t_and_m", "fixed_price", "maintenance"];
export const isClientType = (type: ProjectType): boolean => CLIENT_TYPES.includes(type);

export const PROJECT_STATES = ["planned", "active", "on_hold", "closed", "cancelled"] as const;
export const ProjectStateSchema = z.enum(PROJECT_STATES);
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const ContractOriginSchema = z.enum(["manual", "deal"]);

/** `name` is `null` when crm-api cannot answer (fail soft) or no longer knows the company. */
export const CompanyRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

const DateOnlyOrNull = z.string().nullable();

export const ContractSummarySchema = z.object({
  id: z.string(),
  type: ProjectTypeSchema,
  company: CompanyRefSchema,
  origin: ContractOriginSchema,
  bexioOrderId: z.string().nullable(),
  startDate: z.string(),
  endDate: DateOnlyOrNull,
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ProjectTypeSchema,
  state: ProjectStateSchema,
  /** The state an `on_hold` project left, the one it can return to; `null` in every other state. */
  stateBeforeHold: ProjectStateSchema.nullable(),
  entity: EntitySchema,
  company: CompanyRefSchema.nullable(),
  projectManager: PersonSchema,
  team: z.array(PersonSchema),
  contracts: z.array(ContractSummarySchema),
  /** Earliest contract start; `null` with no contract. */
  startDate: DateOnlyOrNull,
  /** Latest contract end; `null` with no contract or when any contract is open-ended. */
  endDate: DateOnlyOrNull,
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ProjectTypeSchema,
  state: ProjectStateSchema,
  entity: EntitySchema,
  company: CompanyRefSchema.nullable(),
  /** Distinct companies across the project's contracts (what a `saas` row shows). */
  clientCount: z.number().int(),
  projectManager: PersonSchema,
});

/** 25 per page, fixed (AC-1.4): `page` is the only paging input. */
export const ListProjectsQuery = z.object({
  page: pageQuery().page,
  q: z.string().max(200).optional(),
  type: ProjectTypeSchema.optional(),
  state: ProjectStateSchema.optional(),
  projectManagerId: IdSchema.optional(),
});

export const ProjectPageSchema = pageOf(ProjectSummarySchema);

/** The distinct project managers of all projects: what feeds the list's project-manager filter. */
export const ProjectManagersSchema = z.object({ items: z.array(PersonSchema) });

export const CreateProjectSchema = z
  .object({
    name: requiredText(200),
    type: ProjectTypeSchema,
    entity: EntitySchema,
    companyId: IdSchema.optional(),
    projectManagerId: IdSchema.optional(),
  })
  .strict();

/** The entity, company and type are fixed at creation (tasks.md); only these two change here. */
export const UpdateProjectSchema = z
  .object({
    name: requiredText(200).optional(),
    projectManagerId: IdSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.projectManagerId !== undefined, "Nothing to change");

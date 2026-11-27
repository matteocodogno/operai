/**
 * Request and response shapes of the project routes (specs/20261103-projects, tasks.md § API
 * contracts, as changed by specs/20261103-projects-handoff T23: a project has 0..1 terms and 0..1 purchase order). The type
 * and state vocabularies live here so the transition, terms and take routes reuse them.
 */

import { z } from "@hono/zod-openapi";
import {
  EntitySchema,
  IdSchema,
  PersonSchema,
  pageOf,
  pageQuery,
  requiredText,
  searchText,
} from "../lib/http";
import { CreateTermsSchema } from "../terms/terms.schemas";

export const PROJECT_TYPES = ["t_and_m", "fixed_price", "maintenance", "saas", "internal"] as const;
export const ProjectTypeSchema = z.enum(PROJECT_TYPES);
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

/**
 * Client projects have one company of their own (AC-1.1, specs/20261103-projects-handoff D40): every type but `internal`,
 * `saas` included (one project per licence).
 */
export const CLIENT_TYPES: readonly ProjectType[] = ["t_and_m", "fixed_price", "maintenance", "saas"];
export const isClientType = (type: ProjectType): boolean => CLIENT_TYPES.includes(type);

export const PROJECT_STATES = ["planned", "active", "on_hold", "closed", "cancelled"] as const;
export const ProjectStateSchema = z.enum(PROJECT_STATES);
export type ProjectState = z.infer<typeof ProjectStateSchema>;

/** `name` is `null` when crm-api cannot answer (fail soft) or no longer knows the company. */
export const CompanyRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

const DateOnlyOrNull = z.string().nullable();

/**
 * The deal a purchase order was made from, read live from the CRM on every request (specs/20261103-projects-handoff):
 * `title` and `won` are `null` when crm-api cannot answer or no longer knows the deal; `won: false`
 * is the "no longer won" notice (AC-2.3).
 */
export const DealRefSchema = z.object({ id: z.string(), title: z.string().nullable(), won: z.boolean().nullable() });
export type DealRef = z.infer<typeof DealRefSchema>;

// ─── Terms (output): the type-specific `terms` nested, every member present, `null` when absent ─────────

const SlaView = z.object({ highDays: z.number().int(), normalDays: z.number().int() });
/**
 * The window of an hour package that is current today, derived on read at the Europe/Zurich business day, never stored
 * (specs/20261112-project-hours AC-1.1 – AC-1.3, AC-1.9, `terms/packagePeriod.ts`): both dates inclusive, `ended` true only for
 * a capacity package past its expiry, whose final window it is (D83). `null` before the package's start date (A51).
 */
const PackagePeriodSchema = z.object({ from: z.string(), to: z.string(), ended: z.boolean() });

const HourPackageView = z.object({
  hours: z.number().int(),
  kind: z.enum(["capacity", "yearly"]),
  startDate: z.string(),
  expiryDate: z.string().nullable(),
  currentPeriod: PackagePeriodSchema.nullable(),
});

/** By type: fixed price, SLA and hours (maintenance, saas), positions (t_and_m); `{}` for none. */
export const TermsViewSchema = z.union([
  z.object({ deadline: z.string(), estimatedManDays: z.number().nullable(), maxEffortManDays: z.number() }),
  z.object({ sla: SlaView.nullable(), hourPackage: HourPackageView.nullable() }),
  z.object({ positions: z.array(z.object({ profile: z.string(), plannedManDays: z.number() })) }),
  z.object({}),
]);

/** The delivery terms of a project (specs/20261103-projects's contract shape, renamed): the dates and the nested terms. */
export const TermsSchema = z.object({
  id: z.string(),
  type: ProjectTypeSchema,
  startDate: z.string(),
  endDate: DateOnlyOrNull,
  terms: TermsViewSchema,
  version: z.number().int(),
});

// ─── Purchase order (output) ─────────────────────────────────────────────────

/**
 * The referent, read live from the CRM (specs/20261103-projects-handoff D49, T26): `null` members when `unavailable`. The
 * `PurchaseOrder`'s `referent` is `null` when none is set or the CRM no longer has the contact.
 */
export const ReferentSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "unavailable"]),
  name: z.string().nullable(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
export type ReferentView = z.infer<typeof ReferentSchema>;

/** A contact as the referent picker lists it: no email, phone, company or archived flag (T18 M2). */
export const ContactChoicesSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), jobTitle: z.string().nullable() })),
});

/** The delivery-side record of one won deal (specs/20261103-projects-handoff D38). */
export const PurchaseOrderSchema = z.object({
  id: z.string(),
  deal: DealRefSchema,
  /** The deal's EstimAI estimate at creation (AC-3.2); `null` for a deal without one. */
  estimate: z.object({ id: z.string() }).nullable(),
  bexioOrderId: z.string().nullable(),
  referent: ReferentSchema.nullable(),
  opsManager: PersonSchema,
  version: z.number().int(),
});

// ─── Project ─────────────────────────────────────────────────────────────────

/** One member of an attached team as the page shows it (specs/20261126-teams D10): name and flags from auth's team read. */
export const TeamMemberViewSchema = z.object({
  id: z.string(),
  /** `null` for a deactivated member. */
  name: z.string().nullable(),
  deleted: z.boolean(),
  /** Holds access to Projects: a member without it is attached but not on the project (AC-4.7). */
  projectsAccess: z.boolean(),
});

/**
 * A team attached to a project. Projects keep no copy of a name or a member (AC-1.3, O6): `name` and `archived` are
 * `null` together when the team could not be read (D9), `members` is `null` when they "could not be loaded" (AC-5.4).
 */
export const AttachedTeamViewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  archived: z.boolean().nullable(),
  members: z.array(TeamMemberViewSchema).nullable(),
});

/** Why the page's team read did not complete (D15). A closed enum: a new value is a contract change. */
export const TEAMS_STATUSES = ["complete", "unavailable", "rate_limited"] as const;
export const TeamsStatusSchema = z.enum(TEAMS_STATUSES);
export type TeamsStatus = z.infer<typeof TeamsStatusSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ProjectTypeSchema,
  state: ProjectStateSchema,
  /** The state an `on_hold` project left, the one it can return to; `null` in every other state. */
  stateBeforeHold: ProjectStateSchema.nullable(),
  entity: EntitySchema,
  company: CompanyRefSchema.nullable(),
  /** `null` only while a project made from a deal awaits its project manager (specs/20261103-projects-handoff D42). */
  projectManager: PersonSchema.nullable(),
  /** The project has a purchase order and no project manager yet. */
  awaitingProjectManager: z.boolean(),
  team: z.array(PersonSchema),
  /** The attached teams, in attach order (specs/20261126-teams). */
  teams: z.array(AttachedTeamViewSchema),
  /** Who is on the project: manager, listed members, counted team members, each once (AC-4.4); the known part when incomplete. */
  onProject: z.array(PersonSchema),
  /** False when an attached team's members could not be loaded. */
  onProjectComplete: z.boolean(),
  teamsStatus: TeamsStatusSchema,
  /** Whole seconds until the person's own limit lets the page read teams again, 1..600; set exactly with `rate_limited` (D15). */
  teamsRetryAfterSeconds: z.number().int().min(1).max(600).nullable(),
  /** `null` for a hand-made project, which never has one (D38), and for a project taken from a tender (US-10). */
  purchaseOrder: PurchaseOrderSchema.nullable(),
  /** The CRM tender deal this project was taken from (specs/20261101-crm US-10); `null` otherwise. */
  tenderDealId: z.string().nullable(),
  /** Always set on a project made from a deal; optional on a hand-made one (D50). */
  terms: TermsSchema.nullable(),
  /** The terms' start; `null` without terms. */
  startDate: DateOnlyOrNull,
  /** The terms' end; `null` without terms or when open-ended. */
  endDate: DateOnlyOrNull,
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** The invariants of the team fields (plan § "The project view's team read"), for tests and for whoever builds a view. */
export const ProjectTeamsInvariants = ProjectSchema.superRefine((view, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((view.teamsStatus === "complete") !== view.onProjectComplete) issue("teamsStatus is complete exactly when onProjectComplete");
  if ((view.teamsRetryAfterSeconds !== null) !== (view.teamsStatus === "rate_limited")) {
    issue("teamsRetryAfterSeconds is set exactly with rate_limited");
  }
  if (view.teamsStatus === "rate_limited" && view.teams.length === 0) issue("rate_limited only when there are teams");
});

/** The teams of a project, replaced as a whole (specs/20261126-teams AC-4.1): at most 10 (O9). */
export const MAX_ATTACHED_TEAMS = 10;
export const PutTeamsSchema = z.object({ teamIds: z.array(IdSchema).max(MAX_ATTACHED_TEAMS) }).strict();

/** The attach picker's search text: raw at most 200 and no NUL, then trimmed to at most 80; blank is no search (D13). */
export const AttachableTeamsQuery = z.object({
  q: searchText(200)
    .transform((value) => value.trim())
    .pipe(z.string().max(80))
    .optional(),
});

export const AttachableTeamsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
  truncated: z.boolean(),
});

/**
 * The distinct teams attached to at least one project: what feeds the list's team filter (AC-4.8). A name is `null` (and
 * `archived` with it) when the team could not be read: unknown is not a name, and the list still loads (AC-5.4).
 */
export const AttachedTeamsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string().nullable(), archived: z.boolean().nullable() })),
});

export const ProjectListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ProjectTypeSchema,
  state: ProjectStateSchema,
  entity: EntitySchema,
  /** Every project but an `internal` one has its company, a `saas` licence included. */
  company: CompanyRefSchema.nullable(),
  projectManager: PersonSchema.nullable(),
  awaitingProjectManager: z.boolean(),
});

/** 25 per page, fixed (AC-1.4): `page` is the only paging input. */
export const ListProjectsQuery = z.object({
  page: pageQuery().page,
  q: searchText(200).optional(),
  type: ProjectTypeSchema.optional(),
  state: ProjectStateSchema.optional(),
  projectManagerId: IdSchema.optional(),
  /** Only the projects this team is attached to (specs/20261126-teams AC-4.8): a local filter, archived teams included. */
  teamId: IdSchema.optional(),
});

export const ProjectPageSchema = pageOf(ProjectListItemSchema);

/** The distinct project managers of all projects: what feeds the list's project-manager filter. */
export const ProjectManagersSchema = z.object({ items: z.array(PersonSchema) });

/**
 * A hand-made project: any type, a company for every client type, and optionally its terms (specs/20261103-projects-handoff D50,
 * A38). `terms` is the contract shape of `POST /projects/{id}/terms`, `{ startDate, endDate?, terms? }`, nested
 * as the take of a deal nests it: a refusal names the field by its path in this body (`terms.startDate`,
 * `terms.terms.deadline`). Optional as a whole; an `internal` project takes none.
 */
export const CreateProjectSchema = z
  .object({
    name: requiredText(200),
    type: ProjectTypeSchema,
    entity: EntitySchema,
    companyId: IdSchema.optional(),
    projectManagerId: IdSchema.optional(),
    terms: CreateTermsSchema.optional(),
  })
  .strict();

/**
 * The entity, company and type are fixed at creation (specs/20261103-projects-handoff A30); only these two change here. `null` is
 * accepted so that clearing the project manager is the domain refusal `422 project_manager_required` (AC-4.9),
 * not a `400`.
 */
export const UpdateProjectSchema = z
  .object({
    name: requiredText(200).optional(),
    projectManagerId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.projectManagerId !== undefined, "Nothing to change");

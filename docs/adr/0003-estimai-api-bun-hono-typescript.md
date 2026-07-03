# 0003 — estimai-api is Bun + Hono + TypeScript, not Kotlin/Spring Boot

**Date:** 2026-07-03  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai — EstimAI

---

## Context

`estimai-api` (the estimate-persistence backend, spec 001) does not exist yet — the
directory is empty. The Operai monorepo previously described it as a planned
Kotlin/Spring Boot service (Spring Boot 3.x, Kotlin, JPA, Flyway). The `auth`
service, already in production, is Bun + Hono + TypeScript + Prisma + Effect TS and
covers the same cross-cutting concerns (env validation, Prisma migrations, RFC 7807
errors, CORS, OpenAPI via `@hono/zod-openapi`). The entire job of `estimai-api` in
this iteration is JWT-verified JSONB CRUD across six endpoints — no compute-heavy or
JVM-ecosystem-specific requirement exists.

## Decision

We will build `estimai-api` as **Bun + Hono + TypeScript**, mirroring the `auth`
service exactly: `@hono/zod-openapi` for OpenAPI (Scalar at `/docs`), Prisma 7 +
`@prisma/adapter-pg` for persistence, Effect TS for DB effects, and RFC 7807 Problem
JSON for all error responses. The `auth` skeleton (env validation, db client, errors
module, global `onError`/`notFound`, CORS with `credentials: true`) is the scaffold
template, not a greenfield.

## Options considered

### Option A — Bun + Hono + TypeScript (chosen)

Mirror the existing `auth` service: same runtime, framework, ORM, error model, and
OpenAPI toolchain.

**Pros:**
- One backend language, build system, runtime, and test toolchain across the entire
  monorepo — no context-switching cost for the team
- The `auth` skeleton is a proven, production-deployed template; scaffolding
  `estimai-api` from it is lower risk than greenfielding a second stack
- Prisma migrations, env-validation patterns, Effect-wrapped DB calls, and the
  RFC 7807 error shape are already understood and documented
- Bun's built-in test runner (`bun test`) unifies the test toolchain with `auth`;
  no Gradle or Maven wrapper to manage
- Deployment recipe (Railway EU, env-var secrets via 1Password/direnv) is identical
  to `auth` — one deploy playbook for both services

**Cons:**
- Bun is younger than the JVM; if a future requirement needs a JVM library (e.g.
  a Kotlin-native PDF or actuarial computation library), this choice would need
  revisiting
- The team's `estimai-api` TypeScript types must be kept in sync with the
  `EstimateContent` shape on the `estimai-ui` side manually (no shared codegen across
  repos in this iteration)

### Option B — Kotlin + Spring Boot 3.x (rejected)

The original planned stack: Kotlin, Spring Boot, Spring Data JPA, Flyway, Gradle.

**Pros:**
- Mature ecosystem with deep Spring Security / JWT verification support
- JVM type safety and Kotlin null safety across the service

**Cons:**
- Introduces a second language, build system (Gradle), and runtime (JVM) into a
  monorepo where every other service is TypeScript/Bun
- All cross-cutting concerns already solved in `auth` (env validation, RFC 7807
  errors, CORS, OpenAPI) would have to be re-implemented in idiomatic Spring/Kotlin
  equivalents — no requirement in spec 001 justifies that cost
- JVM cold-start and memory footprint are materially larger than Bun for a service
  whose load in this iteration is low
- Prisma (chosen for `auth`) has no Kotlin client; switching to Hibernate/JPA or
  jOOQ would be a third persistence idiom in the monorepo
- Rejected: no requirement pull; pure duplication cost

### Option C — Drizzle ORM instead of Prisma (rejected)

An alternative TypeScript ORM considered during stack selection, regardless of
runtime.

**Pros:**
- Lighter generated surface; SQL-closer query style preferred by some engineers

**Cons:**
- `auth` uses Prisma with `@prisma/adapter-pg`; adopting Drizzle in `estimai-api`
  introduces a second ORM idiom, a second migration convention, and a second
  generated-client pattern for no concrete gain in this iteration
- Prisma's `Json` field type and `@@index` syntax already model the JSONB document
  shape required by spec 001 cleanly
- Rejected: second ORM idiom, no gain

## Consequences

**Positive:**
- The monorepo has one backend stack — any engineer familiar with `auth` can
  contribute to `estimai-api` immediately
- The `auth` skeleton (env/db/errors/openapi/onError/CORS) is copied and adapted,
  not invented; bootstrapping risk is low
- This decision supersedes the earlier Kotlin/Spring Boot intention documented in
  `CLAUDE.md`; that reference has been updated to reflect Bun + Hono
- Future Operai resource services (ReviewAI, RetroAI, ProposAI backends) have a
  clear, proven template to follow

**Negative / trade-offs:**
- The TypeScript `EstimateContent` type definition must be kept manually in sync
  between `estimai-api` (source of truth for API contracts) and `estimai-ui`
  (consumer); no shared package in this iteration
- Any future requirement that genuinely needs the JVM ecosystem would require a
  rethink — this choice is optimised for the current iteration's scope

**Risks:**
- **Bun runtime maturity:** Bun is production-ready but younger than Node; some npm
  packages have Bun-specific edge cases. Mitigation: `auth` already validates Bun
  in production; the same package set is reused.
- **Schema drift between services:** `estimai-api/prisma/schema.prisma` is separate
  from `auth/prisma/schema.prisma`; migrations must never be cross-applied.
  Mitigation: each service owns its own `prisma/` directory and its own database
  (`estimai` schema, separate from the `auth` tables).

## Compliance notes

- GDPR/nLPD impact: none — this is a stack choice; data handling rules are
  governed by ADR-0004 (storage shape) and the data-residency constraint in spec 001
- Data residency: `estimai-api` must deploy to an EU region (Railway EU) regardless
  of stack — this decision does not affect that constraint
- Audit trail: not required for this decision

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

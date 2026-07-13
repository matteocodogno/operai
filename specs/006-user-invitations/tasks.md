---
spec: 006
generated: 2026-07-14
---

# Tasks: User invitations, resend, and user deletion

Derived from `plan.md` (approved) + `design.md`. Domains: **BE** = backend-dev
(auth / notify-api, Bun+Hono+Prisma), **FE** = frontend-dev (admin-ui, React+Vite+MF),
**DevOps** = devops (env/compose/mise/infra docs).

Tracks: **N** notify-api email channel · **A** auth invitation lifecycle · **B** auth
delete+hooks · **U** admin-ui · **E** infra. Files shared *within* a service
(auth `src/index.ts`, `auth/src/auth/auth.config.ts`; admin-ui routing/`UsersSubNav`) are
owned by a single track to avoid collisions.

---

- [x] T1: notify-api `EmailDelivery` model + migration — refs: US-2 (enabler), AC-2.1 — deps: none
  - touch: `notify-api/prisma/schema.prisma`, `notify-api/prisma/migrations/*`
  - `EmailDelivery` per plan §Data model (to, template, status, providerId?, error?, createdAt, `@@index([to, createdAt desc])`)
  - done when: `bun run db:migrate` applies; Prisma client generates

- [x] T2: notify-api channel abstraction + Resend client — refs: US-2, Constraint (notify-api 2nd channel) — deps: T1
  - touch: `notify-api/src/channels/` (a small interface: `inApp` = today's behaviour refactored behind it, `recipientId=sub`, persist+SSE; `email` = new, raw-address, render→Resend→`EmailDelivery`), `notify-api/src/lib/resend.ts`, env (`RESEND_API_KEY`, `RESEND_FROM`, `EMAIL_ENABLED`)
  - `EMAIL_ENABLED` off in test/local (no key) → email channel stubs the send, records `EmailDelivery` `sent` with a synthetic id. The existing `POST /notifications` keeps using `inApp` UNCHANGED.
  - done when: `bun run typecheck` clean, `bun test` green (unit: email channel records delivery; inApp unchanged)

- [x] T3: notify-api `POST /system/emails` internal endpoint + bilingual templates — refs: AC-2.1, Security R2 — deps: T2
  - touch: `notify-api/src/system/emails.routes.ts` (+ register in `src/index.ts`), `internalTokenMiddleware` (validates `X-Internal-Token` == `NOTIFY_INTERNAL_TOKEN`; NOT jwtMiddleware; user-JWT routes never accept it and `/system/*` never accepts a user JWT), bilingual (IT+EN in one email) `invitation`/`invitation_resend` templates with escaped `to`/`inviteUrl`/`inviterName`/`expiresAt`
  - done when: integration tests — valid token → send (stub/real) 200 `{deliveryId,status}`; missing/wrong token → 401; a user JWT is rejected on `/system/*`; bad `to`/`template` → 400; Resend failure surfaced as `{status:"failed"}` (never a 5xx that fails the caller)

- [x] T4: auth `Invitation` model + `User` soft-delete columns + migration — refs: US-1, US-5 — deps: none
  - touch: `auth/prisma/schema.prisma`, `auth/prisma/migrations/*`
  - `Invitation` (email, status pending|accepted|revoked, roleIds[]/departmentIds[], tokenHash, expiresAt, invitedBy/acceptedBy FKs SetNull, lastEmailStatus/Error, timestamps) + the **partial-unique index** appended as raw SQL to the new migration: `CREATE UNIQUE INDEX invitation_pending_email_key ON invitation (email) WHERE status = 'pending';`; `User.deletedAt?`/`deletedByUserId?` + `@@index([deletedAt])`. `deletedAt` nullable/no default (no backfill, R7). Never edit existing migrations.
  - done when: `bun run db:migrate` applies both the model + the partial-unique index; client generates

- [x] T5: auth invitation domain — refs: US-1, US-4 — deps: T4
  - touch: `auth/src/invitations/` (`invitations.repo.ts`, `invitations.schemas.ts`, invite-link token helper [≥32-byte CSPRNG, sha256 `tokenHash`, rotate], effective-status derivation `status=='pending' && expiresAt<=now ? 'expired' : status`, reconcile-on-write helper that flips past-expiry `pending` rows to a terminal state before insert)
  - done when: `bun test` — token hash/rotate, effective-status derivation (incl. expired), reconcile-on-write helper; `bun run typecheck` clean

- [x] T6: auth invitation admin API + notify email trigger — refs: US-1 (1.1–1.14), US-3 (3.1–3.6), US-4 — deps: T5, T3
  - touch: `auth/src/invitations/invitations.routes.ts` (+ register in `src/index.ts` under the requireAdmin chain), `auth/src/lib/notify.ts` (calls notify-api `POST /system/emails` with `X-Internal-Token`, `NOTIFY_INTERNAL_URL`/`NOTIFY_INTERNAL_TOKEN` env)
  - `POST /admin/invitations` (validate role/dept ids → 422; 409 active-user / live-pending; reconcile-on-write; create pending+token+72h; audit; call notify; store `lastEmailStatus`; 201 with `emailDelivery`), `GET /admin/invitations?page&pageSize&status?&q?` (paginated, effective status, q on email), `POST .../{id}/resend` (rotate token, +72h, re-send; 422 if accepted/revoked), `POST .../{id}/revoke` (terminal; 422 if accepted/revoked); each writes `audit_log`
  - done when: integration tests cover AC-1.1..1.14, 3.1..3.6, 4.1..4.4 (see plan test table) incl. non-admin→403 and the email-failure-still-201 path (notify mocked)

- [x] T7: auth soft-delete user endpoints + guards — refs: US-5 (5.1,5.3–5.9), US-6 (6.1–6.5) — deps: T4
  - touch: `auth/src/admin/users.routes.ts` (`DELETE /admin/users/{id}` single soft-delete; `POST /admin/users/delete` bulk partial-success; filter `deletedAt:null` from `GET /admin/users` + 404 soft-deleted on detail), `auth/src/admin/lastAdminGuard.ts` (admin-count queries gain `deletedAt:null`)
  - per-delete tx: self-delete guard (`caller.id!==target` → 422, absolute, single+bulk); last-admin guard (422); set `deletedAt`/`deletedByUserId`; **synchronous** `session.deleteMany({userId})`; perm_epoch bump; `withAudit` `user.delete`. Bulk = per-user tx, individually audited, skip-and-report `{deleted,skipped:[{userId,reason}]}`; acting admin ALWAYS excluded
  - done when: integration tests cover AC-5.1,5.3–5.9, 6.1–6.5 (plan table) incl. non-admin→403, self+last-admin skipped in bulk, retained data

- [x] T8: auth better-auth activation hooks — refs: US-2 (2.3, 2.4), AC-5.2, AC-5.10 — deps: T5, T7
  - touch: `auth/src/auth/auth.config.ts` (`databaseHooks`)
  - **FIRST: spike R1** — confirm better-auth 1.6.x `session.create.before` can ABORT session creation (return `false` vs throw vs `{}`); if unsupported, use the documented fallback (`session.create.after` + immediate `session.delete` + denied-redirect). State what you found.
  - `user.create.after`: after baseline-role assignment, match a live-pending invite by the **verified** email (`emailVerified===true`) → apply invite roleIds/departmentIds (additive to baseline `employee` per R9 — flag for QE), mark accepted + acceptedByUserId, bump perm_epoch, audit. AC-2.4 holds structurally (keys on new user's own verified email, never the link token).
  - `session.create.before`: `deletedAt!=null` → look for live-pending invite → found = re-activate (clear deletedAt, **replace** roles/depts with invite's set, perm_epoch bump, accept, audit, allow) / not found = **deny** the session (AC-5.2, no resurrection, no new user row)
  - done when: integration tests (hook+DB) cover AC-2.3, 2.4, 5.2, 5.10; the R1 finding documented in the task/commit

- [x] T9: auth hosted invite landing page — refs: US-2 (2.2, 2.5), AC-1.9 state — deps: T5
  - touch: `auth/src/invite/` (`GET /invite?id&token` Hono JSX bilingual, ADR-0002 precedent; `GET /invite/state?id&token` JSON `{state,email?}`), register in `src/index.ts`
  - hashes token, looks up by id, renders effective state: pending+match → "continue with Google/GitHub" wired to existing `POST /auth/sign-in/social` w/ callbackURL; expired/revoked/accepted/token-mismatch → safe "no longer valid"; email only disclosed on a valid pending token; no enumeration; escape `email`/`inviterName`
  - done when: integration tests — each state renders correctly; old-token-post-resend → invalid; no email leak on invalid; `bun run typecheck` clean

- [x] T10: admin-ui user soft-delete UI + UsersSubNav + modal extension — refs: US-5 (5.7) — deps: T7
  - touch: `admin-ui/src/components/ConfirmDeleteModal.tsx` (add optional `body` prop, backward-compatible — soft-delete copy), `admin-ui/src/components/UsersSubNav.tsx` (NEW, "Active users" | "Invitations"), the Users list row delete + confirm; the caller's own row delete is **disabled-with-explanation** (design.md), soft-deleted users vanish from the list; route `/users/invitations` sibling added
  - done when: `pnpm --dir admin-ui lint`+`build`+`test` green; unit tests: row delete calls DELETE + confirm, self-row disabled, list reflects removal

- [x] T11: admin-ui bulk delete + partial-success panel — refs: US-6 (6.3) — deps: T7, T10
  - touch: `admin-ui/src/pages/` Users list — checkbox column (tri-state select-all), `role=region` bulk action bar w/ live count, confirm naming the count, `BulkDeleteResultPanel` (NEW, persistent `role=status`, per-skipped-user reason in a real `<ul>` — NOT a vanishing toast, AC-6.3)
  - done when: lint+build+test green; unit tests: select-all tri-state, bulk POST, the skipped-with-reasons panel renders and persists

- [x] T12: admin-ui InvitationsPage + invite modal — refs: US-1 (1.6), US-3 — deps: T6, T10
  - touch: `admin-ui/src/pages/InvitationsPage.tsx` (NEW), `InviteUserModal` (NEW — email + reuse the role/department pickers), `InvitationStatusBadge` (NEW, pending/accepted/expired/revoked, not color-only), per-row Resend/Revoke (Revoke terminal → confirm), email-send-failed surfaced; list w/ status filter + `?q=`
  - done when: lint+build+test green; unit tests: invite modal submit + 409/422 inline errors, status badges, resend/revoke actions + confirm, email-failed indicator

- [x] T13: env wiring + infra docs — refs: R2, R5, R7 — deps: T3, T6, T7
  - touch: `auth/.env.example` (`NOTIFY_INTERNAL_URL`, `NOTIFY_INTERNAL_TOKEN`, reuse `BETTER_AUTH_URL`/`UI_HOME_URL`), `notify-api/.env.example` (`NOTIFY_INTERNAL_TOKEN`, `RESEND_API_KEY`, `RESEND_FROM`, `EMAIL_ENABLED`), `infra/README.md` + `infra/deploy.sh`/`check.sh` (new vars + Resend domain/SPF-DKIM note + Railway private-networking for `/system/emails`), `compose.yaml`/`mise.toml` if a local default is needed
  - done when: `.env.example`s document every new var; infra docs updated; `bash -n` clean on scripts

- [ ] T14: end-to-end (Playwright) — refs: AC-1.6, 2.1–2.6, 3.x, 5.3/5.7, 6.1/6.3 — deps: T6, T7, T8, T9, T10, T11, T12, T13
  - touch: `admin-ui`/`shell` e2e (seeded-session helper; email via the `EMAIL_ENABLED`-off stub / a mailbox stub)
  - invite → landing → OAuth accept → provisioned with roles; resend invalidates old link; revoke; soft-delete → vanishes + blocked re-sign-in; bulk delete partial-success report
  - done when: the e2e suite passes against the assembled stack (auth + notify-api + admin-ui + shell)

- [ ] T15: close — all gates green, spec → done — deps: T1–T14
  - QE PASS + owasp (frontier tier, ≥medium clear) + eval PASS; then `/wellforge:done 006`
  - done when: done gate met and spec frontmatter `status: done`

---

## Coverage map (every AC → ≥1 task)

| AC | Tasks | | AC | Tasks | | AC | Tasks |
|----|-------|-|----|-------|-|----|-------|
| 1.1 | T6 | | 2.1 | T2,T3,T14 | | 5.1 | T7 |
| 1.2 | T6,T12 | | 2.2 | T9,T14 | | 5.2 | T8 |
| 1.3 | T6 | | 2.3 | T8,T14 | | 5.3 | T7,T10 |
| 1.4 | T4,T6 | | 2.4 | T8 | | 5.4 | T7 |
| 1.5 | T6 | | 2.5 | T9,T8 | | 5.5 | T7 |
| 1.6 | T6,T12 | | 2.6 | T6,T12 | | 5.6 | T7,T10 |
| 1.7 | T6 | | 3.1 | T6 | | 5.7 | T10 |
| 1.8 | T6 | | 3.2 | T6 | | 5.8 | T7 |
| 1.9 | T6,T9,T12 | | 3.3 | T5,T9 | | 5.9 | T7 |
| 1.10 | T6 | | 3.4 | T6 | | 5.10 | T8 |
| 1.11 | T6 | | 3.5 | T6 | | 6.1 | T7,T11 |
| 1.12 | T6 | | 3.6 | T6 | | 6.2 | T7 |
| 1.13 | T6 | | 4.1 | T5,T6 | | 6.3 | T7,T11 |
| 1.14 | T6,T8 | | 4.2 | T5,T6 | | 6.4 | T7 |
| | | | 4.3 | T5,T8 | | 6.5 | T7 |
| | | | 4.4 | T6 | | | |

Enablers T1/T2/T4/T13 (channel, model, infra) serve the above transitively; T14 e2e + T15
close. No task serves zero ACs.

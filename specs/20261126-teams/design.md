---
spec: 20261126
status: draft
---

# Design: Teams — named groups of people, managed in Admin, taking part in projects

Designed against `main` at ad7a0719 from `spec.md` (approved; AC-5.4 read in its amended form: when the
team read fails the project page shows each attached team **by name when readable, otherwise
"could not be loaded"**, and marks its members "could not be loaded"; and AC-5.6, added the same day: a person over
the per-person page-read limit sees the same markers plus a too-many-requests message) and `plan.md` § UI surface,
§ API contracts (the view's `teamsStatus` / `teamsRetryAfterSeconds`, the five-case table, the save 429) and D15. Read first: `operai-ui/docs/building-pages.md`, `design-system.md`, `operai-ui/src/index.ts`,
the Storybook page types, admin-ui Departments, projects-ui `TeamCard` / `PersonPicker` / `ProjectsPage`.
No browser audit was done (no admin session available to the designer); everything below is read from code.

Revised 2026-11-26 after two owner decisions on the gaps this design raised (see Gaps and drift, G1 and G2): auth's 409
`team_name_taken` carries a structured `existingName`, and `GET /attachable-teams` takes an optional server-side search `q`.
Affected: F1, S2, S7, the component inventory, copy, test ids and a11y.

Revised again 2026-11-26 for AC-5.6 and plan D15 (the plan left the copy and the Retry behaviour "for the designer"). Affected: F10, F11,
new F16, S6 (the `"rate_limited"` state, the status rule, Retry behaviour), S7 (the save 429), S9, the component inventory, copy
(`teams.rateLimited`, `dialog.errors.rate_limited`; one sentence removed from `teams.unavailable.body`, see G9), test ids,
a11y and Gaps G7..G10. No admin-ui change.

Two apps, two deliveries (spec § Delivery): **Step 1 admin-ui** (US-1..3), **Step 2 projects-ui** (US-4, US-5).
No library change is needed (see Component inventory).

## Flows

Entry points: Admin → **Teams** tab (`/admin/teams`); a project's page → **Team** card; Projects list → **Team**
filter. A flow is only listed if an AC asks for it.

### Admin (US-1..3)

| # | Flow | ACs | Path |
|---|---|---|---|
| F1 | Create a team | AC-1.1, AC-1.2, AC-3.2 | Teams list → **New team** → `FormDialog` (name, description) → *success*: dialog closes, navigates to the new team's page (empty members), heading takes focus, success banner "Team “X” created. Add its members below." → *name clash* (409 `team_name_taken` with `existingName`): dialog stays open, the **Name field** shows a localized message that names the existing team (`form.nameTaken(existingName)`, composed in the browser, never the server's English `detail`), focus returns to Name, nothing created → *validation* (empty, > 80, description > 500): field errors, focus on the first invalid field → *other failure*: `form-error` in the dialog, values kept. |
| F2 | Find a team | AC-1.4 | Teams list: type in **Search** (case-insensitive substring) and/or switch **Show** (Active default, Archived, All). Filtering is in the browser (plan D12); a polite live region announces the count. |
| F3 | Edit name / description | AC-1.2, AC-1.3, AC-1.8 | Team page → **Edit details** → `FormDialog` prefilled; sends only the fields that changed plus `baseVersion` → *success*: banner "Team saved" → *name clash*: as F1 → *stale* (409 `version_conflict`): dialog stays open, values kept, submit blocked, message says to close, reload and edit again; the page behind shows the stale banner with **Reload** once the dialog closes. |
| F4 | Archive | AC-1.5, AC-1.8, AC-3.2 | Team page → **Archive team** → `ConfirmDialog tone="primary"` whose body states the consequences (not offered for new projects; stays on projects it is on, members keep counting; restorable) → success: badge becomes Archived, button becomes **Restore team**, info banner explains, focus to the page heading. Stale: dialog stays, error shown, Confirm becomes `aria-disabled` with a reason (`confirmDisabledReason`). |
| F5 | Restore | AC-1.6, AC-1.8 | Same shape as F4 with **Restore team**; body says it is offered again to project managers. |
| F6 | Add a member | AC-2.1, AC-2.3, AC-2.4, AC-3.2, AC-2.5 | Team page → Members card → **Add a member** (`SearchPicker`: server search over active users, name or email) → pick → **Add** button commits (pick alone never writes) → success: row appears, polite "X added to this team", picker cleared, focus stays on the picker for the next person → refusals inline under the picker: 422 `user_not_active` ("not an active user"), 422 `team_full` (limit named, 100). Adding someone already in the team is a server no-op; the picker never offers current members. Works on an archived team. |
| F7 | Remove a member | AC-2.2, AC-3.2 | Row **Remove** → `ConfirmDialog` ("Remove X?", body says only this team changes and what it means on projects) → success: row gone, polite "X removed from this team", focus to the add-member field. Works on an archived team. A deactivated member is removable the same way (it frees one of the 100). |
| F8 | Non-admin reaches Teams | AC-3.1 | No **Teams** tab for anyone without Admin's `admin:access` (`SectionNav` shows it with the other admin sections only). A direct address `/admin/teams*`: a legal-entity manager who is not an admin is redirected to `/legal-entities`; anyone else gets the existing `PermissionDenied` panel (the shell already turns away anyone with no Admin capability). The API's 403 on a revoked-mid-session admin renders `PermissionDenied` in place of the page. |
| F9 | Language | AC-3.3 | Every string in `en` and `it`; dates through `formatDate` / `formatDateTime`. |
| — | Delete | AC-1.7 | No flow: no control, no test id `team-delete-*`. |

### Projects (US-4, US-5)

| # | Flow | ACs | Path |
|---|---|---|---|
| F10 | Read who is on a project | AC-4.3, AC-4.7, AC-5.4, AC-5.6 | Project page → **Team** card (any `projects:access` holder): section **People** (listed individuals, unchanged) and section **Teams** (each attached team: name, Archived badge, members with Deactivated / No access to Projects badges). A person who is both listed and in a team appears in both places (the server counts them once; the UI shows what is stored). When the teams could not be read, the Teams section says so, in one of two ways: "Some teams could not be loaded" (the service could not answer) or "Too many requests" (this person is over the limit, F16). |
| F11 | Attach / detach teams | AC-4.1, AC-4.2, AC-4.9 | `canManage` only: Teams section → **Edit teams** → `TeamsDialog` (`FormDialog`): **Attach a team** `SearchPicker` (server search `GET /attachable-teams?q=` over active teams by name, case-insensitive; the already attached are left out of the results; picking a team stages it in the list below and clears the field, nothing is written yet), attached list with **Remove**, limit 10 named → **Save teams** → `PUT /projects/{id}/teams` with the project's version → card updates, "Teams saved." banner. Archived teams already attached stay in the list (badge) and can be removed, never newly attached. If the person is over their per-person limit and the save **adds** a team, it is refused (429, nothing written): inline message, dialog stays open (S7, F16). A save that only removes teams goes through. |
| F16 | Over the per-person limit | AC-5.6 | A person who opened project pages more often than the limit (plan D15: 120 per 10 min) opens another project page, or receives a write's response while over → the page loads normally (people, company, terms, tasks) and the Teams section shows every attached team as "Team could not be loaded" with "Members could not be loaded", under one "Too many requests" banner that says to try again in N minutes (S6). **Retry** reloads; it succeeds once the wait is over, and the next admitted load shows the teams and members again, renames included. Nobody else's page, and no decision about who is on the project, is affected (backend; AC-5.6). Over the limit, a save of Edit teams that adds a team shows the inline too-many-requests message (S7). |
| F12 | Stale save | AC-4.1 | 409/428 → dialog closes, page shows the existing `StaleWriteBanner` (as every other project write). |
| F13 | Filter projects by team | AC-4.8 | Projects list → Filters → **Team** select (only teams attached to at least one project; archived ones marked) → list narrows, page resets to 1. |
| F14 | Manager field | AC-4.9 | No UI: the project manager picker (`PersonPicker`) offers people only. Nothing to design; test only. |
| F15 | Given a task / recording hours / reading meetings through a team | AC-5.1..5.3 | No new screen. The assignee `select` of `TaskFormDialog` and the page's Record hours offer read `project.onProject` (server-computed). The only visible additions are the incomplete-list note (S9) and the unchanged read-only banner for a team-only person (AC-5.5: they see the page, no edit buttons). While a person is over their limit (F16) or the teams are unavailable, `onProject` holds only the project manager and the listed people, so a person who is on the project **only** through a team is not offered Record hours on the page, and is not in the assignee list, until the teams load again; the banner says so (S6). hours-api still decides every save, and My hours still records. |

**ACs with no UI surface of their own** (backend/behaviour only; covered by tests): AC-2.5 (no permission change),
AC-3.2 (audit rows; the Audit page renders them with its existing generic row), AC-4.4..4.6 (computation, freshness),
AC-5.1..5.3 outcomes, AC-5.5 (403 only, shown by the existing read-only banner).

## Screens & states

States per building-pages § 2, one at a time, in order: denied → loading → failed → empty → loaded.

### S1 — Admin: Teams list (`/admin/teams`, `admin-teams-page`)

Purpose: find, create, open. Structure: `PageHeader` (title "Teams", description "Groups of people who work together.
A team grants no permissions and is not a role." so nobody mistakes it for a department; action **New team**, the one
primary) → `SuccessBanner` slot → filter `Card` (Search, Show) → one state.

Table (`DataTable`, caption "Teams"): **Name** (row header, router `Link className="link"` to the team) · **Active
members** (numeric, `formatNumber`) · **State** (`TeamStatusBadge`). Order: as the server (name order). No pagination
(bounded, plan D12/R10, trigger ~500 teams). No description column (the page shows it).

| State | Render |
|---|---|
| Denied (403) | existing `PermissionDenied` |
| Loading | `SkeletonListRows` + visually hidden live "Loading teams…" |
| Failed | `ErrorBanner` (warning) with Retry; message from Problem detail, else "Could not load teams." |
| Empty (no team exists) | `StatePanel` "No teams yet" + body pointing at **New team** (no second button: the header has it) |
| Filter matches nothing, text typed | `StatePanel` "No teams match" "Change the search or the filter." |
| Filter = Active and every team is archived | `StatePanel` "No active teams" "Every team is archived. Show archived or all teams to see them." |
| Loaded | the table + `VisuallyHidden live` "N teams" after every filter change |
| After create / archive | success surfaced on the destination (flash) — see F1 |

Default filter: **Active teams**. The state filter and the search are plain controls in a `Card`, not a `<form>` (they apply
live, nothing is submitted).

### S2 — Admin: create team dialog (`create-team-*`)

`FormDialog size="sm"` mounted beside the page content (S1 root), never inside a `<form>` (ADR 20261118). Fields (each in
`Field`): **Name** (required, hint "1 to 80 characters. Unique among all teams, archived ones included, ignoring case."),
**Description** (textarea, hint "Optional, up to 500 characters."). Validation on submit and on blur of a touched
field; trimmed values; errors: required, "Use at most 80 characters.", "Use at most 500 characters." (no `maxLength`
attribute: truncating a paste silently is worse than saying so). Submit **Create** / "Creating…". 409 clash goes on the Name
field (it is about one field), not in `form-error`. Its text is `form.nameTaken(existingName)`, e.g. "A team named “Backend”
already exists. Archived teams count too." / "Esiste già un team chiamato “Backend”. Contano anche i team archiviati."; the name is the
stored one (it may differ in case from what was typed, which is the point), rendered as plain text (never HTML), wrapping
if long (up to 80 characters). If the 409 arrives without `existingName` (a skewed deploy or a contract bug) the dialog does not
invent a name: it shows `form.createFailed` / `saveFailed` in `form-error` and keeps the values. Any other failure: `error` prop (role alert), values kept.

### S3 — Admin: team page (`/admin/teams/$id`, `team-detail-page`)

`PageHeader`: back link "Back to teams" (every state), title = team name, `status` = `TeamStatusBadge`, actions =
**Edit details** (secondary) and **Archive team** (secondary) or **Restore team** (secondary). No primary on this page
(no one action leads; Add is in the Members card). No delete anywhere.

Cards (h3, no nesting): **Details** (`FactList`: Description or "No description", Created `formatDateTime`, Last changed
`formatDateTime`) and **Members**.

Page-level banners (above the cards, at most one at a time, in this order): stale (danger, Reload) → archived (info, static:
"This team is archived. It is not offered for new projects and it stays on the projects it is already on. You can still
change its members.").

Members card:
- Intro hint (`text-soft`): "A team grants no permissions. On every project this team is attached to, its members count as
  people on the project: they can record hours, be given tasks and read the project's linked meetings." (consent text for
  the O8 widening; copy only, not a new surface).
- Count line: "12 of 100 members" (active **and** deactivated count towards 100, plan D7) and, if any, " · 1 deactivated".
- **Add a member** `SearchPicker` + **Add** button (secondary, disabled until a person is picked) in one row. Not wrapped
  in a `<form>`.
- Table (`DataTable`, caption "Members of this team"): **Name** (row header; the admin API returns every member's name, deactivated ones included) · **Email** · **Added** (`formatDate`) · actions column with **Remove** (`danger`, `sm`, label
  names the person). A deactivated member's row shows `Badge` "Deactivated" beside the name; they stay listed, last.
- Hint under the table when someone is deactivated: "Deactivated people stay listed, are not counted as active, and count
  again if the account is reactivated."

| State | Render |
|---|---|
| Denied | `PermissionDenied` |
| Loading | `SkeletonListRows` + live "Loading the team…"; the heading shows the fallback "Team" |
| Not found (404 `team_not_found`) | `StatePanel role="alert" focusOnMount` "Team not found" with the back link still in the header |
| Failed | `ErrorBanner` + Retry |
| Loaded, no members | inside the Members card, `StatePanel` "No members yet" "Add the people who work in this team." (the picker stays above it) |
| Loaded, archived | as loaded + archived banner + Restore instead of Archive; Edit details and member editing still work (AC-2.4) |
| **Stale save** (409 `version_conflict`) | see S4 |
| **Limit reached** (100 members) | the picker is closed to input (`SearchPicker disabled`) and **Add** is `aria-disabled="true"` so it stays a focus stop that can explain itself; the text under them, linked by `aria-describedby`, reads "This team has 100 members, deactivated people included. Remove someone to add another." The same sentence appears as the inline error if a concurrent add trips 422 `team_full` ("A team has at most 100 members, deactivated people included."). |
| Add refused: not active (422 `user_not_active`) | inline `form-error` (role alert) under the picker: "This person is not an active user and cannot be added." |
| Add / remove failed otherwise | inline `form-error` under the picker or above the table; the row/picker state is unchanged |
| Search failure (picker) | `SearchPicker` messages: forbidden / unavailable are in the list and announced; never "no match" for an outage |
| Remove in flight | the confirm is `busy`, not dismissible; the row stays until the answer |
| Concurrent member change by another admin | add and remove return the whole `TeamDetail`; the page replaces its members from the response (idempotent set operations, D6), so nothing is lost and no stale banner is raised for members |

### S4 — Admin: stale-save conflict (AC-1.8)

The API refuses an edit, archive or restore whose `baseVersion` is old (409 `version_conflict`, `currentVersion`). The
design never overwrites silently and never throws typed text away:

1. **Edit details**: the dialog stays open, every typed value stays, submit becomes unavailable (`canSubmit=false`; a retry
   would resend the old version), and the dialog error says: "Someone else changed this team while you were editing. Your
   text is kept here so you can copy it. Close this dialog, reload, then edit again." The page sets `stale` and refetches
   nothing behind the dialog.
2. When the dialog is closed, the page shows the stale `Banner tone="danger"` ("This team has changed" / "Someone else
   changed this team. Reload to see their changes, then try again.") with **Reload**. Reload refetches the team and clears
   the banner. While `stale`, **Edit details**, **Archive** and **Restore** remain usable (they re-fail visibly), so the
   banner is a signal, not a lock.
3. **Archive / Restore** conflicts: the `ConfirmDialog` stays open with the error and Confirm `aria-disabled` with the reason
   "Reload to see the latest version first."; Cancel closes, then the banner as in 2.
4. A name clash (409 `team_name_taken`) is a different 409: field error, not a stale state.

(Interpretation of plan "409 shows the stale banner and keeps the typed values": the typed values are kept in the open
dialog; the banner appears on the page. The plan's wording left the order open.)

### S5 — Admin: archive / restore / remove dialogs

`ConfirmDialog` ×3, each mounted as a sibling of the cards (S3 root), never inside a form.
- Archive: `tone="primary"` (reversible, consequential; not danger). Title "Archive “Backend”?"; body in Flows F4. Confirm
  **Archive** / "Archiving…".
- Restore: `tone="primary"`. Title "Restore “Backend”?". Confirm **Restore**.
- Remove member: `tone="danger"` (a removal that changes people's access on projects). Title "Remove Ada Rossi?". Confirm
  **Remove** / "Removing…". Initial focus on Cancel (library default).
Failures stay inline (`error`), dialog stays open; busy blocks dismissal.

### S6 — Projects: Team card (`project-team`)

One `Card` titled "Team" (h3) with two sections, each with its own heading row (h4: **People**, **Teams**) and, for
`canManage`, its own button at the right of that row: **Edit people** (existing editor, `project-team-edit`, label
changes, behaviour unchanged) and **Edit teams**. Buttons live in the section header rather than the Card `action`
because two same-weight actions in the title row would not say which list each edits (O11 collision).

People section: unchanged list of listed people; empty → "No people listed yet." (plain `text-sm text-soft` line, as today).

Teams section, one block per attached team in attach order:

- Header line: team **name** (or "Team could not be loaded" when `name` is null), `TeamStatusBadge`-style **Archived**
  badge when `archived`, and a count "5 people count on this project" (members who are not deactivated and have access;
  omitted when members are unavailable).
- When archived, one small `text-soft` line: "Archived: it stays on this project until it is removed."
- Members list: `<ul aria-label="Members of Backend">`, two columns from `sm` up; each item: name (a deactivated member:
  "Deleted user", the existing `people.deleted`) plus badges **Deactivated** (`StatusBadge voided`) or **No access to
  Projects** (`Badge tone="warning"` with the `lock` glyph). A deactivated member shows only **Deactivated**, never both: auth reports
  `appAccess: false` for every deactivated account, so a second badge would be misleading (decision under T15 in `decisions.md`).
- More than 12 members: the first 12 show, then a `ghost` `sm` button "Show all 34 people" / "Show fewer"
  (`aria-expanded`, `aria-controls`). Up to 100 × 10 rows must stay scannable.
- If any member lacks access, one legend line under the section: "People marked “No access to Projects” do not count as on
  this project until an administrator gives them access."

| State | Render |
|---|---|
| Loading / not found / failed | the page's existing states (the card only renders with the project) |
| No teams | "No teams attached." (plain line) |
| Loaded | blocks as above |
| Team read failed for a team (`members: null`) | that block keeps its name (or "Team could not be loaded") and reads "Members could not be loaded" in place of the list; nothing is guessed (AC-5.4) |
| Any team unreadable (`teamsStatus: "unavailable"`, or any value the UI does not know, see *Status rule*) | one `Banner tone="warning" live="polite"` at the top of the Teams section: title "Some teams could not be loaded", body "Their members are not shown. People who are on this project only through a team may be missing from the lists of people, such as the task assignee.", **Retry** (*Retry behaviour*). Polite: the page did load. |
| **Over the person's limit** (`teamsStatus: "rate_limited"`, AC-5.6, plan D15) | every team block is shown as in the row "Team read failed for a team" (the server sends `name: null, archived: null, members: null` for each): header "Team could not be loaded", body "Members could not be loaded", no Archived badge or note, no count, no legend. One `Banner tone="warning" live="polite"` at the top of the Teams section, **replacing** the "Some teams could not be loaded" banner (the two never show together): title "Too many requests"; body = the lead ("You made too many requests, so teams and their members are not shown for now."), the wait sentence ("Try again in 3 minutes."; `teamsRetryAfterSeconds` rounded **up** to whole minutes, 1..10; "a minute" for 1; when the number is missing or not a whole number of at least 1, which the contract rules out, "Try again later.") and the consequences ("People who are on this project only through a team may be missing from lists of people, such as the task assignee, and may not be offered Record hours on this page. You can still record hours from My hours."); **Retry**. The rest of the page is unchanged. The Edit teams button stays for `canManage`. |
| Teams section with no attached team | "No teams attached." and no banner, whatever `teamsStatus` says |
| A write's response arrives degraded | every route that answers with a project (create, PATCH, transitions, `PUT …/team`, `PUT …/teams`, the take) carries the same fields. An over-limit person who saves something unrelated sees "Saved" and, in the same moment, the Teams section turning into this state; the banner wording therefore never claims that nothing was changed (G9). A `PUT …/teams` that only removes commits, and the section is then shown in this state too, with the teams unnamed |
| Team with no members | "This team has no members." |
| Archived attached team | badge + note, members as normal (they still count, O4) |
| Member without access | badge + legend (AC-4.7); not counted |
| Member deactivated | badge (AC-4.3) |
| Person both listed and via a team | appears in both sections, no marker (see Scope flags) |
| Viewer without `project:manage` | no Edit buttons; existing read-only info banner (AC-5.5 also for a team-only person) |
| Viewer who is a team member without Projects access | cannot open the page (not a `projects:access` holder): existing denied state; nothing new |

**Status rule** (one function of the project, not per block). The block rendering follows each team's own `name` and `members`
(null = "could not be loaded"), never the status; only the banner follows the status:

| `teams` | `teamsStatus` | `onProjectComplete` | Banner |
|---|---|---|---|
| empty | any | any | none |
| not empty | `"rate_limited"` | `false` | Too many requests |
| not empty | `"complete"` | `true` | none |
| not empty | `"unavailable"`, an unknown string, `null` or absent, or `"complete"` with `onProjectComplete: false` | any | Some teams could not be loaded |

An unknown value is therefore read as `"unavailable"` (the plan: the enum is closed, a new value is a contract change). So is a missing
one, which cannot happen when projects-ui ships after projects-api as planned (plan § Delivery, step 5); the rule fails toward saying that something could
not be loaded, never toward saying nothing. A `"rate_limited"` answer is never shown as "unavailable": the person is told they made too many requests, because
it is true and because they can act on it by waiting. The service's own window (`"unavailable"`, `teamsRetryAfterSeconds: null`) is
shown as "unavailable", because the person did nothing (plan D15).

**Retry behaviour** (both banners, one handler: the page's existing reload of the project, the one behind the stale banner's Reload).
- There is no automatic reload, no countdown and no timer: the number of minutes is the value at load time. An automatic reload when the wait
  ends would spend one of the person's admitted reads unasked.
- A click while a reload is in flight does nothing (the handler ignores it).
- Clicking before the wait ends is harmless and honest: the server neither records nor serves it and does not extend the wait, so the answer is
  `"rate_limited"` again with an equal or smaller number. The banner keeps its place (same element, no remount, so the Retry button keeps
  focus), its minutes update, and a hidden polite line says "Checked again. Teams are still not shown." so a screen-reader user hears that
  the click did something even when the minutes are unchanged.
- After the wait, Retry loads the teams and members normally: banner and markers disappear, names and members (renames included) show. If
  the reload answers `"unavailable"` instead, the banner changes to "Some teams could not be loaded".
- When the Retry button that had focus disappears (success, or the other banner), focus moves to the **Teams** section heading
  (`tabIndex={-1}`), never to the body.
- A reload that fails outright is the page's existing load-failure handling; nothing new.

### S7 — Projects: Edit teams dialog (`project-attached-teams-dialog-*`)

`FormDialog size="md"`, mounted by `TeamCard` as a sibling of the Card (as `TeamDialog` today). `description` (consent
text, O8): "Everyone in an attached team who has access to Projects counts as part of this project: they can record hours,
be given tasks and read the project's linked meetings. This follows the team as it changes."

Content:
1. **Attach a team**: a `SearchPicker` (library; `Field`-wrapped `Combobox`, server-side search) whose `search(q, signal)` calls
   `GET /attachable-teams?q=<trimmed text>` through `apiFetch` (signal passed) and maps the answer: 200 → `ok` with the items minus
   the ids already attached or staged; 403 → `forbidden`; 503 `teams_unavailable`, any other failure or network error → `unavailable`
   (an outage is never "no match"). The picker's `value` is always `null`: choosing a team stages it in list 2 and the field
   empties (the library's `onSelect` clears the draft; focus stays in the field for the next team). Each time the list opens it asks
   again, so reopening the list is also the retry. `q` is the trimmed text; empty `q` lists the first active teams (the list
   opens on an empty field). Text longer than 80 characters (the team-name maximum) cannot match any team, so `search`
   answers `ok` with no items without calling the server (never a 400 read as "unavailable"). Hint: "3 of 10 teams. Only active
   teams can be attached; an administrator creates teams in Admin." When the last answer said `truncated`, the hint adds "Type
   more of the name to narrow the list." (the hint is a plain prop, set from a state the `search` wrapper updates).
2. **Attached teams** list (`aria-labelledby`), each row: name (or "Team that could not be loaded"), Archived badge when so,
   **Remove** (`ghost`, `sm`, labelled with the name; unnamed ones "Remove team 2 that could not be loaded"). A static hint:
   "Removing a team removes its members from this project, unless they are also listed or in another attached team."
3. Submit **Save teams** / "Saving…"; `canSubmit` only when the set changed.

Nothing is fetched when the dialog opens: the list is empty of requests until the field is focused. So removals, the limit
and Save work whatever the teams service does; only attaching depends on it.

| State | Render |
|---|---|
| Loading (searching) | in the list and announced: "Searching teams…" (the library's `searching`; also on every reopen and every new text, after the 250 ms pause) |
| No match | in the list and announced: "No active team matches, or it is already attached." (one sentence for: no team with that text, no active team at all, every match already attached) |
| Results | the matching names; polite count "2 teams found" (never announced for 0) |
| Error: 503 `teams_unavailable` / network | in the list and announced: "Teams could not be searched. Nothing was changed. Try again." Removals and Save still work. Reopening the list or changing the text asks again |
| Error: 403 | in the list and announced: "You may not attach teams." (a manager whose grant was revoked mid-session) |
| **Limit reached** (10) | the picker is `disabled` (closed to input and searching); its hint (linked to the input by `Field`'s `aria-describedby`) becomes "A project can have at most 10 teams. Remove one to attach another."; a polite live line announces "10 of 10 teams attached" when the 10th is staged. Removing one re-enables it |
| Results `truncated` | hint addition above ("Type more of the name to narrow the list."); no dead end now: any team is reachable by typing part of its name |
| Save refused: 422 `team_archived` | inline: "These teams were archived and can no longer be attached: X. Remove them to save." (names resolved from the dialog's own list) |
| 422 `team_not_found` | inline: "A team you chose no longer exists. Close this dialog and try again." |
| 503 `teams_unavailable` on save | inline: "Teams could not be loaded right now. Nothing was changed. Try again in a moment." |
| **429 `rate_limited` on save** (the person is over the per-person limit and the save adds a team; plan D15: the only 429 of a project write) | inline in `form-error` (role alert): "Too many requests, so nothing was changed." + the wait sentence from the body's `retryAfterSeconds` (the browser cannot read `Retry-After`: projects-api's CORS exposes only `ETag`), rounded up to minutes as in S6 ("Try again in 7 minutes."), or "Try again later." when the body lacks it. The dialog stays open, the staged set is kept, **Save teams** stays available (a refused save costs nothing and does not extend the wait), so the person can wait with the dialog open or cancel. Not the stale path: the project's version is not at fault. A save that only removes never meets this |
| Attach search answers 429 (its own per-caller limit, plan D13) | still "Teams could not be searched. Nothing was changed. Try again." (the plan maps a 429 of the search to unavailable); it is a different limit from the page's and is not described to the person |
| Project is over its page limit while the dialog is open | the attached list shows the teams unnamed ("Team that could not be loaded", "Remove team 2 that could not be loaded"), removing and saving removals work, attaching works until the save |
| 403 `out_of_scope` / `forbidden` | inline via `errorMessage` (existing mapping) |
| 409 / 428 | dialog closes, `StaleWriteBanner` on the page (existing, F12) |
| Success | closes, card shows the new teams, "Teams saved." (`Saved`) |

### S8 — Projects: list filter (`ProjectsPage`)

A fifth `Field`/`select` **Team** in the filter Card grid: options "Any", then each team from `GET /attached-teams` (name; an
archived one "Backend (archived)"; an unreadable one "Team that could not be loaded"). Fed like the project-manager filter
(`useResource`, own cache key). States: loading → the select holds only "Any"; failed → hint "The teams could not be
loaded." (as `managersFailed`); no team attached anywhere → hint "No team is attached to a project yet." Selecting a team
resets the page to 1 and sends `teamId`. A filter that matches nothing uses the existing "No projects match these filters".

### S9 — Projects: assignee list note (`TaskFormDialog`)

The assignee `select` reads `project.onProject` (deleted users excluded). When `onProjectComplete` is false the **Assignee**
`Field` gets the hint "Some team members could not be loaded, so this list may be missing people." The "not on the
project" error copy stays valid ("Choose someone who is on this project.", see copy). The hint also covers the over-limit state (F16): `onProjectComplete` is
`false` there too. A task that already has a team-only assignee must keep that person selectable while editing it (see G10).

## Component inventory

Library in use: **`@operai/ui`** (Tailwind 4 token utilities, one styling dialect; AGENTS.md § Frontend; not Mantine/MUI).
Both apps already import it; no new export, no new token, no change to `operai-ui/`.

| Element | Existing component to reuse | Verdict |
|---|---|---|
| Section tab "Teams" | `TabNav` + `tabLinkClassName` via admin-ui `SectionNav` (`components/SectionNav.tsx`) | REUSE (one entry) |
| Page frame, titles, back link | `ToolLayout`, `PageHeader` (`back`, `status`, `actions`, `focusableHeading`) | REUSE |
| Teams table, members table | `DataTable` (`rowHeader`, `numeric`, sr caption) | REUSE |
| Cards, details facts | `Card`, `FactList` | REUSE |
| Active/Archived/Deactivated | `StatusBadge` through ONE per-app map (admin-ui: `components/TeamStatusBadge.tsx`; projects-ui: in `Badges.tsx`): active → `active`, archived → `voided` (the suite's `ARCHIVED_MEANING`, `crm-ui/src/lib/statusMeanings.ts:44`), deactivated → `voided` | REUSE (a new map entry, not a component) |
| "No access to Projects" | `Badge tone="warning"` + `Icon name="lock"` (design-system: Badge is for an access level) | REUSE |
| Create / edit team | `FormDialog` + `Field` (+ `input`, `textarea`) in admin-ui `components/TeamFormDialog.tsx` (one dialog, create and edit; mirrors `CreateDepartmentModal.tsx`) | REUSE |
| Archive, restore, remove member | `ConfirmDialog` (`tone`, `confirmDisabledReason`) | REUSE |
| Add a member (server search over users) | `SearchPicker` (not the department page's hand-rolled search form) with admin-ui's `listUsers({ q, pageSize: 10 })` | REUSE |
| Attach a team (server search by name, `GET /attachable-teams?q=`) | `SearchPicker` (design-system table: "a record found by a server-side search"; already used by hours-ui, and in the Admin member picker here) with `value` always `null` | REUSE |
| Too-many-requests notice (S6), Retry status | `Banner tone="warning" live="polite"` with `onRetry`, the same component and props as the "unavailable" banner; `VisuallyHidden live` for the retry status; the Teams `h4` is a plain heading with `tabIndex={-1}` | REUSE |
| Stale save | `Banner tone="danger"` with `onRetry` (admin-ui inline; projects-ui existing `StaleWriteBanner`) | REUSE |
| Success feedback | admin-ui `SuccessBanner` (wraps `Banner compact autoDismiss`), projects-ui `Saved` | REUSE |
| Load failed / loading | `ErrorBanner`, `SkeletonListRows` (admin-ui); `LoadFailure`, `Loading` (projects-ui) | REUSE |
| Empty / no match | `StatePanel` | REUSE |
| Counts announced | `VisuallyHidden live` | REUSE |
| Filters | `Card` + `Field` + `select` / `input type="search"` (as `ProjectsPage`) | REUSE |
| Show all / fewer | `Button variant="ghost" size="sm"` | REUSE |
| Icons | `Icon` (`lock`, `users`, `arrow-left`) | REUSE |
| Page: Teams list | admin-ui `pages/TeamsPage.tsx` | app composition (a page, like `DepartmentsPage`) |
| Page: Team detail | admin-ui `pages/TeamDetail.tsx` | app composition |
| Attached-teams section of the Team card | projects-ui `components/AttachedTeams.tsx`, rendered by `TeamCard.tsx` | app composition |
| Edit teams dialog | projects-ui `components/TeamsDialog.tsx` | app composition of `FormDialog` + `SearchPicker` |
| Library NEW components | none | **NEW: 0** |

Reuse vs NEW: **0 NEW library components; ~22 library elements reused; 6 app-local files** (2 admin pages, the admin
`TeamFormDialog` and `TeamStatusBadge`, projects-ui `AttachedTeams` and `TeamsDialog`), each a composition of reused parts and
none a candidate for the library (single use; the "show N more" pattern is two lines of `Button`).

Rejected: a shared library `TeamPicker` (one consumer, `SearchPicker` fits); a client-filtered `Combobox` over a fully loaded list (cannot reach teams past the server's cap; reversed 2026-11-26); `PersonChips` for team members (cannot carry
the two badges); a `Drawer` for members (the people list is the point of the page, not reference content); `Tabs` inside the
team page (two cards read better and the detail is short); native `<details>` for long member lists (an unstyled control the
system has no rule for; `Button` + `aria-expanded` is the sanctioned shape).

## Copy

Sentence case. `strings` module per app; English and a complete Italian `it: typeof en`; the existing parity
(`catalogGaps`) and hardcoded-copy tests cover them. No glyph prefixes. Dates only through `formatDate` / `formatDateTime`,
numbers through `formatNumber`. Italian uses the informal "tu" imperative for instructions in both apps (decided in eval round 1, `decisions.md` § "Eval round 1 fix — Italian register": projects-ui already used it, and the newer admin screens do too). "Team" is invariable in Italian.

### admin-ui — `src/strings/nav.ts` (add) and new `src/strings/teams.ts` (register as `teams` in `strings.ts`)

`nav.teams`: en `Teams` · it `Team`.
`common.notFound.body` (existing key, edit): "…Use the navigation above to pick Roles, Departments, **Teams**, Users or Audit." / it adds "Team". `audit.description` (existing key) gains "teams" ("…roles, departments, teams, and user assignments…" / "…ruoli, reparti, team e assegnazioni degli utenti…").

```ts
// en                                                       // it
heading: 'Teams'                                             'Team'
description: 'Groups of people who work together. A team     'Gruppi di persone che lavorano insieme. Un team non
  grants no permissions and is not a role.'                    conferisce permessi e non è un ruolo.'
newTeam: 'New team'                                          'Nuovo team'
loading: 'Loading teams…'                                    'Caricamento dei team…'
loadError: 'Could not load teams.'                           'Impossibile caricare i team.'
caption: 'Teams'                                             'Team'
filters: { title: 'Filters', search: 'Search',               { title: 'Filtri', search: 'Cerca',
  searchHint: 'Part of a team name', show: 'Show',             searchHint: 'Parte del nome di un team', show: 'Mostra',
  active: 'Active teams', archived: 'Archived teams',          active: 'Team attivi', archived: 'Team archiviati',
  all: 'All teams' }                                           all: 'Tutti i team' }
columns: { name: 'Name', members: 'Active members',          { name: 'Nome', members: 'Membri attivi',
  state: 'State' }                                             state: 'Stato' }
state: { active: 'Active', archived: 'Archived' }            { active: 'Attivo', archived: 'Archiviato' }
count: (n) => n === 1 ? '1 team' : `${n} teams`              n === 1 ? '1 team' : `${n} team`
empty: { title: 'No teams yet',                              { title: 'Ancora nessun team',
  body: 'Create a team with “New team”, then add the          body: 'Crea un team con “Nuovo team”, poi aggiungi le
  people who work together.' }                                 persone che lavorano insieme.' }
noMatch: { title: 'No teams match',                          { title: 'Nessun team corrisponde',
  body: 'Change the search or the filter.' }                  body: 'Modifica la ricerca o il filtro.' }
noActive: { title: 'No active teams',                        { title: 'Nessun team attivo',
  body: 'Every team is archived. Show archived or all         body: 'Tutti i team sono archiviati. Mostra i team
  teams to see them.' }                                        archiviati o tutti i team per vederli.' }
created: (name) => `Team “${name}” created. Add its          `Team “${name}” creato. Aggiungi qui sotto i suoi
  members below.`                                              membri.`
form: {
  createTitle: 'New team'                                    'Nuovo team'
  editTitle: 'Edit team'                                     'Modifica team'
  nameHint: '1 to 80 characters. Unique among all teams,     'Da 1 a 80 caratteri. Univoco tra tutti i team,
    archived ones included, ignoring case.'                    anche archiviati, senza distinguere maiuscole.'
  descriptionHint: 'Optional, up to 500 characters.'         'Facoltativa, fino a 500 caratteri.'
  nameTooLong: 'Use at most 80 characters.'                  'Usa al massimo 80 caratteri.'
  descriptionTooLong: 'Use at most 500 characters.'          'Usa al massimo 500 caratteri.'
  nameTaken: (existingName: string) =>                       (existingName: string) =>
    `A team named “${existingName}” already exists.            `Esiste già un team chiamato “${existingName}”.
    Archived teams count too.`                                 Contano anche i team archiviati.`
  // existingName is the structured field of the 409 `team_name_taken` body (required by the contract, 2026-11-26).
  // No name-less variant exists: a 409 without it shows createFailed / saveFailed.
  createFailed: 'Could not create the team.'                 'Impossibile creare il team.'
  saveFailed: 'Could not save the team.'                     'Impossibile salvare il team.'
  saveEdit: 'Save'  (common.actions.save)  busy 'Saving…'     (common)
}
detail: {
  titleFallback: 'Team'                                      'Team'
  back: 'Back to teams'                                      'Torna ai team'
  loading: 'Loading the team…'                               'Caricamento del team…'
  loadError: 'Could not load this team.'                     'Impossibile caricare questo team.'
  notFound: { title: 'Team not found',                       { title: 'Team non trovato',
    body: 'It may have been removed, or the link is wrong.' }  body: 'Potrebbe essere stato rimosso, oppure il link non è corretto.' }
  detailsTitle: 'Details'                                    'Dettagli'
  noDescription: 'No description'                            'Nessuna descrizione'
  created: 'Created' / updated: 'Last changed'               'Creato' / 'Ultima modifica'
  editDetails: 'Edit details'                                'Modifica dettagli'
  saved: 'Team saved'                                        'Team salvato'
  archivedNote: 'This team is archived. It is not offered    'Questo team è archiviato. Non viene proposto per i nuovi
    for new projects and it stays on the projects it is        progetti e resta sui progetti a cui è già collegato. Si
    already on. You can still change its members.'             possono ancora modificare i suoi membri.'
  stale: { title: 'This team has changed',                   { title: 'Questo team è cambiato',
    body: 'Someone else changed this team. Reload to see       body: 'Qualcun altro ha modificato questo team. Ricarica per
    their changes, then try again.',                            vedere le modifiche, poi riprova.',
    reload: 'Reload',                                          reload: 'Ricarica',
    inDialog: 'Someone else changed this team while you        inDialog: 'Qualcun altro ha modificato questo team mentre lo
    were editing. Your text is kept here so you can copy        modificavi. Il testo resta qui per poterlo copiare. Chiudi
    it. Close this dialog, reload, then edit again.',           questa finestra, ricarica e modifica di nuovo.',
    confirmReason: 'Reload to see the latest version first.' confirmReason: 'Ricarica prima per vedere l’ultima versione.' }
  archive: { action: 'Archive team',                         { action: 'Archivia team',
    title: (name) => `Archive “${name}”?`,                     title: (name) => `Archiviare “${name}”?`,
    body: 'It will no longer be offered when a project          body: 'Non verrà più proposto quando un responsabile di
    manager attaches a team to a project. It keeps its          progetto collega un team a un progetto. Mantiene i suoi
    members and stays on every project it is already on,        membri e resta su ogni progetto a cui è già collegato, dove
    where its members keep counting. You can restore it         i suoi membri continuano a contare. Si può ripristinare in
    at any time.',                                              qualsiasi momento.',
    confirm: 'Archive', busy: 'Archiving…',                    confirm: 'Archivia', busy: 'Archiviazione…',
    done: (name) => `Team “${name}” archived`,                  done: (name) => `Team “${name}” archiviato`,
    failed: 'Could not archive the team.' }                    failed: 'Impossibile archiviare il team.' }
  restore: { action: 'Restore team',                         { action: 'Ripristina team',
    title: (name) => `Restore “${name}”?`,                     title: (name) => `Ripristinare “${name}”?`,
    body: 'It will be offered again when a project manager     body: 'Verrà proposto di nuovo quando un responsabile di
    attaches a team to a project.',                             progetto collega un team a un progetto.',
    confirm: 'Restore', busy: 'Restoring…',                    confirm: 'Ripristina', busy: 'Ripristino…',
    done: (name) => `Team “${name}” restored`,                  done: (name) => `Team “${name}” ripristinato`,
    failed: 'Could not restore the team.' }                    failed: 'Impossibile ripristinare il team.' }
  members: {
    title: 'Members'                                          'Membri'
    hint: 'A team grants no permissions. On every project      'Un team non conferisce permessi. Su ogni progetto a cui è
      this team is attached to, its members count as people     collegato, i suoi membri contano come persone del progetto:
      on the project: they can record hours, be given tasks     possono registrare ore, ricevere attività e leggere i
      and read the project’s linked meetings.'                  meeting collegati al progetto.'
    countOf: (n, limit) => `${n} of ${limit} members`          n === 1 ? `1 membro su ${limit}` : `${n} membri su ${limit}`
    deactivatedCount: (n) => ` · ${n} deactivated`             ` · ${n} disattivati` (1: 'disattivato')
    caption: 'Members of this team'                            'Membri di questo team'
    columns: { name: 'Name', email: 'Email', added: 'Added' }  { name: 'Nome', email: 'Email', added: 'Aggiunto il' }
    deactivated: 'Deactivated'                                 'Disattivato'
    deactivatedNote: 'Deactivated people stay listed, are      'Le persone disattivate restano nell’elenco, non sono
      not counted as active, and count again if the account     conteggiate come attive e tornano a contare se l’account
      is reactivated.'                                          viene riattivato.'
    empty: { title: 'No members yet',                          { title: 'Ancora nessun membro',
      body: 'Add the people who work in this team.' }            body: 'Aggiungi le persone che lavorano in questo team.' }
    add: { label: 'Add a member',                              { label: 'Aggiungi un membro',
      hint: 'Search by name or email. Only active users          hint: 'Cerca per nome o email. Si possono aggiungere solo
      can be added.',                                             utenti attivi.',
      button: 'Add', busy: 'Adding…',                           button: 'Aggiungi', busy: 'Aggiunta…',
      searching: 'Searching…',                                  searching: 'Ricerca…',
      noMatch: 'No active user matches, or they are              noMatch: 'Nessun utente attivo corrisponde, oppure è già
        already on this team.',                                    in questo team.',
      forbidden: 'You may not search users.',                   forbidden: 'Non è consentito cercare gli utenti.',
      unavailable: 'Users could not be searched. Try again.',   unavailable: 'Impossibile cercare gli utenti. Riprova.',
      count: (n) => n === 1 ? '1 user found' : `${n} users found`, n === 1 ? '1 utente trovato' : `${n} utenti trovati`,
      added: (name) => `${name} added to this team`,            `${name} aggiunto a questo team`,
      notActive: 'This person is not an active user and         'Questa persona non è un utente attivo e non può essere
        cannot be added.',                                         aggiunta.',
      limit: (max) => `A team has at most ${max} members,       `Un team ha al massimo ${max} membri, comprese le persone
        deactivated people included.`,                             disattivate.`
      full: (max) => `This team has ${max} members,             `Questo team ha ${max} membri, comprese le persone
        deactivated people included. Remove someone to add         disattivate. Rimuovine uno per aggiungerne un altro.`
        another.`,
      failed: 'Could not add this member.' }                    failed: 'Impossibile aggiungere questo membro.' }
    remove: { label: (name) => `Remove ${name} from this        `Rimuovi ${name} da questo team`,
      team`,
      title: (name) => `Remove ${name}?`,                       `Rimuovere ${name}?`,
      body: 'They leave this team only: their other teams,      'Esce solo da questo team: gli altri team, i ruoli e i
        roles and departments do not change. On every project     reparti non cambiano. Su ogni progetto a cui questo team è
        this team is attached to they stop counting within a      collegato smette di contare entro un minuto, a meno che
        minute, unless they are on the project another way.',     non sia sul progetto in un altro modo.',
      confirm: 'Remove', busy: 'Removing…',                     (common)
      done: (name) => `${name} removed from this team`,         `${name} rimosso da questo team`,
      failed: 'Could not remove this member.' }                 'Impossibile rimuovere questo membro.'
  }
}
```

(`common.actions.*`, `common.nameRequired`, `common.fields.*`, `common.emptyValue` are reused as they are.)

### projects-ui — `src/strings/project.ts` (`team` namespace, extend) and `src/strings/projects.ts` (`list`, extend) and `src/strings/tasks.ts`

```ts
// project.team (existing keys kept; values marked * change)
edit: 'Edit people'*                                          'Modifica persone'*
empty: 'No people listed yet.'*                               'Ancora nessuna persona in elenco.'*
people: { title: 'People', label: 'People listed on this project' }   { title: 'Persone', label: 'Persone elencate in questo progetto' }
teams: {
  title: 'Teams'                                              'Team'
  edit: 'Edit teams'                                          'Modifica team'
  empty: 'No teams attached.'                                 'Nessun team collegato.'
  listLabel: 'Attached teams'                                 'Team collegati'
  unnamed: 'Team could not be loaded'                         'Impossibile caricare il team'
  archived: 'Archived'                                        'Archiviato'
  archivedNote: 'Archived: it stays on this project until     'Archiviato: resta su questo progetto finché non viene
    it is removed.'                                             rimosso.'
  counted: (n) => n === 1 ? '1 person counts on this         n === 1 ? '1 persona conta su questo progetto' : `${n} persone contano su questo progetto`
    project' : `${n} people count on this project`
  membersLabel: (name) => `Members of ${name}`                `Membri di ${name}`
  membersUnavailable: 'Members could not be loaded'           'Impossibile caricare i membri'
  noMembers: 'This team has no members.'                      'Questo team non ha membri.'
  deactivated: 'Deactivated'                                  'Disattivato'
  noAccess: 'No access to Projects'                           'Nessun accesso a Progetti'
  noAccessLegend: 'People marked “No access to Projects” do   'Le persone con “Nessun accesso a Progetti” non contano come
    not count as on this project until an administrator        persone del progetto finché un amministratore non dà loro
    gives them access.'                                         accesso.'
  showAll: (n) => `Show all ${n} people`                      `Mostra tutte le ${n} persone`
  showFewer: 'Show fewer'                                     'Mostra meno'
  unavailable: { title: 'Some teams could not be loaded',     { title: 'Impossibile caricare alcuni team',
    body: 'Their members are not shown. People who are on      body: 'I loro membri non vengono mostrati. Le persone che sono
    this project only through a team may be missing from        sul progetto solo tramite un team potrebbero mancare negli
    the lists of people, such as the task assignee.' }          elenchi di persone, come l’assegnatario di un’attività.' }
  // AC-5.6, plan D15. Shown instead of `unavailable` when teamsStatus is "rate_limited". Retry label: the one of `unavailable`. `stillLimited` is also the hidden status line of the `unavailable` banner's Retry.
  rateLimited: {
    title: 'Too many requests'                                  'Troppe richieste'
    lead: 'You made too many requests, so teams and their       'Hai fatto troppe richieste, quindi per ora i team e i loro
      members are not shown for now.'                             membri non vengono mostrati.'
    retryIn: (minutes) => minutes === 1                         minutes === 1
      ? 'Try again in a minute.'                                  ? 'Riprova tra un minuto.'
      : `Try again in ${minutes} minutes.`                        : `Riprova tra ${minutes} minuti.`
    retryLater: 'Try again later.'                              'Riprova più tardi.'
    consequences: 'People who are on this project only         'Le persone che sono sul progetto solo tramite un team
      through a team may be missing from lists of people,         potrebbero mancare negli elenchi di persone, come
      such as the task assignee, and may not be offered           l’assegnatario di un’attività, e potrebbe non essere
      Record hours on this page. You can still record hours       offerto loro Registra ore in questa pagina. Si possono
      from My hours.'                                             comunque registrare le ore da Le mie ore.'
    stillLimited: 'Checked again. Teams are still not shown.'   'Controllato di nuovo. I team non vengono ancora mostrati.'
    // The banner reads: lead + (retryIn(ceil(seconds / 60)) | retryLater) + consequences. `minutes` is an integer 1..10;
    // the component passes retryLater when the seconds are not a whole number of at least 1.
  }
  dialog: {
    title: 'Edit teams'                                       'Modifica team'
    description: 'Everyone in an attached team who has        'Chi fa parte di un team collegato e ha accesso a Progetti
      access to Projects counts as part of this project:        conta come parte di questo progetto: può registrare ore,
      they can record hours, be given tasks and read the        ricevere attività e leggere i meeting collegati al progetto.
      project’s linked meetings. This follows the team as       Segue il team quando cambia.'
      it changes.'
    add: 'Attach a team'                                      'Collega un team'
    addHint: (n, max) => `${n} of ${max} teams. Only active   `${n} team su ${max}. Si possono collegare solo team attivi; un
      teams can be attached; an administrator creates            amministratore crea i team in Amministrazione.`
      teams in Admin.`
    narrowHint: 'Type more of the name to narrow the list.'   'Scrivi altre lettere del nome per restringere l’elenco.'
    limitHint: (max) => `A project can have at most ${max}    `Un progetto può avere al massimo ${max} team. Rimuovine uno
      teams. Remove one to attach another.`                     per collegarne un altro.`
    limitReached: (n, max) => `${n} of ${max} teams attached` `${n} team su ${max} collegati`
    attached: 'Attached teams'                                'Team collegati'
    none: 'No teams attached.'                                'Nessun team collegato.'
    unnamed: 'Team that could not be loaded'                 'Team che non è stato possibile caricare'
    removeHint: 'Removing a team removes its members from     'Rimuovere un team toglie i suoi membri da questo progetto,
      this project, unless they are also listed or in            a meno che siano anche elencati o in un altro team
      another attached team.'                                    collegato.'
    removeButton: 'Remove'                                    'Rimuovi'
    remove: (name) => `Remove ${name}`                        `Rimuovi ${name}`
    removeUnnamed: (n) => `Remove team ${n} that could not    `Rimuovi il team ${n} che non è stato possibile caricare`
      be loaded`
    search: {                                                 {
      searching: 'Searching teams…'                             searching: 'Ricerca dei team…'
      noMatch: 'No active team matches, or it is already        noMatch: 'Nessun team attivo corrisponde, oppure è già
        attached.'                                                collegato.'
      forbidden: 'You may not attach teams.'                    forbidden: 'Non è consentito collegare team.'
      unavailable: 'Teams could not be searched. Nothing was    unavailable: 'Impossibile cercare i team. Non è stato modificato
        changed. Try again.'                                      nulla. Riprova.'
      count: (n) => n === 1 ? '1 team found'                    n === 1 ? '1 team trovato'
        : `${n} teams found`                                      : `${n} team trovati`
    }                                                         }
    submit: 'Save teams', busy: 'Saving…'                     'Salva team', 'Salvataggio…'
    errors: {
      team_archived: (names) => `These teams were archived    `Questi team sono stati archiviati e non possono più essere
        and can no longer be attached: ${names}. Remove          collegati: ${names}. Rimuovili per salvare.`
        them to save.`
      team_not_found: 'A team you chose no longer exists.     'Un team scelto non esiste più. Chiudi questa finestra e
        Close this dialog and try again.'                        riprova.'
      teams_unavailable: 'Teams could not be loaded right     'Al momento non è possibile caricare i team. Non è stato
        now. Nothing was changed. Try again in a moment.'        modificato nulla. Riprova tra poco.'
      rate_limited: 'Too many requests, so nothing was        'Troppe richieste: non è stato modificato nulla.'
        changed.'
      // The message shown is rate_limited + ' ' + teams.rateLimited.retryIn(minutes) (or retryLater), minutes from the 429 body's
      // retryAfterSeconds. Only on a 429 of PUT …/teams, the one 429 of a project write (plan D15).
    }
  }
}
saved.teams: 'Teams saved.'                                   'Team salvati.'
// projects.list
team: 'Team'                                                  'Team'
teamArchived: (name) => `${name} (archived)`                  `${name} (archiviato)`
teamUnreadable: 'Team that could not be loaded'              'Team che non è stato possibile caricare'
teamsFailed: 'The teams could not be loaded.'                 'Non è stato possibile caricare i team.'
noTeamsYet: 'No team is attached to a project yet.'           'Nessun team è ancora collegato a un progetto.'
// tasks.form
membersIncomplete: 'Some team members could not be loaded,    'Non è stato possibile caricare alcuni membri dei team, quindi
  so this list may be missing people.'                          l’elenco potrebbe non includere tutte le persone.'
assigneeNotOnProject (existing, value changes): 'Choose       'Scegli una persona che fa parte del progetto.'
  someone who is on this project.'
```

## Data test ids (e2e: `shell/e2e/admin-teams.spec.ts`, `projects-teams.spec.ts`)

Existing ids that stay: `project-team`, `project-team-edit` (now the **Edit people** button), `project-team-*` dialog
ids, `projects-stale-write*`, `projects-saved`, `projects-load-error*`, `error-banner*`.

**admin-ui**
- Page: `admin-teams-page`, `new-team-button`, `teams-search`, `teams-show` (select), `teams-count-live`, `teams-table`,
  `team-open-<teamId>`, `team-state-<teamId>`, `teams-empty-state`, `teams-no-match`, `teams-no-active`, `teams-success`
- Create/edit dialog (`testIdPrefix`): `create-team` / `edit-team` → `-submit`, `-cancel`, `-close`, `-error`; inputs
  `create-team-name-input`, `create-team-description-input`, `edit-team-name-input`, `edit-team-description-input`,
  errors `create-team-name-error`, `edit-team-name-error`
- Detail: `team-detail-page`, `team-detail-back-link`, `team-status`, `team-edit-details`, `team-archive`, `team-restore`,
  `team-details-section`, `team-archived-note`, `team-stale-banner`, `team-stale-reload`, `team-created`
- Members: `team-members-section`, `team-members-count`, `team-members-table`, `team-member-<userId>`,
  `team-member-deactivated-<userId>`, `team-member-remove-<userId>`, `team-members-empty`, `team-member-picker`
  (`SearchPicker`; input `team-member-picker-input`), `team-member-add`, `team-members-error`, `team-members-success`,
  `team-members-full`
- Confirm dialogs: `archive-team`, `restore-team`, `remove-team-member` → `-confirm`, `-cancel`, `-error`
- Must **not** exist: any `team-delete*` (AC-1.7)

**projects-ui**
- Card: `project-team` · People: `project-team-people`, `project-team-edit` · Teams: `project-attached-teams`,
  `project-attached-teams-edit`, `project-attached-teams-empty`, `project-attached-teams-unavailable`,
  `project-attached-teams-unavailable-retry`, `project-attached-teams-legend`, `project-attached-teams-heading` (the Teams `h4`, `tabIndex={-1}`),
  `project-attached-teams-rate-limited` (the too-many-requests banner), `project-attached-teams-rate-limited-title`,
  `project-attached-teams-rate-limited-retry`, `project-attached-teams-retry-status` (the hidden polite line). The two banners are
  mutually exclusive: tests assert one present and the other absent
- Per team: `project-attached-team-<teamId>`, `-name-<teamId>`, `-archived-<teamId>`, `-members-<teamId>`,
  `-members-unavailable-<teamId>`, `-more-<teamId>`; per member: `project-attached-team-member-<teamId>-<userId>`,
  `-deactivated-<teamId>-<userId>`, `-noaccess-<teamId>-<userId>`
- Dialog (`testIdPrefix project-attached-teams-dialog`): `-submit`, `-cancel`, `-close`, `-error`; `project-attached-teams-add`
  (the `SearchPicker` field) / `-add-input`, `-add-input-listbox` (same ids as before; there is no Attach button: a pick stages
  the team); `project-attached-teams-list`, `-row-<teamId>`, `-remove-<teamId>`,
  `-count` (live), `-limit`; the save 429 shows in the existing `project-attached-teams-dialog-error`
- List filter: `projects-team` (Field; the `select` inside)
- Task form: `task-form-assignee` (existing; hint text only)

## Accessibility

Applies to both apps and every screen; items are test-able.

**Structure and landmarks**
- One h1 (tool title via `ToolLayout`), one h2 per page (`PageHeader`), h3 per card, h4 for the Team card's People / Teams
  sections; no skipped level. The `SectionNav` landmark keeps its label "Admin sections"; **Teams** is a real `<a>`
  (`aria-current="page"` from `<Link>`).
- Tables have a caption; row header per row; the members table's Remove buttons are named by person ("Remove Ada Rossi from
  this team"); the actions column header is visually hidden but present.
- The Teams section's team blocks are a `<ul aria-label>` of `<li>`; each member list is a `<ul aria-label="Members of
  Backend">`. Badges carry glyph + text: Deactivated (`voided` icon), Archived (`voided` icon), No access to Projects (`lock`
  icon) so colour is never the only signal.

**Dialogs (ADR 20261118)**
- `FormDialog` / `ConfirmDialog` render their own `<form>` and do not portal: mount each as a **sibling** of the page content
  (admin: the section root, beside the cards; projects: `TeamCard` returns a fragment `Card` + dialog). The admin filters and
  the add-member row are not in a `<form>`. Tests assert `document.querySelectorAll('form form')` is empty in every dialog
  state, and e2e confirms Archive / Remove / Save teams with the keyboard (Enter in `FormDialog`, Space on Confirm).
- The opening buttons carry `aria-haspopup="dialog"` and are plain buttons (never `aria-pressed`).
- Focus: into the first field (create/edit) or Cancel (confirm); back to the opener on close. Cases where the opener
  disappears: after Archive/Restore the buttons swap, so focus goes to the page heading (`PageHeader focusableHeading` +
  `headingRef`, the QE A1 precedent in `ProjectDetailPage`); after Create the new page's heading takes focus.
- Dialogs holding typed input ignore the backdrop (library behaviour); busy states cannot be dismissed.
- `SearchPicker` inside the attach dialog (a `Combobox` in a `Field`): Enter selects an option and must not submit the form
  (Enter on a closed list submits); ↓/↑/Home/End/Escape per the library; "Searching teams…", the result count and the
  no-match / forbidden / unavailable lines are announced politely by the library (`liveRegionText`) and are also the list's
  visible content, so the failure is never silent or read as "no match"; after a pick the field empties and keeps focus; the
  limit message is the hint (`aria-describedby`) of the disabled field.

**Keyboard paths**
- Admin list: Tab → Search → Show → table links → New team. New team (opens create dialog), Enter submits.
- Team page: back link → Edit details → Archive/Restore → picker (type, ↓, Enter picks) → **Add** → members rows → Remove.
  After Add, focus stays in the picker; after Remove, it moves to the picker; after a dialog closes, to its opener or the
  heading as above.
- Projects Team card: **Edit people** and **Edit teams** are separate tab stops in their section headers; **Show all N
  people** is a button (`aria-expanded`, `aria-controls` the list).
- Projects filter: the Team `select` is native, label "Team".

**Announcements (polite live regions, never moving focus)**: list count after each filter change; "X added to / removed
from this team"; "N of 10 teams attached" in the dialog; combobox / SearchPicker result counts and "Searching…". Assertive
(`role="alert"`) only for refusals the person must act on: `form-error` in dialogs, the field errors, the stale banner, the
`not found` panel. The "Some teams could not be loaded" and "Too many requests" banners are `live="polite"` (`role="status"`: the page did load, nothing
is time-critical): a banner that appears with the page is read in place, one that appears after a write response is announced. The
inline save 429 in the Edit teams dialog is `role="alert"` like every `form-error`. Success banners are
`role="status"` and auto-dismiss.

**Errors**: field errors under the control (`Field` wires `aria-invalid` and `aria-describedby`); a failed submit moves
focus to the first invalid field (`focusFirstInvalid`), including the name-clash case; errors state the cause in words
(never colour alone).

**Contrast / theme**: only token utilities; the badges, banners and `text-soft` are library-checked in both themes. No
`text-muted` for text people must read; the legend and notes use `text-soft`.

**Too-many-requests state (S6, F16)**
- The banner is a `role="status"` region with a bold title ("Too many requests") followed by the text; it is not colour-only (icon, title).
- Retry keeps its place when the answer is still `"rate_limited"` (same element), so focus stays on it; a visually hidden polite region,
  mounted once and filled after each such click, says "Checked again. Teams are still not shown." (the banner announces the
  minutes only when they changed). When the focused Retry disappears, focus moves to the Teams heading (`tabIndex={-1}`), the same rule as for the
  "unavailable" banner; focus is never lost to the body.
- The per-team "Team could not be loaded" and "Members could not be loaded" are plain text in each `li` (up to 10 repetitions), not
  announced on their own; the banner is the one message.
- The minutes are static text, not a ticking timer: nothing re-announces by itself.
- Record hours missing for a team-only person is explained in the banner text (not by a disabled control).

**Reduced motion / zoom**: nothing animates beyond the library's; the member grid collapses to one column below `sm`; the
admin `SectionNav` already wraps (WCAG 1.4.10).

**Hotspots**: (1) the SearchPicker + Add pair (pick must not write; focus handling after add/remove); (2) the 10-row
attach dialog with a `SearchPicker` inside a form (Enter must pick, not submit; the staged-then-saved model); (3) the unreadable-team block (three distinct text states, none guessed);
(4) the stale dialog (error + blocked submit + banner afterwards); (5) two near-identical buttons "Edit people" / "Edit teams"; (6) the Retry that stays or disappears (focus, the hidden status line) and the
banner that swaps between "Too many requests" and "Some teams could not be loaded".

## Scope flags (UI added or changed that no AC asks for — reported, minimal)

1. **"Show all N people" toggle** for teams over 12 members: not asked by any AC; needed because a project can show up to
   10 × 100 members (AC-4.3 + O9).
2. **Consent/consequence copy** (Members card hint, attach dialog description, archive body, remove body): states the O8 / O4
   effects in the places a person decides. Copy only, no extra control.
3. **Archived page banner and the card's "Archived: …stays on this project" line**: informational.
4. **Renaming the existing button** "Edit team" to "Edit people" (key `project.team.edit`, value changed; behaviour and test id
   unchanged): avoids two buttons named "Edit team(s)" (O11 follow-through).
5. **Narrowing hint** in the attach dialog when the server answers `truncated` (copy only; it replaces the dead-end "Not every team
   is listed here"). No AC asks; it follows from the owner's 2026-11-26 decision to search server-side.
6. **Consequences sentence in the "Too many requests" banner** (Record hours may not be offered here; My hours still records): no AC asks; it explains the
   one visible side effect of AC-5.6 (a team-only person loses the offer, plan § UI surface) so the missing button is not a mystery. Copy only.
7. **The hidden "Checked again…" status line and the focus move to the Teams heading after Retry**: no AC asks; without them a click that changes
   nothing is silent for a screen-reader user and a successful Retry drops focus. Applied to the "unavailable" banner too (same handler).
8. **The save 429's inline message** (S7): the plan (D15) refuses the write with 429 and asks for "inline, too many requests, nothing was changed"; AC-5.6
   speaks of page loads only. Reported because it is UI no AC names; it follows the plan.
9. **Not designed (reported, not added)**: a warning inside the Edit teams dialog before saving when the project already shows "Too many requests" (the
   save would be refused; the state may have lapsed by then, and the plan asks for the message on the refusal); an automatic reload when the wait ends;
   a countdown; a marker on a person who is both listed and in a team (would explain AC-4.5 at
   a glance; no AC asks); a team description or member count in the Projects card; a "my teams" view (O15); search by
   member on the Admin list.

## Gaps and drift (spec / plan)

- **G1 (plan, AC-1.2 + AC-3.3): RESOLVED 2026-11-26.** The owner decided that auth's 409 `team_name_taken` carries a structured
  `existingName` (beside `code`), so the browser composes `form.nameTaken(existingName)` in `en` or `it` and names the clash
  (AC-1.2) in the user's language (AC-3.3). The generic name-less sentence is removed from the design. Residual, for the
  architect's plan: `existingName` must be non-optional in the 409 schema; the design treats a 409 without it as a generic failure
  (`createFailed` / `saveFailed`), not as a name-less clash. `team_full { limit }` and `team_archived { teamIds }` were already
  structured.
- **G2 (plan, AC-4.1): RESOLVED 2026-11-26.** The owner decided that `GET /attachable-teams` accepts an optional `q`
  (server-side, case-insensitive name match). The attach dialog is now a server-searched `SearchPicker` (S7); the
  "Not every team is listed here" fallback is removed. Residual, for the architect's plan: (a) `q` bound: the design never sends
  text longer than 80 characters (it answers "no match" locally) and sends the trimmed text, empty meaning "the first active
  teams"; the route should still validate `q` (strict, max 80) and answer 400 beyond it; (b) the cap behind `truncated` stays, and
  the UI now treats it only as a "type more" hint; (c) the server does not exclude already-attached ids, the client does, so with
  up to 10 attached a capped page could be partly consumed by them: the cap should exceed 10 plus a usable page.
- **G3 (spec/plan wording)** Plan § UI surface says admin-ui's stale save "shows the stale banner and keeps the typed values".
  The design keeps typed values in the **open dialog** (submit blocked) and shows the banner on the page once the dialog is
  closed (S4); a literal banner behind a modal would be unreachable. Interpretation, not a contradiction.
- **G4 (plan, naming)** The plan's `strings` for the Team card keep "Team" with People and Teams (O11) but leave the existing
  "Edit team" label; this design changes its value (scope flag 4).
- **G5 (consistency)** Departments use a hand-rolled search form for adding members; this design uses `SearchPicker` instead
  (design-system names it for server-side search and says remote apps still carrying copies move when next touched). Two
  add-member patterns will coexist in admin-ui until Departments is touched; not a spec issue.
- **G6 (copy)** A deactivated member reads "Deleted user" (existing `people.deleted`, from the plan's `name: null`) beside the
  badge "Deactivated"; the two words differ for the same state. Aligning `people.deleted` is a suite copy decision, left alone.
- **G7 (plan § UI surface, "drift for the designer"): RESOLVED.** The plan left the copy of the too-many-requests banner and of the dialog's 429 to
  this design. Both are in Copy (`teams.rateLimited`, `dialog.errors.rate_limited`, en and it), with the Retry behaviour in S6.
- **G8 (dependency for frontend-dev):** Retry relies on the page's reload being **in place**. `ProjectDetailPage` uses `useResource`
  (`resource.retry`, `resource.replace`); if its retry replaces the page with the loading state, the Team card remounts and loses the hidden
  status line and the focus rule. The designer did not read `useResource`'s retry semantics. If that is how it behaves, the page heading takes focus
  when the reload settles and the hidden status line is dropped (the banner's minutes still update); no copy changes. To be settled in the task.
- **G9 (design correction, copy):** the earlier "Some teams could not be loaded" body ended "Nothing was changed.". Plan D15 and the AC-5.4 tests
  return a degraded view from **writes** that committed (a PATCH, a `PUT …/teams` that only removes), so on the same screen as "Saved" the sentence
  would be false. It is removed from `teams.unavailable.body` (en and it); the "Too many requests" banner never had it. The dialog's own error
  messages keep "Nothing was changed", which is true there (a refused write). This edits copy this design had already proposed; no spec or plan change.
- **G10 (check, possible existing behaviour):** while the teams are not loaded (F16 or "unavailable") `onProject` drops team-only people, so the task
  assignee `select` of a task already assigned to one has no option for its current value. AC-5.2 says an unchanged resend of such a task is
  accepted by the server; the form must keep the current assignee selectable (and unchanged) rather than blank it or raise "Choose someone who is
  on this project". Not verified in `TaskFormDialog`; frontend-dev to check and test.
- **G11 (plan wording, no conflict):** plan § UI surface says the banner "may use" `teamsRetryAfterSeconds`; the design uses it, rounded up to minutes,
  and falls back to "Try again later." when it is missing. The plan's remark that Retry "succeeds only after the wait" is shown honestly: a click
  before it re-shows the banner with the smaller number (S6).
- No AC lacks a flow or a verifier; the ACs with no UI surface are listed under Flows. AC-3.1's "redirects away" is realised
  as a redirect for a legal-entity manager and the denied panel otherwise (the plan's reading).

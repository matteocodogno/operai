# 20261116 — Recording hours from another tool's page is hours-ui's own widget, embedded through the shell's host-extension seam: plain strings in, nothing back, and the host decides only whether to show it

**Date:** 2026-11-16
**Status:** Accepted (specs/20261116-record-hours-in-place plan approved 2026-11-16)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR 20261104-host-extension-federated-panel-through-the-shell](20261104-host-extension-federated-panel-through-the-shell.md) (this applies that seam to a second domain widget and to a list row), [ADR 20261110-shell-floating-slot-for-remote-widgets](20261110-shell-floating-slot-for-remote-widgets.md) (same loader, same failure rule), [ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route](20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md) (who may record is asked of the owner), [ADR 20261112-hours-api-time-entries-own-service-hours-catalog](20261112-hours-api-time-entries-own-service-hours-catalog.md), [ADR 20261112-hours-ui-ungated-remote](20261112-hours-ui-ungated-remote.md), [ADR 20261031-shared-ui-library-consumed-as-source](20261031-shared-ui-library-consumed-as-source.md) (why the dialog is not in `@operai/ui`), [ADR 20260709-suite-frontend-module-federation](20260709-suite-frontend-module-federation.md), [ADR 20260803-suite-version-generated-file-federated-export](20260803-suite-version-generated-file-federated-export.md)

---

## Context

A person working on a project, a deal or a task has to leave that page, open My hours from the user menu and find
the same project, deal or task again in a picker before recording a few hours. The detour is slow and hours are then
recorded late and less accurately, so the project page, the CRM deal page and each task row must offer Record hours
(specs/20261116-record-hours-in-place, US-1 to US-3). The dialog that records must be My hours' own dialog, so the
rules and refusals match (AC-4.2), and the offer must degrade to a link to My hours when the hours screens cannot be
loaded (AC-4.5). Two hosts (projects-ui, crm-ui) show these pages, and the same question arises for every task list
they render.

## Decision

We will render Record hours as **hours-ui's own federated widget `./RecordHours`**, reached through the shell's
existing `HostExtension` seam under the new extension name `hours.recordHours`, and the host will decide only *whether*
to render it from data it already shows.

1. **hours-ui exposes `./RecordHours`**. The widget owns everything after the click: it opens My hours' `EntryDialog`
   with the target (and the task) set and fixed, saves through the unchanged `POST /time-entries` as the person, and
   says what it recorded with a "See in My hours" link. It never edits, deletes or reads entries.
2. **The shell registers `hours.recordHours`** in `ExtensionProps` and `LOADERS` (`() => import('hours/RecordHours')`),
   with the existing 5 s timeout, error boundary and per-host fallback. The props are plain strings only: `on`
   (`project` | `deal` | `none`), `targetId`, `targetName`, `activityId`, `activityName`, `placement` (`page` | `row`).
   Nothing comes back across the seam: no callback, no return value.
3. **The widget rejects an invalid prop set by throwing at render**, so the host's boundary shows its fallback. A host
   bug must never become a silent "record on nothing".
4. **Each host decides visibility from what it already shows**, in one pure function per host (`mayRecordOnProject`,
   `mayRecordOnDeal`, `mayRecordOnTask`) built on the object the row or the page already holds: a project's project
   manager and team; a deal's owner and technical contact; a task's assignee and participants (the author alone is
   not offered it). Each host also has one `recordHoursPropsOf(…)` that builds the props from that same object, so
   the id and the name the person sees come from one source.
5. **A host renders the widget through a small seam wrapper of its own** (dynamic `import('shell/extensions')`, a
   feature check, its own error boundary: the shape of crm-ui's `MeetingsSection`), because `@operai/ui` cannot import
   `shell/extensions`. Its fallback is a link to My hours.

**The rule this records:** a host may embed another tool's *write* as that tool's widget, passing only what the host
already shows and getting nothing back. Whether to *show* the offer may be the host's decision; whether the person is
*allowed* to record never is. The owner (hours-api, asked as the caller) decides every save.

## Failure shape

**A permission answered by a copy of the owner's facts, shown in someone else's UI, and taken as the answer.** The
host's button, its prop set or a list it cached stands in for the question "may this person do this?", and nobody
asks the one service that owns the answer. The mistake is not one bad check; it is that the place which *displays* an
affordance quietly becomes the place which *decides* it, and the two drift apart the next time the owner's rule
changes.

Symmetric cases, where the same text must still catch the mistake:

- **Show versus accept.** A hidden button is not access control, and a visible one is not permission. The same error
  appears as a route that trusts the UI's gate, or as a UI that hides a control while the route still accepts it.
  Read the host's visibility rule as a convenience that is allowed to be wrong in either direction, and check the
  owner's answer on every write.
- **Identifier and label from two sources.** The person confirms a name the host displayed, and the write uses an id
  the host passed. When the two come from different objects, the person records on something they did not see. The
  same shape appears in any embedded widget that writes to a target named by someone else, and in a success message
  that names a target the server never confirmed.
- **Read side of the same seam.** A host that shows a fact it got with its own right, and hands its id to a widget
  that writes with the viewer's right, carries authority across the boundary. The mirror case is a widget reading back
  a fact the host may not show. Ask, for every new embedded widget, which right each side is using at the moment it
  acts.
- **Stale copy.** A host that keeps a figure derived from the write it hosted (a card of the person's hours on the
  project) shows yesterday's answer after the widget saved. Nothing comes back across the seam, so the host cannot
  know; a widget that writes must say so to the person, and a host that shows totals must re-read rather than
  reason from its own copy.

Recognise it in any future embedded write: a button on a page, a row action, a "just this once" shortcut that
prefills a form from a list, or a permission-like flag passed as a prop.

## Options considered

### Option A — hours-ui's own `./RecordHours` widget through the `hours.recordHours` seam (chosen)

Hosts pass plain strings; the widget owns the dialog, the write and the message; the host's fallback is a link to My
hours; visibility is a pure function per host.

**Pros:**
- One dialog, one set of rules and messages (AC-4.2), changed in one place without redeploying any host.
- Reuses the seam proven by Meetings on the CRM deal page (ADR 20261104-host-extension-federated-panel-through-the-shell), with the same timeout, boundary and fallback.
- Nothing crosses back into the host; no new callback or toast API.
- The host needs no hours knowledge beyond the props.

**Cons:**
- A second kind of federated widget per row; many `HostExtension` instances on a task list (the import is cached, and only rows the person may record on render one).
- The props are a runtime-typed contract, declared once in the shell and copied by hand into crm-ui's `remotes.d.ts`.
- Deploy order matters for the offer to work; every other order degrades to the fallback link.

### Option B — a copy of the entry dialog in each host

**Pros:** no seam; each host fully owns its look.

**Cons:** two dialogs with two sets of rules and messages; they drift the first time My hours changes. Against spec D3 and AGENTS.md "never copy a component from another app".

### Option C — `EntryDialog` in `@operai/ui`

**Pros:** one component, one import, no federation.

**Cons:** the dialog reads hours-api, and three owners' searches (projects, CRM, meetings). ADR 20261104-host-extension-federated-panel-through-the-shell keeps domain widgets out of the design system; `@operai/ui` is for primitives used everywhere.

### Option D — a link that opens My hours with the target prefilled

**Pros:** no widget, no seam, no extra code in the hosts.

**Cons:** the person leaves the page, which is the problem this work exists to solve.

### Option E — a host callback across the seam, or a shell toast API for the success message

**Pros:** the host could show the message in its own chrome and refresh its own figures.

**Cons:** a function prop across the boundary, outside the error boundary's reset key, against the strings-only convention; or a new shell seam for a message the widget can say itself. AC-4.3 says nothing else on the page changes, so the host needs no callback today.

### Option F — ask hours-api whether to show the button, per row

**Pros:** the server's answer decides visibility as well as access.

**Cons:** a new API read per row on every task list; the person's rights are already decided at save, so the read adds load and a second rule to keep in step, for a question that is only a convenience. The user chose host-decided visibility (ledger D4).

## Consequences

**Positive:**
- The dialog, its rules, its refusals and its messages exist once, in My hours. A change to recording reaches every page on the next hours-ui deploy.
- A failure in hours-ui cannot break the project page, the deal page or a task list: each shows the link to My hours instead (AC-4.5), proven by the seam's tests and an e2e that aborts the hours remote.
- Nothing about hours goes back to a host, so no host gains a read path into hours.
- The authority stays where it was: hours-api decides every save as the caller, failing closed.

**Negative / trade-offs:**
- A shell deploy changes the seam for every host; the extension name list is the shell's to grow deliberately.
- crm-ui's hand-kept copy of `ExtensionProps` grows, and projects-ui gets its first use of `shell/extensions` (ambient type, test alias, stub).
- The widget cannot verify that `targetName` matches `targetId`; the hosts' `recordHoursPropsOf` functions are the only guard.

**Risks:**
- **Wrong pair of id and name** if a host builds the props from two objects. Mitigation: one function per host takes the single object the row or page holds; tests assert the props for a project task, a deal task and a CRM task with no deal.
- **Deploy order.** A host on a shell without `hours.recordHours`, or a shell before hours-ui's expose, shows the fallback link. Mitigation: deploy hours-ui, then the shell, then the hosts; unknown names fall back (`extensions.tsx`), so nothing breaks, the offer is only missing.
- **Visibility drift.** A host's rule may stop matching hours-api's bookability rule (for example, a new kind of assignee). Mitigation: the owner still refuses the save with `not_on_project` / `not_involved_in_deal`, shown with My hours' message; the host rule is a convenience, and a mismatch is a bug in the host's offer, not a hole.

## Revisit when

- A host must react to the save itself (for example, a read-only hours card of specs/20261112-project-hours that refreshes after the widget records). That is the first reason to add a callback or an event, and it needs its own decision.
- A third widget per row appears. Each row then mounts several seam instances, and the way rows embed widgets needs its own look.
- The strings-only props stop being enough (an object, a list of targets, a choice the host must make).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

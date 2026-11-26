# 20261126 — A figure set against another owner's figure is composed by the screen that owns the comparison, from each owner's own answer; a panel about one tool's data in another tool's page is that tool's widget

**Date:** 2026-11-26
**Status:** Accepted (specs/20261112-project-hours plan, decisions D-P3 and D-P4; accepted with the plan at its approval gate, 2026-11-26)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR 20261104-host-extension-federated-panel-through-the-shell](20261104-host-extension-federated-panel-through-the-shell.md) (the seam a read panel uses), [ADR 20261116-record-hours-widget-through-the-host-extension-seam](20261116-record-hours-widget-through-the-host-extension-seam.md) (the write widget on the same seam), [ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route](20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md) (a fact is read under its owner's right), [ADR 20261031-shared-ui-library-consumed-as-source](20261031-shared-ui-library-consumed-as-source.md) (why the panel is not a shared component)

---

## Context

A project's terms say what was sold (an hour package, a fixed price, a time-and-materials budget). The hours people
record are owned by hours-api. Projects-ui shows the comparison so a project manager can act before a package runs
out, and hours-ui shows the breakdown of those hours by work type and, for some viewers, by person. The comparison
needs a package window that only projects-api can derive, because it owns the terms. Two pages (project and deal) need
the breakdown.

The rejected designs each moved a model across a service line: hours-api reading the terms, projects-api calling
hours-api, or the widget receiving the terms as props. Another rejected design drew the breakdown from a shared
component that each host fed from its own summary call, which leaves the hours copy in two hosts.

## Decision

We will compose each figure on the screen of its owner, and keep each owner's rule on that owner's side.

1. **Consumption is composed by projects-ui**, the screen of the terms' owner. projects-api derives the hour package's
   current period on read (`hourPackage.currentPeriod`, from a pure `packagePeriod(hourPackage, today)`, today in
   Europe/Zurich, never stored). projects-ui asks hours-api's `GET /time-entries/summary` once for that window (or for
   all time when the terms have no window) and sets the two answers side by side. hours-api never learns the terms;
   projects-api never calls hours-api.
2. **The breakdown is hours-ui's read panel `./HostHours`**, reached through the shell's `HostExtension` seam as
   `hours.hostHours` with plain-string props `{ on: 'project' | 'deal', targetId }`. projects-ui and crm-ui embed it as
   they embed Meetings' panel: 5 s timeout, error boundary, the host's own fallback. Nothing comes back across the seam.
   The panel imports only hoursApi, its strings and `@operai/ui`; it never imports the export library, the pages or the
   router.
3. **`packagePeriod` lives in projects-api**, so the server-side alerts of specs/20261112-project-alerts, which run without
   a user, reuse it rather than copy it.

**The rule this records:** a figure set against another owner's figure is computed by the screen of the owner of the
comparison, from complete answers, each read under its own owner's right. A panel about one tool's data, shown inside
another tool's page, is that tool's widget, mounted through the seam: the host passes identifiers and gets nothing back.

## Failure shape

**A comparison built on a copy of one owner's model inside another owner's service or page, and one owner's presentation
re-implemented wherever it is shown.** The first half is a combined figure that is right only while two copies agree: a
service that re-derives a window from a copy of the terms, or learns another service's rules so it can answer alone.
The second half is the same breakdown drawn once per host, each with its own wording, rounding, error mapping and
per-person rule, so a change to the owner's rule reaches one page and not the other.

The mistake is about where the arithmetic and the drawing sit, not about one wrong formula. Each owner answers about
what it owns, and the screen that sets two answers against each other is the screen of the thing being compared.

Symmetric cases, where the same text must still catch the mistake:

- **Stored versus derived.** A "current period" column that one service writes and another reads is the copy under a
  new name. Derive it on read from the owner's rule, wherever the next consumer needs it.
- **Pull versus push.** A service that pulls the other's model in to answer ("over package"), and one that pushes its
  own figure into the other's answer (projects-api asking hours-api to fill in consumption), are the same error. For any
  figure, ask which side's rule decides it, and keep that rule on that side.
- **Props versus data.** An owner's model passed to a widget as strings or a props object is the copy in a seam's
  clothing. The widget receives identifiers and reads its own data under the viewer's right.
- **Host versus remote.** A host that rebuilds a remote's table, or a second implementation of a rounding rule
  (man-days from minutes), is the same presentation or model drawn twice.

Recognise it in any request to "show the hours of X on page Y", any dashboard that subtracts a figure held by another
service, any alert or export that combines two sources, and any second copy of a window, a rounding rule or a visibility
rule.

## Options considered

### Option A — Compose on the comparison's screen, panel from the owner (chosen)

Projects-ui sets the package figure against the summary; hours-ui owns the breakdown panel; projects-api derives the
window.

**Pros:**
- Each rule lives once, with its owner: the window with the terms, the hours with hours-api.
- hours-api learns no terms; projects-api makes no call; the seam carries identifiers only.
- The breakdown exists once, so its wording, its "without a work type" group and its per-person rule do too.
- The window is reusable by the alerts without a second implementation.

**Cons:**
- The project page calls the summary twice (card and panel), accepted for now (R3).
- The man-day rule lives in projects-ui and must be repeated in the alerts spec if it runs server-side (R6).
- The panel is a second kind of federated read widget, so its prop contract is copied by hand into crm-ui.

### Option B — hours-api reads the terms and answers the comparison

**Cons:** a second service learns the terms model, gains a cross-service read it does not need for its own data, and
changes with every package change. Rejected.

### Option C — projects-api calls hours-api to compose consumption

**Cons:** projects-api reads hours with a service credential on a user's behalf; there is no user path between the two,
so the read borrows authority it does not hold for that viewer. Rejected.

### Option D — the widget receives the terms as props

**Cons:** hours-ui learns the terms model through a string seam that cannot type it. Rejected.

### Option E — a shared `@operai/ui` breakdown that each host fills from its own summary call

**Cons:** each host owns a copy of the hours wording, the merged-group words, the error mapping and the per-person
rendering; the copies drift the first time the owner's rule changes. ADR
20261104-host-extension-federated-panel-through-the-shell keeps domain widgets out of the design system. Rejected.

## Consequences

**Positive:**
- Each figure has one owner and one place that computes it; a rule change ships with its owner.
- A broken hours-ui deploy shows a fallback on the project page; the terms and the card's own "Hours unavailable" state
  stay up.
- The alerts reuse the window server-side without a copy.

**Negative / trade-offs:**
- Two summary reads per project page, within the p95 budget of 800 ms.
- `hours.hostHours` is a shell-owned name; growing the seam is the shell's decision.

**Risks:**
- **A second copy of the man-day or window rule** in a new consumer. Mitigation: `packagePeriod` stays in projects-api;
  the man-day rule is one line with test vectors, recorded for the alerts spec.
- **Time counted twice** when a meeting's hours and the project's own hours record the same time (A48, accepted). This
  is a question of figures, decided in the plan, not by this placement.

## Compliance notes

- GDPR / data-protection impact: low. The panel shows per-person hours only to the project manager, the deal owner or a
  holder of see everyone's hours, decided by hours-api as the caller; the card shows no person.
- Data residency: compliant (EU services only, no new processor).
- Audit trail: not required by this decision.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

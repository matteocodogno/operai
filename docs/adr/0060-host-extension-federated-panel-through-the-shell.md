# 0060 — A host embeds Meetings through a federated panel loaded via `shell/extensions`: the case where a federated component is right, and ADR-0050's rejection does not apply

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-3)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0050](0050-shared-ui-library-consumed-as-source.md), [ADR-0006](0006-suite-frontend-module-federation.md), [ADR-0030](0030-suite-version-generated-file-federated-export.md), [ADR-0001](0001-jwt-in-memory-never-web-storage.md), [ADR-0059](0059-meeting-host-contract-resolve-and-notices.md), [ADR-0058](0058-meetings-tool-shape-visibility-by-participation.md)

---

## Context

The CRM deal page must show the meetings linked to the deal and offer "Start meeting"
(AC-11.2), and every future host will want the same. Meetings owns how its meetings are
listed, their status map, copy in Italian and English, and the permission rules (who sees
"Start meeting"). A host must keep working when Meetings is slow, broken or not yet deployed
(AC-11.6).

ADR-0050 rejected exposing *components* through Module Federation for the design system
(untyped runtime coupling). Reusing that rejection mechanically here would force every host to
re-implement the list; ignoring it would need a reason.

## Decision

1. **`meetings-ui` exposes `./HostMeetings`** with props `{ hostApp, entityType, entityId }`:
   three strings, nothing else crosses the boundary. It lists
   `GET /hosts/:app/:type/:id/meetings`, shows "Start meeting" only when `usePermissions()`
   includes `meetings`, navigates with `navigateSuite('/meetings/new?hostApp=…&hostType=…&hostId=…')`
   and renders its own "Meetings are unavailable" state when meetings-api fails.
2. **The shell owns the seam**, a new expose `./extensions` (`shell/src/lib/extensions.tsx`):
   a `HostExtension<K extends keyof ExtensionProps>({ name, props, fallback, loading })` whose
   prop types are declared once, here. It loads `import('meetings/HostMeetings')` raced against
   5 s; **a rejection, a timeout, a missing export or a render-time throw (error boundary) all
   render `fallback`; it never throws** (ADR-0030's rule for every shell-remote seam).
3. **The host imports the seam dynamically** (`import('shell/extensions').catch(() => null)`),
   so a host running against a shell that predates the expose renders its own fallback. Each
   host keeps its own fallback copy.
4. **The new-meeting page asks meetings-api** for the host entity (`GET /hosts/:app/:type/:id`,
   resolved as the caller), so the title prefill and the "Deal · <title>" label come from the
   host's answer (ADR-0059), not from a query string.
5. **Why ADR-0050 option D does not apply.** That ADR rejected federated components for
   *primitives used everywhere*, on four grounds. They invert here: this is one coarse,
   domain-owned widget with a single three-string prop type declared once; a host's tests stub
   one module, as they already stub `shell/session`; it has no Storybook role; and changing it
   without rebuilding the host is the goal, exactly as Meetings owns its `./App`. What does
   carry over from ADR-0050 is the runtime failure surface, which is why the timeout, error
   boundary and per-host fallback are part of the decision, not options.

## Failure shape

**A dependency's failure becoming the host page's failure, and ownership of a domain's UI being
spread over every consumer.** The first: a remote that is down, slow, missing an export,
version-skewed against the shell, or throwing at render takes a page that is otherwise fine
down with it (a blank deal page because Meetings deployed badly). The second: each consumer
re-implementing a domain widget, so a contract change needs N redeploys and the copy and
permission rules drift.

Mirror positions. **Shell→remote** and **remote→shell** are both runtime seams that can be
absent: the shell loading a remote needs timeout + boundary + fallback (ADR-0030), and a
remote loading a shell expose needs a `.catch` and its own fallback. **Data direction:** only
identifiers cross into the widget; the widget fetches its own data with the viewer's JWT
(ADR-0001), so the host never forwards content or credentials. **Failure inside vs around:**
the widget's own "unavailable" state (its API failed) and the seam's fallback (its code failed)
are different failures and both must exist. Recognise it for any future embedded panel
("reviews on a PR", "proposals on a deal"): ask what the host page shows when the other
side's code, not just its API, is unavailable.

## Alternatives considered

- **Host-owned UI calling meetings-api.** Rejected: every host re-implements the list, status
  map, copy and permission rules, so N hosts need N redeploys per contract change, and the
  host must know Meetings' domain, inverting US-11.
- **Navigation only** (a link to `/meetings?host=…`, no list on the deal). Rejected: fails
  AC-11.2.
- **crm-ui declaring `meetings` as its own MF remote.** Rejected: each host would replicate
  the shell's runtime remote-URL resolution (`runtimeRemotes.ts`); composition belongs to the
  shell (ADR-0006).
- **An iframe.** Rejected: it needs a second session bootstrap and breaks ADR-0001.

## Consequences

**Positive:**
- Meetings changes its panel without rebuilding any host; a new host adds one component with a
  fallback.
- A broken Meetings deploy cannot break the deal page (R11), proven by tests: reject, 5 s
  timeout, missing export, render throw, absent `shell/extensions` (AC-11.6).

**Negative / trade-offs:**
- A runtime-typed seam: `ExtensionProps` is the single declared contract, and a host's types
  for the loaded module are only as good as that declaration.
- A shell deploy changes the seam for every host; the extension name list is the shell's to
  grow deliberately.
- A second kind of federated expose (a component, not a route entry) exists in the suite.

**Risks:**
- A future "shared primitive" proposal citing this ADR. This ADR is not precedent for that:
  the test is a coarse domain widget with a minimal prop type and a mandatory fallback.

## Amended 2026-11-04 (design stage)

The panel also offers "Link an existing meeting" (G2), so that a meeting started standalone can
be attached to the entity later. It reads one more meetings-api route,
`GET /hosts/:app/:type/:id/linkable-meetings` (the caller's own meetings as creator, not
frozen, not already on this entity; needs `meetings:access`), and links through the existing
`PATCH` of the host reference, which re-resolves the entity as the caller exactly as starting
a meeting does. The props (`{ hostApp, entityType, entityId }`), the `shell/extensions` loading
seam, the timeout, error boundary and fallback are unchanged; unlinking stays on the meeting
page. There is no host-side search API. Source: plan.md § Amendments 2026-11-04 (design
stage), G2.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

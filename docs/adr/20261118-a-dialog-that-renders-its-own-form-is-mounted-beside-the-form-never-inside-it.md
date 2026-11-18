# 20261118 — A dialog from `@operai/ui` that renders its own `<form>` (`ConfirmDialog`, `FormDialog`) is mounted beside the page's form, never inside it, and its Confirm is proved by a journey in a real browser

**Date:** 2026-11-18  
**Status:** Accepted — rule drawn from fix D3 of specs/20261117-legal-entities (QE T68 defect D-T68-1, high; commit `95ebd129`; tasks.md D3). It is an engineering rule of the shared library's use, not a product decision of the spec, and no separate owner approval is recorded; the owner may amend it. Not a plan ADR candidate: found by QE after the plan was approved.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The protected-change confirmation of the legal-entity page (ADR 20261117-a-confirmation-is-backed-by-a-read-only-server-check-it-is-admin-uis-and-the-registry-does-not-enforce-it-and-when-the-check-cannot-be-made-nothing-is-saved) is a `ProtectedChangeDialog` built on `ConfirmDialog` from `@operai/ui` (ADR 20261031-shared-ui-library-consumed-as-source). `ConfirmDialog` renders its own `<form noValidate onSubmit=…>` around its body and buttons (`operai-ui/src/components/ConfirmDialog.tsx`), and so does `FormDialog`. `Dialog`, the frame they are built on, does not portal: the dialog's DOM is rendered where it is mounted.

`ProtectedChangeDialog` was mounted inside `LegalEntityForm`'s own `<form>`. HTML forbids a form inside a form, and the browser submitted the **outer** form natively when Confirm was pressed (commit `95ebd129`): the page navigated to `/admin/legal-entities?` with no POST, and React's `onSubmit` of the dialog never ran. Confirm did not save. The unit tests were green, because jsdom does not navigate on a native submit and React only warns. QE found it as D-T68-1 (high) in three e2e journeys ("keyboard only: Confirm saves", "a newer version saved while the dialog is open", a welld_ch manager edits welld_ch). The same fix commit found a second, unrelated defect in the same dialogs: an `aria-label` on a list replaces the list's items in the computed accessible description (D-T68-2, fixed there by making the label content).

## Decision

We will mount a dialog that renders its own `<form>` as a **sibling** of the form it is opened from (a fragment returning the form and the dialog), or in a slot that sits outside any form, never as a descendant of a `<form>`; and a page that has such a dialog carries a test that no `form form` exists in each state of the dialog and a browser journey in which the confirming control saves.

(`admin-ui/src/components/LegalEntityForm.tsx`: "A sibling of the form, never inside it: the library's ConfirmDialog renders its own `<form>` and does not portal, so mounted inside ours it nests forms and Confirm submits the browser's way (D3)"; the restore dialog sits in the History slot, outside any form.)

1. **Mount site.** `LegalEntityForm` returns `<> <form>…</form> {confirming !== null && <ProtectedChangeDialog …/>} </>`. `RestoreDialog` is opened from the History slot, which is outside the form. The dialog's state (`confirming`) lives in the form's component, which is fine: where the state lives is not where the DOM is.
2. **Unit tests assert the DOM, not the handler.** `document.querySelectorAll('form form')` has length 0 in each dialog state (`LegalEntityForm.protected.test.tsx`, `LegalEntityPanel.test.tsx`, `ProtectedChangeDialog.test.tsx`, `RestoreDialog.test.tsx`), and the submit paths save once with `defaultPrevented`.
3. **The browser journey is the proof of the control.** `shell/e2e/protected-legal-details.spec.ts` presses Confirm with the keyboard and expects the POST; jsdom cannot show a native submission.
4. **No change to the library.** The library keeps its forms (they give Enter and the `noValidate` semantics to its dialogs); this ADR constrains how pages mount them. A guard in the library (a warning when mounted inside a form) is possible and is not decided here.

## Failure shape

**A control that has native meaning in the browser is placed where a surrounding element gives it a different native meaning, so the user's action does something other than what the code says, and the test environment, which does not implement the native behaviour, reports success.** Nothing throws: the click lands, a page reload or a different request happens, and the handler the team wrote never runs. The defect is in the structure of the DOM, not in any function.

Where else this shape can appear, including the mirror-image positions:

- **Component and its host.** Any shared component that renders a native element with built-in behaviour (`<form>`, `<a href>`, `<button>` whose default type is `submit`, `<label>`, `<dialog>`, `<details>`) can be misplaced inside a host that has the same or a conflicting behaviour: a form inside a form, a button inside a link, an interactive element inside a button. Recognise it by reading the library component's markup before mounting it inside another component's markup.
- **Inbound and outbound.** The mirror of "a dialog with a form placed in a form" is "a page form placed inside a library component that already renders one", for example a custom body that includes its own `<form>` passed as `children` of `ConfirmDialog` or `FormDialog`.
- **Library change.** A component that today renders no form can later gain one (a refactor of `NoticeDialog`, a drawer with a form): every host that mounted it inside a form was fine and becomes wrong with no change in the host's code. The nesting test is what notices.
- **Portals.** A component that does portal would be safe from this in the DOM but not from React's synthetic-event bubbling through the React tree (a submit event bubbles to a parent's `onSubmit` handler); a change of `Dialog` to portal does not make the rule moot.
- **Test and browser.** Whatever a unit environment does not implement (native submission, navigation, focus order, scroll, constraint validation, the browser's form-association by `form=` attribute), a control that depends on it needs one test in a real browser.
- **Keyboard and pointer.** Enter submits the innermost form by the browser's rule; the journey must be run by keyboard as well as by click, since the failure can differ.

## Options considered

### Option A — Mount beside the form and test the DOM and the journey (chosen)

Described above.

**Pros:**
- Valid HTML; Confirm submits its own form and React's handler runs
- No change in the shared library; applies to every app that uses it
- The unit assertion is cheap and fails exactly on this mistake

**Cons:**
- A rule people must know (the library's component does not warn); the two component names that render a form are in this ADR and in the code comment
- The dialog's open state is held by the form component while its DOM is outside it, so a reader looking for the dialog inside the form's JSX does not find it

### Option B — Make the library's dialogs not render a `<form>` (rejected for now)

**Pros:**
- Removes the hazard for all hosts

**Cons:**
- A library change shared by every remote through the shell's singleton (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell) for a case that one mount-site rule fixes; the dialogs' Enter-to-confirm and `noValidate` behaviour come from the form

### Option C — Give the dialog a `form=` association or stop the submit event in the outer form's handler (rejected)

**Pros:**
- No move of the JSX

**Cons:**
- The nesting remains invalid HTML, so browsers and React keep warning and behaving by parser rules; a handler that suppresses a submit by guessing its origin is brittle

### Option D — Rely on unit tests (rejected)

**Pros:**
- Nothing new

**Cons:**
- jsdom does not navigate on a native submit; this is the failure that unit tests missed

## Evidence

- Root cause and fix: commit `95ebd129` (specs/20261117-legal-entities, D3), `specs/20261117-legal-entities/tasks.md` D3 and qe-report.md § 10 ("D3 Confirm must save: closed; e2e journeys pass; no nested `<form>` unit test green").
- The four unit assertions listed in point 2, and `shell/e2e/protected-legal-details.spec.ts` (13 pass on a fresh stack, including the D3 journeys).
- Library: `operai-ui/src/components/ConfirmDialog.tsx` (`<form noValidate onSubmit>`), `FormDialog.tsx` (`<form noValidate onSubmit>`), `Dialog.tsx` (no portal).

## Consequences

**Positive:**
- The confirmation works with mouse and keyboard, and the shape is recorded for the next dialog
- A cheap DOM assertion exists to copy

**Negative / trade-offs:**
- Every page with a dialog of this kind needs the assertion and a browser journey, and a review that checks the mount site
- The hazard stays in the library; the rule is the guard

**Risks:**
- **Other mount sites were not audited here.** Files in the frontends that contain both a `<form>` and a use of `ConfirmDialog` or `FormDialog` (at the time of writing `CreateDepartmentModal.tsx`, `meetings-ui` `LinkMeetingDialog.tsx` and `MeetingsListPage.tsx`, besides `LegalEntityForm.tsx`) have not been checked for nesting by this ADR; a check is cheap (`querySelectorAll('form form')` in their tests).
- **Dev-only warning.** React's DOM-nesting warning appears in development and is easy to ignore; treat it as a failure in tests of such pages.

## Escalation triggers

This decision is revisited when any of these happens:

- a second page is found with the same nesting: add the guard to the library (a dev warning in `ConfirmDialog` and `FormDialog` when mounted inside a form, or dialogs that do not render a form);
- `Dialog` starts to portal, or a dialog gains a form it did not have;
- the suite adopts a browser-level component test runner that makes the e2e journey unnecessary for this class.

## Compliance notes

- GDPR / data-protection impact: none.
- Data residency: no change.
- Audit trail: not required. The defect was a confirmation that did not save, so nothing was changed without confirmation; it failed closed.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

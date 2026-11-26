# Decisions — Project hours

Choices the agents made that the spec, plan and tasks did not dictate. Disagree with one?
It is drift: amend the spec/plan and re-sync tasks — do not quietly edit the code.

## T5 · devops · 2026-11-26
- default: dropped the glossary's "Suggested entry" line instead of keeping it beside Automatic entry — why: #12 deleted it as the superseded design, this branch only carried it as unchanged context, and #12's Automatic entry says "Avoid: suggested entry (the superseded design)" — where: `.claude/context/glossary.md`
- default: put a blank line between #12's ledger block and this branch's (the same blank-line-separated style the ledger uses between sections), text of both unchanged — why: keeps the "Decided when … re-opened" headings readable as separate batches — where: `specs/20261112-time-tracking/ledger.md`
- assumption: the `D44` that appears twice in the ledger is the original open question plus its resolution, not an id collision — why: it is identical in `225f0275` and #12's head, so it predates both branches; nothing was renumbered — where: `specs/20261112-time-tracking/ledger.md`
- default: recorded T5's done box as its own commit `bfd9b91e` on top of the rebased commits instead of amending `fc41021e` — why: the rebase itself rewrites commits, and a separate commit keeps the T5 outcome visible and revertible — where: `specs/20261112-project-hours/tasks.md`
- scope: ran only the five T5 checks and none of plan R1's "other app the new base changed" builds, such as projects-ui — why: that extra check applies to a restack onto a newer `main`, and the base here is #12's head, whose parent is the same `225f0275` this branch was written against — where: R1 / T5

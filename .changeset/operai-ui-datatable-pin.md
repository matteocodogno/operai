---
"@operai/ui": minor
---

`DataTable` columns can be pinned: `pin: 'start' | 'end'` keeps that column (the row's name, a total) in view at
the edge of the scroll region while the other columns scroll under it, from 48 rem up, with an opaque surface, a
hairline on the edge that faces the scrolling columns, and scroll padding that follows the pinned columns' measured
widths so a cell reached with Tab or Shift+Tab is never left under one. At most one column per edge; without `pin`
nothing changes. Ships through the shell: the shell must be deployed with this library before hours-ui passes `pin`
(a remote on an older shell gets an unpinned table: the prop is ignored, with no error).

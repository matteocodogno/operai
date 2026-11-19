---
"@operai/shell": minor
---

The shell can now show hours-ui's Record hours button inside other tools' pages (specs/20261116-record-hours-in-place, ADR 20261116-record-hours-widget-through-the-host-extension-seam): a new host extension, `hours.recordHours`, takes six plain strings from the page that embeds it (what the hours are on, the project or deal and the task by id and name, and whether it sits in a page header or a task row), loads `hours/RecordHours` with the same 5 second timeout and error boundary as the other extensions, and shows the host's own fallback, a link to My hours, when hours-ui cannot be loaded or does not have the button yet. Nothing flows back to the host page.

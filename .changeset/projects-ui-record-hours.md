---
"@operai/projects-ui": minor
---

Record hours from the project (specs/20261116-record-hours-in-place). A project's manager and team see a **Record hours** button in the project page's header, and the assignee or a participant of a task sees one on the task's row, in the project's Tasks card and in My tasks, done tasks included. It opens the Hours entry dialog with the project (or, for a task of a CRM deal, the deal) and the task already chosen and today as the day, and says what it recorded with a link to My hours. Hours-api still decides each save and the dialog says why in plain words when it refuses. When the Hours screens cannot be loaded the page works as before and shows a My hours link instead. Copy is English and Italian.

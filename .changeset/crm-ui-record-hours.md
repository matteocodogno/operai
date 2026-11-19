---
"@operai/crm-ui": minor
---

Record hours from the deal and from a task (specs/20261116-record-hours-in-place). A deal's owner and technical contact see a **Record hours** button in the deal page's header, and the assignee or a participant of a task sees one on the task's row, in the Tasks page and in the activity timeline of a deal, a company and a contact, done tasks included. It opens the Hours entry dialog with the deal and the task already chosen and today as the day; a task with no deal records as other work, with a category and no task link. Hours-api still decides each save and the dialog says why in plain words when it refuses. When the Hours screens cannot be loaded the page works as before and shows a My hours link instead. Copy is English and Italian.

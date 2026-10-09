---
"@operai/estimai-ui": patch
---

React and React DOM now resolve to 19.2.7, the version every other frontend in the suite
uses. Module Federation shares React as a singleton, so a different version in one remote can
break the others when they load together.

Dropdowns now draw the suite's own chevron with space reserved for it, instead of the browser's
arrow sitting against the right border.

Checkboxes and radio buttons use the suite's own style instead of the browser's.

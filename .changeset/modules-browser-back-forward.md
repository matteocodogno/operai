---
"@operai/admin-ui": patch
"@operai/crm-ui": patch
"@operai/estimai-ui": patch
"@operai/inventory-ui": patch
"@operai/notify-ui": patch
"@operai/projects-ui": patch
"@operai/refund-ui": patch
---

The browser's back and forward buttons show the page of the address in every module,
within a module and between modules. Each module now builds its router when it mounts,
so coming back from another module no longer shows a page matched from that module's
address (a project named "admin", "This page does not exist"). The router also follows
the address while the shell hides the module behind its pending fallback, so back from
"To start" or from a company shows the list it was opened from, not the page it left.

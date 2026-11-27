---
"@operai/shell": patch
---

The e2e legal-entities fixture no longer takes a connection URL for a local one when it carries a `host`, `hostaddr` or `service` parameter (libpq honours them over the URL's own host), and the import it runs now reads the CRM and auth database URLs the check actually looked at, passed after `direnv` has loaded the service's environment, so a value set there cannot replace them.

---
'@operai/auth': minor
---

Auth now holds the legal-entity registry: the name, VAT number, IBAN, address and contact lines of each legal entity, kept as numbered versions. Any signed-in person can read the entities, and a service holding the new `legal-entities:read` scope can read them too, with a limit per service. Saving and restoring an earlier version are checked against the person's grant for that entity and recorded in the audit log in the same step, and a save that changes nothing creates no version. The admin area now shows in `/authz/me` for anyone who can manage at least one entity. Until the details are moved, both entities answer version 0. A script, `mise run legal-entities:import`, copies the CRM's legal details into version 1; it is a dry run unless given `--apply` and prints a report without any of the values.

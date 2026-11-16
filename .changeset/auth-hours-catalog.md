---
"@operai/auth": minor
---

Add the `hours` permission catalog for time tracking (specs/20261112-time-tracking, ADR 20261112-hours-api-time-entries-own-service-hours-catalog): `time-entry:read-all` (see everyone's hours) and `time-list:manage` (the categories and work types), both unconditioned, seeded to `admin` only and registered by the deploy-time seed. The catalog has no `access` resource, because every signed-in user records and sees their own hours, so `hours` is a declared catalog but not one of the apps `admin` is granted `access` to. An admin can grant either permission to another role through the roles screen.

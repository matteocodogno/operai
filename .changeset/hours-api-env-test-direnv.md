---
"@operai/hours-api": patch
---

The local-setup test now reads the example file together with the committed direnv file (which supplies `DATABASE_URL`), so it follows the setup the service actually has. No change to the service.

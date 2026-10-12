---
"@operai/inventory-api": minor
"@operai/inventory-ui": minor
---

The supplier field now suggests the suppliers already in the register, on the
register form and in the Edit dialog. It is still free text: a new supplier is
typed as before. Suggestions come from a new `GET /suppliers` endpoint, limited
to the entities the caller can read.

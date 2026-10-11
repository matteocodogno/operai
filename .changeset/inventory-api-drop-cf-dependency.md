---
"@operai/inventory-api": patch
---

Remove the Cloudflare CLI (`cf`) from the service's dependencies. It was added by
mistake and never recorded in `bun.lock`, so the image build, which installs with
a frozen lockfile, failed.

# @operai/auth

## 0.1.1

### Patch Changes

- bdf998c: Bind backends to IPv6 (::) on Railway (when RAILWAY_PRIVATE_DOMAIN is set) so private networking (\*.railway.internal) can reach them. Enables moving cross-service call URLs (AUTH_JWKS_URL / AUTH_BASE_URL / NOTIFY_INTERNAL_URL) to internal DNS and shared/reference variables (Layer 2), reducing the env-var sprawl. Local dev unchanged (keeps Bun default IPv4).

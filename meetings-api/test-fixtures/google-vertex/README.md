# Vertex AI control-plane fixtures

RECORDED 2026-11-05 (T107, specs/021) against the sandbox project through `https://aiplatform.eu.rep.googleapis.com`,
then scrubbed (project number and id replaced). They are the answers `checkVertex` (N3, N4) is tested against:

- `cache-config.json`: `GET /v1/projects/<p>/cacheConfig`, HTTP 200. The `eu` host DOES serve it.
- `fetch-publisher-model-config-not-found.json`: `GET /v1beta1/projects/<p>/locations/eu/publishers/anthropic/models/<model>:fetchPublisherModelConfig`
  for a model that was never configured, HTTP **404** `NOT_FOUND` (not 200 `{}`): N4's "404 means no config, default
  disabled" holds. The 200 shape (a configured model) was NOT observed; the code's strict parse of it stays unverified.

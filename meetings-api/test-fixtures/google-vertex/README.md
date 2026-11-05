# Vertex AI control-plane fixtures

RECORDED 2026-11-05 (T107, specs/021) against the sandbox project through `https://aiplatform.eu.rep.googleapis.com`,
then scrubbed (project number and id replaced). They are the answers `checkVertex` (N3, N4) is tested against:

- `cache-config.json`: `GET /v1/projects/<p>/cacheConfig`, HTTP 200. The `eu` host DOES serve it.
- `fetch-publisher-model-config-not-found.json`: `GET /v1beta1/projects/<p>/locations/eu/publishers/anthropic/models/<model>:fetchPublisherModelConfig`
  for a model that was never configured, HTTP **404** `NOT_FOUND` (not 200 `{}`): N4's "404 means no config, default
  disabled" holds. The 200 shape (a configured model) was NOT observed; the code's strict parse of it stays unverified.

## Messages reply shapes (T120, plan H-8)

RECORDED 2026-11-05 from the pinned model (`claude-sonnet-5-5`) through the `eu` host, a synthetic two-line transcript
and a one-tool request with NO `tool_choice` and NO `thinking`, by `scripts/record-vertex-replies.ts` (5 calls). Scrubbed
(project, message and tool ids, signatures). `vertexClaude.test.ts` replays each through the adapter:

- `messages-unforced-single-call.json`: HTTP 200, `stop_reason: tool_use`, one `tool_use` block. Accepted.
- `messages-auto-disable-parallel.json`: the same request plus `tool_choice: {type:"auto", disable_parallel_tool_use:true}`.
  **HTTP 200, accepted**, same reply shape. RECORDED, NOT ADOPTED (H-8: adopting it is a separate, deliberate change; the
  adapter still sends no `tool_choice`).
- `messages-text-only.json`: a system prompt that forbids the tool gets `stop_reason: end_turn` with one `text` block.
  `invalid_output` (`no_call`).
- `messages-double-call.json`: asked to call twice, the model returns TWO `tool_use` blocks of the offered tool in one reply
  with `stop_reason: tool_use`, although no `tool_choice` was sent. `invalid_output` (`multiple_calls`).
- `messages-max-tokens-cut.json`: `max_tokens: 40` gives `stop_reason: max_tokens` with a `tool_use` block whose `input` is
  empty or partial. `invalid_output` (`stop_reason`): a cut call is never partial output.

No `thinking` or `redacted_thinking` block appeared in any reply (`usage.output_tokens_details.thinking_tokens` is 0), so
the discard-unread rule is covered by hand-built blocks in the unit test, not by a recording. The environment's model id
had no `publishers/` prefix.

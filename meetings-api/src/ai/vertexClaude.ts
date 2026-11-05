/**
 * Claude on Vertex AI, EU, through `@anthropic-ai/vertex-sdk` (specs/021-meetings plan.md § Amendment
 * 2026-11-05 G-4, G-8, ADR-0069, ADR-0067; AC-7.9, AC-7.10, AC-9.6, AC-4.10).
 *
 * THE SDK'S ENVIRONMENT DEFAULTS DO NOT APPLY. Left alone it reads `ANTHROPIC_VERTEX_BASE_URL`,
 * `CLOUD_ML_REGION` and `ANTHROPIC_VERTEX_PROJECT_ID`, falls back to Application Default Credentials, and
 * retries twice. Here the client is built with everything explicit:
 *   - `baseURL`: derived from `MEETINGS_VERTEX_LOCATION` (`https://aiplatform.eu.rep.googleapis.com/v1` for the
 *     `eu` multi-region), so an ambient override cannot redirect traffic (R13);
 *   - `region` and `projectId`: the SDK puts them in the path (`.../projects/<p>/locations/<region>/...`);
 *   - `authClient`: the service account's JWT client (src/lib/google/auth.ts), never ADC;
 *   - `maxRetries: 0` and `timeout: 60 s`: the job runner owns retry (ADR-0062), a hidden retry would
 *     multiply the deadline.
 *
 * FORCED TOOL USE, and the only tool is the output schema (AC-7.10): `tool_choice: { type: "tool", name }`.
 * There is no other tool, no server tool (web search, code execution), no `cache_control` (Vertex prompt caching
 * is stored for minutes to an hour), no `advanced_ai_enabled` and no beta. A reply that does not stop at
 * `tool_use` with the forced tool's block is `invalid_output`, as before.
 *
 * Errors become `LanguageModelError` with a closed code and a status (plan § G-8). Provider text can echo the
 * prompt, so it is never copied into a message or a log line.
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { JWT } from "google-auth-library";
import { checkVertexLocation, vertexHost } from "../lib/residency";
import { LanguageModelError, type LanguageModel, type LlmRequest, type OutputSchema } from "./languageModel";

const DEFAULT_TIMEOUT_MS = 60_000;

/** What this module needs of the SDK client: tests pass the real one over a stubbed `fetch`, or a stub. */
export interface VertexClientLike {
  messages: {
    create(body: MessageBody, options?: { signal?: AbortSignal }): Promise<MessageReply>;
  };
}

interface MessageBody {
  readonly model: string;
  readonly system: string;
  readonly messages: { role: "user" | "assistant"; content: string }[];
  readonly max_tokens: number;
  readonly tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  readonly tool_choice: { type: "tool"; name: string };
}

interface MessageReply {
  readonly stop_reason?: string | null;
  readonly content?: readonly { type?: string; name?: string; input?: unknown }[];
}

export interface VertexOptions {
  readonly client: VertexClientLike;
  /** `MEETINGS_VERTEX_MODEL_ID`, already checked (S3). */
  readonly modelId: string;
}

export interface VertexClientConfig {
  /** `MEETINGS_VERTEX_LOCATION`, already checked (S2); checked again here. */
  readonly location: string;
  readonly projectId: string;
  /** The service account's credentials (explicit; never ADC). */
  readonly authClient: JWT;
  readonly timeoutMs?: number;
  /** Tests stub the wire; production uses the platform's `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The base URL for a location, with the SDK's `/v1` suffix. */
export const vertexBaseUrl = (location: string): string => `https://${vertexHost(location)}/v1`;

/** The real client: derived base URL, explicit credentials, no SDK retries. */
export function createVertexClient(config: VertexClientConfig): VertexClientLike {
  // Defence in depth: env.ts has refused a bad location already; this module must not depend on that.
  if (checkVertexLocation(config.location) !== null) throw new Error("Vertex location is not an allowed EU location");
  return new AnthropicVertex({
    baseURL: vertexBaseUrl(config.location),
    region: config.location,
    projectId: config.projectId,
    authClient: config.authClient,
    maxRetries: 0,
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  }) as unknown as VertexClientLike;
}

/** Plan § G-8: no status at all (DNS, reset, TLS, our deadline), 408, 429 and 5xx (529 = overloaded) are transient. */
function classify(error: unknown): LanguageModelError {
  if (error instanceof LanguageModelError) return error;
  const status = (error as { status?: unknown } | null)?.status;
  const httpStatus = typeof status === "number" ? status : undefined;
  const transient = httpStatus === undefined || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
  return new LanguageModelError(transient ? "provider_unavailable" : "provider_rejected", transient, httpStatus);
}

/** The forced tool's input, or not-found when the reply is anything else. */
function toolInput(reply: MessageReply, toolName: string): { found: true; input: unknown } | { found: false } {
  // A reply cut short (max_tokens), or stopped by a filter, is not a call we can trust the shape of.
  if (reply.stop_reason !== "tool_use") return { found: false };
  for (const block of reply.content ?? []) {
    if (block.type === "tool_use" && block.name === toolName) return { found: true, input: block.input };
  }
  return { found: false };
}

export function createVertexLanguageModel(options: VertexOptions): LanguageModel {
  return {
    async complete(request: LlmRequest, outputSchema: OutputSchema, signal?: AbortSignal): Promise<unknown> {
      const body: MessageBody = {
        model: options.modelId,
        system: request.system,
        messages: request.messages.map((message) => ({ role: message.role, content: message.text })),
        max_tokens: request.maxTokens,
        tools: [{ name: outputSchema.name, description: outputSchema.description, input_schema: { ...outputSchema.jsonSchema } }],
        tool_choice: { type: "tool", name: outputSchema.name },
      };

      let reply: MessageReply;
      try {
        reply = await options.client.messages.create(body, signal ? { signal } : {});
      } catch (error) {
        throw classify(error);
      }

      const result = toolInput(reply, outputSchema.name);
      if (!result.found) throw new LanguageModelError("invalid_output", true);
      return result.input;
    },
  };
}

/** From the environment (`MEETINGS_AI_PROVIDER=real`; env.ts requires every value). */
export async function createVertexLanguageModelFromEnv(): Promise<LanguageModel> {
  const { env } = await import("../lib/env");
  const { googleAuth } = await import("../lib/google/auth");
  const auth = await googleAuth();
  return createVertexLanguageModel({
    client: createVertexClient({ location: env.MEETINGS_VERTEX_LOCATION!, projectId: env.MEETINGS_GCP_PROJECT_ID!, authClient: auth.client }),
    modelId: env.MEETINGS_VERTEX_MODEL_ID!,
  });
}

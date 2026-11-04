/**
 * Claude on Amazon Bedrock, EU, through the Converse API (specs/021-meetings
 * plan.md § AI providers, ADR-0061, ADR-0067).
 *
 * FORCED TOOL USE, and the only tool is the output schema (AC-7.10):
 * `toolChoice: { tool: { name } }` makes the model answer by "calling" that tool,
 * and its input is the structured output. There is no other tool in the request, no
 * guardrail, no document or image block and no prompt-cache point (caching is used
 * only if the provider confirms it is compatible with `none` retention).
 *
 * The call has a 60 s deadline (and the caller's signal). SDK retries are off: the
 * job runner owns retry and backoff, and a hidden SDK retry would multiply the
 * deadline. The model id is pinned in env (`BEDROCK_MODEL_ID`); the startup checks
 * (`lib/startupChecks.ts`) verify where it routes and that retention is `none`.
 *
 * Errors become `LanguageModelError` with a closed code and a status. Provider text
 * can echo the prompt, so it is never copied into a message or a log line.
 */

import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { LanguageModelError, type LanguageModel, type LlmRequest, type OutputSchema } from "./languageModel";

const DEFAULT_TIMEOUT_MS = 60_000;

/** What this module needs of the AWS client: tests pass a stub. */
export interface BedrockRuntimeLike {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockOptions {
  readonly client: BedrockRuntimeLike;
  /** `BEDROCK_MODEL_ID`: a model id or an inference profile id. */
  readonly modelId: string;
  readonly timeoutMs?: number;
}

export interface BedrockCredentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The real client: explicit credentials (never the ambient chain), no SDK retries. */
export function createBedrockRuntimeClient(credentials: BedrockCredentials): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: credentials.region,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    maxAttempts: 1,
  });
}

/** Errors AWS reports that a later attempt can get past. */
const TRANSIENT_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "ModelNotReadyException",
  "ModelErrorException",
  "ServiceQuotaExceededException",
  "TimeoutError",
  "AbortError",
]);

function classify(error: unknown): LanguageModelError {
  if (error instanceof LanguageModelError) return error;
  const name = error instanceof Error ? error.name : "";
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  const httpStatus = typeof status === "number" ? status : undefined;

  const transient =
    TRANSIENT_NAMES.has(name) ||
    // no HTTP status at all = the request never got an answer (DNS, reset, TLS, our own deadline)
    httpStatus === undefined ||
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus >= 500;
  return new LanguageModelError(transient ? "provider_unavailable" : "provider_rejected", transient, httpStatus);
}

/** The forced tool's input, or null when the reply is anything else. */
function toolInput(output: ConverseCommandOutput, toolName: string): { found: true; input: unknown } | { found: false } {
  // A reply cut short, or stopped by a filter, is not a call we can trust the shape of.
  if (output.stopReason !== "tool_use") return { found: false };
  for (const block of output.output?.message?.content ?? []) {
    if (block.toolUse?.name === toolName) return { found: true, input: block.toolUse.input };
  }
  return { found: false };
}

export function createBedrockLanguageModel(options: BedrockOptions): LanguageModel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async complete(request: LlmRequest, outputSchema: OutputSchema, signal?: AbortSignal): Promise<unknown> {
      const command = new ConverseCommand({
        modelId: options.modelId,
        system: [{ text: request.system }],
        messages: request.messages.map((message) => ({ role: message.role, content: [{ text: message.text }] })),
        inferenceConfig: { maxTokens: request.maxTokens },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: outputSchema.name,
                description: outputSchema.description,
                inputSchema: { json: outputSchema.jsonSchema as never },
              },
            },
          ],
          toolChoice: { tool: { name: outputSchema.name } },
        },
      });

      const deadline = AbortSignal.timeout(timeoutMs);
      let output: ConverseCommandOutput;
      try {
        output = await options.client.send(command, { abortSignal: signal ? AbortSignal.any([deadline, signal]) : deadline });
      } catch (error) {
        throw classify(error);
      }

      const result = toolInput(output, outputSchema.name);
      if (!result.found) throw new LanguageModelError("invalid_output", true);
      return result.input;
    },
  };
}

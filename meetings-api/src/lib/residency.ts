/**
 * Synchronous residency checks for the AI providers (specs/021-meetings AC-4.9,
 * plan.md § AI providers and residency, ADR-0061). Pure functions over the
 * configured strings: `env.ts` runs them while parsing, so a misconfiguration
 * stops the process before it listens.
 *
 * A refusal NAMES the variable and never echoes the value it refused: the
 * startup output is read by operators and by log aggregators, and a region or
 * endpoint is configuration, but the habit of printing offending values is how
 * a key ends up in a log line.
 *
 * The checks that need the network (Bedrock inference-profile destinations, the
 * retention mode, the bucket lifecycle) are startup checks of their own tasks
 * (T14, T35); this file is what can be decided from the environment alone.
 */

/**
 * Azure regions where fast transcription runs (plan.md table, Microsoft's
 * region list) AND that are in the EU, plus the two Swiss regions: residency
 * allows Switzerland, even though fast transcription is batch-only there today,
 * so a future availability change needs no code change. West Europe
 * (Amsterdam, next to Railway) is the recommended region.
 */
export const AZURE_ALLOWED_REGIONS = [
  "francecentral",
  "germanywestcentral",
  "italynorth",
  "northeurope",
  "swedencentral",
  "westeurope",
  "switzerlandnorth",
  "switzerlandwest",
] as const;

/** Bedrock regions in the EU. London (eu-west-2) is not EU. */
export const BEDROCK_ALLOWED_REGIONS = [
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
] as const;

/** Microsoft hosts whose FIRST label is the region: the only endpoints whose location can be read from the name. */
const AZURE_REGIONAL_HOST_SUFFIXES = [".api.cognitive.microsoft.com", ".stt.speech.microsoft.com"] as const;

/**
 * `null` when `region` is allowed and, if given, `endpoint` is an https URL on a
 * Microsoft regional host naming that same region. A custom-domain endpoint
 * (`<name>.cognitiveservices.azure.com`) hides its region, so it cannot be
 * verified and is refused rather than trusted.
 */
export function checkAzureResidency(region: string, endpoint: string | undefined): string | null {
  if (!(AZURE_ALLOWED_REGIONS as readonly string[]).includes(region)) {
    return `AZURE_SPEECH_REGION is not an EU or Swiss region. Allowed: ${AZURE_ALLOWED_REGIONS.join(", ")}`;
  }
  if (endpoint === undefined) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "AZURE_SPEECH_ENDPOINT is not a valid URL";
  }
  const host = url.hostname.toLowerCase();
  const matches =
    url.protocol === "https:" && AZURE_REGIONAL_HOST_SUFFIXES.some((suffix) => host === `${region}${suffix}`);
  return matches
    ? null
    : "AZURE_SPEECH_ENDPOINT must be an https Microsoft regional host (<region>.api.cognitive.microsoft.com or " +
        "<region>.stt.speech.microsoft.com) for the same region as AZURE_SPEECH_REGION";
}

/** `null` when `region` is one of the EU Bedrock regions. */
export function checkBedrockRegion(region: string): string | null {
  return (BEDROCK_ALLOWED_REGIONS as readonly string[]).includes(region)
    ? null
    : `BEDROCK_REGION is not an EU region. Allowed: ${BEDROCK_ALLOWED_REGIONS.join(", ")}`;
}

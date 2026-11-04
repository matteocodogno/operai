import { describe, expect, it } from "bun:test";
import {
  AZURE_ALLOWED_REGIONS,
  BEDROCK_ALLOWED_REGIONS,
  checkAzureResidency,
  checkBedrockRegion,
} from "./residency";

// AC-4.9: transcription and language processing stay in the EU and Switzerland.
describe("checkAzureResidency", () => {
  it("accepts every allowlisted region with its default endpoint", () => {
    for (const region of AZURE_ALLOWED_REGIONS) expect(checkAzureResidency(region, undefined)).toBeNull();
  });

  it("includes westeurope, the plan's recommended region", () => {
    expect(AZURE_ALLOWED_REGIONS).toContain("westeurope");
  });

  it("refuses a region outside the EU and Switzerland", () => {
    for (const region of ["eastus", "uksouth", "southeastasia", "WESTEUROPE ", ""]) {
      expect(checkAzureResidency(region, undefined)).not.toBeNull();
    }
  });

  it("accepts an endpoint whose host names the same region", () => {
    expect(checkAzureResidency("westeurope", "https://westeurope.api.cognitive.microsoft.com")).toBeNull();
    expect(checkAzureResidency("westeurope", "https://westeurope.stt.speech.microsoft.com/")).toBeNull();
  });

  it("refuses an endpoint in another region than the configured one", () => {
    expect(checkAzureResidency("westeurope", "https://eastus.api.cognitive.microsoft.com")).not.toBeNull();
  });

  it("refuses an endpoint on a host that cannot be tied to a region", () => {
    expect(checkAzureResidency("westeurope", "https://my-speech.cognitiveservices.azure.com")).not.toBeNull();
    expect(checkAzureResidency("westeurope", "https://evil.example.com")).not.toBeNull();
    // a lookalike: the region label must be the FIRST label of a Microsoft host
    expect(checkAzureResidency("westeurope", "https://westeurope.api.cognitive.microsoft.com.evil.example")).not.toBeNull();
    expect(checkAzureResidency("westeurope", "http://westeurope.api.cognitive.microsoft.com")).not.toBeNull();
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(checkAzureResidency("westeurope", "not a url")).not.toBeNull();
  });

  it("never echoes the value it refuses", () => {
    const message = checkAzureResidency("secret-region-xyz", undefined) ?? "";
    expect(message).not.toContain("secret-region-xyz");
  });
});

describe("checkBedrockRegion", () => {
  it("accepts the seven EU regions of the plan", () => {
    expect([...BEDROCK_ALLOWED_REGIONS].sort() as string[]).toEqual(
      ["eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"].sort(),
    );
    for (const region of BEDROCK_ALLOWED_REGIONS) expect(checkBedrockRegion(region)).toBeNull();
  });

  it("refuses London (not EU), the US and anything else", () => {
    for (const region of ["eu-west-2", "us-east-1", "us-west-2", "ap-southeast-1", "eu", ""]) {
      expect(checkBedrockRegion(region)).not.toBeNull();
    }
  });

  it("never echoes the value it refuses", () => {
    expect(checkBedrockRegion("us-secret-9") ?? "").not.toContain("us-secret-9");
  });
});

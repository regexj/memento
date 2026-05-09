import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

const CLOUD_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const;
const LOCAL_PROVIDERS = ["ollama"] as const;
const ALL_PROVIDERS = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS] as const;

/**
 * Creates a LanguageModel instance for the specified provider and model.
 */
export function createModel(
  provider: string,
  model: string,
  apiKey?: string,
): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: apiKey })(model);
    case "openai":
      return createOpenAI({ apiKey: apiKey })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: apiKey })(model);
    case "mistral":
      return createMistral({ apiKey: apiKey })(model);
    case "ollama":
      return createOllama()(model);
    default:
      throw new Error(
        `Unsupported LLM provider: "${provider}". Supported providers: ${ALL_PROVIDERS.join(", ")}`,
      );
  }
}

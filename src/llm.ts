import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOllama } from "ollama-ai-provider-v2";
import type { LanguageModel } from "ai";

const CLOUD_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const;
const LOCAL_PROVIDERS = ["ollama"] as const;
const ALL_PROVIDERS = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS] as const;

/**
 * Creates a LanguageModel instance for the specified provider and model.
 *
 * @param provider - The LLM provider name (anthropic, openai, google, mistral, ollama)
 * @param model - The model identifier for the chosen provider
 * @param apiKey - API key for cloud providers (optional for local providers like ollama)
 * @returns A LanguageModel instance ready for use with the Vercel AI SDK
 * @throws Error if the provider is not supported
 */
export function createModel(
  provider: string,
  model: string,
  apiKey?: string
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
        `Unsupported LLM provider: "${provider}". Supported providers: ${ALL_PROVIDERS.join(", ")}`
      );
  }
}

import { describe, it, expect } from "vitest";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createModel } from "../llm.ts";

describe("createModel", () => {
  describe("supported providers", () => {
    it("creates an Anthropic model instance", () => {
      const model = createModel("anthropic", "claude-sonnet-4-20250514", "sk-ant-test") as LanguageModelV3;

      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe("claude-sonnet-4-20250514");
    });

    it("creates an OpenAI model instance", () => {
      const model = createModel("openai", "gpt-4o", "sk-openai-test") as LanguageModelV3;

      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe("gpt-4o");
    });

    it("creates a Google model instance", () => {
      const model = createModel("google", "gemini-2.0-flash", "google-test-key") as LanguageModelV3;

      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe("gemini-2.0-flash");
    });

    it("creates a Mistral model instance", () => {
      const model = createModel("mistral", "mistral-large-latest", "mistral-test-key") as LanguageModelV3;

      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe("mistral-large-latest");
    });

    it("creates an Ollama model instance without API key", () => {
      const model = createModel("ollama", "llama3.2") as LanguageModelV3;

      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe("llama3.2");
    });

    it("creates an Ollama model instance with API key provided", () => {
      const model = createModel("ollama", "llama3.2", "unused-key") as LanguageModelV3;

      expect(model.specificationVersion).toBe("v3");
      expect(model.modelId).toBe("llama3.2");
    });
  });

  describe("unsupported providers", () => {
    it("throws for an unknown provider", () => {
      expect(() => createModel("cohere", "command-r", "key")).toThrow(
        'Unsupported LLM provider: "cohere"'
      );
    });

    it("includes supported providers in the error message", () => {
      expect(() => createModel("unknown", "model")).toThrow(
        "Supported providers: anthropic, openai, google, mistral, ollama"
      );
    });

    it("throws for empty string provider", () => {
      expect(() => createModel("", "model")).toThrow(
        'Unsupported LLM provider: ""'
      );
    });
  });
});

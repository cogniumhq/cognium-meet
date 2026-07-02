import { ai } from "@ax-llm/ax";
import type { MeetingLlmProvider } from "@cognium/meet-shared";

export interface MeetingLlmConfig {
  provider: MeetingLlmProvider;
  openaiApiKey: string;
  ollamaUrl: string;
  ollamaModel: string;
}

export function normalizeOllamaUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

export function createMeetingLlm(
  config: MeetingLlmConfig,
  providerOverride?: MeetingLlmProvider,
) {
  const provider = providerOverride ?? config.provider;
  if (provider === "ollama") {
    return ai({ name: "ollama", url: config.ollamaUrl, apiKey: "ollama" });
  }
  return ai({ name: "openai", apiKey: config.openaiApiKey });
}

function looksLikeOpenAiModel(model: string): boolean {
  const name = model.trim().toLowerCase();
  return name.startsWith("gpt-") || name.startsWith("o1") || name.startsWith("o3");
}

export function resolveMeetingLlmModel(
  config: MeetingLlmConfig,
  model: string,
  providerOverride?: MeetingLlmProvider,
): string {
  const provider = providerOverride ?? config.provider;
  if (provider !== "ollama") {
    return model;
  }
  return looksLikeOpenAiModel(model) ? config.ollamaModel : model;
}

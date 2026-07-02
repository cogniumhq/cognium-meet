import { ai } from "@ax-llm/ax";
import {
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  coerceMeetingLlmModelForProvider,
  type MeetingLlmProvider,
} from "@cognium/meet-shared";

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

export function meetingLlmConfigFromFields(
  openaiApiKey: string,
  fields: {
    meetingLlmProvider?: MeetingLlmProvider;
    ollamaUrl?: string;
    ollamaModel?: string;
  },
): MeetingLlmConfig {
  return {
    provider: fields.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER,
    openaiApiKey,
    ollamaUrl: normalizeOllamaUrl(fields.ollamaUrl ?? DEFAULT_OLLAMA_URL),
    ollamaModel: fields.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
  };
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

export function resolveMeetingLlmModel(
  config: MeetingLlmConfig,
  model: string,
  providerOverride?: MeetingLlmProvider,
): string {
  const provider = providerOverride ?? config.provider;
  return coerceMeetingLlmModelForProvider(provider, model);
}

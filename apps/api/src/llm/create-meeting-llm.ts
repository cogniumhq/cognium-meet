import { ai } from "@ax-llm/ax";
import {
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  coerceMeetingLlmModelForProvider,
  openAiMeetingModelUsesResponsesApi,
  type MeetingLlmProvider,
} from "@cognium/meet-shared";

/** App identity for OpenRouter rankings (HTTP-Referer / X-Title). */
export const OPENROUTER_APP_REFERER = "https://cognium.app";
export const OPENROUTER_APP_TITLE = "Cognium Meet";

export interface MeetingLlmConfig {
  provider: MeetingLlmProvider;
  openaiApiKey: string;
  openRouterApiKey: string;
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
    openRouterApiKey?: string;
  },
): MeetingLlmConfig {
  return {
    provider: fields.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER,
    openaiApiKey,
    openRouterApiKey: fields.openRouterApiKey?.trim() ?? "",
    ollamaUrl: normalizeOllamaUrl(fields.ollamaUrl ?? DEFAULT_OLLAMA_URL),
    ollamaModel: fields.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
  };
}

/**
 * Ax reads a 400 response body twice (token-limit check, then the error it
 * throws), so the second read fails and the provider's reason is lost.
 * Buffer error bodies so every read returns the same content.
 */
export const fetchWithRereadableErrors: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.ok) {
    return res;
  }
  const text = await res.text();
  const responseInit = { status: res.status, statusText: res.statusText, headers: res.headers };
  const buffered = new Response(text, responseInit);
  return Object.assign(buffered, {
    json: async () => JSON.parse(text),
    text: async () => text,
    clone: () => new Response(text, responseInit),
  });
};

export function createMeetingLlm(
  config: MeetingLlmConfig,
  providerOverride?: MeetingLlmProvider,
  model?: string,
) {
  const provider = providerOverride ?? config.provider;
  const options = { fetch: fetchWithRereadableErrors };
  if (provider === "ollama") {
    return ai({ name: "ollama", url: config.ollamaUrl, apiKey: "ollama", options });
  }
  if (provider === "openrouter") {
    return ai({
      name: "openrouter",
      apiKey: config.openRouterApiKey,
      referer: OPENROUTER_APP_REFERER,
      title: OPENROUTER_APP_TITLE,
      options,
    });
  }
  if (model && openAiMeetingModelUsesResponsesApi(model)) {
    // Ax defaults temperature/top_p, which GPT-5.5 and o-series reasoning
    // models reject with HTTP 400 — clear them so they are not sent.
    return ai({
      name: "openai-responses",
      apiKey: config.openaiApiKey,
      config: { temperature: undefined, topP: undefined },
      options,
    });
  }
  return ai({ name: "openai", apiKey: config.openaiApiKey, options });
}

export function resolveMeetingLlmModel(
  config: MeetingLlmConfig,
  model: string,
  providerOverride?: MeetingLlmProvider,
): string {
  const provider = providerOverride ?? config.provider;
  return coerceMeetingLlmModelForProvider(provider, model);
}

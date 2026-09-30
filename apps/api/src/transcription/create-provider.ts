import type {
  TranscriptionModel,
  TranscriptionProvider as TranscriptionProviderId,
} from "@cognium/meet-shared";
import { isDiarizeTranscriptionModel } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import { OpenAIDiarizeProvider } from "./openai-diarize.js";
import { OpenAIWhisperProvider } from "./openai-whisper.js";
import { OpenRouterTranscriptionProvider } from "./openrouter-transcription.js";

type ProviderKind = "whisper" | "diarize" | `openrouter:${string}`;

export function createTranscriptionProviderFactory(opts?: {
  openaiApiKey?: string;
  openRouterApiKey?: string;
}) {
  const serverOpenAiKey = opts?.openaiApiKey?.trim() || "";
  const serverOpenRouterKey = opts?.openRouterApiKey?.trim() || "";
  const cache = new Map<string, Map<ProviderKind, TranscriptionProvider>>();

  function getCached(
    cacheKey: string,
    kind: ProviderKind,
    create: () => TranscriptionProvider,
  ): TranscriptionProvider {
    let bucket = cache.get(cacheKey);
    if (!bucket) {
      bucket = new Map();
      cache.set(cacheKey, bucket);
    }
    let provider = bucket.get(kind);
    if (!provider) {
      provider = create();
      bucket.set(kind, provider);
    }
    return provider;
  }

  return (
    model: TranscriptionModel,
    apiKey?: string,
    providerId: TranscriptionProviderId = "openai",
  ): TranscriptionProvider => {
    if (providerId === "openrouter") {
      const key = apiKey?.trim() || serverOpenRouterKey;
      if (!key) {
        throw new Error(
          "OpenRouter API key is required. Add your key in extension Settings (Meeting AI → OpenRouter) or set OPENROUTER_API_KEY on the server.",
        );
      }
      // Never use OpenAI diarize for OpenRouter models — whisper-like pipeline only.
      const openRouterModel = isDiarizeTranscriptionModel(model)
        ? "openai/whisper-large-v3-turbo"
        : model;
      const kind: ProviderKind = `openrouter:${openRouterModel}`;
      return getCached(
        `or:${key}`,
        kind,
        () => new OpenRouterTranscriptionProvider(key, openRouterModel),
      );
    }

    const key = apiKey?.trim() || serverOpenAiKey;
    if (!key) {
      throw new Error(
        "OpenAI API key is required. Add your key in extension Settings or set OPENAI_API_KEY on the server.",
      );
    }
    if (isDiarizeTranscriptionModel(model)) {
      return getCached(key, "diarize", () => new OpenAIDiarizeProvider(key));
    }
    return getCached(key, "whisper", () => new OpenAIWhisperProvider(key));
  };
}

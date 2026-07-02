import type { TranscriptionModel } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import { OpenAIDiarizeProvider } from "./openai-diarize.js";
import { OpenAIWhisperProvider } from "./openai-whisper.js";

type ProviderKind = "whisper" | "diarize";

export function createTranscriptionProviderFactory(serverApiKey?: string) {
  const cache = new Map<string, Map<ProviderKind, TranscriptionProvider>>();

  function getCached(
    apiKey: string,
    kind: ProviderKind,
    create: () => TranscriptionProvider,
  ): TranscriptionProvider {
    let bucket = cache.get(apiKey);
    if (!bucket) {
      bucket = new Map();
      cache.set(apiKey, bucket);
    }
    let provider = bucket.get(kind);
    if (!provider) {
      provider = create();
      bucket.set(kind, provider);
    }
    return provider;
  }

  return (model: TranscriptionModel, apiKey?: string): TranscriptionProvider => {
    const key = apiKey?.trim() || serverApiKey?.trim() || "";
    if (!key) {
      throw new Error(
        "OpenAI API key is required. Add your key in extension Settings or set OPENAI_API_KEY on the server.",
      );
    }
    if (model === "whisper-1") {
      return getCached(key, "whisper", () => new OpenAIWhisperProvider(key));
    }
    return getCached(key, "diarize", () => new OpenAIDiarizeProvider(key));
  };
}

import type { TranscriptionModel } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import { OpenAIDiarizeProvider } from "./openai-diarize.js";
import { OpenAIWhisperProvider } from "./openai-whisper.js";

export function createTranscriptionProviderFactory(apiKey: string) {
  let whisper: OpenAIWhisperProvider | undefined;
  let diarize: OpenAIDiarizeProvider | undefined;

  return (model: TranscriptionModel): TranscriptionProvider => {
    if (model === "whisper-1") {
      whisper ??= new OpenAIWhisperProvider(apiKey);
      return whisper;
    }
    diarize ??= new OpenAIDiarizeProvider(apiKey);
    return diarize;
  };
}

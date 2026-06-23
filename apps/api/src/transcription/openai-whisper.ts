import { createReadStream } from "node:fs";
import OpenAI from "openai";
import type { TranscriptResult } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(
    audioPath: string,
    opts?: { language?: string },
  ): Promise<TranscriptResult> {
    const response = await this.client.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
      ...(opts?.language ? { language: opts.language } : {}),
    });

    const segments = (response.segments ?? []).map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
    }));

    return {
      recordingId: "",
      language: response.language,
      duration: response.duration,
      segments,
    };
  }
}

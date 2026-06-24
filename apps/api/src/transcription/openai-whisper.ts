import { readFile, unlink } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import type { TranscriptResult } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import {
  prepareAudioForWhisper,
  whisperFilename,
  whisperMimeType,
} from "./prepare-audio.js";
import { withRetries } from "./retry.js";

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: 5 * 60 * 1000,
    });
  }

  async transcribe(
    audioPath: string,
    opts?: { language?: string },
  ): Promise<TranscriptResult> {
    const preparedPath = await prepareAudioForWhisper(audioPath);
    const data = await readFile(preparedPath);
    const file = await toFile(data, whisperFilename(preparedPath), {
      type: whisperMimeType(preparedPath),
    });

    try {
      const response = await withRetries(
        () =>
          this.client.audio.transcriptions.create({
            file,
            model: "whisper-1",
            response_format: "verbose_json",
            timestamp_granularities: ["segment"],
            ...(opts?.language ? { language: opts.language } : {}),
          }),
        { attempts: 4, baseDelayMs: 2000 },
      );

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
    } finally {
      if (preparedPath !== audioPath) {
        await unlink(preparedPath).catch(() => {});
      }
    }
  }
}

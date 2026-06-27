import { readFile } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import type { TranscriptResult, TranscriptSegment } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import {
  cleanupPreparedAudio,
  prepareAudioChunksForWhisper,
  whisperFilename,
  whisperMimeType,
} from "./prepare-audio.js";
import { withRetries } from "./retry.js";
import {
  buildWhisperPrompt,
  chunkPlainText,
  filterPromptEchoSegments,
  stripLeadingTitleEchoes,
} from "./whisper-prompt.js";

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: 10 * 60 * 1000,
    });
  }

  async transcribe(
    audioPath: string,
    opts?: { language?: string; meetingTitle?: string },
  ): Promise<TranscriptResult> {
    const { paths, cleanup } = await prepareAudioChunksForWhisper(audioPath);

    try {
      const segments: TranscriptSegment[] = [];
      let language: string | undefined;
      let duration = 0;
      let offset = 0;
      let previousChunkText: string | undefined;

      for (const chunkPath of paths) {
        const prompt = buildWhisperPrompt({ previousChunkText });

        const chunk = await this.transcribeChunk(chunkPath, {
          language: opts?.language,
          meetingTitle: opts?.meetingTitle,
          prompt,
        });
        language ??= chunk.language;
        for (const seg of chunk.segments) {
          segments.push({
            start: seg.start + offset,
            end: seg.end + offset,
            text: seg.text,
          });
        }
        const chunkDuration = chunk.duration ?? 0;
        offset += chunkDuration;
        duration += chunkDuration;

        const chunkText = chunkPlainText(chunk.segments);
        if (chunkText) {
          previousChunkText = chunkText;
        }
      }

      return {
        recordingId: "",
        language,
        duration: duration || undefined,
        segments: stripLeadingTitleEchoes(segments, opts?.meetingTitle),
      };
    } finally {
      await cleanupPreparedAudio(cleanup);
    }
  }

  private async transcribeChunk(
    audioPath: string,
    opts?: { language?: string; meetingTitle?: string; prompt?: string },
  ): Promise<TranscriptResult> {
    const data = await readFile(audioPath);
    const file = await toFile(data, whisperFilename(audioPath), {
      type: whisperMimeType(audioPath),
    });

    const response = await withRetries(
      () =>
        this.client.audio.transcriptions.create({
          file,
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
          ...(opts?.language ? { language: opts.language } : {}),
          ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        }),
      { attempts: 4, baseDelayMs: 2000 },
    );

    const segments = filterPromptEchoSegments(
      (response.segments ?? []).map((seg) => ({
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
      })),
      { prompt: opts?.prompt, meetingTitle: opts?.meetingTitle },
    );

    return {
      recordingId: "",
      language: response.language,
      duration: response.duration,
      segments,
    };
  }
}

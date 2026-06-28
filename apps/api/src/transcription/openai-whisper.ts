import { readFile } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import type { TranscriptResult, TranscriptSegment } from "@cognium/meet-shared";
import type { TranscriptionOptions, TranscriptionProvider } from "./provider.js";
import {
  cleanupPreparedAudio,
  getAudioDurationSeconds,
  prepareAudioChunksForWhisper,
  whisperFilename,
  whisperMimeType,
} from "./prepare-audio.js";
import {
  logOpenAIRequestFailed,
  logOpenAIRequestStart,
  logOpenAIResponse,
} from "./openai-request-log.js";
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
    opts?: TranscriptionOptions,
  ): Promise<TranscriptResult> {
    await opts?.onProgress?.({
      phase: "preparing",
      profile: "whisper",
      label: "Preparing audio…",
      updatedAt: new Date().toISOString(),
    });
    const { paths, cleanup } = await prepareAudioChunksForWhisper(audioPath);

    const partDurations: number[] = [];
    for (const chunkPath of paths) {
      partDurations.push((await getAudioDurationSeconds(chunkPath)) ?? 0);
    }
    const totalAudioSeconds = partDurations.reduce((sum, s) => sum + s, 0);

    await opts?.onProgress?.({
      phase: "preparing",
      profile: "whisper",
      totalSteps: paths.length,
      totalAudioSeconds: totalAudioSeconds || undefined,
      label:
        paths.length > 1
          ? `Audio ready — ${paths.length} parts to transcribe`
          : "Audio ready — transcribing…",
      updatedAt: new Date().toISOString(),
    });

    try {
      const segments: TranscriptSegment[] = [];
      let language: string | undefined;
      let duration = 0;
      let offset = 0;
      let previousChunkText: string | undefined;
      let completedAudioSeconds = 0;

      for (let i = 0; i < paths.length; i++) {
        const chunkPath = paths[i]!;
        const partNum = i + 1;
        const label =
          paths.length > 1
            ? `Transcribing part ${partNum}/${paths.length}…`
            : "Transcribing…";

        const audioSeconds = partDurations[i] ?? 0;
        const partStartedAt = new Date().toISOString();

        await opts?.onProgress?.({
          phase: "transcribing",
          profile: "whisper",
          step: partNum,
          totalSteps: paths.length,
          label,
          updatedAt: partStartedAt,
          partStartedAt,
          partAudioSeconds: audioSeconds,
          totalAudioSeconds: totalAudioSeconds || undefined,
          completedAudioSeconds,
        });

        const prompt = buildWhisperPrompt({ previousChunkText });

        const chunk = await this.transcribeChunk(chunkPath, {
          language: opts?.language,
          meetingTitle: opts?.meetingTitle,
          prompt,
          part:
            paths.length > 1 ? { index: i, total: paths.length } : undefined,
          audioSeconds: audioSeconds,
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

        completedAudioSeconds += audioSeconds || chunkDuration;

        await opts?.onProgress?.({
          phase: "transcribing",
          profile: "whisper",
          step: partNum,
          totalSteps: paths.length,
          label: `Part ${partNum}/${paths.length} finished`,
          updatedAt: new Date().toISOString(),
          partAudioSeconds: audioSeconds || chunkDuration,
          totalAudioSeconds: totalAudioSeconds || undefined,
          completedAudioSeconds,
        });
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
    opts?: {
      language?: string;
      meetingTitle?: string;
      prompt?: string;
      part?: { index: number; total: number };
      audioSeconds?: number;
    },
  ): Promise<TranscriptResult> {
    const fileBytes = await readFile(audioPath);
    const file = await toFile(fileBytes, whisperFilename(audioPath), {
      type: whisperMimeType(audioPath),
    });

    const model = "whisper-1";
    const response = await withRetries(async () => {
      logOpenAIRequestStart({
        model,
        bytes: fileBytes.byteLength,
        part: opts?.part,
        audioSeconds: opts?.audioSeconds,
      });
      const started = Date.now();
      try {
        const { data, response: raw } = await this.client.audio.transcriptions
          .create({
            file,
            model,
            response_format: "verbose_json",
            timestamp_granularities: ["segment"],
            ...(opts?.language ? { language: opts.language } : {}),
            ...(opts?.prompt ? { prompt: opts.prompt } : {}),
          })
          .withResponse();

        logOpenAIResponse({
          model,
          part: opts?.part,
          elapsedMs: Date.now() - started,
          requestId: raw.headers.get("x-request-id") ?? undefined,
          detail: `segments=${data.segments?.length ?? 0}`,
        });
        return data;
      } catch (err) {
        logOpenAIRequestFailed({
          model,
          part: opts?.part,
          elapsedMs: Date.now() - started,
          err,
        });
        throw err;
      }
    }, { attempts: 4, baseDelayMs: 2000 });

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

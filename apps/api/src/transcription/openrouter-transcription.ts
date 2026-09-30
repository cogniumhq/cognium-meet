import { readFile } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import type { TranscriptResult, TranscriptSegment } from "@cognium/meet-shared";
import {
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
} from "../llm/create-meeting-llm.js";
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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type VerboseSegment = { start?: number; end?: number; text?: string };

function looksLikeUnsupportedFormat(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /verbose_json|response_format|timestamp_granularit|unsupported|invalid.*format/i.test(
    message,
  );
}

function singleSegmentResult(text: string, duration?: number): TranscriptResult {
  const trimmed = text.trim();
  return {
    recordingId: "",
    duration,
    segments: trimmed
      ? [{ start: 0, end: duration && duration > 0 ? duration : 0, text: trimmed }]
      : [],
  };
}

function mapVerboseSegments(
  segments: VerboseSegment[] | undefined,
  opts?: { prompt?: string; meetingTitle?: string },
): TranscriptSegment[] {
  return filterPromptEchoSegments(
    (segments ?? []).map((seg) => ({
      start: typeof seg.start === "number" ? seg.start : 0,
      end: typeof seg.end === "number" ? seg.end : 0,
      text: (seg.text ?? "").trim(),
    })),
    { prompt: opts?.prompt, meetingTitle: opts?.meetingTitle },
  );
}

/**
 * OpenRouter OpenAI-compatible audio transcriptions.
 * Prefer verbose_json + segment timestamps; fall back to json/text when a model rejects them.
 */
export class OpenRouterTranscriptionProvider implements TranscriptionProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": OPENROUTER_APP_REFERER,
        "X-Title": OPENROUTER_APP_TITLE,
      },
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
          part: paths.length > 1 ? { index: i, total: paths.length } : undefined,
          audioSeconds,
        });
        language ??= chunk.language;
        for (const seg of chunk.segments) {
          segments.push({
            start: seg.start + offset,
            end: seg.end + offset,
            text: seg.text,
          });
        }
        const chunkDuration = chunk.duration ?? audioSeconds ?? 0;
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

    const model = this.model;
    return withRetries(
      async () => {
        logOpenAIRequestStart({
          model,
          bytes: fileBytes.byteLength,
          part: opts?.part,
          audioSeconds: opts?.audioSeconds,
        });
        const started = Date.now();
        try {
          const result = await this.createTranscription(file, opts);
          logOpenAIResponse({
            model,
            part: opts?.part,
            elapsedMs: Date.now() - started,
            detail: `segments=${result.segments.length}`,
          });
          return result;
        } catch (err) {
          logOpenAIRequestFailed({
            model,
            part: opts?.part,
            elapsedMs: Date.now() - started,
            err,
          });
          throw err;
        }
      },
      { attempts: 4, baseDelayMs: 2000 },
    );
  }

  private async createTranscription(
    file: Awaited<ReturnType<typeof toFile>>,
    opts?: {
      language?: string;
      meetingTitle?: string;
      prompt?: string;
      audioSeconds?: number;
    },
  ): Promise<TranscriptResult> {
    const common = {
      file,
      model: this.model,
      ...(opts?.language ? { language: opts.language } : {}),
      ...(opts?.prompt ? { prompt: opts.prompt } : {}),
    };

    try {
      const { data } = await this.client.audio.transcriptions
        .create({
          ...common,
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
        })
        .withResponse();

      const verbose = data as {
        language?: string;
        duration?: number;
        text?: string;
        segments?: VerboseSegment[];
      };

      const segments = mapVerboseSegments(verbose.segments, {
        prompt: opts?.prompt,
        meetingTitle: opts?.meetingTitle,
      });

      if (segments.length > 0) {
        return {
          recordingId: "",
          language: verbose.language,
          duration: verbose.duration ?? opts?.audioSeconds,
          segments,
        };
      }

      return singleSegmentResult(
        verbose.text ?? "",
        verbose.duration ?? opts?.audioSeconds,
      );
    } catch (err) {
      if (!looksLikeUnsupportedFormat(err)) {
        throw err;
      }
    }

    try {
      const { data } = await this.client.audio.transcriptions
        .create({
          ...common,
          response_format: "json",
        })
        .withResponse();

      const json = data as { text?: string; language?: string; duration?: number };
      return {
        recordingId: "",
        language: json.language,
        duration: json.duration ?? opts?.audioSeconds,
        segments: singleSegmentResult(
          json.text ?? "",
          json.duration ?? opts?.audioSeconds,
        ).segments,
      };
    } catch (err) {
      if (!looksLikeUnsupportedFormat(err)) {
        throw err;
      }
    }

    const { data } = await this.client.audio.transcriptions
      .create({
        ...common,
        response_format: "text",
      })
      .withResponse();

    const text = typeof data === "string" ? data : String(data ?? "");
    return singleSegmentResult(text, opts?.audioSeconds);
  }
}

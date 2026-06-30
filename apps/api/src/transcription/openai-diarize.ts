import { readFile, stat } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import type { TranscriptResult, TranscriptSegment } from "@cognium/meet-shared";
import type { TranscriptionOptions, TranscriptionProvider } from "./provider.js";
import {
  cleanupPreparedAudio,
  DIARIZE_TIMEOUT_MAX_MS,
  diarizeTimeoutMs,
  getAudioDurationSeconds,
  prepareAudioForDiarize,
  splitAudioForDiarize,
  whisperFilename,
  whisperMimeType,
} from "./prepare-audio.js";
import {
  logOpenAIRequestFailed,
  logOpenAIRequestStart,
  logOpenAIResponse,
} from "./openai-request-log.js";
import { withRetries } from "./retry.js";

interface DiarizedSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface DiarizedJsonResponse {
  language?: string;
  duration?: number;
  segments?: DiarizedSegment[];
}

export interface DiarizePartLabel {
  index: number;
  total: number;
}

/** Map API speaker ids (e.g. speaker_0) to readable labels. */
export function formatDiarizedSpeaker(
  speaker: string | undefined,
  part?: DiarizePartLabel,
): string | undefined {
  if (!speaker) {
    return undefined;
  }
  const match = /^speaker_(\d+)$/i.exec(speaker);
  const base = match
    ? `Speaker ${Number.parseInt(match[1], 10) + 1}`
    : speaker;
  if (part && part.total > 1) {
    return `${base} (pt ${part.index + 1})`;
  }
  return base;
}

export class OpenAIDiarizeProvider implements TranscriptionProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: DIARIZE_TIMEOUT_MAX_MS,
    });
  }

  async transcribe(
    audioPath: string,
    opts?: TranscriptionOptions,
  ): Promise<TranscriptResult> {
    const prepStarted = Date.now();
    await opts?.onProgress?.({
      phase: "preparing",
      profile: "diarize",
      label: "Preparing audio…",
    });
    console.log("[transcription] diarize: preparing audio…");

    const { path: preparedPath, cleanup } = await prepareAudioForDiarize(audioPath);
    const { paths: chunkPaths, cleanup: splitCleanup } =
      await splitAudioForDiarize(preparedPath);
    cleanup.push(...splitCleanup);

    const prepMs = Date.now() - prepStarted;
    const fileSize = (await stat(preparedPath)).size;
    const durationSeconds = await getAudioDurationSeconds(preparedPath);

    await opts?.onProgress?.({
      phase: "preparing",
      profile: "diarize",
      totalSteps: chunkPaths.length,
      totalAudioSeconds: durationSeconds,
      label:
        chunkPaths.length > 1
          ? `Audio ready — ${chunkPaths.length} parts to transcribe`
          : "Audio ready — transcribing…",
      updatedAt: new Date().toISOString(),
    });

    console.log(
      `[transcription] diarize: prep done in ${(prepMs / 1000).toFixed(1)}s` +
        ` file=${(fileSize / 1024 / 1024).toFixed(2)} MB` +
        ` duration=${durationSeconds ? `${Math.round(durationSeconds)}s` : "?"}` +
        ` parts=${chunkPaths.length}`,
    );

    try {
      const apiStarted = Date.now();
      const partLabel: DiarizePartLabel = { index: 0, total: chunkPaths.length };
      const segments: TranscriptSegment[] = [];
      let language: string | undefined;
      let totalDuration = 0;
      let offset = 0;
      let completedAudioSeconds = 0;

      const partDurations: number[] = [];
      for (const chunkPath of chunkPaths) {
        partDurations.push((await getAudioDurationSeconds(chunkPath)) ?? 0);
      }
      const totalAudioSeconds =
        durationSeconds ?? partDurations.reduce((sum, s) => sum + s, 0);

      for (let i = 0; i < chunkPaths.length; i++) {
        partLabel.index = i;
        const chunkPath = chunkPaths[i]!;
        const chunkDuration = partDurations[i] ?? 0;
        const chunkTimeoutMs = diarizeTimeoutMs(chunkDuration);
        const partNum = i + 1;
        const partLabelText =
          chunkPaths.length > 1
            ? `Transcribing part ${partNum}/${chunkPaths.length}…`
            : "Transcribing with speaker labels…";

        const partStartedAt = new Date().toISOString();

        await opts?.onProgress?.({
          phase: "transcribing",
          profile: "diarize",
          step: partNum,
          totalSteps: chunkPaths.length,
          label: partLabelText,
          updatedAt: partStartedAt,
          partStartedAt,
          partAudioSeconds: chunkDuration,
          totalAudioSeconds,
          completedAudioSeconds,
        });

        console.log(
          `[transcription] diarize: part ${i + 1}/${chunkPaths.length}` +
            ` (${chunkDuration ? `${Math.round(chunkDuration)}s` : "?"})` +
            ` timeout=${Math.round(chunkTimeoutMs / 1000)}s`,
        );

        const chunk = await this.transcribeFile(chunkPath, {
          language: opts?.language ?? language,
          timeoutMs: chunkTimeoutMs,
          part: partLabel,
          audioSeconds: chunkDuration,
        });
        language ??= chunk.language;

        for (const seg of chunk.segments) {
          segments.push({
            start: seg.start + offset,
            end: seg.end + offset,
            text: seg.text,
            speaker: seg.speaker,
          });
        }

        const advance = chunkDuration ?? chunk.duration ?? 0;
        offset += advance;
        totalDuration += advance;
        completedAudioSeconds += chunkDuration;

        await opts?.onProgress?.({
          phase: "transcribing",
          profile: "diarize",
          step: partNum,
          totalSteps: chunkPaths.length,
          label: `Part ${partNum}/${chunkPaths.length} finished`,
          updatedAt: new Date().toISOString(),
          partAudioSeconds: chunkDuration,
          totalAudioSeconds,
          completedAudioSeconds,
        });
      }

      console.log(
        `[transcription] diarize: API done in ${((Date.now() - apiStarted) / 1000).toFixed(1)}s` +
          ` segments=${segments.length}`,
      );

      return {
        recordingId: "",
        language,
        duration: totalDuration || durationSeconds || undefined,
        segments,
      };
    } finally {
      await cleanupPreparedAudio(cleanup);
    }
  }

  private async transcribeFile(
    audioPath: string,
    opts: {
      language?: string;
      timeoutMs: number;
      part?: DiarizePartLabel;
      audioSeconds?: number;
    },
  ): Promise<TranscriptResult> {
    const fileBytes = await readFile(audioPath);
    const file = await toFile(fileBytes, whisperFilename(audioPath), {
      type: whisperMimeType(audioPath),
    });

    const model = "gpt-4o-transcribe-diarize";
    const diarized = await withRetries(async () => {
      logOpenAIRequestStart({
        model,
        bytes: fileBytes.byteLength,
        part: opts.part,
        audioSeconds: opts.audioSeconds,
      });
      const started = Date.now();
      try {
        const { data, request_id } = await this.client.audio.transcriptions
          .create(
            {
              file,
              model,
              response_format: "diarized_json" as "json",
              chunking_strategy: "auto",
              ...(opts.language ? { language: opts.language } : {}),
            },
            { timeout: opts.timeoutMs },
          )
          .withResponse();

        const body = data as unknown as DiarizedJsonResponse;
        logOpenAIResponse({
          model,
          part: opts.part,
          elapsedMs: Date.now() - started,
          requestId: request_id ?? undefined,
          detail: `segments=${body.segments?.length ?? 0}`,
        });
        return body;
      } catch (err) {
        logOpenAIRequestFailed({
          model,
          part: opts.part,
          elapsedMs: Date.now() - started,
          err,
        });
        throw err;
      }
    }, { attempts: 2, baseDelayMs: 3000 });
    const segments: TranscriptSegment[] = (diarized.segments ?? []).map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      speaker: formatDiarizedSpeaker(seg.speaker, opts.part),
    }));

    return {
      recordingId: "",
      language: diarized.language,
      duration: diarized.duration,
      segments,
    };
  }
}

import {
  mergeTranscriptionProgress,
  segmentsToPlainText,
  type RecordingMeta,
  type TranscriptResult,
  type TranscriptionModel,
  type TranscriptionProgress,
} from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import type { RecordingStore } from "../storage/recording-store.js";
import type { SearchIndex } from "../storage/search-index.js";
import { getAudioDurationSeconds } from "./prepare-audio.js";
import {
  mergeSpeakerSegments,
  SPEAKER_OTHERS,
  SPEAKER_YOU,
} from "./merge-segments.js";
import { enqueueMeetingNotes, type NotesProcessingDeps } from "../notes/process-notes.js";

async function saveProgress(
  store: RecordingStore,
  id: string,
  progress: TranscriptionProgress,
): Promise<void> {
  const meta = await store.getMeta(id);
  if (!meta || meta.status !== "processing") {
    return;
  }
  await store.saveMeta({
    ...meta,
    progress: mergeTranscriptionProgress(meta.progress, {
      ...progress,
      updatedAt: progress.updatedAt ?? new Date().toISOString(),
    }),
  });
}

export interface ProcessingDeps extends NotesProcessingDeps {
  getTranscriptionProvider: (model: TranscriptionModel) => TranscriptionProvider;
  defaultTranscriptionModel: TranscriptionModel;
  deleteAudioAfterTranscription: boolean;
}

const PROCESSING_STALE_MS = 90 * 60 * 1000;
const activeJobs = new Set<string>();

function transcriptionJobKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

export function cancelTranscription(userId: string, id: string): void {
  activeJobs.delete(transcriptionJobKey(userId, id));
}

export function isTranscriptionActive(userId: string, id: string): boolean {
  return activeJobs.has(transcriptionJobKey(userId, id));
}

async function transcribeDualTrack(
  store: RecordingStore,
  whisper: TranscriptionProvider,
  id: string,
  meta: RecordingMeta,
): Promise<TranscriptResult> {
  const tabPath = store.audioPath(id);
  const micPath = store.micAudioPath(id);
  const tabSeconds = (await getAudioDurationSeconds(tabPath)) ?? 0;
  const micSeconds = (await getAudioDurationSeconds(micPath)) ?? 0;
  const totalAudioSeconds = tabSeconds + micSeconds || undefined;

  const transcribeOpts = {
    meetingTitle: meta.meetingTitle,
    onProgress: (progress: TranscriptionProgress) =>
      saveProgress(store, id, progress),
  };

  const partStartedAt1 = new Date().toISOString();
  await saveProgress(store, id, {
    phase: "transcribing",
    profile: "whisper",
    step: 1,
    totalSteps: 2,
    label: "Transcribing tab audio (Others)…",
    updatedAt: partStartedAt1,
    partStartedAt: partStartedAt1,
    partAudioSeconds: tabSeconds || undefined,
    totalAudioSeconds,
    completedAudioSeconds: 0,
  });

  const tabResult = await whisper.transcribe(tabPath, transcribeOpts);

  const partStartedAt2 = new Date().toISOString();
  await saveProgress(store, id, {
    phase: "transcribing",
    profile: "whisper",
    step: 2,
    totalSteps: 2,
    label: "Transcribing mic audio (You)…",
    updatedAt: partStartedAt2,
    partStartedAt: partStartedAt2,
    partAudioSeconds: micSeconds || undefined,
    totalAudioSeconds,
    completedAudioSeconds: tabSeconds,
  });

  const micResult = await whisper.transcribe(micPath, transcribeOpts);

  console.log(
    `[transcription] dual-track id=${id} others=${tabResult.segments.length} you=${micResult.segments.length}`,
  );

  return {
    recordingId: "",
    language: tabResult.language ?? micResult.language,
    duration:
      Math.max(tabResult.duration ?? 0, micResult.duration ?? 0) || undefined,
    segments: mergeSpeakerSegments(
      { speaker: SPEAKER_OTHERS, segments: tabResult.segments },
      { speaker: SPEAKER_YOU, segments: micResult.segments },
    ),
  };
}

export async function processRecording(
  deps: ProcessingDeps,
  userId: string,
  id: string,
): Promise<void> {
  const { store, searchIndex } = await deps.userRegistry.forUser(userId);
  const meta = await store.getMeta(id);
  if (!meta) {
    throw new Error(`Recording ${id} not found`);
  }

  if (!(await store.audioExists(id))) {
    throw new Error("Audio file missing — cannot transcribe");
  }

  const dualTrack =
    meta.captureMode === "dual-track" && (await store.micAudioExists(id));
  const model = dualTrack
    ? "whisper-1"
    : (meta.transcriptionModel ?? deps.defaultTranscriptionModel);
  const transcription = deps.getTranscriptionProvider(model);

  await store.saveMeta({
    ...meta,
    status: "processing",
    error: undefined,
    processingStartedAt: new Date().toISOString(),
    transcriptionModel: model,
    notesStatus: deps.notesEnabled ? "pending" : "skipped",
    notesError: undefined,
  });

  console.log(
    `[transcription] started user=${userId} id=${id} model=${model} capture=${meta.captureMode ?? "mixed"} dual=${dualTrack} title=${meta.meetingTitle ?? "(none)"}`,
  );

  const result = dualTrack
    ? await transcribeDualTrack(
        store,
        deps.getTranscriptionProvider("whisper-1"),
        id,
        meta,
      )
    : await transcription.transcribe(store.audioPath(id), {
        meetingTitle: meta.meetingTitle,
        onProgress: (progress) => saveProgress(store, id, progress),
      });

  const stillExists = await store.getMeta(id);
  if (!stillExists) {
    return;
  }

  await saveProgress(store, id, {
    phase: "saving",
    label: "Saving transcript…",
  });

  await store.saveTranscript(id, result);

  searchIndex.indexTranscript(
    id,
    stillExists.meetingTitle,
    stillExists.startedAt,
    segmentsToPlainText(result.segments),
  );

  const completed: RecordingMeta = {
    ...stillExists,
    status: "completed",
    language: result.language,
    error: undefined,
    processingStartedAt: undefined,
    progress: undefined,
    transcriptionModel: model,
    notesStatus: deps.notesEnabled ? "pending" : "skipped",
    notesError: undefined,
  };
  await store.saveMeta(completed);

  console.log(
    `[transcription] completed user=${userId} id=${id} segments=${result.segments.length} language=${result.language ?? "?"}`,
  );

  enqueueMeetingNotes(deps, userId, id);

  if (deps.deleteAudioAfterTranscription) {
    await store.deleteAudio(id);
  }
}

export async function markRecordingFailed(
  deps: ProcessingDeps,
  userId: string,
  id: string,
  error: string,
): Promise<void> {
  const { store } = await deps.userRegistry.forUser(userId);
  const meta = await store.getMeta(id);
  if (!meta) {
    return;
  }
  await store.saveMeta({
    ...meta,
    status: "failed",
    error,
    processingStartedAt: undefined,
    progress: undefined,
  });
  console.log(`[transcription] failed user=${userId} id=${id} error=${error}`);
}

export function enqueueTranscription(
  deps: ProcessingDeps,
  userId: string,
  id: string,
): void {
  const key = transcriptionJobKey(userId, id);
  if (activeJobs.has(key)) {
    return;
  }
  activeJobs.add(key);
  void processRecording(deps, userId, id)
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await markRecordingFailed(deps, userId, id, message);
    })
    .finally(() => {
      activeJobs.delete(key);
    });
}

export async function resumePendingRecordings(deps: ProcessingDeps): Promise<void> {
  const userIds = await deps.userRegistry.listUserIds();
  for (const userId of userIds) {
    const { store } = await deps.userRegistry.forUser(userId);
    const pending = await store.listMetasByStatus("processing");
    for (const meta of pending) {
      const started = new Date(meta.processingStartedAt ?? meta.startedAt).getTime();
      const ageMs = Date.now() - started;

      if (await store.audioExists(meta.id)) {
        console.log(`Resuming transcription for user=${userId} id=${meta.id}`);
        enqueueTranscription(deps, userId, meta.id);
        continue;
      }

      if (ageMs > PROCESSING_STALE_MS) {
        await markRecordingFailed(
          deps,
          userId,
          meta.id,
          "Transcription interrupted — audio file is no longer available",
        );
      }
    }
  }
}

export function isProcessingStale(meta: RecordingMeta): boolean {
  if (meta.status !== "processing") {
    return false;
  }
  const started = new Date(meta.processingStartedAt ?? meta.startedAt).getTime();
  return Date.now() - started > PROCESSING_STALE_MS;
}

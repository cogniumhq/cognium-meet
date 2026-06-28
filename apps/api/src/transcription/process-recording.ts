import type { RecordingMeta, TranscriptionProgress } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import { RecordingStore } from "../storage/recording-store.js";

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
    progress: {
      ...progress,
      updatedAt: progress.updatedAt ?? new Date().toISOString(),
    },
  });
}

export interface ProcessingDeps {
  store: RecordingStore;
  transcription: TranscriptionProvider;
  deleteAudioAfterTranscription: boolean;
}

const PROCESSING_STALE_MS = 90 * 60 * 1000;
const activeJobs = new Set<string>();

export function cancelTranscription(id: string): void {
  activeJobs.delete(id);
}

export function isTranscriptionActive(id: string): boolean {
  return activeJobs.has(id);
}

export async function processRecording(
  deps: ProcessingDeps,
  id: string,
): Promise<void> {
  const meta = await deps.store.getMeta(id);
  if (!meta) {
    throw new Error(`Recording ${id} not found`);
  }

  if (!(await deps.store.audioExists(id))) {
    throw new Error("Audio file missing — cannot transcribe");
  }

  await deps.store.saveMeta({
    ...meta,
    status: "processing",
    error: undefined,
    processingStartedAt: new Date().toISOString(),
  });

  console.log(`[transcription] started id=${id} title=${meta.meetingTitle ?? "(none)"}`);

  const result = await deps.transcription.transcribe(deps.store.audioPath(id), {
    meetingTitle: meta.meetingTitle,
    onProgress: (progress) => saveProgress(deps.store, id, progress),
  });

  const stillExists = await deps.store.getMeta(id);
  if (!stillExists) {
    return;
  }

  await saveProgress(deps.store, id, {
    phase: "saving",
    label: "Saving transcript…",
  });

  await deps.store.saveTranscript(id, result);

  const completed: RecordingMeta = {
    ...meta,
    status: "completed",
    language: result.language,
    error: undefined,
    processingStartedAt: undefined,
    progress: undefined,
  };
  await deps.store.saveMeta(completed);

  console.log(
    `[transcription] completed id=${id} segments=${result.segments.length} language=${result.language ?? "?"}`,
  );

  if (deps.deleteAudioAfterTranscription) {
    await deps.store.deleteAudio(id);
  }
}

export async function markRecordingFailed(
  deps: ProcessingDeps,
  id: string,
  error: string,
): Promise<void> {
  const meta = await deps.store.getMeta(id);
  if (!meta) {
    return;
  }
  await deps.store.saveMeta({
    ...meta,
    status: "failed",
    error,
    processingStartedAt: undefined,
    progress: undefined,
  });
  console.log(`[transcription] failed id=${id} error=${error}`);
}

export function enqueueTranscription(deps: ProcessingDeps, id: string): void {
  if (activeJobs.has(id)) {
    return;
  }
  activeJobs.add(id);
  void processRecording(deps, id)
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await markRecordingFailed(deps, id, message);
    })
    .finally(() => {
      activeJobs.delete(id);
    });
}

export async function resumePendingRecordings(deps: ProcessingDeps): Promise<void> {
  const pending = await deps.store.listMetasByStatus("processing");
  for (const meta of pending) {
    const started = new Date(meta.processingStartedAt ?? meta.startedAt).getTime();
    const ageMs = Date.now() - started;

    if (await deps.store.audioExists(meta.id)) {
      console.log(`Resuming transcription for ${meta.id}`);
      enqueueTranscription(deps, meta.id);
      continue;
    }

    if (ageMs > PROCESSING_STALE_MS) {
      await markRecordingFailed(
        deps,
        meta.id,
        "Transcription interrupted — audio file is no longer available",
      );
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

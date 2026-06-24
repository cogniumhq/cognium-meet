import type { RecordingMeta } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./provider.js";
import { RecordingStore } from "../storage/recording-store.js";

export interface ProcessingDeps {
  store: RecordingStore;
  transcription: TranscriptionProvider;
  deleteAudioAfterTranscription: boolean;
}

const PROCESSING_STALE_MS = 20 * 60 * 1000;
const activeJobs = new Set<string>();

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

  const result = await deps.transcription.transcribe(deps.store.audioPath(id));
  await deps.store.saveTranscript(id, result);

  const completed: RecordingMeta = {
    ...meta,
    status: "completed",
    language: result.language,
    error: undefined,
    processingStartedAt: undefined,
  };
  await deps.store.saveMeta(completed);

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
  });
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

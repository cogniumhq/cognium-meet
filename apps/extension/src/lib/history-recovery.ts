import { addOrphanedAudioToHistory, referencedLocalAudioIds, type OrphanAudioInfo } from "./history-merge.js";
import { listPendingAudioIds, loadPendingAudioMeta } from "./pending-audio-store.js";
import { loadRecordingState } from "./recording-state.js";
import { getHistory, saveHistory, type StoredRecording } from "./storage.js";

let recoveryInFlight: Promise<number> | null = null;

/**
 * Re-adds history entries for locally saved audio (IndexedDB) that no history entry
 * references — e.g. after a service worker died mid-upload or history was trimmed.
 * Idempotent and read-only for IndexedDB: audio is never deleted here.
 * Returns the number of entries added or re-linked.
 */
export function recoverOrphanedPendingAudio(): Promise<number> {
  recoveryInFlight ??= doRecoverOrphanedPendingAudio().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

async function doRecoverOrphanedPendingAudio(): Promise<number> {
  // While a recording is active/stopping, its audio may be saved before its history entry.
  const recording = await loadRecordingState();
  if (recording.isRecording) {
    return 0;
  }

  const ids = await listPendingAudioIds();
  const referenced = referencedLocalAudioIds(await getHistory());
  const orphanIds = ids.filter((id) => !referenced.has(id));
  if (orphanIds.length === 0) {
    return 0;
  }

  const orphans: OrphanAudioInfo[] = [];
  for (const id of orphanIds) {
    try {
      const meta = await loadPendingAudioMeta(id);
      if (!meta) {
        continue;
      }
      orphans.push({
        id,
        meetingTitle: meta.meetingTitle,
        startedAt: meta.startedAt,
        durationMs: meta.durationMs,
        createdAt: meta.createdAt,
        hasMicAudio: meta.hasMicTrack,
      });
    } catch (err) {
      console.warn("[history] could not read local recording", id, err);
    }
  }

  // Re-read right before writing so concurrent history writes are not lost.
  const latest: StoredRecording[] = await getHistory();
  const result = addOrphanedAudioToHistory(latest, orphans);
  if (result.added + result.linked > 0) {
    await saveHistory(result.history);
    console.info(
      `[history] restored ${result.added} local recording(s), re-linked ${result.linked}`,
    );
  }
  return result.added + result.linked;
}

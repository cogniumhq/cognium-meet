import type { ExtensionSettings, TranscriptionProgress } from "@cognium/meet-shared";
import {
  DEFAULT_API_URL,
  DEFAULT_AUDIO_CAPTURE_MODE,
  DEFAULT_TRANSCRIPTION_MODEL,
  mergeTranscriptionProgress,
} from "@cognium/meet-shared";

const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS: ExtensionSettings = {
  apiUrl: DEFAULT_API_URL,
  apiToken: "dev-token-change-me",
  transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  captureMode: DEFAULT_AUDIO_CAPTURE_MODE,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

export interface StoredRecording {
  id: string;
  meetingTitle?: string;
  startedAt: string;
  durationMs?: number;
  status: string;
  error?: string;
  createdAt: string;
  /** Local IndexedDB backup when upload has not reached the server yet */
  localAudioId?: string;
  progress?: TranscriptionProgress;
}

const HISTORY_KEY = "recordingHistory";

export { HISTORY_KEY };

export function findServerProcessingEntry(
  history: StoredRecording[],
): StoredRecording | undefined {
  return history.find((item) => item.status === "processing" && !item.localAudioId);
}

export async function addToHistory(entry: StoredRecording): Promise<void> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  const history = (result[HISTORY_KEY] as StoredRecording[] | undefined) ?? [];
  const next = [entry, ...history].slice(0, 50);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

export async function updateHistoryEntry(
  id: string,
  patch: Partial<StoredRecording>,
): Promise<void> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  const history = (result[HISTORY_KEY] as StoredRecording[] | undefined) ?? [];
  const next = history.map((item) => {
    if (item.id !== id) {
      return item;
    }
    const merged: StoredRecording = { ...item, ...patch };
    if (patch.progress) {
      merged.progress = mergeTranscriptionProgress(item.progress, patch.progress);
    }
    return merged;
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

export async function replaceHistoryEntry(
  oldId: string,
  entry: StoredRecording,
): Promise<void> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  const history = (result[HISTORY_KEY] as StoredRecording[] | undefined) ?? [];
  const next = history.map((item) => (item.id === oldId ? entry : item));
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

export async function getHistory(): Promise<StoredRecording[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as StoredRecording[] | undefined) ?? [];
}

export async function removeHistoryEntry(id: string): Promise<void> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  const history = (result[HISTORY_KEY] as StoredRecording[] | undefined) ?? [];
  await chrome.storage.local.set({
    [HISTORY_KEY]: history.filter((item) => item.id !== id),
  });
}

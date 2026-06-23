import type { ExtensionSettings } from "@cognium/meet-shared";
import { DEFAULT_API_URL } from "@cognium/meet-shared";

const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS: ExtensionSettings = {
  apiUrl: DEFAULT_API_URL,
  apiToken: "dev-token-change-me",
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
  createdAt: string;
}

const HISTORY_KEY = "recordingHistory";

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
  const next = history.map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

export async function getHistory(): Promise<StoredRecording[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as StoredRecording[] | undefined) ?? [];
}

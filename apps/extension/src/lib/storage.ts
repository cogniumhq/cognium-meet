import type { ExtensionSettings, MeetingAskMessage, NotesStatus, TranscriptionProgress } from "@cognium/meet-shared";
import {
  DEFAULT_API_URL,
  DEFAULT_AUDIO_CAPTURE_MODE,
  DEFAULT_DELETE_AUDIO_AFTER_TRANSCRIPTION,
  DEFAULT_MAX_UPLOAD_MB,
  DEFAULT_MEETING_ASK_ENABLED,
  DEFAULT_MEETING_LLM_MODEL,
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_MEETING_NOTES_ENABLED,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_TRANSCRIPTION_MODEL,
  mergeTranscriptionProgress,
} from "@cognium/meet-shared";

const SETTINGS_KEY = "settings";
const USER_ID_KEY = "cogniumUserId";
const OPENAI_KEY_STORAGE_KEY = "openaiApiKey";

const DEFAULT_SETTINGS: ExtensionSettings = {
  apiUrl: DEFAULT_API_URL,
  apiToken: "dev-token-change-me",
  transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  captureMode: DEFAULT_AUDIO_CAPTURE_MODE,
  meetingLlmProvider: DEFAULT_MEETING_LLM_PROVIDER,
  meetingNotesEnabled: DEFAULT_MEETING_NOTES_ENABLED,
  meetingAskEnabled: DEFAULT_MEETING_ASK_ENABLED,
  meetingLlmModel: DEFAULT_MEETING_LLM_MODEL,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  deleteAudioAfterTranscription: DEFAULT_DELETE_AUDIO_AFTER_TRANSCRIPTION,
  maxUploadMb: DEFAULT_MAX_UPLOAD_MB,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

/** User's OpenAI key — local only (not synced across Chrome profiles). */
export async function getOpenAiApiKey(): Promise<string | undefined> {
  const result = await chrome.storage.local.get(OPENAI_KEY_STORAGE_KEY);
  const key = result[OPENAI_KEY_STORAGE_KEY];
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

export async function saveOpenAiApiKey(key: string | undefined): Promise<void> {
  const trimmed = key?.trim();
  if (trimmed) {
    await chrome.storage.local.set({ [OPENAI_KEY_STORAGE_KEY]: trimmed });
  } else {
    await chrome.storage.local.remove(OPENAI_KEY_STORAGE_KEY);
  }
}

/** Stable per Chrome profile — stored in local (not sync) storage. */
export async function getOrCreateUserId(): Promise<string> {
  const result = await chrome.storage.local.get(USER_ID_KEY);
  const existing = result[USER_ID_KEY];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const userId = crypto.randomUUID();
  await chrome.storage.local.set({ [USER_ID_KEY]: userId });
  return userId;
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
  notesStatus?: NotesStatus;
  notesError?: string;
}

const HISTORY_KEY = "recordingHistory";
const ASK_CHAT_KEY = "meetingAskChat";

export interface AskChatState {
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  messages: MeetingAskMessage[];
  draftInput?: string;
}

export async function loadAskChat(): Promise<AskChatState | undefined> {
  const result = await chrome.storage.local.get(ASK_CHAT_KEY);
  const chat = result[ASK_CHAT_KEY] as AskChatState | undefined;
  if (chat && Array.isArray(chat.messages)) {
    return chat;
  }
  return undefined;
}

export async function saveAskChat(state: AskChatState): Promise<void> {
  await chrome.storage.local.set({ [ASK_CHAT_KEY]: state });
}

export async function clearAskChat(): Promise<void> {
  await chrome.storage.local.remove(ASK_CHAT_KEY);
}

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

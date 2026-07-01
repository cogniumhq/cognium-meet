import type { ExtensionSettings, MeetingAskCitation, MeetingAskMessage, NotesStatus, TranscriptionProgress } from "@cognium/meet-shared";
import {
  DEFAULT_API_URL,
  DEFAULT_AUDIO_CAPTURE_MODE,
  DEFAULT_TRANSCRIPTION_MODEL,
  mergeTranscriptionProgress,
} from "@cognium/meet-shared";

const SETTINGS_KEY = "settings";
const USER_ID_KEY = "cogniumUserId";

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
const ASK_DRAFT_KEY = "meetingAskDraft";

export interface AskChatState {
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  messages: MeetingAskMessage[];
  draftInput?: string;
}

/** @deprecated — migrated to AskChatState on load */
interface LegacyAskDraftState {
  question: string;
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  lastAnswer?: string;
  lastInsufficientContext?: boolean;
  lastCitations?: MeetingAskCitation[];
  lastError?: string;
}

function migrateLegacyDraft(draft: LegacyAskDraftState): AskChatState {
  const messages: MeetingAskMessage[] = [];
  if (draft.question?.trim()) {
    messages.push({ role: "user", content: draft.question.trim() });
  }
  if (draft.lastError) {
    messages.push({ role: "assistant", content: draft.lastError, isError: true });
  } else if (draft.lastAnswer) {
    messages.push({
      role: "assistant",
      content: draft.lastAnswer,
      insufficientContext: draft.lastInsufficientContext,
      citations: draft.lastCitations,
    });
  }
  return {
    scopeRecordingId: draft.scopeRecordingId,
    scopeMeetingTitle: draft.scopeMeetingTitle,
    messages,
    draftInput: "",
  };
}

export async function loadAskChat(): Promise<AskChatState | undefined> {
  const result = await chrome.storage.local.get([ASK_CHAT_KEY, ASK_DRAFT_KEY]);
  const chat = result[ASK_CHAT_KEY] as AskChatState | undefined;
  if (chat && Array.isArray(chat.messages)) {
    return chat;
  }
  const legacy = result[ASK_DRAFT_KEY] as LegacyAskDraftState | undefined;
  if (legacy && typeof legacy.question === "string") {
    const migrated = migrateLegacyDraft(legacy);
    await saveAskChat(migrated);
    await chrome.storage.local.remove(ASK_DRAFT_KEY);
    return migrated;
  }
  return undefined;
}

export async function saveAskChat(state: AskChatState): Promise<void> {
  await chrome.storage.local.set({ [ASK_CHAT_KEY]: state });
}

export async function clearAskChat(): Promise<void> {
  await chrome.storage.local.remove([ASK_CHAT_KEY, ASK_DRAFT_KEY]);
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

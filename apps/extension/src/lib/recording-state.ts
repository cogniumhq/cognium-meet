export interface PersistedRecordingState {
  isRecording: boolean;
  tabId?: number;
  startedAt?: number;
  meetingTitle?: string;
  includedMic?: boolean;
  micLabel?: string;
  lastError?: string;
}

const STORAGE_KEY = "activeRecording";

export async function loadRecordingState(): Promise<PersistedRecordingState> {
  const result = await chrome.storage.session.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as PersistedRecordingState | undefined;
  return stored ?? { isRecording: false };
}

export async function saveRecordingState(
  state: PersistedRecordingState,
): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
}

export async function clearRecordingState(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEY);
}

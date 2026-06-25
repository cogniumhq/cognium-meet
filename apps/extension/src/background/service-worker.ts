import { OFFSCREEN_TARGET } from "../lib/messages.js";
import type { RecordingState } from "../lib/messages.js";
import {
  isLikelyAudio,
  normalizeAudioBytes,
} from "../lib/audio-bytes.js";
import {
  clearRecordingState,
  loadRecordingState,
  saveRecordingState,
  type PersistedRecordingState,
} from "../lib/recording-state.js";
import {
  addToHistory,
  getSettings,
  updateHistoryEntry,
  type StoredRecording,
} from "../lib/storage.js";
import { pollRecording, uploadRecording } from "../lib/upload.js";

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

export {};

let recordingState: PersistedRecordingState = { isRecording: false };

void loadRecordingState().then((state) => {
  recordingState = state;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === OFFSCREEN_TARGET) {
    return false;
  }
  void handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(
  message: { type: string; tabId?: number; meetingTitle?: string },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    if (message.type === "GET_STATUS") {
      const status = await getReconciledStatus();
      sendResponse(status);
      return;
    }

    if (message.type === "START_RECORDING") {
      await handleStartRecording(message, sendResponse);
      return;
    }

    if (message.type === "STOP_RECORDING") {
      await handleStopRecording(sendResponse);
      return;
    }

    sendResponse({ type: "RECORDING_ERROR", error: "Unknown message" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setRecordingState({ ...recordingState, isRecording: false, lastError: error });
    sendResponse({ type: "RECORDING_ERROR", error });
  }
}

async function handleStartRecording(
  message: { tabId?: number; meetingTitle?: string },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  const tabId = message.tabId;
  if (!tabId) {
    sendResponse({ type: "RECORDING_ERROR", error: "No active tab" });
    return;
  }

  const status = await getReconciledStatus();
  if (status.isRecording) {
    if (status.tabId === tabId) {
      sendResponse({
        type: "RECORDING_STARTED",
        startedAt: status.startedAt,
        meetingTitle: status.meetingTitle,
        includedMic: status.includedMic ?? false,
        micLabel: status.micLabel,
      });
      return;
    }
    sendResponse({
      type: "RECORDING_ERROR",
      error: "Already recording another meeting tab",
    });
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith("https://meet.google.com/")) {
    sendResponse({
      type: "RECORDING_ERROR",
      error: "Open a Google Meet tab before recording",
    });
    return;
  }

  let streamId: string;
  try {
    streamId = await getTabStreamId(tabId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (error.includes("active stream")) {
      await forceReleaseCapture();
      try {
        streamId = await getTabStreamId(tabId);
      } catch (retryErr) {
        const retryError =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        sendResponse({
          type: "RECORDING_ERROR",
          error: `${retryError} — reload the extension if this persists`,
        });
        return;
      }
    } else {
      sendResponse({ type: "RECORDING_ERROR", error });
      return;
    }
  }

  try {
    await ensureOffscreenDocument();
    const settings = await getSettings();
    const micDeviceId = settings.microphoneDeviceId?.trim() || undefined;
    const startResult = await sendToOffscreen<{
      type: string;
      error?: string;
      includedMic?: boolean;
      micLabel?: string;
    }>({
      type: "OFFSCREEN_START",
      streamId,
      micDeviceId,
    });

    if (startResult.type === "RECORDING_ERROR") {
      throw new Error(startResult.error ?? "Failed to start offscreen recorder");
    }

    const startedAt = Date.now();
    await setRecordingState({
      isRecording: true,
      tabId,
      startedAt,
      meetingTitle: message.meetingTitle ?? tab.title ?? "Google Meet",
      includedMic: startResult.includedMic ?? false,
      micLabel: startResult.micLabel,
      lastError: undefined,
    });

    await chrome.tabs.sendMessage(tabId, { type: "SHOW_CONSENT_BANNER" }).catch(() => {});
    sendResponse({
      type: "RECORDING_STARTED",
      startedAt,
      meetingTitle: recordingState.meetingTitle,
      includedMic: recordingState.includedMic ?? false,
      micLabel: recordingState.micLabel,
    });
  } catch (err) {
    await forceReleaseCapture();
    throw err;
  }
}

async function handleStopRecording(
  sendResponse: (response: unknown) => void,
): Promise<void> {
  const status = await getReconciledStatus();
  if (!status.isRecording) {
    sendResponse({ type: "RECORDING_ERROR", error: "Not recording" });
    return;
  }

  const response = await sendToOffscreen<{
    type: string;
    audioBase64?: string;
    byteLength?: number;
    mimeType?: string;
    error?: string;
  }>({ type: "OFFSCREEN_STOP" });

  if (response.type === "RECORDING_ERROR" || !response.audioBase64) {
    const error = response.error ?? "Failed to stop recording";
    await setRecordingState({ ...recordingState, lastError: error });
    sendResponse({ type: "RECORDING_ERROR", error });
    return;
  }

  const audioBytes = normalizeAudioBytes(response.audioBase64);
  if (response.byteLength && audioBytes.length !== response.byteLength) {
    sendResponse({
      type: "RECORDING_ERROR",
      error: `Audio corrupted in transfer (${audioBytes.length}/${response.byteLength} bytes)`,
    });
    return;
  }

  if (!isLikelyAudio(audioBytes)) {
    sendResponse({
      type: "RECORDING_ERROR",
      error: `Invalid audio data (${audioBytes.length} bytes)`,
    });
    return;
  }

  const startedAt = status.startedAt ?? Date.now();
  const durationMs = Date.now() - startedAt;
  const meetingTitle = status.meetingTitle;
  const tabId = status.tabId;

  await setRecordingState({
    isRecording: false,
    tabId: undefined,
    startedAt: undefined,
    meetingTitle: undefined,
    includedMic: undefined,
    micLabel: undefined,
    lastError: undefined,
  });

  if (tabId) {
    await chrome.tabs.sendMessage(tabId, { type: "HIDE_CONSENT_BANNER" }).catch(() => {});
  }

  await closeOffscreenDocument();

  const upload = await uploadRecording({
    bytes: audioBytes,
    mimeType: response.mimeType ?? "audio/webm",
    meetingTitle,
    startedAt,
    durationMs,
  });

  const entry: StoredRecording = {
    id: upload.id,
    meetingTitle,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    status: "processing",
    createdAt: new Date().toISOString(),
  };
  await addToHistory(entry);
  void trackTranscription(upload.id);

  sendResponse({
    type: "RECORDING_STOPPED",
    recordingId: upload.id,
    durationMs,
    meetingTitle,
    startedAt,
  });
}

async function getReconciledStatus(): Promise<RecordingState> {
  const stored = await loadRecordingState();
  const offscreen = await queryOffscreenStatus();

  if (offscreen.isRecording) {
    if (!stored.isRecording || !stored.startedAt) {
      const repaired: PersistedRecordingState = {
        isRecording: true,
        tabId: stored.tabId,
        startedAt: stored.startedAt ?? Date.now(),
        meetingTitle: stored.meetingTitle,
        includedMic: offscreen.includedMic,
        micLabel: offscreen.micLabel,
      };
      await setRecordingState(repaired);
      return repaired;
    }
    recordingState = {
      ...stored,
      includedMic: offscreen.includedMic,
      micLabel: offscreen.micLabel,
    };
    return recordingState;
  }

  if (stored.isRecording) {
    await clearRecordingState();
    recordingState = { isRecording: false };
    return recordingState;
  }

  recordingState = stored;
  return stored;
}

async function setRecordingState(state: PersistedRecordingState): Promise<void> {
  recordingState = state;
  if (state.isRecording) {
    await saveRecordingState(state);
  } else {
    await clearRecordingState();
  }
}

async function queryOffscreenStatus(): Promise<{
  isRecording: boolean;
  includedMic: boolean;
  micLabel?: string;
}> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length === 0) {
    return { isRecording: false, includedMic: false, micLabel: undefined };
  }

  try {
    const response = await sendToOffscreen<{
      type: string;
      isRecording?: boolean;
      includedMic?: boolean;
      micLabel?: string;
    }>({ type: "OFFSCREEN_STATUS" });
    return {
      isRecording: response.isRecording ?? false,
      includedMic: response.includedMic ?? false,
      micLabel: response.micLabel,
    };
  } catch {
    return { isRecording: false, includedMic: false, micLabel: undefined };
  }
}

async function forceReleaseCapture(): Promise<void> {
  try {
    await sendToOffscreen({ type: "OFFSCREEN_ABORT" });
  } catch {
    // offscreen may be gone
  }
  await closeOffscreenDocument();
  await setRecordingState({
    isRecording: false,
    tabId: undefined,
    startedAt: undefined,
    meetingTitle: undefined,
    includedMic: undefined,
    micLabel: undefined,
    lastError: undefined,
  });
}

function getTabStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });
}

async function sendToOffscreen<T>(message: {
  type: string;
  streamId?: string;
  micDeviceId?: string;
}): Promise<T> {
  const payload = { ...message, target: OFFSCREEN_TARGET };

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (response !== undefined) {
        return response as T;
      }
    } catch {
      // Offscreen document may still be loading.
    }
    await sleep(100);
  }

  throw new Error("Offscreen recorder not ready");
}

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record Google Meet tab audio for transcription",
  });

  await sleep(200);
}

async function closeOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trackTranscription(id: string): Promise<void> {
  try {
    const meta = await pollRecording(id, {
      intervalMs: 3000,
      timeoutMs: 20 * 60 * 1000,
    });
    await updateHistoryEntry(id, {
      status: meta.status,
      error: meta.error,
    });
  } catch (err) {
    await updateHistoryEntry(id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordingState.isRecording && recordingState.tabId === tabId) {
    void forceReleaseCapture();
    void setRecordingState({
      isRecording: false,
      lastError: "Meeting tab was closed",
    });
  }
});

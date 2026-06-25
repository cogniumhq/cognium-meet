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
  replaceHistoryEntry,
  updateHistoryEntry,
  type StoredRecording,
} from "../lib/storage.js";
import { pollRecording, uploadRecording } from "../lib/upload.js";
import {
  deletePendingAudio,
  loadPendingAudio,
  savePendingAudio,
} from "../lib/pending-audio-store.js";
import { isRecordableTabUrl, tabRecordingTitle } from "../lib/recordable-tab.js";

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

export {};

let recordingState: PersistedRecordingState = { isRecording: false };
let isFinalizingRecording = false;

interface OffscreenStopResponse {
  type: string;
  audioBase64?: string;
  byteLength?: number;
  mimeType?: string;
  error?: string;
}

interface FinalizeResult {
  recordingId?: string;
  localAudioId?: string;
  uploadFailed?: boolean;
  savedLocally?: boolean;
  error?: string;
  durationMs: number;
  meetingTitle?: string;
  startedAt: number;
}

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
  message: {
    type: string;
    tabId?: number;
    meetingTitle?: string;
    transcribe?: boolean;
    localAudioId?: string;
  },
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
      const transcribe = message.transcribe !== false;
      await handleStopRecording(sendResponse, transcribe);
      return;
    }

    if (message.type === "RETRY_UPLOAD") {
      await handleRetryUpload(
        message as { localAudioId?: string },
        sendResponse,
      );
      return;
    }

    if (message.type === "TAB_CAPTURE_ENDED") {
      void stopRecordingAndFinalize({ reason: "capture_ended" }).catch(() => {});
      sendResponse({ ok: true });
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
      error: "Already recording another tab",
    });
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  if (!isRecordableTabUrl(tab.url)) {
    sendResponse({
      type: "RECORDING_ERROR",
      error:
        "This page cannot be recorded — open a regular website tab (http/https) and try again",
    });
    return;
  }

  const recordingTitle = tabRecordingTitle(tab);

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
      meetingTitle: message.meetingTitle ?? recordingTitle,
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
  transcribe = true,
): Promise<void> {
  const result = await stopRecordingAndFinalize({ transcribe });
  if (!result) {
    sendResponse({ type: "RECORDING_ERROR", error: "Not recording" });
    return;
  }

  if (result.error && !result.localAudioId) {
    sendResponse({ type: "RECORDING_ERROR", error: result.error });
    return;
  }

  if (result.savedLocally) {
    sendResponse({
      type: "RECORDING_STOPPED",
      savedLocally: true,
      localAudioId: result.localAudioId,
      durationMs: result.durationMs,
      meetingTitle: result.meetingTitle,
      startedAt: result.startedAt,
    });
    return;
  }

  if (result.uploadFailed) {
    sendResponse({
      type: "RECORDING_STOPPED",
      uploadFailed: true,
      localAudioId: result.localAudioId,
      error: result.error,
      durationMs: result.durationMs,
      meetingTitle: result.meetingTitle,
      startedAt: result.startedAt,
    });
    return;
  }

  sendResponse({
    type: "RECORDING_STOPPED",
    recordingId: result.recordingId,
    durationMs: result.durationMs,
    meetingTitle: result.meetingTitle,
    startedAt: result.startedAt,
  });
}

async function stopRecordingAndFinalize(opts?: {
  reason?: "tab_closed" | "capture_ended";
  transcribe?: boolean;
}): Promise<FinalizeResult | null> {
  if (isFinalizingRecording) {
    return null;
  }

  const status = await loadRecordingState();
  if (!status.isRecording) {
    return null;
  }

  isFinalizingRecording = true;
  try {
    let response: OffscreenStopResponse;
    try {
      response = await sendToOffscreen<OffscreenStopResponse>({
        type: "OFFSCREEN_STOP",
      });
    } catch {
      await forceReleaseCapture();
      return null;
    }

    const startedAt = status.startedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    const meetingTitle = status.meetingTitle;
    const tabId = status.tabId;

    if (response.type === "RECORDING_ERROR" || !response.audioBase64) {
      const error =
        response.error ??
        (opts?.reason === "tab_closed"
          ? "Tab closed before any audio could be saved"
          : "Failed to stop recording");
      await forceReleaseCapture();
      await setRecordingState({ isRecording: false, lastError: error });
      return { error, durationMs, meetingTitle, startedAt };
    }

    const audioBytes = normalizeAudioBytes(response.audioBase64);
    if (response.byteLength && audioBytes.length !== response.byteLength) {
      const error = `Audio corrupted in transfer (${audioBytes.length}/${response.byteLength} bytes)`;
      await forceReleaseCapture();
      await setRecordingState({ isRecording: false, lastError: error });
      return { error, durationMs, meetingTitle, startedAt };
    }

    if (!isLikelyAudio(audioBytes)) {
      const error = `Invalid audio data (${audioBytes.length} bytes)`;
      await forceReleaseCapture();
      await setRecordingState({ isRecording: false, lastError: error });
      return { error, durationMs, meetingTitle, startedAt };
    }

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
      await chrome.tabs
        .sendMessage(tabId, { type: "HIDE_CONSENT_BANNER" })
        .catch(() => {});
    }

    await closeOffscreenDocument();

    return finalizeRecordingBytes(audioBytes, {
      mimeType: response.mimeType ?? "audio/webm",
      meetingTitle,
      startedAt,
      durationMs,
      autoStoppedReason: opts?.reason,
      transcribe: opts?.transcribe !== false,
    });
  } finally {
    isFinalizingRecording = false;
  }
}

async function finalizeRecordingBytes(
  audioBytes: Uint8Array,
  params: {
    mimeType: string;
    meetingTitle?: string;
    startedAt: number;
    durationMs: number;
    autoStoppedReason?: "tab_closed" | "capture_ended";
    transcribe?: boolean;
  },
): Promise<FinalizeResult> {
  const {
    meetingTitle,
    startedAt,
    durationMs,
    mimeType,
    autoStoppedReason,
    transcribe = true,
  } = params;
  const titleSuffix =
    autoStoppedReason === "tab_closed"
      ? " (tab closed)"
      : autoStoppedReason === "capture_ended"
        ? " (capture ended)"
        : "";
  const displayTitle = meetingTitle
    ? `${meetingTitle}${titleSuffix}`
    : `Recording${titleSuffix}`;

  const localAudioId = crypto.randomUUID();
  await savePendingAudio(localAudioId, audioBytes, {
    mimeType,
    meetingTitle: displayTitle,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
  });

  if (!transcribe) {
    const entry: StoredRecording = {
      id: localAudioId,
      meetingTitle: displayTitle,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      status: "saved",
      createdAt: new Date().toISOString(),
      localAudioId,
    };
    await addToHistory(entry);

    return {
      localAudioId,
      savedLocally: true,
      durationMs,
      meetingTitle: displayTitle,
      startedAt,
    };
  }

  try {
    const upload = await uploadRecording({
      bytes: audioBytes,
      mimeType,
      meetingTitle: displayTitle,
      startedAt,
      durationMs,
    });

    await deletePendingAudio(localAudioId);

    const entry: StoredRecording = {
      id: upload.id,
      meetingTitle: displayTitle,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      status: "processing",
      createdAt: new Date().toISOString(),
    };
    await addToHistory(entry);
    void trackTranscription(upload.id);

    return {
      recordingId: upload.id,
      durationMs,
      meetingTitle: displayTitle,
      startedAt,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const entry: StoredRecording = {
      id: localAudioId,
      meetingTitle: displayTitle,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      status: "upload_failed",
      error,
      createdAt: new Date().toISOString(),
      localAudioId,
    };
    await addToHistory(entry);

    return {
      localAudioId,
      uploadFailed: true,
      error,
      durationMs,
      meetingTitle: displayTitle,
      startedAt,
    };
  }
}

async function handleRetryUpload(
  message: { localAudioId?: string },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  const localAudioId = message.localAudioId;
  if (!localAudioId) {
    sendResponse({ type: "RECORDING_ERROR", error: "Missing local recording id" });
    return;
  }

  const pending = await loadPendingAudio(localAudioId);
  if (!pending) {
    sendResponse({
      type: "RECORDING_ERROR",
      error: "Local recording not found — it may have been cleared after a successful upload",
    });
    return;
  }

  try {
    const upload = await uploadRecording({
      bytes: pending.bytes,
      mimeType: pending.meta.mimeType,
      meetingTitle: pending.meta.meetingTitle,
      startedAt: new Date(pending.meta.startedAt).getTime(),
      durationMs: pending.meta.durationMs,
    });

    await deletePendingAudio(localAudioId);

    const entry: StoredRecording = {
      id: upload.id,
      meetingTitle: pending.meta.meetingTitle,
      startedAt: pending.meta.startedAt,
      durationMs: pending.meta.durationMs,
      status: "processing",
      createdAt: new Date().toISOString(),
    };
    await replaceHistoryEntry(localAudioId, entry);
    void trackTranscription(upload.id);

    sendResponse({
      type: "RECORDING_STOPPED",
      recordingId: upload.id,
      uploadFailed: false,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await updateHistoryEntry(localAudioId, { status: "upload_failed", error });
    sendResponse({ type: "RECORDING_ERROR", error });
  }
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
  if (!(await isOffscreenDocumentOpen())) {
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

async function isOffscreenDocumentOpen(): Promise<boolean> {
  if (typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }

  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return existing.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await isOffscreenDocumentOpen()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record tab audio for transcription",
  });

  await sleep(200);
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    if (!(await isOffscreenDocumentOpen())) {
      return;
    }
    await chrome.offscreen.closeDocument();
  } catch {
    // Another stop path or extension reload may have already closed the document.
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
    void stopRecordingAndFinalize({ reason: "tab_closed" }).catch(() => {});
  }
});

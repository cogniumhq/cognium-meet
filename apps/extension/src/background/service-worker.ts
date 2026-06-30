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
const activeTranscriptionPolls = new Set<string>();

interface OffscreenStopResponse {
  type: string;
  localAudioId?: string;
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

    if (message.type === "TRACK_TRANSCRIPTION") {
      const id = (message as { recordingId?: string }).recordingId;
      if (!id) {
        sendResponse({ ok: false, error: "Missing recording id" });
        return;
      }
      void trackTranscription(id);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TAB_CAPTURE_ENDED") {
      void stopRecordingAndFinalize({ reason: "capture_ended" }).catch((err) => {
        console.error("[recording] capture ended finalize failed", err);
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CAPTURE_ENDED_WITH_AUDIO") {
      void handleCaptureEndedWithAudio(
        message as {
          audioBase64?: string;
          mimeType?: string;
          byteLength?: number;
          reason?: "tab_closed" | "capture_ended";
        },
      );
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CAPTURE_ENDED_WITH_LOCAL_AUDIO") {
      void handleCaptureEndedWithLocalAudio(
        message as {
          localAudioId?: string;
          mimeType?: string;
          byteLength?: number;
          reason?: "tab_closed" | "capture_ended";
        },
      );
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "LIST_MIC_DEVICES") {
      await handleListMicDevices(sendResponse);
      return;
    }

    if (message.type === "REQUEST_MIC_ACCESS") {
      await handleRequestMicAccess(
        message as { deviceId?: string },
        sendResponse,
      );
      return;
    }

    sendResponse({ type: "RECORDING_ERROR", error: "Unknown message" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setRecordingState({ ...recordingState, isRecording: false, lastError: error });
    sendResponse({ type: "RECORDING_ERROR", error });
  }
}

async function handleListMicDevices(
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    await ensureOffscreenDocument();
    const response = await sendToOffscreen<{
      type: string;
      devices?: { deviceId: string; label: string }[];
    }>({ type: "OFFSCREEN_LIST_DEVICES" });
    sendResponse({ devices: response.devices ?? [] });
  } catch (err) {
    sendResponse({
      error: err instanceof Error ? err.message : String(err),
      devices: [],
    });
  }
}

async function handleRequestMicAccess(
  message: { deviceId?: string },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    await ensureOffscreenDocument();
    const response = await sendToOffscreen<{
      type: string;
      ok?: boolean;
      error?: string;
      label?: string;
    }>({
      type: "OFFSCREEN_REQUEST_MIC",
      micDeviceId: message.deviceId,
    });
    sendResponse({
      ok: response.ok ?? response.type === "MIC_ACCESS_GRANTED",
      error: response.error,
      label: response.label,
    });
  } catch (err) {
    sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
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
    const startedAt = Date.now();
    const startResult = await sendToOffscreen<{
      type: string;
      error?: string;
      includedMic?: boolean;
      micLabel?: string;
    }>({
      type: "OFFSCREEN_START",
      streamId,
      micDeviceId,
      captureMode: settings.captureMode ?? "mixed",
      meetingTitle: message.meetingTitle ?? recordingTitle,
      startedAt,
    });

    if (startResult.type === "RECORDING_ERROR") {
      throw new Error(startResult.error ?? "Failed to start offscreen recorder");
    }

    await setRecordingState({
      isRecording: true,
      tabId,
      startedAt,
      meetingTitle: message.meetingTitle ?? recordingTitle,
      includedMic: startResult.includedMic ?? false,
      micLabel: startResult.micLabel,
      lastError: undefined,
    });

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

async function handleCaptureEndedWithAudio(message: {
  audioBase64?: string;
  mimeType?: string;
  byteLength?: number;
  reason?: "tab_closed" | "capture_ended";
}): Promise<void> {
  if (!message.audioBase64) {
    await stopRecordingAndFinalize({ reason: message.reason ?? "capture_ended" });
    return;
  }

  const stored = await loadRecordingState();
  recordingState = stored;

  await stopRecordingAndFinalize({
    reason: message.reason ?? "capture_ended",
    capturedAudio: {
      audioBase64: message.audioBase64,
      mimeType: message.mimeType,
      byteLength: message.byteLength,
    },
    meetingTitle: stored.meetingTitle,
    startedAt: stored.startedAt,
    tabId: stored.tabId,
    force: !stored.isRecording,
  });
}

async function handleCaptureEndedWithLocalAudio(message: {
  localAudioId?: string;
  mimeType?: string;
  byteLength?: number;
  reason?: "tab_closed" | "capture_ended";
}): Promise<void> {
  if (!message.localAudioId) {
    await stopRecordingAndFinalize({ reason: message.reason ?? "capture_ended" });
    return;
  }

  if (isFinalizingRecording) {
    return;
  }
  isFinalizingRecording = true;

  try {
    const stored = await loadRecordingState();
    recordingState = stored;

    if (!stored.isRecording) {
      return;
    }

    const startedAt = stored.startedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    const meetingTitle = stored.meetingTitle;

    const pending = await loadPendingAudio(message.localAudioId);
    if (!pending) {
      console.error("[recording] local audio missing after tab close", message.localAudioId);
      return;
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

    await closeOffscreenDocument();

    await finalizeRecordingBytes(pending.bytes, {
      mimeType: pending.meta.mimeType ?? message.mimeType ?? "audio/webm",
      micBytes: pending.micBytes,
      micMimeType: pending.meta.micMimeType,
      meetingTitle: meetingTitle ?? pending.meta.meetingTitle,
      startedAt,
      durationMs,
      autoStoppedReason: message.reason ?? "tab_closed",
      transcribe: true,
      existingLocalAudioId: message.localAudioId,
    });
  } finally {
    isFinalizingRecording = false;
  }
}

async function handleStopRecording(
  sendResponse: (response: unknown) => void,
  transcribe = true,
): Promise<void> {
  const result = await stopRecordingAndFinalize({ transcribe });
  if (!result) {
    const still = await loadRecordingState();
    sendResponse({
      type: "RECORDING_ERROR",
      error: still.isRecording
        ? "Stop in progress or timed out — wait a moment and try again"
        : "Not recording",
    });
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
  force?: boolean;
  meetingTitle?: string;
  startedAt?: number;
  tabId?: number;
  capturedAudio?: {
    audioBase64: string;
    mimeType?: string;
    byteLength?: number;
  };
}): Promise<FinalizeResult | null> {
  if (isFinalizingRecording) {
    return null;
  }
  isFinalizingRecording = true;

  try {
    const status = await loadRecordingState();
    if (!status.isRecording && !opts?.force && !opts?.capturedAudio) {
      return null;
    }
    recordingState = status;

    const startedAt = opts?.startedAt ?? status.startedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    const meetingTitle = opts?.meetingTitle ?? status.meetingTitle;

    let response: OffscreenStopResponse;
    if (opts?.capturedAudio) {
      response = {
        type: "RECORDING_STOPPED",
        audioBase64: opts.capturedAudio.audioBase64,
        mimeType: opts.capturedAudio.mimeType,
        byteLength: opts.capturedAudio.byteLength,
      };
    } else {
      try {
        response = await sendToOffscreen<OffscreenStopResponse>(
          { type: "OFFSCREEN_STOP" },
          { timeoutMs: 15 * 60 * 1000, intervalMs: 500 },
        );
      } catch {
        // Offscreen may still be assembling a long recording — wait before retry.
        await sleep(5000);
        const afterFlush = await loadRecordingState();
        if (!afterFlush.isRecording) {
          return null;
        }
        try {
          response = await sendToOffscreen<OffscreenStopResponse>(
            { type: "OFFSCREEN_STOP" },
            { timeoutMs: 15 * 60 * 1000, intervalMs: 500 },
          );
        } catch (err) {
          console.error("[recording] stop timed out", err);
          return null;
        }
      }
    }

    if (response.type === "RECORDING_ERROR") {
      const error = response.error ?? "Failed to stop recording";
      await setRecordingState({ isRecording: true, lastError: error });
      return { error, durationMs, meetingTitle, startedAt };
    }

    if (response.localAudioId) {
      const pending = await loadPendingAudio(response.localAudioId);
      if (!pending) {
        const error = "Recording saved in offscreen but missing from local storage";
        await setRecordingState({ isRecording: true, lastError: error });
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

      await closeOffscreenDocument();

      return finalizeRecordingBytes(pending.bytes, {
        mimeType: pending.meta.mimeType ?? response.mimeType ?? "audio/webm",
        micBytes: pending.micBytes,
        micMimeType: pending.meta.micMimeType,
        meetingTitle,
        startedAt,
        durationMs,
        autoStoppedReason: opts?.reason,
        transcribe: opts?.transcribe !== false,
        existingLocalAudioId: response.localAudioId,
      });
    }

    if (!response.audioBase64) {
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
    micBytes?: Uint8Array;
    micMimeType?: string;
    meetingTitle?: string;
    startedAt: number;
    durationMs: number;
    autoStoppedReason?: "tab_closed" | "capture_ended";
    transcribe?: boolean;
    existingLocalAudioId?: string;
  },
): Promise<FinalizeResult> {
  const {
    meetingTitle,
    startedAt,
    durationMs,
    mimeType,
    micBytes,
    micMimeType,
    autoStoppedReason,
    transcribe = true,
    existingLocalAudioId,
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

  const localAudioId = existingLocalAudioId ?? crypto.randomUUID();
  if (!existingLocalAudioId) {
    await savePendingAudio(localAudioId, audioBytes, {
      mimeType,
      meetingTitle: displayTitle,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      micBytes,
      micMimeType,
    });
  }

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
      micBytes,
      micMimeType,
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
      micBytes: pending.micBytes,
      micMimeType: pending.meta.micMimeType,
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

  if (stored.isRecording && !offscreen.isRecording) {
    if (isFinalizingRecording) {
      recordingState = stored;
      return stored;
    }
    if (await isOffscreenDocumentOpen()) {
      try {
        await sendToOffscreen({ type: "OFFSCREEN_FLUSH", reason: "capture_ended" });
      } catch {
        void stopRecordingAndFinalize({ reason: "capture_ended" }).catch((err) => {
          console.error("[recording] reconcile finalize failed", err);
        });
      }
    }
    recordingState = stored;
    return stored;
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

async function sendToOffscreen<T>(
  message: {
    type: string;
    streamId?: string;
    micDeviceId?: string;
    meetingTitle?: string;
    startedAt?: number;
    micDeviceId?: string;
    captureMode?: string;
    reason?: "tab_closed" | "capture_ended";
  },
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const payload = { ...message, target: OFFSCREEN_TARGET };
  const intervalMs = opts?.intervalMs ?? 100;
  const maxAttempts = Math.ceil((opts?.timeoutMs ?? 2000) / intervalMs);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (response !== undefined) {
        return response as T;
      }
    } catch {
      // Offscreen document may still be loading or busy finalizing audio.
    }
    await sleep(intervalMs);
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
  if (activeTranscriptionPolls.has(id)) {
    return;
  }
  activeTranscriptionPolls.add(id);
  try {
    const meta = await pollRecording(id, {
      intervalMs: 3000,
      timeoutMs: 90 * 60 * 1000,
      onUpdate: (update) => {
        void updateHistoryEntry(id, {
          status: update.status,
          error: update.error,
          progress: update.progress,
        });
      },
    });
    await updateHistoryEntry(id, {
      status: meta.status,
      error: meta.error,
      progress: undefined,
    });
  } catch (err) {
    await updateHistoryEntry(id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      progress: undefined,
    });
  } finally {
    activeTranscriptionPolls.delete(id);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const stored = await loadRecordingState();
    recordingState = stored;
    if (!stored.isRecording || stored.tabId !== tabId) {
      return;
    }

    // Ask offscreen to flush — do not race OFFSCREEN_STOP against track-ended flush.
    try {
      await sendToOffscreen({ type: "OFFSCREEN_FLUSH", reason: "tab_closed" });
    } catch {
      // offscreen may already be flushing after capture track ended
    }

    await sleep(4000);
    const still = await loadRecordingState();
    if (still.isRecording && !isFinalizingRecording) {
      await stopRecordingAndFinalize({ reason: "tab_closed" }).catch((err) => {
        console.error("[recording] tab close finalize failed", err);
      });
    }
  })();
});

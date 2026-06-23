import { OFFSCREEN_TARGET } from "../lib/messages.js";
import {
  isLikelyAudio,
  normalizeAudioBytes,
} from "../lib/audio-bytes.js";
import { uploadRecording } from "../lib/upload.js";

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

export {};

let recordingState = {
  isRecording: false,
  tabId: undefined as number | undefined,
  startedAt: undefined as number | undefined,
  meetingTitle: undefined as string | undefined,
  lastError: undefined as string | undefined,
};

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
      sendResponse({ ...recordingState });
      return;
    }

    if (message.type === "START_RECORDING") {
      const tabId = message.tabId;
      if (!tabId) {
        sendResponse({ type: "RECORDING_ERROR", error: "No active tab" });
        return;
      }

      if (recordingState.isRecording) {
        sendResponse({ type: "RECORDING_ERROR", error: "Already recording" });
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

      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(id);
        });
      });

      await ensureOffscreenDocument();
      const startResult = await sendToOffscreen<{
        type: string;
        error?: string;
        includedMic?: boolean;
      }>({
        type: "OFFSCREEN_START",
        streamId,
      });

      if (startResult.type === "RECORDING_ERROR") {
        throw new Error(startResult.error ?? "Failed to start offscreen recorder");
      }

      recordingState = {
        isRecording: true,
        tabId,
        startedAt: Date.now(),
        meetingTitle: message.meetingTitle ?? tab.title ?? "Google Meet",
        lastError: undefined,
      };

      await chrome.tabs.sendMessage(tabId, { type: "SHOW_CONSENT_BANNER" }).catch(() => {});
      sendResponse({
        type: "RECORDING_STARTED",
        startedAt: recordingState.startedAt,
        meetingTitle: recordingState.meetingTitle,
        includedMic: startResult.includedMic ?? false,
      });
      return;
    }

    if (message.type === "STOP_RECORDING") {
      if (!recordingState.isRecording) {
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
        recordingState.lastError = error;
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

      const startedAt = recordingState.startedAt ?? Date.now();
      const durationMs = Date.now() - startedAt;
      const meetingTitle = recordingState.meetingTitle;
      const tabId = recordingState.tabId;

      recordingState = {
        isRecording: false,
        tabId: undefined,
        startedAt: undefined,
        meetingTitle: undefined,
        lastError: undefined,
      };

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

      sendResponse({
        type: "RECORDING_STOPPED",
        recordingId: upload.id,
        durationMs,
        meetingTitle,
        startedAt,
      });
      return;
    }

    sendResponse({ type: "RECORDING_ERROR", error: "Unknown message" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordingState.lastError = error;
    recordingState.isRecording = false;
    sendResponse({ type: "RECORDING_ERROR", error });
  }
}

async function sendToOffscreen<T>(message: {
  type: string;
  streamId?: string;
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordingState.isRecording && recordingState.tabId === tabId) {
    recordingState = {
      isRecording: false,
      tabId: undefined,
      startedAt: undefined,
      meetingTitle: undefined,
      lastError: "Meeting tab was closed",
    };
    void closeOffscreenDocument();
  }
});

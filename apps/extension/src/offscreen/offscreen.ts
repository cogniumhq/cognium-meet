import { blobToBytes, bytesToBase64 } from "../lib/audio-bytes.js";
import { listAudioInputDevices, micTrackLabel, openMicStream } from "../lib/audio-devices.js";
import { isOffscreenMessage } from "../lib/messages.js";
import { savePendingAudio } from "../lib/pending-audio-store.js";

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let includedMic = false;
let micLabel: string | undefined;
let isRecording = false;
let captureFlushPromise: Promise<void> | null = null;
let activeStopPromise: Promise<Blob> | null = null;
let lastStoppedBlob: Blob | null = null;
let recordingMeta: { meetingTitle?: string; startedAt: number } | null = null;

async function flushRecordingOnCaptureEnd(
  reason: "tab_closed" | "capture_ended" = "capture_ended",
): Promise<void> {
  if (captureFlushPromise) {
    return captureFlushPromise;
  }
  if (!isRecording && !lastStoppedBlob) {
    return;
  }

  captureFlushPromise = doFlushRecordingOnCaptureEnd(reason);
  try {
    await captureFlushPromise;
  } finally {
    captureFlushPromise = null;
  }
}

async function doFlushRecordingOnCaptureEnd(
  reason: "tab_closed" | "capture_ended",
): Promise<void> {
  try {
    const blob = await stopRecording();
    const audioBytes = await blobToBytes(blob);
    const mimeType = blob.type || "audio/webm";
    const startedAt = recordingMeta?.startedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    const meetingTitle = recordingMeta?.meetingTitle;

    const localAudioId = crypto.randomUUID();
    await savePendingAudio(localAudioId, audioBytes, {
      mimeType,
      meetingTitle,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
    });

    await chrome.runtime.sendMessage({
      type: "CAPTURE_ENDED_WITH_LOCAL_AUDIO",
      reason,
      localAudioId,
      mimeType,
      byteLength: audioBytes.length,
    });
  } catch (err) {
    await chrome.runtime.sendMessage({
      type: "TAB_CAPTURE_ENDED",
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export {};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenMessage(message)) {
    return false;
  }

  void handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(
  message: {
    type: string;
    streamId?: string;
    micDeviceId?: string;
    meetingTitle?: string;
    startedAt?: number;
    reason?: "tab_closed" | "capture_ended";
  },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    if (message.type === "OFFSCREEN_STATUS") {
      sendResponse({ type: "OFFSCREEN_STATUS", isRecording, includedMic, micLabel });
      return;
    }

    if (message.type === "OFFSCREEN_ABORT") {
      abortRecording();
      sendResponse({ type: "OFFSCREEN_ABORTED" });
      return;
    }

    if (message.type === "OFFSCREEN_LIST_DEVICES") {
      const devices = await listAudioInputDevices();
      sendResponse({ type: "OFFSCREEN_DEVICES", devices });
      return;
    }

    if (message.type === "OFFSCREEN_FLUSH") {
      void flushRecordingOnCaptureEnd(message.reason ?? "tab_closed");
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "OFFSCREEN_START") {
      await startRecording(
        message.streamId!,
        message.micDeviceId,
        message.meetingTitle,
        message.startedAt,
      );
      sendResponse({ type: "OFFSCREEN_READY", includedMic, micLabel });
      return;
    }

    if (message.type === "OFFSCREEN_STOP") {
      const blob = await stopRecording();
      const audioBytes = await blobToBytes(blob);
      sendResponse({
        type: "RECORDING_STOPPED",
        audioBase64: bytesToBase64(audioBytes),
        mimeType: blob.type || "audio/webm",
        byteLength: audioBytes.length,
      });
      return;
    }

    sendResponse({ type: "RECORDING_ERROR", error: "Unknown offscreen message" });
  } catch (err) {
    sendResponse({
      type: "RECORDING_ERROR",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function startRecording(
  streamId: string,
  micDeviceId?: string,
  meetingTitle?: string,
  startedAt?: number,
): Promise<void> {
  if (isRecording) {
    return;
  }

  abortRecording();
  captureFlushPromise = null;
  recordingMeta = {
    meetingTitle,
    startedAt: startedAt ?? Date.now(),
  };

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: false,
  });

  includedMic = false;
  micLabel = undefined;
  micStream = null;

  const wantsMic = Boolean(micDeviceId);
  try {
    micStream = await openMicStream(micDeviceId || undefined);
    includedMic = true;
    micLabel = micTrackLabel(micStream);
  } catch (err) {
    if (wantsMic) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not open the selected microphone. Pick another device in Settings. (${detail})`,
      );
    }
    micStream = null;
  }

  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  tabSource.connect(audioContext.destination);

  for (const track of tabStream.getAudioTracks()) {
    track.addEventListener(
      "ended",
      () => {
        void flushRecordingOnCaptureEnd("tab_closed");
      },
      { once: true },
    );
  }

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  const mixedStream = destination.stream;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  chunks = [];
  lastStoppedBlob = null;
  mediaRecorder = new MediaRecorder(mixedStream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.start(1000);
  isRecording = true;
}

async function stopRecording(): Promise<Blob> {
  if (lastStoppedBlob) {
    return lastStoppedBlob;
  }

  if (activeStopPromise) {
    return activeStopPromise;
  }

  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("No active recording");
  }

  activeStopPromise = doStopRecording();
  try {
    return await activeStopPromise;
  } finally {
    activeStopPromise = null;
  }
}

async function doStopRecording(): Promise<Blob> {
  const recorder = mediaRecorder!;

  if (recorder.state === "recording") {
    recorder.requestData();
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const result = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      resolve(result);
    };
    recorder.onerror = () => reject(new Error("MediaRecorder error"));
    recorder.stop();
  });

  cleanupStreams();
  mediaRecorder = null;
  chunks = [];
  isRecording = false;

  if (blob.size === 0) {
    lastStoppedBlob = null;
    throw new Error("Recording is empty");
  }

  lastStoppedBlob = blob;
  return blob;
}

function abortRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  mediaRecorder = null;
  chunks = [];
  lastStoppedBlob = null;
  activeStopPromise = null;
  captureFlushPromise = null;
  recordingMeta = null;
  cleanupStreams();
  isRecording = false;
}

function cleanupStreams(): void {
  tabStream?.getTracks().forEach((track) => track.stop());
  micStream?.getTracks().forEach((track) => track.stop());
  tabStream = null;
  micStream = null;
  micLabel = undefined;
  if (audioContext && audioContext.state !== "closed") {
    void audioContext.close();
  }
  audioContext = null;
}

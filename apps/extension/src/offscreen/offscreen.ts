import { blobToBytes } from "../lib/audio-bytes.js";
import { listAudioInputDevices, micTrackLabel, openMicStream } from "../lib/audio-devices.js";
import { isOffscreenMessage } from "../lib/messages.js";
import { savePendingAudio } from "../lib/pending-audio-store.js";

interface DualTrackBlobs {
  tab: Blob;
  mic?: Blob;
}

interface TrackRecorder {
  recorder: MediaRecorder;
  chunks: Blob[];
}

let tabRecorder: TrackRecorder | null = null;
let micRecorder: TrackRecorder | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let includedMic = false;
let micLabel: string | undefined;
let isRecording = false;
let captureFlushPromise: Promise<void> | null = null;
let activeStopPromise: Promise<DualTrackBlobs> | null = null;
let lastStoppedBlobs: DualTrackBlobs | null = null;
let recordingMeta: { meetingTitle?: string; startedAt: number } | null = null;

const PREFERRED_MIME = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  ? "audio/webm;codecs=opus"
  : "audio/webm";

async function flushRecordingOnCaptureEnd(
  reason: "tab_closed" | "capture_ended" = "capture_ended",
): Promise<void> {
  if (captureFlushPromise) {
    return captureFlushPromise;
  }
  if (!isRecording && !lastStoppedBlobs) {
    return;
  }

  captureFlushPromise = doFlushRecordingOnCaptureEnd(reason);
  try {
    await captureFlushPromise;
  } finally {
    captureFlushPromise = null;
  }
}

async function saveStoppedRecordingToLocal(): Promise<{
  localAudioId: string;
  mimeType: string;
  byteLength: number;
  hasMicTrack: boolean;
}> {
  const blobs = await stopRecording();
  const tabBytes = await blobToBytes(blobs.tab);
  const mimeType = blobs.tab.type || "audio/webm";
  const startedAt = recordingMeta?.startedAt ?? Date.now();
  const durationMs = Date.now() - startedAt;
  const meetingTitle = recordingMeta?.meetingTitle;

  let micBytes: Uint8Array | undefined;
  if (blobs.mic && blobs.mic.size > 0) {
    micBytes = await blobToBytes(blobs.mic);
  }

  const localAudioId = crypto.randomUUID();
  await savePendingAudio(localAudioId, tabBytes, {
    mimeType,
    meetingTitle,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    micBytes,
    micMimeType: blobs.mic?.type || mimeType,
  });

  return {
    localAudioId,
    mimeType,
    byteLength: tabBytes.length,
    hasMicTrack: Boolean(micBytes?.length),
  };
}

async function doFlushRecordingOnCaptureEnd(
  reason: "tab_closed" | "capture_ended",
): Promise<void> {
  try {
    const saved = await saveStoppedRecordingToLocal();
    await chrome.runtime.sendMessage({
      type: "CAPTURE_ENDED_WITH_LOCAL_AUDIO",
      reason,
      localAudioId: saved.localAudioId,
      mimeType: saved.mimeType,
      byteLength: saved.byteLength,
      hasMicTrack: saved.hasMicTrack,
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
      const saved = await saveStoppedRecordingToLocal();
      sendResponse({
        type: "RECORDING_STOPPED",
        localAudioId: saved.localAudioId,
        mimeType: saved.mimeType,
        byteLength: saved.byteLength,
        hasMicTrack: saved.hasMicTrack,
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
  micRecorder = null;

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
  const tabSource = audioContext.createMediaStreamSource(tabStream);
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

  lastStoppedBlobs = null;
  tabRecorder = createTrackRecorder(tabStream);

  if (micStream) {
    micRecorder = createTrackRecorder(micStream);
  }

  isRecording = true;
}

function createTrackRecorder(stream: MediaStream): TrackRecorder {
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: PREFERRED_MIME });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.start(1000);
  return { recorder, chunks };
}

async function stopRecording(): Promise<DualTrackBlobs> {
  if (lastStoppedBlobs) {
    return lastStoppedBlobs;
  }

  if (activeStopPromise) {
    return activeStopPromise;
  }

  if (!tabRecorder || tabRecorder.recorder.state === "inactive") {
    throw new Error("No active recording");
  }

  activeStopPromise = doStopRecording();
  try {
    return await activeStopPromise;
  } finally {
    activeStopPromise = null;
  }
}

async function stopTrackRecorder(track: TrackRecorder): Promise<Blob | undefined> {
  const { recorder, chunks } = track;
  if (recorder.state === "inactive") {
    return undefined;
  }

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

  return blob.size > 0 ? blob : undefined;
}

async function doStopRecording(): Promise<DualTrackBlobs> {
  const tabBlob = await stopTrackRecorder(tabRecorder!);
  const micBlob = micRecorder ? await stopTrackRecorder(micRecorder) : undefined;

  cleanupStreams();
  tabRecorder = null;
  micRecorder = null;
  isRecording = false;

  if (!tabBlob) {
    lastStoppedBlobs = null;
    throw new Error("Recording is empty");
  }

  lastStoppedBlobs = { tab: tabBlob, mic: micBlob };
  return lastStoppedBlobs;
}

function abortRecording(): void {
  for (const track of [tabRecorder, micRecorder]) {
    if (track && track.recorder.state !== "inactive") {
      try {
        track.recorder.stop();
      } catch {
        // ignore
      }
    }
  }
  tabRecorder = null;
  micRecorder = null;
  lastStoppedBlobs = null;
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

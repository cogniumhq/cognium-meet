import { blobToBytes } from "../lib/audio-bytes.js";
import { listAudioInputDevices, micTrackLabel, openMicStream } from "../lib/audio-devices.js";
import type { AudioCaptureMode } from "@cognium/meet-shared";
import { isOffscreenMessage } from "../lib/messages.js";
import { loadPendingAudio, savePendingAudio } from "../lib/pending-audio-store.js";

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
let mixedRecorder: TrackRecorder | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let captureMode: AudioCaptureMode = "mixed";
let includedMic = false;
let micLabel: string | undefined;
let isRecording = false;
let captureFlushPromise: Promise<void> | null = null;
let activeStopPromise: Promise<Blob | DualTrackBlobs> | null = null;
let lastStoppedBlob: Blob | null = null;
let lastStoppedBlobs: DualTrackBlobs | null = null;
/** Reused if stop and tab-close flush race. */
let savedLocalAudioId: string | null = null;
/** Suppress tab-ended flush while OFFSCREEN_STOP is handling stop. */
let offscreenStopInProgress = false;
let recordingMeta: { meetingTitle?: string; startedAt: number } | null = null;

const PREFERRED_MIME = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  ? "audio/webm;codecs=opus"
  : "audio/webm";

async function flushRecordingOnCaptureEnd(
  reason: "tab_closed" | "capture_ended" = "capture_ended",
): Promise<void> {
  if (offscreenStopInProgress) {
    return;
  }
  if (captureFlushPromise) {
    return captureFlushPromise;
  }
  if (!isRecording && !lastStoppedBlob && !lastStoppedBlobs) {
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
  if (savedLocalAudioId) {
    const existing = await loadPendingAudio(savedLocalAudioId);
    if (existing) {
      return {
        localAudioId: savedLocalAudioId,
        mimeType: existing.meta.mimeType,
        byteLength: existing.meta.byteLength,
        hasMicTrack: Boolean(existing.meta.micByteLength),
      };
    }
    savedLocalAudioId = null;
  }

  const startedAt = recordingMeta?.startedAt ?? Date.now();
  const durationMs = Date.now() - startedAt;
  const meetingTitle = recordingMeta?.meetingTitle;

  if (captureMode === "dual-track") {
    const blobs = (await stopRecording()) as DualTrackBlobs;
    const tabBytes = await blobToBytes(blobs.tab);
    const mimeType = blobs.tab.type || "audio/webm";

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
    savedLocalAudioId = localAudioId;

    return {
      localAudioId,
      mimeType,
      byteLength: tabBytes.length,
      hasMicTrack: Boolean(micBytes?.length),
    };
  }

  const blob = (await stopRecording()) as Blob;
  const bytes = await blobToBytes(blob);
  const mimeType = blob.type || "audio/webm";
  const localAudioId = crypto.randomUUID();
  await savePendingAudio(localAudioId, bytes, {
    mimeType,
    meetingTitle,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
  });
  savedLocalAudioId = localAudioId;

  return {
    localAudioId,
    mimeType,
    byteLength: bytes.length,
    hasMicTrack: false,
  };
}

async function doFlushRecordingOnCaptureEnd(
  reason: "tab_closed" | "capture_ended",
): Promise<void> {
  if (offscreenStopInProgress) {
    return;
  }
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
    captureMode?: AudioCaptureMode;
    meetingTitle?: string;
    startedAt?: number;
    reason?: "tab_closed" | "capture_ended";
  },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    if (message.type === "OFFSCREEN_STATUS") {
      sendResponse({
        type: "OFFSCREEN_STATUS",
        isRecording,
        includedMic,
        micLabel,
        captureMode,
      });
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

    if (message.type === "OFFSCREEN_REQUEST_MIC") {
      try {
        const stream = await openMicStream(message.micDeviceId);
        const label = micTrackLabel(stream);
        stream.getTracks().forEach((track) => track.stop());
        sendResponse({ type: "MIC_ACCESS_GRANTED", ok: true, label });
      } catch (err) {
        sendResponse({
          type: "MIC_ACCESS_DENIED",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
        message.captureMode ?? "mixed",
        message.meetingTitle,
        message.startedAt,
      );
      sendResponse({ type: "OFFSCREEN_READY", includedMic, micLabel, captureMode });
      return;
    }

    if (message.type === "OFFSCREEN_STOP") {
      offscreenStopInProgress = true;
      try {
        const saved = await saveStoppedRecordingToLocal();
        sendResponse({
          type: "RECORDING_STOPPED",
          localAudioId: saved.localAudioId,
          mimeType: saved.mimeType,
          byteLength: saved.byteLength,
          hasMicTrack: saved.hasMicTrack,
        });
      } finally {
        offscreenStopInProgress = false;
      }
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
  micDeviceId: string | undefined,
  mode: AudioCaptureMode,
  meetingTitle?: string,
  startedAt?: number,
): Promise<void> {
  if (isRecording) {
    return;
  }

  abortRecording();
  captureFlushPromise = null;
  captureMode = mode;
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
  mixedRecorder = null;

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

  lastStoppedBlob = null;
  lastStoppedBlobs = null;
  savedLocalAudioId = null;

  if (captureMode === "dual-track") {
    tabRecorder = createTrackRecorder(tabStream);
    if (micStream) {
      micRecorder = createTrackRecorder(micStream);
    }
  } else {
    const mixDestination = audioContext.createMediaStreamDestination();
    tabSource.connect(mixDestination);
    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(mixDestination);
    }
    mixedRecorder = createTrackRecorder(mixDestination.stream);
    tabRecorder = null;
  }

  isRecording = true;
}

function createTrackRecorder(stream: MediaStream): TrackRecorder {
  const chunks: Blob[] = [];
  const mediaRecorder = new MediaRecorder(stream, { mimeType: PREFERRED_MIME });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  mediaRecorder.start(1000);
  return { recorder: mediaRecorder, chunks };
}

async function stopRecording(): Promise<Blob | DualTrackBlobs> {
  if (captureMode === "dual-track") {
    if (lastStoppedBlobs) {
      return lastStoppedBlobs;
    }
  } else if (lastStoppedBlob) {
    return lastStoppedBlob;
  }

  if (activeStopPromise) {
    return activeStopPromise;
  }

  const active =
    captureMode === "dual-track"
      ? tabRecorder && tabRecorder.recorder.state !== "inactive"
      : mixedRecorder && mixedRecorder.recorder.state !== "inactive";

  if (!active) {
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
  const { recorder: mediaRecorder, chunks } = track;
  if (mediaRecorder.state === "inactive") {
    return undefined;
  }

  if (mediaRecorder.state === "recording") {
    mediaRecorder.requestData();
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    mediaRecorder.onstop = () => {
      const result = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      resolve(result);
    };
    mediaRecorder.onerror = () => reject(new Error("MediaRecorder error"));
    mediaRecorder.stop();
  });

  return blob.size > 0 ? blob : undefined;
}

async function doStopRecording(): Promise<Blob | DualTrackBlobs> {
  if (captureMode === "dual-track") {
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

  const blob = await stopTrackRecorder(mixedRecorder!);

  cleanupStreams();
  mixedRecorder = null;
  isRecording = false;

  if (!blob) {
    lastStoppedBlob = null;
    throw new Error("Recording is empty");
  }

  lastStoppedBlob = blob;
  return lastStoppedBlob;
}

function abortRecording(): void {
  for (const track of [tabRecorder, micRecorder, mixedRecorder]) {
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
  mixedRecorder = null;
  lastStoppedBlob = null;
  lastStoppedBlobs = null;
  savedLocalAudioId = null;
  offscreenStopInProgress = false;
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

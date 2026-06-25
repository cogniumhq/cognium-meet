import { blobToBytes, bytesToBase64 } from "../lib/audio-bytes.js";
import { listAudioInputDevices, micTrackLabel, openMicStream } from "../lib/audio-devices.js";
import { isOffscreenMessage } from "../lib/messages.js";

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let includedMic = false;
let micLabel: string | undefined;
let isRecording = false;

export {};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenMessage(message)) {
    return false;
  }

  void handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(
  message: { type: string; streamId?: string; micDeviceId?: string },
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

    if (message.type === "OFFSCREEN_START") {
      await startRecording(message.streamId!, message.micDeviceId);
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

async function startRecording(streamId: string, micDeviceId?: string): Promise<void> {
  if (isRecording) {
    return;
  }

  abortRecording();

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

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  const mixedStream = destination.stream;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  chunks = [];
  mediaRecorder = new MediaRecorder(mixedStream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.start(5000);
  isRecording = true;
}

async function stopRecording(): Promise<Blob> {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("No active recording");
  }

  const recorder = mediaRecorder;

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
    throw new Error("Recording is empty");
  }

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

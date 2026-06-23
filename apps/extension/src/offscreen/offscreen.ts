import { blobToBytes, bytesToBase64 } from "../lib/audio-bytes.js";
import { isOffscreenMessage } from "../lib/messages.js";

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let includedMic = false;

export {};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenMessage(message)) {
    return false;
  }

  void handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(
  message: { type: string; streamId?: string },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    if (message.type === "OFFSCREEN_START") {
      await startRecording(message.streamId!);
      sendResponse({ type: "OFFSCREEN_READY", includedMic });
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

async function startRecording(streamId: string): Promise<void> {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await stopRecording().catch(() => {});
  }
  cleanupStreams();

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: false,
  });

  // Also capture the local microphone (the local speaker's own voice),
  // since Google Meet does not play your own mic back into the tab.
  // This is optional: if mic permission is not granted, we record tab audio only.
  includedMic = false;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    includedMic = true;
  } catch {
    micStream = null;
  }

  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  // Keep playing the meeting audio to the user's speakers; tab capture
  // would otherwise silence the tab for the user.
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

  if (blob.size === 0) {
    throw new Error("Recording is empty");
  }

  return blob;
}

function cleanupStreams(): void {
  tabStream?.getTracks().forEach((track) => track.stop());
  micStream?.getTracks().forEach((track) => track.stop());
  tabStream = null;
  micStream = null;
  if (audioContext && audioContext.state !== "closed") {
    void audioContext.close();
  }
  audioContext = null;
}

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stream: MediaStream | null = null;

export {};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      sendResponse({ type: "OFFSCREEN_READY" });
      return;
    }

    if (message.type === "OFFSCREEN_STOP") {
      const blob = await stopRecording();
      sendResponse({ type: "RECORDING_STOPPED", blob });
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
  await stopRecording().catch(() => {});

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: false,
  });

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType });

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
  const blob = await new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const result = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      resolve(result);
    };
    recorder.onerror = () => reject(new Error("MediaRecorder error"));
    recorder.stop();
  });

  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  mediaRecorder = null;
  chunks = [];

  if (blob.size === 0) {
    throw new Error("Recording is empty");
  }

  return blob;
}

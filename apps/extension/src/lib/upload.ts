import type { AudioCaptureMode, RecordingMeta } from "@cognium/meet-shared";
import {
  DEFAULT_AUDIO_CAPTURE_MODE,
  DEFAULT_TRANSCRIPTION_MODEL,
} from "@cognium/meet-shared";
import { isLikelyAudio } from "./audio-bytes.js";
import { getSettings } from "./storage.js";

export interface UploadResult {
  id: string;
  status: RecordingMeta["status"];
}

export async function uploadRecording(params: {
  bytes: Uint8Array;
  mimeType?: string;
  micBytes?: Uint8Array;
  micMimeType?: string;
  meetingTitle?: string;
  startedAt: number;
  durationMs: number;
}): Promise<UploadResult> {
  if (!isLikelyAudio(params.bytes)) {
    throw new Error(
      `Invalid audio data (${params.bytes.length} bytes) — reload the extension and try again`,
    );
  }

  const settings = await getSettings();
  const headers: Record<string, string> = {};
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const form = new FormData();
  form.append(
    "audio",
    new Blob([params.bytes], { type: params.mimeType ?? "audio/webm" }),
    "recording.webm",
  );
  if (params.micBytes && params.micBytes.length > 0 && isLikelyAudio(params.micBytes)) {
    form.append(
      "micAudio",
      new Blob([params.micBytes], { type: params.micMimeType ?? "audio/webm" }),
      "mic.webm",
    );
  }
  if (params.meetingTitle) {
    form.append("meetingTitle", params.meetingTitle);
  }
  form.append("startedAt", new Date(params.startedAt).toISOString());
  form.append("durationMs", String(params.durationMs));
  form.append(
    "transcriptionModel",
    settings.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL,
  );
  form.append(
    "captureMode",
    settings.captureMode ?? DEFAULT_AUDIO_CAPTURE_MODE,
  );

  const response = await fetch(`${settings.apiUrl}/v1/recordings`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  return (await response.json()) as UploadResult;
}

export async function fetchRecordingStatus(id: string): Promise<RecordingMeta> {
  const settings = await getSettings();
  const headers: Record<string, string> = {};
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const response = await fetch(`${settings.apiUrl}/v1/recordings/${id}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`Status check failed (${response.status})`);
  }
  return (await response.json()) as RecordingMeta;
}

export async function retryRecording(id: string): Promise<RecordingMeta> {
  const settings = await getSettings();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const response = await fetch(`${settings.apiUrl}/v1/recordings/${id}/retry`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      transcriptionModel: settings.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL,
      captureMode: settings.captureMode ?? DEFAULT_AUDIO_CAPTURE_MODE,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Retry failed (${response.status}): ${text}`);
  }
  return (await response.json()) as RecordingMeta;
}

export async function deleteServerRecording(id: string): Promise<void> {
  const settings = await getSettings();
  const headers: Record<string, string> = {};
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const response = await fetch(`${settings.apiUrl}/v1/recordings/${id}`, {
    method: "DELETE",
    headers,
  });
  if (response.status === 404) {
    return;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Delete failed (${response.status}): ${text}`);
  }
}

export async function pollRecording(
  id: string,
  opts?: {
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (meta: RecordingMeta) => void;
  },
): Promise<RecordingMeta> {
  const settings = await getSettings();
  const intervalMs = opts?.intervalMs ?? 2000;
  const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();

  const headers: Record<string, string> = {};
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  while (Date.now() - started < timeoutMs) {
    let meta: RecordingMeta | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${settings.apiUrl}/v1/recordings/${id}`, {
          headers,
        });
        if (!response.ok) {
          throw new Error(`Status check failed (${response.status})`);
        }
        meta = (await response.json()) as RecordingMeta;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          await sleep(Math.min(intervalMs, 1500) * attempt);
        }
      }
    }

    if (!meta) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    opts?.onUpdate?.(meta);
    if (meta.status === "completed" || meta.status === "failed") {
      return meta;
    }
    await sleep(intervalMs);
  }

  throw new Error("Transcription timed out");
}

export async function downloadTranscript(
  id: string,
  format: "txt" | "json",
): Promise<void> {
  const settings = await getSettings();
  const headers: Record<string, string> = {};
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const suffix = format === "txt" ? "transcript.txt" : "transcript.json";
  const response = await fetch(
    `${settings.apiUrl}/v1/recordings/${id}/${suffix}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}.${format === "txt" ? "txt" : "json"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

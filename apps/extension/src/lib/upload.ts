import type { RecordingMeta } from "@cognium/meet-shared";
import {
  bytesToBase64,
  isLikelyAudio,
  normalizeAudioBytes,
} from "./audio-bytes.js";
import { getSettings } from "./storage.js";

export interface UploadResult {
  id: string;
  status: RecordingMeta["status"];
}

export async function uploadRecording(params: {
  bytes: Uint8Array;
  mimeType?: string;
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const response = await fetch(`${settings.apiUrl}/v1/recordings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      audioBase64: bytesToBase64(params.bytes),
      mimeType: params.mimeType ?? "audio/webm",
      meetingTitle: params.meetingTitle,
      startedAt: new Date(params.startedAt).toISOString(),
      durationMs: params.durationMs,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  return (await response.json()) as UploadResult;
}

export async function pollRecording(
  id: string,
  opts?: { intervalMs?: number; timeoutMs?: number },
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
    const response = await fetch(`${settings.apiUrl}/v1/recordings/${id}`, {
      headers,
    });
    if (!response.ok) {
      throw new Error(`Status check failed (${response.status})`);
    }
    const meta = (await response.json()) as RecordingMeta;
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

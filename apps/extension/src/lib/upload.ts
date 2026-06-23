import type { RecordingMeta } from "@cognium/meet-shared";
import { getSettings } from "./storage.js";

export interface UploadResult {
  id: string;
  status: RecordingMeta["status"];
}

export async function uploadRecording(params: {
  blob: Blob;
  meetingTitle?: string;
  startedAt: number;
  durationMs: number;
}): Promise<UploadResult> {
  const settings = await getSettings();
  const form = new FormData();
  form.append("audio", params.blob, "recording.webm");
  if (params.meetingTitle) {
    form.append("meetingTitle", params.meetingTitle);
  }
  form.append("startedAt", new Date(params.startedAt).toISOString());
  form.append("durationMs", String(params.durationMs));

  const headers: Record<string, string> = {};
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }

  const response = await fetch(`${settings.apiUrl}/v1/recordings`, {
    method: "POST",
    headers,
    body: form,
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

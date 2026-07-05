import type { MeetingAskRequest, MeetingAskResponse, RecordingMeta, TranscriptResult } from "@cognium/meet-shared";
import {
  DEFAULT_AUDIO_CAPTURE_MODE,
  DEFAULT_TRANSCRIPTION_MODEL,
} from "@cognium/meet-shared";
import { buildApiHeaders, getApiUrl } from "./api-headers.js";
import { isLikelyAudio } from "./audio-bytes.js";
import {
  maxUploadBytesForSettings,
  meetingAskPayload,
  meetingSettingsFormFields,
} from "./client-config.js";
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
  const maxBytes = maxUploadBytesForSettings(settings);
  if (params.bytes.length > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(
      `Recording too large (${Math.round(params.bytes.length / (1024 * 1024))} MB). Max upload is ${maxMb} MB — increase it in Settings or record a shorter meeting.`,
    );
  }

  const headers = await buildApiHeaders();

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
  for (const [key, value] of Object.entries(meetingSettingsFormFields(settings))) {
    form.append(key, value);
  }

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
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();

  const response = await fetch(`${apiUrl}/v1/recordings/${id}`, { headers });
  if (!response.ok) {
    throw new Error(`Status check failed (${response.status})`);
  }
  return (await response.json()) as RecordingMeta;
}

export async function retryRecording(id: string): Promise<RecordingMeta> {
  const settings = await getSettings();
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders({ "Content-Type": "application/json" });

  const response = await fetch(`${apiUrl}/v1/recordings/${id}/retry`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      transcriptionModel: settings.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL,
      captureMode: settings.captureMode ?? DEFAULT_AUDIO_CAPTURE_MODE,
      ...meetingSettingsFormFields(settings),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Retry failed (${response.status}): ${text}`);
  }
  return (await response.json()) as RecordingMeta;
}

export async function deleteServerRecording(id: string): Promise<void> {
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();

  const response = await fetch(`${apiUrl}/v1/recordings/${id}`, {
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
  const apiUrl = await getApiUrl();
  const intervalMs = opts?.intervalMs ?? 2000;
  const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    let meta: RecordingMeta | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const headers = await buildApiHeaders();
        const response = await fetch(`${apiUrl}/v1/recordings/${id}`, { headers });
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

export async function fetchTranscript(id: string): Promise<TranscriptResult> {
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();

  const response = await fetch(`${apiUrl}/v1/recordings/${id}/transcript.json`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`Transcript fetch failed (${response.status})`);
  }
  return (await response.json()) as TranscriptResult;
}

function normalizeAskRequest(request: MeetingAskRequest): MeetingAskRequest {
  if (!request.messages?.length) {
    return request;
  }

  const messages = request.messages.map(({ role, content }) => ({ role, content }));
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  return {
    ...request,
    messages,
    // Older API builds only read `question`; keep it in sync with the latest user turn.
    question: request.question?.trim() || lastUser?.content,
  };
}

export async function askMeetings(
  request: MeetingAskRequest,
  options?: { signal?: AbortSignal },
): Promise<MeetingAskResponse> {
  const settings = await getSettings();
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders({ "Content-Type": "application/json" });
  const payload = normalizeAskRequest({
    ...request,
    ...meetingAskPayload(settings),
  });

  const response = await fetch(`${apiUrl}/v1/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options?.signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ask failed (${response.status})${text ? `: ${text}` : ""}`);
  }
  return (await response.json()) as MeetingAskResponse;
}

export async function downloadTranscript(
  id: string,
  format: "txt" | "json",
): Promise<void> {
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();

  const suffix = format === "txt" ? "transcript.txt" : "transcript.json";
  const response = await fetch(`${apiUrl}/v1/recordings/${id}/${suffix}`, { headers });
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

export async function downloadRecordingAudio(
  id: string,
  track: "tab" | "mic",
  filename: string,
): Promise<void> {
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();
  const suffix = track === "mic" ? "mic-audio" : "audio";
  const response = await fetch(`${apiUrl}/v1/recordings/${id}/${suffix}`, { headers });
  if (!response.ok) {
    throw new Error(`Audio download failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function downloadMeetingNotes(
  id: string,
  format: "json" | "md",
): Promise<void> {
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();

  const suffix = format === "md" ? "notes.md" : "notes.json";
  const response = await fetch(`${apiUrl}/v1/recordings/${id}/${suffix}`, { headers });
  if (!response.ok) {
    throw new Error(`Notes download failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}-notes.${format === "md" ? "md" : "json"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

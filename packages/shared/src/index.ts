export type RecordingStatus = "pending" | "processing" | "completed" | "failed";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Present when recorded with separate mic + tab tracks (e.g. "You", "Others"). */
  speaker?: string;
}

export interface TranscriptResult {
  recordingId: string;
  language?: string;
  duration?: number;
  segments: TranscriptSegment[];
}

export interface RecordingMeta {
  id: string;
  meetingTitle?: string;
  startedAt: string;
  durationMs?: number;
  status: RecordingStatus;
  error?: string;
  language?: string;
  processingStartedAt?: string;
}

export interface ExtensionSettings {
  apiUrl: string;
  apiToken: string;
  /** Chrome media deviceId for audioinput; empty = Chrome default */
  microphoneDeviceId?: string;
}

export const DEFAULT_API_URL = "http://localhost:3847";

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function segmentsToPlainText(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => {
      const who = seg.speaker ? `${seg.speaker}: ` : "";
      return `[${formatTimestamp(seg.start)}] ${who}${seg.text.trim()}`;
    })
    .join("\n");
}

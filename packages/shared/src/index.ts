export type RecordingStatus = "pending" | "processing" | "completed" | "failed";

export type TranscriptionPhase = "preparing" | "transcribing" | "saving";

/** Drives progress-bar timing — whisper is much faster than diarize per audio minute. */
export type TranscriptionProfile = "whisper" | "diarize";

export interface TranscriptionProgress {
  phase: TranscriptionPhase;
  profile?: TranscriptionProfile;
  /** 1-based index of the part currently processing (or just finished). */
  step?: number;
  totalSteps?: number;
  label?: string;
  /** When this progress snapshot was written (ISO). */
  updatedAt?: string;
  /** When the current transcribing part started (ISO). */
  partStartedAt?: string;
  /** Duration in seconds of audio in the current part. */
  partAudioSeconds?: number;
  /** Total meeting audio duration in seconds (all parts). */
  totalAudioSeconds?: number;
  /** Audio seconds fully transcribed (sum of finished parts). */
  completedAudioSeconds?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Speaker label from diarization (e.g. "Speaker 1") when available. */
  speaker?: string;
}

export interface TranscriptResult {
  recordingId: string;
  language?: string;
  duration?: number;
  segments: TranscriptSegment[];
}

export type NotesStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

export interface MeetingNotes {
  recordingId: string;
  meetingTitle?: string;
  generatedAt: string;
  summary: string;
  actionItems: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface RecordingMeta {
  id: string;
  meetingTitle?: string;
  startedAt: string;
  durationMs?: number;
  status: RecordingStatus;
  error?: string;
  language?: string;
  /** OpenAI model used for this recording (set at upload; used on retry/resume). */
  transcriptionModel?: TranscriptionModel;
  /** How tab + mic were captured (mixed single file vs separate tracks). */
  captureMode?: AudioCaptureMode;
  processingStartedAt?: string;
  /** Present while status is processing */
  progress?: TranscriptionProgress;
  /** AI meeting notes generation state (after transcript is ready). */
  notesStatus?: NotesStatus;
  notesError?: string;
}

export const TRANSCRIPTION_MODELS = [
  "whisper-1",
  "gpt-4o-transcribe-diarize",
] as const;

export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = "whisper-1";

export function parseTranscriptionModel(
  value: unknown,
  fallback: TranscriptionModel = DEFAULT_TRANSCRIPTION_MODEL,
): TranscriptionModel {
  return value === "whisper-1" || value === "gpt-4o-transcribe-diarize"
    ? value
    : fallback;
}

export function transcriptionModelLabel(model: TranscriptionModel): string {
  switch (model) {
    case "whisper-1":
      return "Whisper (fast, no speaker labels)";
    case "gpt-4o-transcribe-diarize":
      return "Diarize (speaker labels, slower)";
  }
}

export function transcriptionModelToProfile(
  model: TranscriptionModel,
): TranscriptionProfile {
  return model === "whisper-1" ? "whisper" : "diarize";
}

export const AUDIO_CAPTURE_MODES = ["mixed", "dual-track"] as const;

export type AudioCaptureMode = (typeof AUDIO_CAPTURE_MODES)[number];

export const DEFAULT_AUDIO_CAPTURE_MODE: AudioCaptureMode = "mixed";

export function parseAudioCaptureMode(
  value: unknown,
  fallback: AudioCaptureMode = DEFAULT_AUDIO_CAPTURE_MODE,
): AudioCaptureMode {
  return value === "mixed" || value === "dual-track" ? value : fallback;
}

export function audioCaptureModeLabel(mode: AudioCaptureMode): string {
  switch (mode) {
    case "mixed":
      return "Mixed — tab + mic in one file";
    case "dual-track":
      return "Dual-track — separate tab & mic (You / Others)";
  }
}

export type MeetingAskCitation = {
  recordingId: string;
  meetingTitle?: string;
  startedAt: string;
  excerpt: string;
};

export type MeetingAskRole = "user" | "assistant";

export interface MeetingAskMessage {
  role: MeetingAskRole;
  content: string;
  insufficientContext?: boolean;
  citations?: MeetingAskCitation[];
  /** Set when the API call failed for this turn */
  isError?: boolean;
}

export interface MeetingAskRequest {
  /** Single-turn shorthand — converted to one user message on the server */
  question?: string;
  /** Full conversation including the latest user message */
  messages?: MeetingAskMessage[];
  /** Limit to one meeting; omit to search across all saved meetings. */
  recordingId?: string;
}

export interface MeetingAskResponse {
  answer: string;
  insufficientContext: boolean;
  citations: MeetingAskCitation[];
  meetingCount: number;
}

/** Combine recent user turns for transcript retrieval (follow-ups). */
export function meetingAskRetrievalQuery(messages: MeetingAskMessage[]): string {
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);
  if (userTexts.length === 0) {
    return "";
  }
  return userTexts.slice(-3).join(" ");
}

export function formatMeetingAskConversation(messages: MeetingAskMessage[]): string {
  return messages
    .map((m) => {
      const who = m.role === "user" ? "User" : "Assistant";
      return `${who}: ${m.content.trim()}`;
    })
    .join("\n\n");
}

export const COGNIUM_USER_ID_HEADER = "X-Cognium-User-Id";

/** UUID v4 assigned per Chrome profile (chrome.storage.local). */
export function isValidCogniumUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

export interface ExtensionSettings {
  apiUrl: string;
  apiToken: string;
  /** OpenAI transcription model sent with each upload */
  transcriptionModel?: TranscriptionModel;
  /** Tab + mic capture strategy */
  captureMode?: AudioCaptureMode;
  /** Chrome media deviceId for audioinput; empty = Chrome default */
  microphoneDeviceId?: string;
}

export const DEFAULT_API_URL = "http://localhost:3847";

/** Rough diarize runtime vs audio length — used for in-part progress estimates. */
export const DIARIZE_REALTIME_FACTOR = 2.5;
/** Upper bound aligned with API client timeout (~4× audio length). */
export const DIARIZE_TIMEOUT_FACTOR = 4;
/** Whisper often finishes in well under 1× realtime — used for in-part bar creep. */
export const WHISPER_PROCESS_FACTOR = 0.08;

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatElapsedMmSs(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatAudioMinutes(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  return `${mins} min`;
}

export function segmentsToPlainText(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => {
      const who = seg.speaker ? `${seg.speaker}: ` : "";
      return `[${formatTimestamp(seg.start)}] ${who}${seg.text.trim()}`;
    })
    .join("\n");
}

export function formatMeetingNotesMarkdown(notes: MeetingNotes): string {
  const lines: string[] = ["# Meeting notes", ""];

  if (notes.meetingTitle) {
    lines.push(`**${notes.meetingTitle}**`, "");
  }

  lines.push("## Summary", "", notes.summary.trim(), "", "## Action items", "");
  if (notes.actionItems.length === 0) {
    lines.push("_None identified._", "");
  } else {
    for (const item of notes.actionItems) {
      lines.push(`- ${item.trim()}`);
    }
    lines.push("");
  }

  lines.push("## Decisions", "");
  if (notes.decisions.length === 0) {
    lines.push("_None identified._", "");
  } else {
    for (const item of notes.decisions) {
      lines.push(`- ${item.trim()}`);
    }
    lines.push("");
  }

  lines.push("## Open questions", "");
  if (notes.openQuestions.length === 0) {
    lines.push("_None identified._", "");
  } else {
    for (const item of notes.openQuestions) {
      lines.push(`- ${item.trim()}`);
    }
    lines.push("");
  }

  lines.push(`_Generated ${notes.generatedAt}_`);
  return lines.join("\n");
}

function partElapsedSeconds(progress: TranscriptionProgress, nowMs: number): number {
  if (!progress.partStartedAt) {
    return 0;
  }
  return Math.max(0, (nowMs - Date.parse(progress.partStartedAt)) / 1000);
}

function partProcessTimeoutSeconds(
  partAudioSeconds: number,
  profile?: TranscriptionProfile,
): number {
  if (profile === "whisper") {
    return Math.max(30, partAudioSeconds * WHISPER_PROCESS_FACTOR);
  }
  return Math.max(90, partAudioSeconds * DIARIZE_TIMEOUT_FACTOR);
}

function transcribedAudioSeconds(
  progress: TranscriptionProgress,
  nowMs: number,
): number {
  const completed = progress.completedAudioSeconds ?? 0;
  const partAudio = progress.partAudioSeconds ?? 0;

  if (!progress.partStartedAt || partAudio <= 0) {
    return completed;
  }

  const elapsed = partElapsedSeconds(progress, nowMs);
  const timeout = partProcessTimeoutSeconds(partAudio, progress.profile);
  const inPart = Math.min(0.99, elapsed / timeout);
  return completed + partAudio * inPart;
}

function isSlowerThanExpected(
  progress: TranscriptionProgress,
  nowMs: number,
): boolean {
  if (progress.profile === "whisper") {
    return false;
  }
  if (!progress.partStartedAt || !progress.partAudioSeconds) {
    return false;
  }
  const elapsed = partElapsedSeconds(progress, nowMs);
  return elapsed > progress.partAudioSeconds * DIARIZE_REALTIME_FACTOR;
}

function totalAudioSeconds(progress: TranscriptionProgress): number {
  if (progress.totalAudioSeconds && progress.totalAudioSeconds > 0) {
    return progress.totalAudioSeconds;
  }
  const part = progress.partAudioSeconds ?? 0;
  const steps = progress.totalSteps ?? 1;
  return Math.max(1, part * steps);
}

/** Combine progress snapshots so partial API updates do not drop timing fields. */
export function mergeTranscriptionProgress(
  previous: TranscriptionProgress | undefined,
  incoming: TranscriptionProgress,
): TranscriptionProgress {
  if (!previous) {
    return { ...incoming };
  }

  const merged: TranscriptionProgress = {
    ...previous,
    ...incoming,
    updatedAt: incoming.updatedAt ?? previous.updatedAt,
  };

  const prevDone = previous.completedAudioSeconds ?? 0;
  const nextDone = incoming.completedAudioSeconds ?? 0;
  merged.completedAudioSeconds = Math.max(prevDone, nextDone);

  if (incoming.totalAudioSeconds === undefined) {
    merged.totalAudioSeconds = previous.totalAudioSeconds;
  }
  if (incoming.partAudioSeconds === undefined) {
    merged.partAudioSeconds = previous.partAudioSeconds;
  }
  if (incoming.profile === undefined) {
    merged.profile = previous.profile;
  }
  if (incoming.totalSteps === undefined) {
    merged.totalSteps = previous.totalSteps;
  }
  if (incoming.step === undefined) {
    merged.step = previous.step;
  }

  const stepAdvanced =
    incoming.step !== undefined &&
    previous.step !== undefined &&
    incoming.step > previous.step;
  const partFinished = incoming.label?.includes("finished") ?? false;

  if (partFinished) {
    merged.partStartedAt = undefined;
    return merged;
  }

  if (stepAdvanced) {
    merged.partStartedAt =
      incoming.partStartedAt ?? incoming.updatedAt ?? new Date().toISOString();
    return merged;
  }

  if (
    incoming.phase === "transcribing" &&
    !incoming.partStartedAt &&
    previous.partStartedAt
  ) {
    merged.partStartedAt = previous.partStartedAt;
  }

  return merged;
}

/** Map API progress to 0–100; optional nowMs for smooth in-part estimates between polls. */
export function transcriptionProgressPercent(
  progress: TranscriptionProgress | undefined,
  nowMs: number = Date.now(),
): number {
  if (!progress) {
    return 0;
  }

  switch (progress.phase) {
    case "preparing":
      return progress.totalAudioSeconds ? 10 : 5;
    case "saving":
      return 98;
    case "transcribing": {
      const total = totalAudioSeconds(progress);
      const done = transcribedAudioSeconds(progress, nowMs);
      const ratio = Math.min(1, done / total);
      return Math.min(97, Math.round(10 + 87 * ratio));
    }
  }
}

export function transcriptionProgressLabel(
  progress: TranscriptionProgress | undefined,
  nowMs: number = Date.now(),
): string {
  if (!progress) {
    return "Transcribing…";
  }

  if (progress.label && progress.phase !== "transcribing") {
    return progress.label;
  }

  if (progress.phase === "preparing") {
    if (progress.totalAudioSeconds) {
      return `Audio ready — ${formatAudioMinutes(progress.totalAudioSeconds)} to transcribe`;
    }
    return progress.label ?? "Preparing audio…";
  }

  if (progress.phase === "saving") {
    return progress.label ?? "Saving transcript…";
  }

  if (progress.phase === "transcribing") {
    const step = progress.step ?? 1;
    const total = progress.totalSteps ?? 1;
    const elapsed = partElapsedSeconds(progress, nowMs);
    const elapsedText = progress.partStartedAt ? ` (${formatElapsedMmSs(elapsed)})` : "";
    const totalAudio = progress.totalAudioSeconds;
    const slow = isSlowerThanExpected(progress, nowMs);

    if (total > 1) {
      if (slow && progress.partAudioSeconds) {
        const timeoutMin = Math.round(
          partProcessTimeoutSeconds(progress.partAudioSeconds, progress.profile) / 60,
        );
        return `Part ${step}/${total} — still processing${elapsedText} (can take up to ~${timeoutMin} min)`;
      }
      const base = `Transcribing part ${step}/${total}${elapsedText}`;
      if (totalAudio) {
        const done = transcribedAudioSeconds(progress, nowMs);
        return `${base} — ${formatAudioMinutes(done)} of ${formatAudioMinutes(totalAudio)} audio`;
      }
      return `${base}…`;
    }

    if (totalAudio) {
      const done = transcribedAudioSeconds(progress, nowMs);
      return `Transcribing — ${formatAudioMinutes(done)} of ${formatAudioMinutes(totalAudio)}${elapsedText}`;
    }
    if (progress.profile === "diarize") {
      return `Transcribing with speaker labels${elapsedText}…`;
    }
    return `Transcribing${elapsedText}…`;
  }

  return progress.label ?? "Transcribing…";
}

export function isTranscriptionProgressActive(
  progress: TranscriptionProgress | undefined,
): boolean {
  return progress?.phase === "transcribing" && Boolean(progress.partStartedAt);
}

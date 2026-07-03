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
  /** LLM provider used for Ask/notes (when set per recording). */
  meetingLlmProvider?: MeetingLlmProvider;
  /** Generate meeting notes after transcription (extension default per upload). */
  meetingNotesEnabled?: boolean;
  /** Model for notes + Ask (OpenAI name or Ollama tag). */
  meetingLlmModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  /** Delete raw audio after successful transcription. */
  deleteAudioAfterTranscription?: boolean;
  /**
   * Per-recording OpenAI key from extension (BYOK). Stored server-side for async jobs;
   * never returned in API responses.
   */
  openaiApiKey?: string;
}

/** Strip server-only fields before returning recording metadata to clients. */
export function publicRecordingMeta(meta: RecordingMeta): RecordingMeta {
  const { openaiApiKey: _openaiApiKey, ...rest } = meta;
  return rest;
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
export type MeetingLlmProvider = "openai" | "ollama";

export const MEETING_LLM_PROVIDERS = ["openai", "ollama"] as const;
export const DEFAULT_MEETING_LLM_PROVIDER: MeetingLlmProvider = "openai";

export const DEFAULT_MEETING_LLM_MODEL = "gpt-4o-mini";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

export const OPENAI_MEETING_LLM_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
] as const;

export const OLLAMA_MEETING_LLM_MODELS = [
  "qwen2.5:7b",
  "llama3.2",
  "mistral",
  "phi3:mini",
  "gemma2:9b",
] as const;

export type OpenAiMeetingLlmModel = (typeof OPENAI_MEETING_LLM_MODELS)[number];
export type OllamaMeetingLlmModel = (typeof OLLAMA_MEETING_LLM_MODELS)[number];

export function meetingLlmModelsForProvider(
  provider: MeetingLlmProvider,
): readonly string[] {
  return provider === "ollama" ? OLLAMA_MEETING_LLM_MODELS : OPENAI_MEETING_LLM_MODELS;
}

export function defaultMeetingLlmModelForProvider(provider: MeetingLlmProvider): string {
  return provider === "ollama" ? DEFAULT_OLLAMA_MODEL : DEFAULT_MEETING_LLM_MODEL;
}

export function meetingLlmModelLabel(model: string): string {
  switch (model) {
    case "gpt-4o-mini":
      return "GPT-4o mini (fast, low cost)";
    case "gpt-4o":
      return "GPT-4o (higher quality)";
    case "gpt-4.1-mini":
      return "GPT-4.1 mini";
    case "gpt-4.1":
      return "GPT-4.1";
    case "qwen2.5:7b":
      return "Qwen 2.5 7B";
    case "llama3.2":
      return "Llama 3.2";
    case "mistral":
      return "Mistral";
    case "phi3:mini":
      return "Phi-3 mini";
    case "gemma2:9b":
      return "Gemma 2 9B";
    default:
      return model;
  }
}

export const DEFAULT_MAX_UPLOAD_MB = 150;
/** Hard server ceiling for request body size (not configurable via env). */
export const ABSOLUTE_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const DEFAULT_DELETE_AUDIO_AFTER_TRANSCRIPTION = true;
export const DEFAULT_MEETING_NOTES_ENABLED = true;
export const DEFAULT_MEETING_ASK_ENABLED = true;

export function parseBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return fallback;
}

export function parseMaxUploadMb(
  value: unknown,
  fallback: number = DEFAULT_MAX_UPLOAD_MB,
): number {
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  const ceilingMb = Math.floor(ABSOLUTE_MAX_UPLOAD_BYTES / (1024 * 1024));
  return Math.min(parsed, ceilingMb);
}

export function maxUploadBytesFromMb(mb: number): number {
  return parseMaxUploadMb(mb) * 1024 * 1024;
}

export function parseMeetingLlmProvider(
  value: unknown,
  fallback: MeetingLlmProvider = DEFAULT_MEETING_LLM_PROVIDER,
): MeetingLlmProvider {
  return value === "openai" || value === "ollama" ? value : fallback;
}

export function looksLikeOpenAiMeetingModel(model: string): boolean {
  const name = model.trim().toLowerCase();
  return name.startsWith("gpt-") || name.startsWith("o1") || name.startsWith("o3");
}

/** Pick a model tag that matches the selected provider (avoids Ollama tags on OpenAI, etc.). */
export function coerceMeetingLlmModelForProvider(
  provider: MeetingLlmProvider,
  model: string | undefined,
): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return defaultMeetingLlmModelForProvider(provider);
  }
  if (provider === "openai") {
    return looksLikeOpenAiMeetingModel(trimmed)
      ? trimmed
      : defaultMeetingLlmModelForProvider(provider);
  }
  return looksLikeOpenAiMeetingModel(trimmed)
    ? defaultMeetingLlmModelForProvider(provider)
    : trimmed;
}

export function meetingLlmProviderLabel(provider: MeetingLlmProvider): string {
  return provider === "ollama" ? "Ollama (local)" : "OpenAI (cloud)";
}

/** Max wait for Ask LLM completion (API + extension client). */
export const MEETING_ASK_TIMEOUT_MS_OLLAMA = 60 * 1000;
export const MEETING_ASK_TIMEOUT_MS_OPENAI = 30 * 1000;

export function meetingAskTimeoutMs(provider: MeetingLlmProvider): number {
  return provider === "ollama"
    ? MEETING_ASK_TIMEOUT_MS_OLLAMA
    : MEETING_ASK_TIMEOUT_MS_OPENAI;
}

export function meetingAskTimeoutMessage(provider: MeetingLlmProvider): string {
  const secs = Math.round(meetingAskTimeoutMs(provider) / 1000);
  if (provider === "ollama") {
    return `Ollama took too long (over ${secs} seconds). Try OpenAI, a smaller model, or ask a simpler question.`;
  }
  return `OpenAI Ask timed out after ${secs} seconds. Try again or use a faster model.`;
}

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
  /** Optional provider override for this ask call */
  llmProvider?: MeetingLlmProvider;
  meetingLlmProvider?: MeetingLlmProvider;
  meetingLlmModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
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
/** Extension sends the user's OpenAI key; server uses it when OPENAI_API_KEY is unset. */
export const OPENAI_API_KEY_HEADER = "X-OpenAI-Key";

export function parseOpenAiKeyHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

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
  /** Provider for Ask + meeting notes */
  meetingLlmProvider?: MeetingLlmProvider;
  meetingNotesEnabled?: boolean;
  meetingAskEnabled?: boolean;
  meetingLlmModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  deleteAudioAfterTranscription?: boolean;
  maxUploadMb?: number;
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

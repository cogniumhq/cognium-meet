import type { MeetingAskCitation, RecordingMeta, TranscriptResult, TranscriptSegment, TranscriptionProgress } from "@cognium/meet-shared";
import {
  formatTimestamp,
  isTranscriptionProgressActive,
  mergeTranscriptionProgress,
  segmentsToPlainText,
  transcriptionProgressLabel,
  transcriptionProgressPercent,
} from "@cognium/meet-shared";
import {
  askMeetings,
  deleteServerRecording,
  downloadMeetingNotes,
  downloadTranscript,
  fetchRecordingStatus,
  fetchTranscript,
  retryRecording,
} from "../lib/upload.js";
import { deletePendingAudio, downloadPendingAudio, loadPendingAudio } from "../lib/pending-audio-store.js";
import {
  findServerProcessingEntry,
  getHistory,
  HISTORY_KEY,
  loadAskDraft,
  removeHistoryEntry,
  saveAskDraft,
  updateHistoryEntry,
  type AskDraftState,
  type StoredRecording,
} from "../lib/storage.js";
import { isRecordableTabUrl } from "../lib/recordable-tab.js";
import { initSettingsForm } from "../lib/settings-form.js";

const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopOnlyBtn = document.getElementById("stop-only-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const recordingIndicator = document.getElementById("recording-indicator") as HTMLDivElement;
const timerEl = document.getElementById("timer") as HTMLSpanElement;
const historyList = document.getElementById("history-list") as HTMLUListElement;
const meetingAsk = document.getElementById("meeting-ask") as HTMLTextAreaElement;
const meetingAskLabel = document.getElementById("meeting-ask-label") as HTMLLabelElement;
const meetingAskBtn = document.getElementById("meeting-ask-btn") as HTMLButtonElement;
const meetingAskClearScope = document.getElementById(
  "meeting-ask-clear-scope",
) as HTMLButtonElement;
const meetingAskResult = document.getElementById("meeting-ask-result") as HTMLDivElement;
const mainView = document.getElementById("main-view") as HTMLDivElement;
const transcriptView = document.getElementById("transcript-view") as HTMLDivElement;
const settingsView = document.getElementById("settings-view") as HTMLDivElement;
const settingsOpenBtn = document.getElementById("settings-open-btn") as HTMLButtonElement;
const settingsBackBtn = document.getElementById("settings-back-btn") as HTMLButtonElement;
const transcriptBackBtn = document.getElementById("transcript-back-btn") as HTMLButtonElement;
const transcriptTitle = document.getElementById("transcript-title") as HTMLHeadingElement;
const transcriptSearch = document.getElementById("transcript-search") as HTMLInputElement;
const transcriptCopyBtn = document.getElementById("transcript-copy-btn") as HTMLButtonElement;
const transcriptBody = document.getElementById("transcript-body") as HTMLDivElement;
const transcriptionProgress = document.getElementById(
  "transcription-progress",
) as HTMLDivElement;
const progressLabel = document.getElementById("progress-label") as HTMLParagraphElement;
const progressTrack = document.getElementById("progress-track") as HTMLDivElement;
const progressFill = document.getElementById("progress-fill") as HTMLDivElement;
const progressPercent = document.getElementById("progress-percent") as HTMLParagraphElement;

let timerInterval: number | undefined;
let progressTickInterval: number | undefined;
let recordingStartedAt: number | undefined;
let currentProgress: TranscriptionProgress | undefined;
let watchingTranscriptionId: string | undefined;
let displayedPercentFloor = 0;
let historyRenderGen = 0;
let currentTranscript: TranscriptResult | undefined;
let askScopeRecordingId: string | undefined;
let askScopeMeetingTitle: string | undefined;
let askRequestGen = 0;
let askDraftSaveTimer: number | undefined;

void init();

function recordingMicNote(status: {
  includedMic?: boolean;
  micLabel?: string;
}): string {
  if (!status.includedMic) {
    return "tab audio only — pick mic in Settings";
  }
  if (status.micLabel) {
    return `tab + ${status.micLabel}`;
  }
  return "tab + mic";
}

async function init(): Promise<void> {
  settingsOpenBtn.addEventListener("click", () => showSettings(true));
  settingsBackBtn.addEventListener("click", () => showMainView());
  transcriptBackBtn.addEventListener("click", () => showMainView());
  transcriptSearch.addEventListener("input", () => {
    if (currentTranscript) {
      renderTranscriptSegments(currentTranscript.segments, transcriptSearch.value);
    }
  });
  transcriptCopyBtn.addEventListener("click", () => void copyTranscript());
  meetingAskBtn.addEventListener("click", () => void runMeetingAsk());
  meetingAskClearScope.addEventListener("click", () => setAskScope());
  meetingAsk.addEventListener("input", () => scheduleSaveAskDraft());
  meetingAsk.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void runMeetingAsk();
    }
  });
  window.addEventListener("pagehide", () => {
    window.clearTimeout(askDraftSaveTimer);
    void persistAskDraft();
  });
  await initSettingsForm(document.getElementById("settings-root")!);
  await restoreAskDraft();

  startBtn.addEventListener("click", () => void startRecording());
  stopOnlyBtn.addEventListener("click", () => void stopRecording(false));
  stopBtn.addEventListener("click", () => void stopRecording(true));

  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (status?.isRecording && status.startedAt) {
    enterRecordingUi(status.startedAt);
    const micNote = recordingMicNote(status);
    setStatus(`Recording (${micNote})`, !status.includedMic);
  }

  await refreshStaleHistory();
  await restoreTranscriptionProgressUi();
  await renderHistory();
  subscribeToHistoryUpdates();
}

function subscribeToHistoryUpdates(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[HISTORY_KEY]) {
      return;
    }
    void onHistoryStorageChanged(
      changes[HISTORY_KEY].newValue as StoredRecording[] | undefined,
    );
  });
}

async function onHistoryStorageChanged(history?: StoredRecording[]): Promise<void> {
  const list = history ?? (await getHistory());

  if (watchingTranscriptionId) {
    const watched = list.find((item) => item.id === watchingTranscriptionId);
    if (watched?.status === "processing") {
      if (watched.progress) {
        showGlobalProgress(watched.progress);
      }
      setStatus("Transcribing… — safe to close this popup");
    } else if (watched?.status === "completed") {
      watchingTranscriptionId = undefined;
      showGlobalProgress(undefined);
      setStatus("Transcript ready — see Recent transcripts below");
    } else if (watched?.status === "failed") {
      watchingTranscriptionId = undefined;
      showGlobalProgress(undefined);
      setStatus(watched.error ?? "Transcription failed", true);
    }
  } else {
    const active = findServerProcessingEntry(list);
    if (active?.progress) {
      watchingTranscriptionId = active.id;
      showGlobalProgress(active.progress);
      setStatus("Transcribing… — safe to close this popup");
    }
  }

  await renderHistory();
}

async function restoreTranscriptionProgressUi(): Promise<void> {
  const history = await getHistory();
  const active = findServerProcessingEntry(history);
  if (!active) {
    return;
  }

  if (active.id !== watchingTranscriptionId) {
    currentProgress = undefined;
    displayedPercentFloor = 0;
  }
  watchingTranscriptionId = active.id;
  if (active.progress) {
    showGlobalProgress(active.progress);
    setStatus("Transcribing… — safe to close this popup");
    return;
  }

  try {
    const meta = await fetchRecordingStatus(active.id);
    applyTranscriptionMeta(meta);
  } catch {
    // API may be offline; the service worker will refresh history when it is back.
  }
}

function applyTranscriptionMeta(meta: RecordingMeta): void {
  if (meta.status === "processing") {
    watchingTranscriptionId = meta.id;
    if (meta.progress) {
      showGlobalProgress(meta.progress);
    }
    setStatus("Transcribing… — safe to close this popup");
    return;
  }

  if (meta.status === "completed") {
    watchingTranscriptionId = undefined;
    showGlobalProgress(undefined);
    setStatus("Transcript ready — see Recent transcripts below");
    return;
  }

  if (meta.status === "failed") {
    watchingTranscriptionId = undefined;
    showGlobalProgress(undefined);
    setStatus(meta.error ?? "Transcription failed", true);
  }
}

async function showTranscriptionProgressFor(id: string): Promise<void> {
  if (id !== watchingTranscriptionId) {
    currentProgress = undefined;
    displayedPercentFloor = 0;
  }
  watchingTranscriptionId = id;
  try {
    const meta = await fetchRecordingStatus(id);
    applyTranscriptionMeta(meta);
  } catch {
    showGlobalProgress({ phase: "preparing", label: "Starting transcription…" });
    setStatus("Transcribing… — safe to close this popup");
  }
}

function showGlobalProgress(incoming?: TranscriptionProgress): void {
  if (!incoming) {
    currentProgress = undefined;
    displayedPercentFloor = 0;
    renderProgressUi(undefined);
    return;
  }

  currentProgress = mergeTranscriptionProgress(currentProgress, incoming);
  renderProgressUi(currentProgress);
}

function renderProgressUi(progress?: TranscriptionProgress, nowMs: number = Date.now()): void {
  if (!progress) {
    transcriptionProgress.classList.add("hidden");
    progressFill.classList.remove("progress-fill--active");
    stopProgressTick();
    return;
  }

  const active = isTranscriptionProgressActive(progress);
  let pct = transcriptionProgressPercent(progress, nowMs);
  if (progress.phase === "transcribing") {
    displayedPercentFloor = Math.max(displayedPercentFloor, pct);
    pct = displayedPercentFloor;
  } else {
    displayedPercentFloor = pct;
  }

  transcriptionProgress.classList.remove("hidden");
  progressLabel.textContent = transcriptionProgressLabel(progress, nowMs);
  progressFill.style.width = `${pct}%`;
  progressFill.classList.toggle("progress-fill--active", active);
  progressPercent.textContent = `${pct}%`;
  progressTrack.setAttribute("aria-valuenow", String(pct));
  statusText.textContent = "Transcribing…";
  statusText.classList.remove("error");

  if (active && !progressTickInterval) {
    progressTickInterval = window.setInterval(() => {
      if (currentProgress) {
        renderProgressUi(currentProgress);
        if (watchingTranscriptionId) {
          void renderHistory();
        }
      }
    }, 1000);
  } else if (!active) {
    stopProgressTick();
  }
}

function stopProgressTick(): void {
  if (progressTickInterval) {
    clearInterval(progressTickInterval);
    progressTickInterval = undefined;
  }
}

function createProgressBarElement(
  itemId: string,
  storedProgress?: TranscriptionProgress,
): HTMLDivElement | null {
  const progress =
    itemId === watchingTranscriptionId && currentProgress
      ? currentProgress
      : storedProgress;
  if (!progress) {
    return null;
  }

  const now = Date.now();
  let pct = transcriptionProgressPercent(progress, now);
  if (itemId === watchingTranscriptionId && progress.phase === "transcribing") {
    pct = displayedPercentFloor;
  }

  const active = isTranscriptionProgressActive(progress);
  const wrap = document.createElement("div");
  wrap.className = "transcription-progress history-progress";

  const label = document.createElement("p");
  label.className = "progress-label";
  label.textContent = transcriptionProgressLabel(progress, now);

  const track = document.createElement("div");
  track.className = "progress-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(pct));

  const fill = document.createElement("div");
  fill.className = "progress-fill";
  if (active) {
    fill.classList.add("progress-fill--active");
  }
  fill.style.width = `${pct}%`;
  track.appendChild(fill);

  const percent = document.createElement("p");
  percent.className = "progress-percent";
  percent.textContent = `${pct}%`;

  wrap.appendChild(label);
  wrap.appendChild(track);
  wrap.appendChild(percent);
  return wrap;
}

function showMainView(): void {
  mainView.classList.remove("hidden");
  settingsView.classList.add("hidden");
  transcriptView.classList.add("hidden");
  currentTranscript = undefined;
}

function setAskScope(item?: StoredRecording): void {
  askScopeRecordingId = item?.id;
  askScopeMeetingTitle = item?.meetingTitle;
  if (item) {
    meetingAskLabel.textContent = `Ask about: ${item.meetingTitle ?? "Recording"}`;
    meetingAskClearScope.classList.remove("hidden");
    meetingAsk.focus();
  } else {
    meetingAskLabel.textContent = "Ask about your meetings";
    meetingAskClearScope.classList.add("hidden");
  }
  scheduleSaveAskDraft();
}

function scheduleSaveAskDraft(): void {
  window.clearTimeout(askDraftSaveTimer);
  askDraftSaveTimer = window.setTimeout(() => {
    void persistAskDraft();
  }, 250);
}

async function persistAskDraft(overrides?: Partial<AskDraftState>): Promise<void> {
  const draft: AskDraftState = {
    question: meetingAsk.value,
    scopeRecordingId: askScopeRecordingId,
    scopeMeetingTitle: askScopeMeetingTitle,
    ...overrides,
  };
  if (overrides?.lastAnswer === undefined && overrides?.lastError === undefined) {
    const existing = await loadAskDraft();
    if (existing) {
      draft.lastAnswer = existing.lastAnswer;
      draft.lastInsufficientContext = existing.lastInsufficientContext;
      draft.lastCitations = existing.lastCitations;
      draft.lastError = existing.lastError;
    }
  }
  await saveAskDraft(draft);
}

async function restoreAskDraft(): Promise<void> {
  const draft = await loadAskDraft();
  if (!draft) {
    return;
  }

  meetingAsk.value = draft.question;
  if (draft.scopeRecordingId) {
    askScopeRecordingId = draft.scopeRecordingId;
    askScopeMeetingTitle = draft.scopeMeetingTitle;
    meetingAskLabel.textContent = `Ask about: ${draft.scopeMeetingTitle ?? "Recording"}`;
    meetingAskClearScope.classList.remove("hidden");
  }

  if (draft.lastError) {
    meetingAskResult.classList.remove("hidden");
    meetingAskResult.innerHTML = "";
    const error = document.createElement("p");
    error.className = "meeting-ask-error";
    error.textContent = draft.lastError;
    meetingAskResult.appendChild(error);
    return;
  }

  if (draft.lastAnswer) {
    meetingAskResult.classList.remove("hidden");
    meetingAskResult.innerHTML = "";
    const answer = document.createElement("div");
    answer.className = "meeting-ask-answer";
    if (draft.lastInsufficientContext) {
      answer.classList.add("meeting-ask-answer--weak");
    }
    answer.textContent = draft.lastAnswer;
    meetingAskResult.appendChild(answer);
    renderAskCitations(draft.lastCitations ?? []);
  }
}

function clearAskResult(): void {
  meetingAskResult.innerHTML = "";
  meetingAskResult.classList.add("hidden");
}

function citationToRecording(citation: MeetingAskCitation): StoredRecording {
  return {
    id: citation.recordingId,
    meetingTitle: citation.meetingTitle,
    startedAt: citation.startedAt,
    status: "completed",
    createdAt: citation.startedAt,
  };
}

function renderAskCitations(citations: MeetingAskCitation[]): void {
  if (citations.length === 0) {
    return;
  }

  const heading = document.createElement("p");
  heading.className = "meeting-ask-sources-title";
  heading.textContent =
    citations.length === 1 ? "Source meeting" : `Source meetings (${citations.length})`;
  meetingAskResult.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "meeting-ask-sources";

  for (const citation of citations) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-ask-source-btn";
    btn.textContent = citation.meetingTitle ?? "Recording";
    btn.title = citation.excerpt;
    btn.addEventListener("click", () => {
      void openTranscriptViewer(citationToRecording(citation));
    });
    li.appendChild(btn);
    list.appendChild(li);
  }

  meetingAskResult.appendChild(list);
}

async function runMeetingAsk(): Promise<void> {
  const question = meetingAsk.value.trim();
  if (!question) {
    return;
  }

  const gen = ++askRequestGen;
  meetingAskBtn.disabled = true;
  meetingAskResult.classList.remove("hidden");
  meetingAskResult.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "meeting-ask-loading";
  loading.textContent = "Thinking…";
  meetingAskResult.appendChild(loading);

  try {
    const response = await askMeetings({
      question,
      recordingId: askScopeRecordingId,
    });
    if (gen !== askRequestGen) {
      return;
    }

    meetingAskResult.innerHTML = "";
    const answer = document.createElement("div");
    answer.className = "meeting-ask-answer";
    if (response.insufficientContext) {
      answer.classList.add("meeting-ask-answer--weak");
    }
    answer.textContent = response.answer;
    meetingAskResult.appendChild(answer);
    renderAskCitations(response.citations);
    await persistAskDraft({
      lastAnswer: response.answer,
      lastInsufficientContext: response.insufficientContext,
      lastCitations: response.citations,
      lastError: undefined,
    });
  } catch (err) {
    if (gen !== askRequestGen) {
      return;
    }
    meetingAskResult.innerHTML = "";
    const error = document.createElement("p");
    error.className = "meeting-ask-error";
    const message = err instanceof Error ? err.message : String(err);
    error.textContent = message;
    meetingAskResult.appendChild(error);
    await persistAskDraft({
      lastAnswer: undefined,
      lastCitations: undefined,
      lastInsufficientContext: undefined,
      lastError: message,
    });
  } finally {
    if (gen === askRequestGen) {
      meetingAskBtn.disabled = false;
    }
  }
}

function showSettings(open: boolean): void {
  if (open) {
    mainView.classList.add("hidden");
    settingsView.classList.remove("hidden");
    transcriptView.classList.add("hidden");
    currentTranscript = undefined;
    return;
  }
  showMainView();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightText(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const q = query.trim();
  if (!q) {
    return escaped;
  }
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(pattern, "gi"), (match) => `<mark>${match}</mark>`);
}

function renderTranscriptSegments(segments: TranscriptSegment[], query: string): void {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? segments.filter(
        (seg) =>
          seg.text.toLowerCase().includes(q) ||
          seg.speaker?.toLowerCase().includes(q),
      )
    : segments;

  transcriptBody.innerHTML = "";
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "transcript-empty";
    empty.textContent = q ? "No matches" : "Transcript is empty";
    transcriptBody.appendChild(empty);
    return;
  }

  for (const seg of filtered) {
    const row = document.createElement("div");
    row.className = "transcript-segment";

    const meta = document.createElement("div");
    meta.className = "transcript-segment-meta";
    const speaker = seg.speaker ? ` · ${seg.speaker}` : "";
    meta.textContent = `${formatTimestamp(seg.start)}${speaker}`;

    const text = document.createElement("div");
    text.className = "transcript-segment-text";
    text.innerHTML = highlightText(seg.text.trim(), query);

    row.appendChild(meta);
    row.appendChild(text);
    transcriptBody.appendChild(row);
  }
}

async function openTranscriptViewer(
  item: StoredRecording,
  initialQuery = "",
): Promise<void> {
  mainView.classList.add("hidden");
  settingsView.classList.add("hidden");
  transcriptView.classList.remove("hidden");
  transcriptTitle.textContent = item.meetingTitle ?? "Recording";
  transcriptSearch.value = initialQuery;
  currentTranscript = undefined;
  transcriptBody.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "transcript-loading";
  loading.textContent = "Loading transcript…";
  transcriptBody.appendChild(loading);
  transcriptCopyBtn.disabled = true;

  try {
    const transcript = await fetchTranscript(item.id);
    currentTranscript = transcript;
    renderTranscriptSegments(transcript.segments, initialQuery);
    transcriptCopyBtn.disabled = false;
  } catch (err) {
    transcriptBody.innerHTML = "";
    const error = document.createElement("p");
    error.className = "transcript-error";
    error.textContent = err instanceof Error ? err.message : String(err);
    transcriptBody.appendChild(error);
  }
}

async function copyTranscript(): Promise<void> {
  if (!currentTranscript) {
    return;
  }
  try {
    await navigator.clipboard.writeText(segmentsToPlainText(currentTranscript.segments));
    setStatus("Transcript copied to clipboard");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

async function startRecording(): Promise<void> {
  startBtn.disabled = true;
  setStatus("Starting…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found");
    }
    if (!isRecordableTabUrl(tab.url)) {
      throw new Error(
        "This page cannot be recorded — open a regular website tab (http/https)",
      );
    }

    const response = await chrome.runtime.sendMessage({
      type: "START_RECORDING",
      tabId: tab.id,
      meetingTitle: tab.title,
    });

    if (response?.type === "RECORDING_ERROR") {
      const error = response.error ?? "Recording failed";
      if (error.includes("Already recording")) {
        const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
        if (status?.isRecording && status.startedAt) {
          enterRecordingUi(status.startedAt);
          setStatus("Recording already in progress");
          return;
        }
      }
      throw new Error(error);
    }

    recordingStartedAt = response.startedAt as number;
    enterRecordingUi(recordingStartedAt);
    const micNote = recordingMicNote(response);
    setStatus(`Recording (${micNote})`, !response.includedMic);
    startBtn.disabled = false;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    startBtn.disabled = false;
  }
}

async function stopRecording(transcribe: boolean): Promise<void> {
  stopOnlyBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus(transcribe ? "Stopping & transcribing… (may take a minute for long recordings)" : "Stopping recording… (may take a minute for long recordings)");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "STOP_RECORDING",
      transcribe,
    });
    if (!response) {
      throw new Error("No response from background worker — try reloading the extension");
    }
    if (response?.type === "RECORDING_ERROR") {
      throw new Error(response.error);
    }

    exitRecordingUi();

    if (response.savedLocally) {
      setStatus("Recording saved — transcribe when ready from Recent transcripts");
      return;
    }

    if (response.uploadFailed) {
      setStatus(
        response.error
          ? `Upload failed — saved locally. ${response.error}`
          : "Upload failed — recording saved locally",
        true,
      );
      return;
    }

    if (!response.recordingId) {
      throw new Error("Upload did not return a recording id");
    }

    setStatus("Transcribing… — safe to close this popup");
    void showTranscriptionProgressFor(response.recordingId);
  } catch (err) {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    const message = err instanceof Error ? err.message : String(err);
    if (status?.isRecording && status.startedAt) {
      enterRecordingUi(status.startedAt);
      const micNote = recordingMicNote(status);
      setStatus(`Still recording (${micNote}) — ${message}`, true);
    } else {
      exitRecordingUi();
      setStatus(message, true);
    }
  } finally {
    startBtn.disabled = false;
    stopOnlyBtn.disabled = false;
    stopBtn.disabled = false;
  }
}

function enterRecordingUi(startedAt: number): void {
  recordingStartedAt = startedAt;
  startBtn.classList.add("hidden");
  stopOnlyBtn.classList.remove("hidden");
  stopBtn.classList.remove("hidden");
  stopOnlyBtn.disabled = false;
  stopBtn.disabled = false;
  recordingIndicator.classList.remove("hidden");
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  updateTimer();
  timerInterval = window.setInterval(updateTimer, 1000);
}

function exitRecordingUi(): void {
  startBtn.classList.remove("hidden");
  stopOnlyBtn.classList.add("hidden");
  stopBtn.classList.add("hidden");
  recordingIndicator.classList.add("hidden");
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = undefined;
  }
}

function updateTimer(): void {
  if (!recordingStartedAt) {
    return;
  }
  const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function setStatus(text: string, isError = false): void {
  statusText.textContent = text;
  statusText.classList.toggle("error", isError);
}

function statusBadgeLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Done";
    case "processing":
      return "Transcribing";
    case "saved":
      return "Saved";
    case "upload_failed":
      return "Upload failed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function createStatusBadge(status: string): HTMLSpanElement {
  const badge = document.createElement("span");
  const safeStatus = status.replace(/[^a-z_]/gi, "");
  badge.className = `status-badge status-badge--${safeStatus}`;
  badge.textContent = statusBadgeLabel(status);
  return badge;
}

function appendHistoryMeta(li: HTMLLIElement, item: { startedAt: string; status: string }): void {
  const meta = document.createElement("div");
  meta.className = "history-meta";

  const date = document.createElement("span");
  date.className = "history-date";
  date.textContent = new Date(item.startedAt).toLocaleString();

  meta.appendChild(date);
  meta.appendChild(createStatusBadge(item.status));
  li.appendChild(meta);
}

async function refreshStaleHistory(): Promise<void> {
  const history = await getHistory();
  for (const item of history) {
    const needsNotesPoll =
      item.status === "completed" &&
      !item.localAudioId &&
      (item.notesStatus === "pending" || item.notesStatus === "processing");
    if (item.status !== "processing" && item.status !== "failed" && !needsNotesPoll) {
      continue;
    }
    if (item.localAudioId) {
      continue;
    }
    try {
      const meta = await fetchRecordingStatus(item.id);
      if (
        meta.status !== item.status ||
        meta.error !== item.error ||
        meta.progress ||
        meta.notesStatus !== item.notesStatus
      ) {
        await updateHistoryEntry(item.id, {
          status: meta.status,
          error: meta.error,
          progress: meta.progress,
          notesStatus: meta.notesStatus,
          notesError: meta.notesError,
        });
      }
    } catch {
      // API may be offline; keep cached status.
    }
  }
}

async function retryTranscription(id: string): Promise<void> {
  setStatus("Retrying transcription…");
  showGlobalProgress({ phase: "preparing", label: "Starting transcription…" });
  watchingTranscriptionId = id;
  try {
    await retryRecording(id);
    await updateHistoryEntry(id, { status: "processing", error: undefined, progress: undefined });
    await renderHistory();
    void chrome.runtime.sendMessage({ type: "TRACK_TRANSCRIPTION", recordingId: id });
    void showTranscriptionProgressFor(id);
  } catch (err) {
    watchingTranscriptionId = undefined;
    showGlobalProgress(undefined);
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

async function retryUpload(localAudioId: string): Promise<void> {
  setStatus("Retrying upload…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RETRY_UPLOAD",
      localAudioId,
    });
    if (response?.type === "RECORDING_ERROR") {
      throw new Error(response.error);
    }
    await renderHistory();
    if (response?.recordingId) {
      setStatus("Transcribing… — safe to close this popup");
      void showTranscriptionProgressFor(response.recordingId);
      void chrome.runtime.sendMessage({
        type: "TRACK_TRANSCRIPTION",
        recordingId: response.recordingId,
      });
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    await renderHistory();
  }
}

async function deleteLocalRecording(item: {
  id: string;
  localAudioId?: string;
  meetingTitle?: string;
}): Promise<void> {
  const label = item.meetingTitle ?? "this recording";
  if (
    !confirm(
      `Delete "${label}" from this device?\n\nLocal audio will be removed from browser storage. This cannot be undone.`,
    )
  ) {
    return;
  }

  const localId = item.localAudioId ?? item.id;
  try {
    await deletePendingAudio(localId);
  } catch {
    // Entry may already be cleared after a successful upload.
  }
  await removeHistoryEntry(item.id);
  await renderHistory();
  setStatus("Local recording deleted");
}

async function removeFromHistory(item: {
  id: string;
  meetingTitle?: string;
  status: string;
  localAudioId?: string;
}): Promise<void> {
  const label = item.meetingTitle ?? "this item";
  const onServer =
    !item.localAudioId &&
    (item.status === "completed" ||
      item.status === "failed" ||
      item.status === "processing");

  const message = onServer
    ? `Delete "${label}" from the server?\n\nAudio and transcripts will be permanently removed.`
    : `Remove "${label}" from Recent transcripts?`;

  if (!confirm(message)) {
    return;
  }

  if (onServer) {
    try {
      await deleteServerRecording(item.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      return;
    }
  }

  await removeHistoryEntry(item.id);
  await renderHistory();
  setStatus(onServer ? "Recording deleted from server" : "Removed from list");
}

function appendLocalAudioActions(
  li: HTMLLIElement,
  item: { id: string; localAudioId?: string; meetingTitle?: string },
  uploadLabel = "Retry upload",
  hasMicTrack = false,
): void {
  if (!item.localAudioId) {
    return;
  }

  const links = document.createElement("div");
  links.className = "history-links";
  const base = (item.meetingTitle ?? "recording").replace(/[/\\?%*:|"<>]/g, "-");

  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "link-btn";
  upload.textContent = uploadLabel;
  upload.addEventListener("click", () => {
    void retryUpload(item.localAudioId!);
  });
  links.appendChild(upload);

  const downloadTab = document.createElement("button");
  downloadTab.type = "button";
  downloadTab.className = "link-btn";
  downloadTab.textContent = hasMicTrack ? "Download tab" : "Download audio";
  downloadTab.addEventListener("click", () => {
    void downloadPendingAudio(
      item.localAudioId!,
      hasMicTrack ? `${base}-tab.webm` : `${base}.webm`,
      "tab",
    ).catch((err) => setStatus(err instanceof Error ? err.message : String(err), true));
  });
  links.appendChild(downloadTab);

  if (hasMicTrack) {
    const downloadMic = document.createElement("button");
    downloadMic.type = "button";
    downloadMic.className = "link-btn";
    downloadMic.textContent = "Download mic";
    downloadMic.addEventListener("click", () => {
      void downloadPendingAudio(item.localAudioId!, `${base}-mic.webm`, "mic").catch((err) =>
        setStatus(err instanceof Error ? err.message : String(err), true),
      );
    });
    links.appendChild(downloadMic);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "link-btn link-btn--danger";
  del.textContent = "Delete local";
  del.addEventListener("click", () => {
    void deleteLocalRecording(item);
  });
  links.appendChild(del);

  li.appendChild(links);
}

function appendRemoveAction(
  li: HTMLLIElement,
  item: { id: string; meetingTitle?: string; status: string; localAudioId?: string },
  links?: HTMLDivElement,
): void {
  const container =
    links ??
    (() => {
      const el = document.createElement("div");
      el.className = "history-links";
      li.appendChild(el);
      return el;
    })();

  const onServer =
    !item.localAudioId &&
    (item.status === "completed" ||
      item.status === "failed" ||
      item.status === "processing");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-btn link-btn--danger";
  remove.textContent = onServer ? "Delete" : "Remove";
  remove.addEventListener("click", () => {
    void removeFromHistory(item);
  });
  container.appendChild(remove);
}

async function renderHistory(): Promise<void> {
  const gen = ++historyRenderGen;
  const history = await getHistory();
  if (gen !== historyRenderGen) {
    return;
  }

  historyList.innerHTML = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "No transcripts yet — start a recording above.";
    historyList.appendChild(li);
    return;
  }

  for (const item of history) {
    const li = document.createElement("li");
    let hasMicTrack = false;
    if (item.localAudioId) {
      const pending = await loadPendingAudio(item.localAudioId);
      if (gen !== historyRenderGen) {
        return;
      }
      hasMicTrack = Boolean(pending?.micBytes?.length);
    }

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = item.meetingTitle ?? "Recording";

    li.appendChild(title);
    appendHistoryMeta(li, item);

    if (item.status === "upload_failed" && item.localAudioId) {
      if (item.error) {
        const err = document.createElement("div");
        err.className = "history-error";
        err.textContent = item.error;
        li.appendChild(err);
      }
      appendLocalAudioActions(li, item, "Retry upload", hasMicTrack);
    }

    if (item.status === "saved" && item.localAudioId) {
      appendLocalAudioActions(li, item, "Transcribe", hasMicTrack);
    }

    if (item.status === "failed" && !item.localAudioId) {
      if (item.error) {
        const err = document.createElement("div");
        err.className = "history-error";
        err.textContent = item.error;
        li.appendChild(err);
      }

      const links = document.createElement("div");
      links.className = "history-links";

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "link-btn";
      retry.textContent = "Retry transcription";
      retry.addEventListener("click", () => {
        void retryTranscription(item.id);
      });
      links.appendChild(retry);
      li.appendChild(links);
      appendRemoveAction(li, item, links);
    }

    if (item.status === "completed") {
      const links = document.createElement("div");
      links.className = "history-links";

      const view = document.createElement("button");
      view.type = "button";
      view.className = "link-btn";
      view.textContent = "View";
      view.addEventListener("click", () => {
        void openTranscriptViewer(item);
      });
      links.appendChild(view);

      const ask = document.createElement("button");
      ask.type = "button";
      ask.className = "link-btn";
      ask.textContent = "Ask";
      ask.addEventListener("click", () => {
        setAskScope(item);
      });
      links.appendChild(ask);

      const txt = document.createElement("button");
      txt.type = "button";
      txt.className = "link-btn";
      txt.textContent = "Download TXT";
      txt.addEventListener("click", () => {
        void downloadTranscript(item.id, "txt").catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err), true),
        );
      });

      const json = document.createElement("button");
      json.type = "button";
      json.className = "link-btn";
      json.textContent = "Download JSON";
      json.addEventListener("click", () => {
        void downloadTranscript(item.id, "json").catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err), true),
        );
      });

      links.appendChild(txt);
      links.appendChild(json);

      if (item.notesStatus === "completed") {
        const notesMd = document.createElement("button");
        notesMd.type = "button";
        notesMd.className = "link-btn";
        notesMd.textContent = "Meeting notes";
        notesMd.addEventListener("click", () => {
          void downloadMeetingNotes(item.id, "md").catch((err) =>
            setStatus(err instanceof Error ? err.message : String(err), true),
          );
        });
        links.appendChild(notesMd);
      } else if (
        item.notesStatus === "pending" ||
        item.notesStatus === "processing"
      ) {
        const pending = document.createElement("span");
        pending.className = "history-notes-pending";
        pending.textContent = "Generating notes…";
        links.appendChild(pending);
      }

      li.appendChild(links);
      appendRemoveAction(li, item, links);
    }

    if (item.status === "processing") {
      const progressBar = createProgressBarElement(item.id, item.progress);
      if (progressBar) {
        li.appendChild(progressBar);
      }
      appendRemoveAction(li, item);
    }

    if (gen !== historyRenderGen) {
      return;
    }
    historyList.appendChild(li);
  }
}

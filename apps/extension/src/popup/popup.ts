import type {
  ExtensionSettings,
  RecordingMeta,
  TranscriptionProgress,
} from "@cognium/meet-shared";
import {
  formatRecordingDurationMs,
  formatRecordingElapsedSeconds,
  isTranscriptionProgressActive,
  mergeTranscriptionProgress,
  transcriptionProgressLabel,
  transcriptionProgressPercent,
  DEFAULT_MEETING_LLM_PROVIDER,
  coerceMeetingLlmModelForProvider,
  meetingLlmModelLabel,
  meetingLlmModelsForProvider,
  type MeetingLlmProvider,
} from "@cognium/meet-shared";
import {
  deleteServerRecording,
  downloadMeetingNotes,
  downloadRecordingAudio,
  downloadTranscript,
  fetchRecordings,
  fetchRecordingStatus,
  regenerateMeetingNotes,
  retryRecording,
} from "../lib/upload.js";
import { deletePendingAudio, downloadPendingAudio, loadPendingAudio } from "../lib/pending-audio-store.js";
import {
  findServerProcessingEntry,
  getHistory,
  getSettings,
  HISTORY_KEY,
  focusAskTabForRecording,
  loadAskWorkspace,
  removeHistoryEntry,
  saveAskWorkspace,
  saveHistory,
  updateHistoryEntry,
  type StoredRecording,
} from "../lib/storage.js";
import { isRecordableTabUrl } from "../lib/recordable-tab.js";
import { isMeetingAskEnabled } from "../lib/client-config.js";
import { initSettingsForm } from "../lib/settings-form.js";
import { initTranscriptViewer } from "../lib/transcript-viewer.js";

const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopOnlyBtn = document.getElementById("stop-only-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const recordingActions = document.getElementById("recording-actions") as HTMLDivElement;
const statusSection = document.getElementById("status-section") as HTMLDivElement;
const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const recordingIndicator = document.getElementById("recording-indicator") as HTMLDivElement;
const timerEl = document.getElementById("timer") as HTMLSpanElement;
const historyList = document.getElementById("history-list") as HTMLUListElement;
const meetingAskOpenBtn = document.getElementById("meeting-ask-open-btn") as HTMLButtonElement;
const mainView = document.getElementById("main-view") as HTMLDivElement;
const transcriptView = document.getElementById("transcript-view") as HTMLDivElement;
const settingsView = document.getElementById("settings-view") as HTMLDivElement;
const settingsOpenBtn = document.getElementById("settings-open-btn") as HTMLButtonElement;
const settingsBackBtn = document.getElementById("settings-back-btn") as HTMLButtonElement;
const transcriptBackBtn = document.getElementById("transcript-back-btn") as HTMLButtonElement;
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
let popupWindowId: number | undefined;
void chrome.windows.getCurrent().then((win) => {
  popupWindowId = win.id;
});
const transcriptViewer = initTranscriptViewer({
  onCopied: (error) =>
    error ? setStatus(error, true) : setStatus("Transcript copied to clipboard"),
});

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
  meetingAskOpenBtn.addEventListener("click", () => void openAskSidePanel());
  await initSettingsForm(document.getElementById("settings-root")!);
  await applyMeetingAskVisibility();

  startBtn.addEventListener("click", () => void startRecording());
  stopOnlyBtn.addEventListener("click", () => void stopRecording(false));
  stopBtn.addEventListener("click", () => void stopRecording(true));

  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (status?.isRecording && status.startedAt) {
    enterRecordingUi(status.startedAt);
    const micNote = recordingMicNote(status);
    setStatus(`Recording (${micNote})`, !status.includedMic);
  }

  await hydrateHistoryFromServer();
  await refreshStaleHistory();
  await restoreTranscriptionProgressUi();
  await renderHistory();
  subscribeToHistoryUpdates();
}

function isLocalOnlyHistoryEntry(item: StoredRecording): boolean {
  return (
    Boolean(item.localAudioId) ||
    item.status === "saved" ||
    item.status === "upload_failed"
  );
}

function recordingMetaToStoredRecording(meta: RecordingMeta): StoredRecording {
  return {
    id: meta.id,
    meetingTitle: meta.meetingTitle,
    startedAt: meta.startedAt,
    durationMs: meta.durationMs,
    status: meta.status,
    error: meta.error,
    createdAt: meta.startedAt,
    notesStatus: meta.notesStatus,
    notesError: meta.notesError,
    deleteAudioAfterTranscription: meta.deleteAudioAfterTranscription,
    hasAudio: meta.hasAudio,
    hasMicAudio: meta.hasMicAudio,
  };
}

async function hydrateHistoryFromServer(): Promise<void> {
  const local = await getHistory();
  let remote: RecordingMeta[];
  try {
    remote = await fetchRecordings();
  } catch {
    return;
  }

  const localOnly = local.filter(isLocalOnlyHistoryEntry);
  const merged = [
    ...remote.map(recordingMetaToStoredRecording),
    ...localOnly.filter((item) => !remote.some((meta) => meta.id === item.id)),
  ].slice(0, 50);

  await saveHistory(merged);
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
  transcriptViewer.reset();
  void applyMeetingAskVisibility();
  // Refresh history so per-meeting Ask chips match the setting.
  void renderHistory();
}

async function applyMeetingAskVisibility(): Promise<void> {
  const settings = await getSettings();
  const enabled = isMeetingAskEnabled(settings);
  meetingAskOpenBtn.classList.toggle("hidden", !enabled);
}

async function openAskSidePanel({ closePopup = true } = {}): Promise<boolean> {
  // sidePanel.open must run inside the click gesture, so the window id is
  // resolved up front at popup load instead of awaited here.
  if (popupWindowId === undefined) {
    setStatus("Could not open Ask — try again", true);
    return false;
  }
  try {
    await chrome.sidePanel.open({ windowId: popupWindowId });
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    return false;
  }
  if (closePopup) {
    window.close();
  }
  return true;
}

async function askAboutRecordingInSidePanel(item: StoredRecording): Promise<void> {
  // Open first so sidePanel.open stays inside the click gesture; the panel
  // follows the shared Ask workspace, so it switches once the save lands.
  const opened = openAskSidePanel({ closePopup: false });
  await saveAskWorkspace(focusAskTabForRecording(await loadAskWorkspace(), item));
  if (await opened) {
    window.close();
  }
}

async function openTranscriptViewer(item: StoredRecording): Promise<void> {
  mainView.classList.add("hidden");
  settingsView.classList.add("hidden");
  transcriptView.classList.remove("hidden");
  await transcriptViewer.open(item);
}

function showSettings(open: boolean): void {
  if (open) {
    mainView.classList.add("hidden");
    settingsView.classList.remove("hidden");
    transcriptView.classList.add("hidden");
    transcriptViewer.reset();
    return;
  }
  showMainView();
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
  recordingActions.classList.remove("hidden");
  statusSection.classList.add("status-card--recording");
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
  recordingActions.classList.add("hidden");
  statusSection.classList.remove("status-card--recording");
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
  timerEl.textContent = formatRecordingElapsedSeconds(elapsed);
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

function createChipBtn(
  label: string,
  onClick: () => void,
  variant: "accent" | "default" | "ghost" | "danger" | "export" = "ghost",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  const classes = ["btn-chip"];
  if (variant === "ghost") {
    classes.push("btn-chip--ghost");
  } else if (variant === "accent") {
    classes.push("btn-chip--accent");
  } else if (variant === "danger") {
    classes.push("btn-chip--danger");
  } else if (variant === "export") {
    classes.push("btn-chip--export");
  }
  btn.className = classes.join(" ");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function meetingLlmModelShortLabel(model: string): string {
  switch (model) {
    case "gpt-4o-mini":
      return "4o mini";
    case "gpt-4o":
      return "4o";
    case "gpt-4.1-mini":
      return "4.1 mini";
    case "gpt-4.1":
      return "4.1";
    case "gpt-5.5":
      return "5.5";
    case "openai/gpt-4o-mini":
      return "OR 4o mini";
    case "openai/gpt-4o":
      return "OR 4o";
    case "openai/gpt-4.1-mini":
      return "OR 4.1 mini";
    case "openai/gpt-4.1":
      return "OR 4.1";
    case "anthropic/claude-sonnet-4":
      return "Claude 4";
    case "anthropic/claude-3.5-sonnet":
      return "Claude 3.5";
    case "google/gemini-2.5-flash":
      return "Gem 2.5";
    case "google/gemini-2.0-flash-001":
      return "Gem 2.0";
    case "meta-llama/llama-3.3-70b-instruct":
      return "Llama 3.3";
    case "deepseek/deepseek-chat":
      return "DeepSeek";
    default:
      return model.length > 14 ? `${model.slice(0, 12)}…` : model;
  }
}

function createHistoryDeleteBtn(
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-delete-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.textContent = "×";
  btn.addEventListener("click", onClick);
  return btn;
}

function createHistoryActions(opts?: { showExport?: boolean; showNotes?: boolean }): {
  root: HTMLDivElement;
  toolbar: HTMLDivElement;
  exportLinks: HTMLDivElement;
  notes: HTMLDivElement;
} {
  const root = document.createElement("div");
  root.className = "history-actions";

  const strip = document.createElement("div");
  strip.className = "history-action-strip";
  if (opts?.showExport === false) {
    strip.classList.add("history-action-strip--toolbar-only");
  }

  const toolbar = document.createElement("div");
  toolbar.className = "history-toolbar";

  const exportLinks = document.createElement("div");
  exportLinks.className = "history-export-links";
  exportLinks.hidden = opts?.showExport === false;

  const notes = document.createElement("div");
  notes.className = "history-notes-inline";
  notes.hidden = opts?.showNotes === false;

  strip.append(toolbar, exportLinks, notes);
  root.append(strip);
  return { root, toolbar, exportLinks, notes };
}

function appendHistoryHead(
  li: HTMLLIElement,
  item: { meetingTitle?: string; status: string },
  opts?: {
    onRemove?: () => void;
    removeLabel?: string;
  },
): void {
  const head = document.createElement("div");
  head.className = "history-item-head";

  const title = document.createElement("div");
  title.className = "history-title";
  title.textContent = item.meetingTitle ?? "Recording";
  title.title = item.meetingTitle ?? "Recording";

  const headRight = document.createElement("div");
  headRight.className = "history-head-right";
  headRight.appendChild(createStatusBadge(item.status));
  if (opts?.onRemove) {
    headRight.appendChild(
      createHistoryDeleteBtn(opts.removeLabel ?? "Remove", opts.onRemove),
    );
  }

  head.append(title, headRight);
  li.appendChild(head);
}

function appendHistoryMeta(
  li: HTMLLIElement,
  item: { startedAt: string; durationMs?: number },
): void {
  const meta = document.createElement("div");
  meta.className = "history-meta";

  const date = document.createElement("span");
  date.className = "history-date";
  const started = new Date(item.startedAt);
  date.textContent = started.toLocaleDateString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  date.title = started.toLocaleString();
  meta.appendChild(date);

  const durationLabel = formatRecordingDurationMs(item.durationMs);
  if (durationLabel) {
    const sep = document.createElement("span");
    sep.className = "history-meta-sep";
    sep.textContent = "·";
    sep.setAttribute("aria-hidden", "true");

    const duration = document.createElement("span");
    duration.className = "history-duration";
    duration.textContent = durationLabel;
    duration.title = "Recording duration";

    meta.appendChild(sep);
    meta.appendChild(duration);
  }

  li.appendChild(meta);
}

async function refreshStaleHistory(): Promise<void> {
  const history = await getHistory();
  for (const item of history) {
    const needsNotesPoll =
      item.status === "completed" &&
      !item.localAudioId &&
      (item.notesStatus === "pending" || item.notesStatus === "processing");
    const needsAudioSync =
      item.status === "completed" &&
      !item.localAudioId &&
      (item.hasAudio === undefined || item.deleteAudioAfterTranscription === false);
    const needsDurationSync =
      item.status === "completed" && !item.localAudioId && item.durationMs == null;
    if (
      item.status !== "processing" &&
      item.status !== "failed" &&
      !needsNotesPoll &&
      !needsAudioSync &&
      !needsDurationSync
    ) {
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
        meta.notesStatus !== item.notesStatus ||
        meta.hasAudio !== item.hasAudio ||
        meta.hasMicAudio !== item.hasMicAudio ||
        meta.durationMs !== item.durationMs
      ) {
        await updateHistoryEntry(item.id, {
          status: meta.status,
          error: meta.error,
          progress: meta.progress,
          notesStatus: meta.notesStatus,
          notesError: meta.notesError,
          hasAudio: meta.hasAudio,
          hasMicAudio: meta.hasMicAudio,
          deleteAudioAfterTranscription: meta.deleteAudioAfterTranscription,
          durationMs: meta.durationMs ?? item.durationMs,
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

async function regenerateNotes(
  id: string,
  settings: ExtensionSettings,
  modelSelect: HTMLSelectElement,
): Promise<void> {
  const provider = (settings.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER) as MeetingLlmProvider;
  const meetingLlmModel = coerceMeetingLlmModelForProvider(
    provider,
    modelSelect.value || settings.meetingLlmModel,
  );
  setStatus(`Regenerating notes with ${meetingLlmModelLabel(meetingLlmModel)}…`);
  try {
    await regenerateMeetingNotes(id, {
      meetingLlmProvider: provider,
      meetingLlmModel,
      ollamaUrl: settings.ollamaUrl,
      ollamaModel: provider === "ollama" ? meetingLlmModel : settings.ollamaModel,
    });
    await updateHistoryEntry(id, {
      notesStatus: "pending",
      notesError: undefined,
    });
    await renderHistory();
    void chrome.runtime.sendMessage({ type: "TRACK_MEETING_NOTES", recordingId: id });
    setStatus("Generating notes… — safe to close this popup");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function createNotesModelSelect(settings: ExtensionSettings): HTMLSelectElement {
  const provider = (settings.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER) as MeetingLlmProvider;
  const models = meetingLlmModelsForProvider(provider);
  const effective = coerceMeetingLlmModelForProvider(provider, settings.meetingLlmModel);
  const select = document.createElement("select");
  select.className = "history-notes-model";
  select.title = "Model for notes regeneration";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = meetingLlmModelShortLabel(model);
    option.title = meetingLlmModelLabel(model);
    select.appendChild(option);
  }
  select.value = effective;
  return select;
}

function appendNotesRegenerateControls(
  toolbar: HTMLElement,
  item: { id: string; notesStatus?: string; notesError?: string },
  settings: ExtensionSettings,
): void {
  if (item.notesStatus === "pending" || item.notesStatus === "processing") {
    const pending = document.createElement("span");
    pending.className = "history-notes-pending";
    pending.textContent = "Generating notes…";
    toolbar.appendChild(pending);
    return;
  }

  const select = createNotesModelSelect(settings);
  toolbar.appendChild(
    createChipBtn(
      "Gen Notes",
      () => void regenerateNotes(item.id, settings, select),
      "accent",
    ),
  );
  toolbar.appendChild(select);
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

function recordingFilenameBase(meetingTitle?: string): string {
  return (meetingTitle ?? "recording").replace(/[/\\?%*:|"<>]/g, "-");
}

function appendServerAudioDownloads(
  exportRow: HTMLDivElement,
  item: StoredRecording,
  hasMicTrack: boolean,
): void {
  const showTab = item.hasAudio === true || item.deleteAudioAfterTranscription === false;
  const showMic = hasMicTrack || item.hasMicAudio === true;
  if (!showTab && !showMic) {
    return;
  }

  const base = recordingFilenameBase(item.meetingTitle);
  if (showTab) {
    exportRow.appendChild(
      createChipBtn(
        showMic ? "Tab audio" : "Audio",
        () => {
          void downloadRecordingAudio(
            item.id,
            "tab",
            showMic ? `${base}-tab.webm` : `${base}.webm`,
          ).catch((err) => setStatus(err instanceof Error ? err.message : String(err), true));
        },
        "export",
      ),
    );
  }

  if (showMic) {
    exportRow.appendChild(
      createChipBtn("Mic audio", () => {
        void downloadRecordingAudio(item.id, "mic", `${base}-mic.webm`).catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err), true),
        );
      }, "export"),
    );
  }
}

function appendLocalAudioDownloadsOnly(
  exportRow: HTMLDivElement,
  item: { localAudioId?: string; meetingTitle?: string },
  hasMicTrack: boolean,
): void {
  if (!item.localAudioId) {
    return;
  }

  const base = recordingFilenameBase(item.meetingTitle);
  exportRow.appendChild(
    createChipBtn(hasMicTrack ? "Tab audio" : "Audio", () => {
      void downloadPendingAudio(
        item.localAudioId!,
        hasMicTrack ? `${base}-tab.webm` : `${base}.webm`,
        "tab",
      ).catch((err) => setStatus(err instanceof Error ? err.message : String(err), true));
    }, "export"),
  );

  if (hasMicTrack) {
    exportRow.appendChild(
      createChipBtn("Mic audio", () => {
        void downloadPendingAudio(item.localAudioId!, `${base}-mic.webm`, "mic").catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err), true),
        );
      }, "export"),
    );
  }
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

  const { root, toolbar, exportLinks } = createHistoryActions();

  toolbar.appendChild(
    createChipBtn(uploadLabel, () => void retryUpload(item.localAudioId!), "accent"),
  );
  appendLocalAudioDownloadsOnly(exportLinks, item, hasMicTrack);

  li.appendChild(root);
}

function historyRemoveLabel(item: {
  status: string;
  localAudioId?: string;
}): string | undefined {
  if (item.localAudioId) {
    return "Delete local recording";
  }
  if (
    item.status === "completed" ||
    item.status === "failed" ||
    item.status === "processing"
  ) {
    return "Delete recording";
  }
  return "Remove from list";
}

function appendHistoryHeader(
  li: HTMLLIElement,
  item: {
    meetingTitle?: string;
    status: string;
    startedAt: string;
    durationMs?: number;
    id: string;
    localAudioId?: string;
  },
): void {
  const removeLabel = historyRemoveLabel(item);
  appendHistoryHead(li, item, {
    onRemove: () => void removeFromHistory(item),
    removeLabel,
  });
  appendHistoryMeta(li, item);
}

async function renderHistory(): Promise<void> {
  const gen = ++historyRenderGen;
  const [history, settings] = await Promise.all([getHistory(), getSettings()]);
  if (gen !== historyRenderGen) {
    return;
  }

  historyList.innerHTML = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    const title = document.createElement("span");
    title.className = "history-empty-title";
    title.textContent = "No transcripts yet";
    const hint = document.createElement("span");
    hint.textContent = "Start a recording above to capture and transcribe a meeting.";
    li.append(title, hint);
    historyList.appendChild(li);
    return;
  }

  for (const item of history) {
    const li = document.createElement("li");
    li.className = "history-item";
    let hasMicTrack = false;
    let durationMs = item.durationMs;
    if (item.localAudioId) {
      const pending = await loadPendingAudio(item.localAudioId);
      if (gen !== historyRenderGen) {
        return;
      }
      hasMicTrack = Boolean(pending?.micBytes?.length);
      if (!durationMs && pending?.meta.durationMs) {
        durationMs = pending.meta.durationMs;
      }
    }

    appendHistoryHeader(li, { ...item, durationMs });

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

      const { root, toolbar } = createHistoryActions({
        showExport: false,
        showNotes: false,
      });
      toolbar.appendChild(
        createChipBtn("Retry transcription", () => void retryTranscription(item.id), "accent"),
      );
      li.appendChild(root);
    }

    if (item.status === "completed") {
      const { root, toolbar, exportLinks } = createHistoryActions({ showNotes: false });

      toolbar.appendChild(
        createChipBtn("View transcript", () => void openTranscriptViewer(item), "accent"),
      );
      if (isMeetingAskEnabled(settings)) {
        toolbar.appendChild(
          createChipBtn("Ask", () => void askAboutRecordingInSidePanel(item), "default"),
        );
      }

      if (item.notesStatus === "failed" && item.notesError) {
        const err = document.createElement("div");
        err.className = "history-error";
        err.textContent = item.notesError;
        li.appendChild(err);
      }

      appendNotesRegenerateControls(toolbar, item, settings);

      exportLinks.appendChild(
        createChipBtn("TXT", () => {
          void downloadTranscript(item.id, "txt").catch((err) =>
            setStatus(err instanceof Error ? err.message : String(err), true),
          );
        }, "export"),
      );
      exportLinks.appendChild(
        createChipBtn("JSON", () => {
          void downloadTranscript(item.id, "json").catch((err) =>
            setStatus(err instanceof Error ? err.message : String(err), true),
          );
        }, "export"),
      );

      if (item.localAudioId) {
        appendLocalAudioDownloadsOnly(exportLinks, item, hasMicTrack);
      } else {
        appendServerAudioDownloads(exportLinks, item, hasMicTrack);
      }

      if (item.notesStatus === "completed") {
        exportLinks.appendChild(
          createChipBtn("Notes", () => {
            void downloadMeetingNotes(item.id, "md").catch((err) =>
              setStatus(err instanceof Error ? err.message : String(err), true),
            );
          }, "export"),
        );
      }

      li.appendChild(root);
    }

    if (item.status === "processing") {
      const progressBar = createProgressBarElement(item.id, item.progress);
      if (progressBar) {
        li.appendChild(progressBar);
      }
    }

    if (gen !== historyRenderGen) {
      return;
    }
    historyList.appendChild(li);
  }
}

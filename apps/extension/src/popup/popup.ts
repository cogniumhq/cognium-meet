import type {
  ExtensionSettings,
  MeetingAskCitation,
  MeetingAskMessage,
  RecordingMeta,
  TranscriptResult,
  TranscriptSegment,
  TranscriptionProgress,
} from "@cognium/meet-shared";
import {
  formatRecordingDurationMs,
  formatRecordingElapsedSeconds,
  formatTimestamp,
  isTranscriptionProgressActive,
  mergeTranscriptionProgress,
  segmentsToPlainText,
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
  fetchTranscript,
  regenerateMeetingNotes,
  retryRecording,
} from "../lib/upload.js";
import { deletePendingAudio, downloadPendingAudio, loadPendingAudio } from "../lib/pending-audio-store.js";
import {
  addAskTab,
  ASK_WORKSPACE_KEY,
  createAskTab,
  findPendingAskTab,
  findServerProcessingEntry,
  getActiveAskTab,
  getHistory,
  getSettings,
  HISTORY_KEY,
  loadAskWorkspace,
  MAX_ASK_TABS,
  removeAskTab,
  removeHistoryEntry,
  saveHistory,
  saveAskWorkspace,
  setActiveAskTab,
  updateAskTab,
  updateHistoryEntry,
  type AskChatWorkspace,
  type StoredRecording,
} from "../lib/storage.js";
import { isRecordableTabUrl } from "../lib/recordable-tab.js";
import { isMeetingAskEnabled } from "../lib/client-config.js";
import { canRetryAsk, messagesForAskRetry } from "../lib/ask-chat.js";
import { initSettingsForm } from "../lib/settings-form.js";

const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopOnlyBtn = document.getElementById("stop-only-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const recordingActions = document.getElementById("recording-actions") as HTMLDivElement;
const statusSection = document.getElementById("status-section") as HTMLDivElement;
const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const recordingIndicator = document.getElementById("recording-indicator") as HTMLDivElement;
const timerEl = document.getElementById("timer") as HTMLSpanElement;
const historyList = document.getElementById("history-list") as HTMLUListElement;
const meetingAskWrap = document.getElementById("meeting-ask-wrap") as HTMLDivElement;
const meetingAskSection = document.getElementById("meeting-ask-section") as HTMLElement;
const meetingAskToggle = document.getElementById("meeting-ask-toggle") as HTMLButtonElement;
const meetingAskBody = document.getElementById("meeting-ask-body") as HTMLDivElement;
const meetingAsk = document.getElementById("meeting-ask") as HTMLTextAreaElement;
const meetingAskLabel = document.getElementById("meeting-ask-label") as HTMLLabelElement;
const meetingAskBtn = document.getElementById("meeting-ask-btn") as HTMLButtonElement;
const meetingAskCancelBtn = document.getElementById(
  "meeting-ask-cancel-btn",
) as HTMLButtonElement;
const meetingAskClearScope = document.getElementById(
  "meeting-ask-clear-scope",
) as HTMLButtonElement;
const meetingAskClearChat = document.getElementById(
  "meeting-ask-clear-chat",
) as HTMLButtonElement;
const meetingAskThread = document.getElementById("meeting-ask-thread") as HTMLDivElement;
const meetingAskTabs = document.getElementById("meeting-ask-tabs") as HTMLDivElement;
const meetingAskNewTab = document.getElementById("meeting-ask-new-tab") as HTMLButtonElement;
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
let askActiveTabId = "";
let askScopeRecordingId: string | undefined;
let askScopeMeetingTitle: string | undefined;
let askMessages: MeetingAskMessage[] = [];
let askChatSaveTimer: number | undefined;
let askLoading = false;
let askSectionOpen = false;

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
  meetingAskCancelBtn.addEventListener("click", () => void cancelMeetingAsk());
  meetingAskToggle.addEventListener("click", () => setAskSectionOpen(!askSectionOpen));
  meetingAskNewTab.addEventListener("click", (event) => {
    event.stopPropagation();
    void createNewAskTab();
  });
  meetingAskClearScope.addEventListener("click", () => void setAskScope());
  meetingAskClearChat.addEventListener("click", () => void clearAskChatUi());
  meetingAsk.addEventListener("input", () => scheduleSaveAskChat());
  meetingAsk.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void runMeetingAsk();
    }
  });
  window.addEventListener("pagehide", () => {
    window.clearTimeout(askChatSaveTimer);
    void persistActiveTab();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[ASK_WORKSPACE_KEY]) {
      void refreshAskFromStorage();
    }
  });
  await initSettingsForm(document.getElementById("settings-root")!);
  await applyMeetingAskVisibility();
  try {
    await restoreAskChat();
  } catch (err) {
    console.error("[popup] restore Ask chat failed", err);
  }

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
  currentTranscript = undefined;
  void applyMeetingAskVisibility();
}

async function applyMeetingAskVisibility(): Promise<void> {
  const settings = await getSettings();
  const enabled = isMeetingAskEnabled(settings);
  meetingAskSection.classList.toggle("hidden", !enabled);
  if (!enabled) {
    return;
  }
  syncAskSectionOpen();
}

function setAskSectionOpen(open: boolean): void {
  askSectionOpen = open;
  meetingAskBody.classList.toggle("collapsed", !open);
  meetingAskSection.classList.toggle("meeting-ask-section--open", open);
  meetingAskToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncAskSectionOpen(): void {
  const hasActivity =
    askMessages.length > 0 || askLoading || Boolean(askScopeRecordingId) || meetingAsk.value.trim();
  if (hasActivity) {
    setAskSectionOpen(true);
  }
}

function updateAskScopeChrome(): void {
  if (askScopeRecordingId) {
    meetingAskLabel.textContent = `Ask about: ${askScopeMeetingTitle ?? "Recording"}`;
    meetingAskClearScope.classList.remove("hidden");
  } else {
    meetingAskLabel.textContent = "Ask about your meetings";
    meetingAskClearScope.classList.add("hidden");
  }
}

function applyActiveTabToUi(tab: {
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  messages: MeetingAskMessage[];
  draftInput?: string;
  pending?: boolean;
}): void {
  askScopeRecordingId = tab.scopeRecordingId;
  askScopeMeetingTitle = tab.scopeMeetingTitle;
  askMessages = tab.messages ?? [];
  askLoading = tab.pending === true;
  meetingAsk.value = tab.draftInput ?? "";
  updateAskScopeChrome();
}

function renderAskTabs(workspace: AskChatWorkspace): void {
  meetingAskTabs.innerHTML = "";

  for (const tab of workspace.tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meeting-ask-tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", tab.id === workspace.activeTabId ? "true" : "false");
    if (tab.id === workspace.activeTabId) {
      btn.classList.add("meeting-ask-tab--active");
    }
    if (tab.pending) {
      btn.classList.add("meeting-ask-tab--pending");
    }

    const label = document.createElement("span");
    label.className = "meeting-ask-tab-label";
    label.textContent = tab.label;
    btn.appendChild(label);

    if (workspace.tabs.length > 1) {
      const close = document.createElement("span");
      close.className = "meeting-ask-tab-close";
      close.setAttribute("aria-label", "Close chat");
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeAskTab(tab.id);
      });
      btn.appendChild(close);
    }

    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      void switchAskTab(tab.id);
    });
    meetingAskTabs.appendChild(btn);
  }

  meetingAskNewTab.disabled = workspace.tabs.length >= MAX_ASK_TABS;
}

async function persistActiveTab(pending = askLoading): Promise<void> {
  if (!askActiveTabId) {
    return;
  }
  let workspace = await loadAskWorkspace();
  workspace = updateAskTab(workspace, askActiveTabId, {
    scopeRecordingId: askScopeRecordingId,
    scopeMeetingTitle: askScopeMeetingTitle,
    messages: askMessages,
    draftInput: meetingAsk.value,
    pending,
  });
  await saveAskWorkspace(workspace);
}

async function switchAskTab(tabId: string): Promise<void> {
  if (tabId === askActiveTabId) {
    return;
  }
  await persistActiveTab(askLoading);
  let workspace = await loadAskWorkspace();
  workspace = setActiveAskTab(workspace, tabId);
  await saveAskWorkspace(workspace);
  await refreshAskFromStorage();
}

async function createNewAskTab(opts?: {
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
}): Promise<void> {
  setAskSectionOpen(true);
  await persistActiveTab(askLoading);
  let workspace = await loadAskWorkspace();
  if (workspace.tabs.length >= MAX_ASK_TABS) {
    return;
  }
  const tab = createAskTab(opts);
  workspace = addAskTab(workspace, tab);
  await saveAskWorkspace(workspace);
  await refreshAskFromStorage();
  meetingAsk.focus();
}

async function openAskForRecording(item: StoredRecording): Promise<void> {
  setAskSectionOpen(true);
  await persistActiveTab(askLoading);
  const workspace = await loadAskWorkspace();
  const existing = workspace.tabs.find((tab) => tab.scopeRecordingId === item.id);
  if (existing) {
    await switchAskTab(existing.id);
    meetingAsk.focus();
    return;
  }
  await createNewAskTab({
    scopeRecordingId: item.id,
    scopeMeetingTitle: item.meetingTitle,
  });
}

async function closeAskTab(tabId: string): Promise<void> {
  const workspace = await loadAskWorkspace();
  const closing = workspace.tabs.find((tab) => tab.id === tabId);
  if (!closing) {
    return;
  }
  if (closing.pending) {
    await cancelMeetingAsk();
  }
  if (tabId === askActiveTabId) {
    askMessages = [];
    meetingAsk.value = "";
    askLoading = false;
  }
  const next = removeAskTab(workspace, tabId);
  await saveAskWorkspace(next);
  await refreshAskFromStorage();
}

async function setAskScope(item?: StoredRecording): Promise<void> {
  const prevScope = askScopeRecordingId;
  await persistActiveTab(askLoading);
  askScopeRecordingId = item?.id;
  askScopeMeetingTitle = item?.meetingTitle;
  if (prevScope !== askScopeRecordingId && askMessages.length > 0) {
    askMessages = [];
    renderAskThread();
  }
  updateAskScopeChrome();
  updateAskChrome();
  await persistActiveTab();
  if (item) {
    meetingAsk.focus();
  }
}

function updateAskChrome(): void {
  if (askMessages.length > 0 || askLoading) {
    meetingAskClearChat.classList.remove("hidden");
  } else {
    meetingAskClearChat.classList.add("hidden");
  }
  const anyPending = askLoading;
  meetingAskBtn.classList.toggle("hidden", anyPending);
  meetingAskCancelBtn.classList.toggle("hidden", !anyPending);
  meetingAsk.disabled = anyPending;
  syncAskSectionOpen();
}

function scheduleSaveAskChat(): void {
  window.clearTimeout(askChatSaveTimer);
  askChatSaveTimer = window.setTimeout(() => {
    void persistActiveTab();
  }, 250);
}

async function refreshAskFromStorage(): Promise<void> {
  const workspace = await loadAskWorkspace();
  const active = getActiveAskTab(workspace);
  askActiveTabId = active.id;
  applyActiveTabToUi(active);
  renderAskTabs(workspace);
  meetingAskBtn.disabled = askLoading;
  updateAskChrome();
  renderAskThread();
}

async function restoreAskChat(): Promise<void> {
  await refreshAskFromStorage();
  const workspace = await loadAskWorkspace();
  if (findPendingAskTab(workspace)) {
    void resumeMeetingAskIfNeeded();
  }
}

async function resumeMeetingAskIfNeeded(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "ASK_MEETINGS" });
  } catch {
    // Background may still be processing; storage listener will update the UI.
  }
}

async function clearAskChatUi(): Promise<void> {
  askMessages = [];
  askLoading = false;
  meetingAsk.value = "";
  meetingAskBtn.disabled = false;
  renderAskThread();
  updateAskChrome();
  await persistActiveTab(false);
  const workspace = await loadAskWorkspace();
  renderAskTabs(workspace);
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

function appendCitationButtons(parent: HTMLElement, citations: MeetingAskCitation[]): void {
  if (citations.length === 0) {
    return;
  }

  const heading = document.createElement("p");
  heading.className = "meeting-ask-sources-title";
  heading.textContent =
    citations.length === 1 ? "Sources" : `Sources (${citations.length})`;
  parent.appendChild(heading);

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

  parent.appendChild(list);
}

function renderAskThread(): void {
  meetingAskThread.innerHTML = "";

  if (askMessages.length === 0 && !askLoading) {
    meetingAskThread.classList.add("hidden");
    return;
  }

  meetingAskThread.classList.remove("hidden");

  for (let i = 0; i < askMessages.length; i++) {
    const message = askMessages[i];
    const bubble = document.createElement("div");
    bubble.className = `meeting-ask-bubble meeting-ask-bubble--${message.role}`;
    if (message.role === "assistant") {
      if (message.isError) {
        bubble.classList.add("meeting-ask-bubble--error");
      } else if (message.insufficientContext) {
        bubble.classList.add("meeting-ask-bubble--weak");
      }
    }

    const text = document.createElement("div");
    text.className = "meeting-ask-bubble-text";
    text.textContent = message.content;
    bubble.appendChild(text);

    if (message.role === "assistant" && message.citations?.length) {
      appendCitationButtons(bubble, message.citations);
    }

    const isLast = i === askMessages.length - 1;
    if (
      message.role === "assistant" &&
      message.isError &&
      isLast &&
      canRetryAsk(askMessages, askLoading)
    ) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "meeting-ask-retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => void retryMeetingAsk());
      bubble.appendChild(retryBtn);
    }

    meetingAskThread.appendChild(bubble);
  }

  if (askLoading) {
    const loading = document.createElement("div");
    loading.className = "meeting-ask-bubble meeting-ask-bubble--assistant meeting-ask-bubble--loading";
    loading.textContent = "Thinking…";
    meetingAskThread.appendChild(loading);
  }

  meetingAskThread.scrollTop = meetingAskThread.scrollHeight;
}

async function submitPendingAsk(): Promise<void> {
  try {
    const result = (await chrome.runtime.sendMessage({ type: "ASK_MEETINGS" })) as
      | { ok?: boolean; error?: string }
      | undefined;

    if (result?.ok === false && result.error === "No pending ask") {
      askLoading = false;
      meetingAskBtn.disabled = false;
      await persistActiveTab(false);
      renderAskThread();
      updateAskChrome();
      return;
    }

    await refreshAskFromStorage();
    if (!askLoading) {
      meetingAsk.focus();
    }
  } catch {
    // Popup may close while the background worker finishes the ask.
    await refreshAskFromStorage();
  }
}

async function retryMeetingAsk(): Promise<void> {
  if (askLoading) {
    return;
  }

  if (!messagesForAskRetry(askMessages)) {
    return;
  }

  askLoading = true;
  updateAskChrome();
  renderAskThread();

  try {
    await chrome.runtime.sendMessage({ type: "ASK_RETRY" });
    await refreshAskFromStorage();
    if (!askLoading) {
      meetingAsk.focus();
    }
  } catch {
    await refreshAskFromStorage();
  }
}

async function cancelMeetingAsk(): Promise<void> {
  if (!askLoading) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: "ASK_CANCEL" });
  } catch {
    // Service worker may be unavailable; still clear local pending state.
  }

  askLoading = false;
  meetingAskBtn.disabled = false;
  await persistActiveTab(false);
  renderAskThread();
  updateAskChrome();
}

async function runMeetingAsk(): Promise<void> {
  const question = meetingAsk.value.trim();
  if (!question || askLoading) {
    return;
  }

  const workspace = await loadAskWorkspace();
  if (findPendingAskTab(workspace)) {
    return;
  }

  askMessages.push({ role: "user", content: question });
  meetingAsk.value = "";
  askLoading = true;
  meetingAskBtn.disabled = true;
  updateAskChrome();
  renderAskThread();
  await persistActiveTab(true);
  await submitPendingAsk();
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
  variant: "accent" | "default" | "ghost" | "danger" = "ghost",
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
  }
  btn.className = classes.join(" ");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function createHistoryActions(): {
  root: HTMLDivElement;
  primary: HTMLDivElement;
  export: HTMLDivElement;
  footer: HTMLDivElement;
} {
  const root = document.createElement("div");
  root.className = "history-actions";
  const primary = document.createElement("div");
  primary.className = "history-actions-primary";
  const secondary = document.createElement("div");
  secondary.className = "history-actions-secondary";
  const exportRow = document.createElement("div");
  exportRow.className = "history-actions-export";
  const footer = document.createElement("div");
  footer.className = "history-actions-footer";
  secondary.append(exportRow, footer);
  root.append(primary, secondary);
  return { root, primary, export: exportRow, footer };
}

function appendHistoryHead(
  li: HTMLLIElement,
  item: { meetingTitle?: string; status: string },
): void {
  const head = document.createElement("div");
  head.className = "history-item-head";

  const title = document.createElement("div");
  title.className = "history-title";
  title.textContent = item.meetingTitle ?? "Recording";

  head.appendChild(title);
  head.appendChild(createStatusBadge(item.status));
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
  date.textContent = new Date(item.startedAt).toLocaleString();
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
    option.textContent = meetingLlmModelLabel(model);
    select.appendChild(option);
  }
  select.value = effective;
  return select;
}

function appendNotesRegenerateControls(
  parent: HTMLElement,
  item: { id: string; notesStatus?: string; notesError?: string },
  settings: ExtensionSettings,
): void {
  if (item.notesStatus === "pending" || item.notesStatus === "processing") {
    const pending = document.createElement("span");
    pending.className = "history-notes-pending";
    pending.textContent = "Generating notes…";
    parent.appendChild(pending);
    return;
  }

  if (item.notesStatus === "failed" && item.notesError) {
    const err = document.createElement("div");
    err.className = "history-error";
    err.textContent = item.notesError;
    parent.appendChild(err);
  }

  if (item.notesStatus !== "pending" && item.notesStatus !== "processing") {
    const row = document.createElement("div");
    row.className = "history-notes-regenerate";
    const select = createNotesModelSelect(settings);
    row.appendChild(select);
    row.appendChild(
      createChipBtn(
        "Regenerate notes",
        () => void regenerateNotes(item.id, settings, select),
        "accent",
      ),
    );
    parent.appendChild(row);
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
      ),
    );
  }

  if (showMic) {
    exportRow.appendChild(
      createChipBtn("Mic audio", () => {
        void downloadRecordingAudio(item.id, "mic", `${base}-mic.webm`).catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err), true),
        );
      }),
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
    }),
  );

  if (hasMicTrack) {
    exportRow.appendChild(
      createChipBtn("Mic audio", () => {
        void downloadPendingAudio(item.localAudioId!, `${base}-mic.webm`, "mic").catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err), true),
        );
      }),
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

  const { root, primary, export: exportRow, footer } = createHistoryActions();

  primary.appendChild(
    createChipBtn(uploadLabel, () => void retryUpload(item.localAudioId!), "accent"),
  );
  appendLocalAudioDownloadsOnly(exportRow, item, hasMicTrack);

  footer.appendChild(
    createChipBtn("Delete local", () => void deleteLocalRecording(item), "danger"),
  );

  li.appendChild(root);
}

function appendRemoveAction(
  li: HTMLLIElement,
  item: { id: string; meetingTitle?: string; status: string; localAudioId?: string },
  footer?: HTMLDivElement,
): void {
  const onServer =
    !item.localAudioId &&
    (item.status === "completed" ||
      item.status === "failed" ||
      item.status === "processing");

  const remove = createChipBtn(
    onServer ? "Delete" : "Remove",
    () => void removeFromHistory(item),
    "danger",
  );

  if (footer) {
    footer.appendChild(remove);
    return;
  }

  const container = document.createElement("div");
  container.className = "history-actions-footer";
  container.appendChild(remove);
  li.appendChild(container);
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

    appendHistoryHead(li, item);
    appendHistoryMeta(li, { ...item, durationMs });

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

      const { root, primary, footer } = createHistoryActions();
      primary.appendChild(
        createChipBtn("Retry transcription", () => void retryTranscription(item.id), "accent"),
      );
      appendRemoveAction(li, item, footer);
      li.appendChild(root);
    }

    if (item.status === "completed") {
      const { root, primary, export: exportRow, footer } = createHistoryActions();

      primary.appendChild(
        createChipBtn("View transcript", () => void openTranscriptViewer(item), "accent"),
      );
      primary.appendChild(
        createChipBtn("Ask", () => void openAskForRecording(item), "ghost"),
      );

      exportRow.appendChild(
        createChipBtn("TXT", () => {
          void downloadTranscript(item.id, "txt").catch((err) =>
            setStatus(err instanceof Error ? err.message : String(err), true),
          );
        }),
      );
      exportRow.appendChild(
        createChipBtn("JSON", () => {
          void downloadTranscript(item.id, "json").catch((err) =>
            setStatus(err instanceof Error ? err.message : String(err), true),
          );
        }),
      );

      if (item.localAudioId) {
        appendLocalAudioDownloadsOnly(exportRow, item, hasMicTrack);
      } else {
        appendServerAudioDownloads(exportRow, item, hasMicTrack);
      }

      if (item.notesStatus === "completed") {
        exportRow.appendChild(
          createChipBtn("Notes", () => {
            void downloadMeetingNotes(item.id, "md").catch((err) =>
              setStatus(err instanceof Error ? err.message : String(err), true),
            );
          }),
        );
      }

      appendNotesRegenerateControls(exportRow, item, settings);

      appendRemoveAction(li, item, footer);
      li.appendChild(root);
    }

    if (item.status === "processing") {
      const progressBar = createProgressBarElement(item.id, item.progress);
      if (progressBar) {
        li.appendChild(progressBar);
      }
      const { root, footer } = createHistoryActions();
      appendRemoveAction(li, item, footer);
      li.appendChild(root);
    }

    if (gen !== historyRenderGen) {
      return;
    }
    historyList.appendChild(li);
  }
}

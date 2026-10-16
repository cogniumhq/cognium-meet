import type { MeetingAskCitation, MeetingAskMessage } from "@cognium/meet-shared";
import {
  addAskTab,
  ASK_WORKSPACE_KEY,
  createAskTab,
  findPendingAskTab,
  formatMeetingScopeLabel,
  getActiveAskTab,
  focusAskTabForRecording,
  getHistory,
  HISTORY_KEY,
  loadAskWorkspace,
  MAX_ASK_TABS,
  removeAskTab,
  saveAskWorkspace,
  setActiveAskTab,
  updateAskTab,
  type AskChatWorkspace,
  type StoredRecording,
} from "./storage.js";
import { canRetryAsk, messagesForAskRetry } from "./ask-chat.js";
import { formatRelativeDateTime } from "./format-date.js";
import { showAlert, showConfirm } from "./confirm-dialog.js";

/**
 * Ask chat UI for the side panel. Expects the `meeting-ask-*` element ids
 * from the page markup. State lives in chrome.storage, so the popup can pick
 * which chat is active and the panel follows.
 */
export interface AskPanelOptions {
  onOpenCitation: (item: StoredRecording) => void;
}

const meetingAsk = document.getElementById("meeting-ask") as HTMLTextAreaElement;
const meetingAskScope = document.getElementById("meeting-ask-scope") as HTMLSelectElement;
const meetingAskBtn = document.getElementById("meeting-ask-btn") as HTMLButtonElement;
const meetingAskCancelBtn = document.getElementById(
  "meeting-ask-cancel-btn",
) as HTMLButtonElement;
const meetingAskClearChat = document.getElementById(
  "meeting-ask-clear-chat",
) as HTMLButtonElement;
const meetingAskThread = document.getElementById("meeting-ask-thread") as HTMLDivElement;
const meetingAskTabs = document.getElementById("meeting-ask-tabs") as HTMLDivElement;
const meetingAskNewTab = document.getElementById("meeting-ask-new-tab") as HTMLButtonElement;

let options: AskPanelOptions = { onOpenCitation: () => {} };
let askActiveTabId = "";
let askScopeRecordingId: string | undefined;
let askScopeMeetingTitle: string | undefined;
let askScopeStartedAt: string | undefined;
let askScopeDurationMs: number | undefined;
let askMessages: MeetingAskMessage[] = [];
let askChatSaveTimer: number | undefined;
let askLoading = false;
let askHistory: StoredRecording[] = [];

const COMPOSER_MAX_HEIGHT_PX = 160;
const ALL_MEETINGS_SUGGESTIONS = [
  "What action items were assigned to me?",
  "What decisions did we make this week?",
  "Which meetings mentioned pricing?",
];
const MEETING_SUGGESTIONS = [
  "Summarize this meeting",
  "What were the action items and owners?",
  "What decisions were made?",
  "What open questions are left?",
];

export async function initAskPanel(opts: AskPanelOptions): Promise<void> {
  options = opts;
  meetingAskBtn.addEventListener("click", () => void runMeetingAsk());
  meetingAskCancelBtn.addEventListener("click", () => void cancelMeetingAsk());
  meetingAskNewTab.addEventListener("click", (event) => {
    event.stopPropagation();
    void createNewAskTab();
  });
  meetingAskScope.addEventListener("change", () => void changeAskScope(meetingAskScope.value));
  meetingAskClearChat.addEventListener("click", () => void clearAskChatUi());
  meetingAsk.addEventListener("input", () => {
    autosizeComposer();
    updateSendState();
    scheduleSaveAskChat();
  });
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
    if (area === "local" && (changes[ASK_WORKSPACE_KEY] || changes[HISTORY_KEY])) {
      void refreshAskFromStorage();
    }
  });
  try {
    await restoreAskChat();
  } catch (err) {
    console.error("[ask] restore Ask chat failed", err);
  }
}

function isAskableRecording(item: StoredRecording): boolean {
  return item.status === "completed";
}

function scopeOptionLabel(title: string | undefined, startedAt: string | undefined): string {
  const name = title?.trim() || "Recording";
  const when = startedAt ? formatRelativeDateTime(startedAt) : "";
  return when ? `${name} · ${when}` : name;
}

function updateAskScopeChrome(): void {
  meetingAskScope.innerHTML = "";
  meetingAskScope.appendChild(new Option("All meetings", ""));

  const recordings = askHistory.filter(isAskableRecording);
  for (const item of recordings) {
    meetingAskScope.appendChild(
      new Option(scopeOptionLabel(item.meetingTitle, item.startedAt), item.id),
    );
  }
  // Keep a scoped chat selectable even if its recording left the history list.
  if (askScopeRecordingId && !recordings.some((item) => item.id === askScopeRecordingId)) {
    meetingAskScope.appendChild(
      new Option(scopeOptionLabel(askScopeMeetingTitle, askScopeStartedAt), askScopeRecordingId),
    );
  }

  meetingAskScope.value = askScopeRecordingId ?? "";
  meetingAskScope.title = askScopeRecordingId
    ? formatMeetingScopeLabel(askScopeMeetingTitle, {
        startedAt: askScopeStartedAt,
        durationMs: askScopeDurationMs,
      })
    : "Search across all your meetings";
  meetingAskScope.disabled = askLoading;
}

/**
 * Change what the active chat is about. An empty chat is re-scoped in place;
 * a chat with messages is kept and another chat opens for the new scope.
 */
async function changeAskScope(recordingId: string): Promise<void> {
  if (recordingId === (askScopeRecordingId ?? "")) {
    return;
  }
  const item = recordingId
    ? askHistory.find((entry) => entry.id === recordingId)
    : undefined;
  const workspace = await loadAskWorkspace();
  const existing = item
    ? workspace.tabs.find((tab) => tab.scopeRecordingId === item.id)
    : undefined;
  const activeIsEmpty = askMessages.length === 0 && !askLoading;

  if (!existing && activeIsEmpty) {
    await setAskScope(item);
    renderAskThread();
    return;
  }

  await persistActiveTab(askLoading);
  let next = await loadAskWorkspace();
  if (item) {
    next = focusAskTabForRecording(next, item);
  } else {
    const emptyAllTab = next.tabs.find(
      (tab) => !tab.scopeRecordingId && tab.messages.length === 0 && !tab.pending,
    );
    next = emptyAllTab
      ? setActiveAskTab(next, emptyAllTab.id)
      : addAskTab(next, createAskTab());
  }
  if (next.activeTabId === askActiveTabId) {
    // Tab limit reached — nothing new could open.
    await showAlert(`You can have up to ${MAX_ASK_TABS} chats`, "Close one to start another.");
    updateAskScopeChrome();
    return;
  }
  await saveAskWorkspace(next);
  await refreshAskFromStorage();
  meetingAsk.focus();
}

function autosizeComposer(): void {
  meetingAsk.style.height = "auto";
  meetingAsk.style.height = `${Math.min(meetingAsk.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}

function updateSendState(): void {
  meetingAskBtn.disabled = askLoading || !meetingAsk.value.trim();
}

function applyActiveTabToUi(tab: {
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  scopeStartedAt?: string;
  scopeDurationMs?: number;
  messages: MeetingAskMessage[];
  draftInput?: string;
  pending?: boolean;
}): void {
  askScopeRecordingId = tab.scopeRecordingId;
  askScopeMeetingTitle = tab.scopeMeetingTitle;
  askScopeStartedAt = tab.scopeStartedAt;
  askScopeDurationMs = tab.scopeDurationMs;
  askMessages = tab.messages ?? [];
  askLoading = tab.pending === true;
  meetingAsk.value = tab.draftInput ?? "";
  autosizeComposer();
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
    if (tab.scopeRecordingId) {
      label.title = formatMeetingScopeLabel(tab.scopeMeetingTitle, {
        startedAt: tab.scopeStartedAt,
        durationMs: tab.scopeDurationMs,
      });
    }
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
    scopeStartedAt: askScopeStartedAt,
    scopeDurationMs: askScopeDurationMs,
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

async function createNewAskTab(): Promise<void> {
  await persistActiveTab(askLoading);
  let workspace = await loadAskWorkspace();
  if (workspace.tabs.length >= MAX_ASK_TABS) {
    return;
  }
  const tab = createAskTab();
  workspace = addAskTab(workspace, tab);
  await saveAskWorkspace(workspace);
  await refreshAskFromStorage();
  meetingAsk.focus();
}

function askTabClosePrompt(tab: {
  label: string;
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  scopeStartedAt?: string;
  scopeDurationMs?: number;
}): Promise<boolean> {
  const name = tab.scopeRecordingId
    ? formatMeetingScopeLabel(tab.scopeMeetingTitle, {
        startedAt: tab.scopeStartedAt,
        durationMs: tab.scopeDurationMs,
      })
    : tab.label.trim() || "this chat";

  return showConfirm({
    title: `Close "${name}"?`,
    message: "Messages in this chat will be deleted.",
    confirmLabel: "Close chat",
    danger: true,
  });
}

async function closeAskTab(tabId: string): Promise<void> {
  const workspace = await loadAskWorkspace();
  const closing = workspace.tabs.find((tab) => tab.id === tabId);
  if (!closing) {
    return;
  }
  if (!(await askTabClosePrompt(closing))) {
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

/** Re-scope the active (empty) chat in place. */
async function setAskScope(item?: StoredRecording): Promise<void> {
  // Update memory and storage in one write: an intermediate save would fire
  // a storage refresh that restores the old scope before this one lands.
  askScopeRecordingId = item?.id;
  askScopeMeetingTitle = item?.meetingTitle;
  askScopeStartedAt = item?.startedAt;
  askScopeDurationMs = item?.durationMs;
  updateAskScopeChrome();
  updateAskChrome();
  await persistActiveTab();
  meetingAsk.focus();
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
  meetingAskScope.disabled = anyPending;
  updateSendState();
}

function scheduleSaveAskChat(): void {
  window.clearTimeout(askChatSaveTimer);
  askChatSaveTimer = window.setTimeout(() => {
    void persistActiveTab();
  }, 250);
}

async function refreshAskFromStorage(): Promise<void> {
  let workspace = await loadAskWorkspace();
  const history = await getHistory();
  askHistory = history;
  let enriched = false;

  for (const tab of workspace.tabs) {
    if (!tab.scopeRecordingId || tab.scopeStartedAt) {
      continue;
    }
    const match = history.find((item) => item.id === tab.scopeRecordingId);
    if (!match) {
      continue;
    }
    workspace = updateAskTab(workspace, tab.id, {
      scopeMeetingTitle: tab.scopeMeetingTitle ?? match.meetingTitle,
      scopeStartedAt: match.startedAt,
      scopeDurationMs: match.durationMs,
    });
    enriched = true;
  }

  if (enriched) {
    await saveAskWorkspace(workspace);
  }

  const active = getActiveAskTab(workspace);
  askActiveTabId = active.id;
  applyActiveTabToUi(active);
  renderAskTabs(workspace);
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
  autosizeComposer();
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
      options.onOpenCitation(citationToRecording(citation));
    });
    li.appendChild(btn);
    list.appendChild(li);
  }

  parent.appendChild(list);
}

function renderAskThread(): void {
  meetingAskThread.innerHTML = "";

  if (askMessages.length === 0 && !askLoading) {
    renderAskEmptyState();
    return;
  }

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

    if (message.role === "assistant" && !message.isError) {
      bubble.appendChild(createCopyButton(message.content));
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

function renderAskEmptyState(): void {
  const empty = document.createElement("div");
  empty.className = "meeting-ask-empty";

  const title = document.createElement("p");
  title.className = "meeting-ask-empty-title";
  title.textContent = askScopeRecordingId
    ? `Ask about “${askScopeMeetingTitle?.trim() || "this recording"}”`
    : "Ask across all your meetings";
  empty.appendChild(title);

  const hasRecordings = askHistory.some(isAskableRecording);
  const hint = document.createElement("p");
  hint.className = "meeting-ask-empty-hint";
  hint.textContent = hasRecordings
    ? "Answers come from your transcripts and notes, with links to the sources."
    : "Record and transcribe a meeting first — then ask anything about it here.";
  empty.appendChild(hint);

  if (hasRecordings || askScopeRecordingId) {
    const list = document.createElement("div");
    list.className = "meeting-ask-suggestions";
    const suggestions = askScopeRecordingId ? MEETING_SUGGESTIONS : ALL_MEETINGS_SUGGESTIONS;
    for (const suggestion of suggestions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meeting-ask-suggestion";
      btn.textContent = suggestion;
      btn.addEventListener("click", () => {
        meetingAsk.value = suggestion;
        void runMeetingAsk();
      });
      list.appendChild(btn);
    }
    empty.appendChild(list);
  }

  meetingAskThread.appendChild(empty);
}

function createCopyButton(text: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "meeting-ask-copy-btn";
  btn.textContent = "Copy";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed";
    }
    window.setTimeout(() => {
      btn.textContent = "Copy";
    }, 1500);
  });
  return btn;
}

async function submitPendingAsk(): Promise<void> {
  try {
    const result = (await chrome.runtime.sendMessage({ type: "ASK_MEETINGS" })) as
      | { ok?: boolean; error?: string }
      | undefined;

    if (result?.ok === false && result.error === "No pending ask") {
      askLoading = false;
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
  autosizeComposer();
  askLoading = true;
  updateAskChrome();
  renderAskThread();
  await persistActiveTab(true);
  await submitPendingAsk();
}

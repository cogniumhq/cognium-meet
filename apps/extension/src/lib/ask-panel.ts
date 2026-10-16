import type { MeetingAskCitation, MeetingAskMessage } from "@cognium/meet-shared";
import {
  addAskTab,
  ASK_WORKSPACE_KEY,
  createAskTab,
  findPendingAskTab,
  formatMeetingScopeLabel,
  getActiveAskTab,
  getHistory,
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

/**
 * Ask chat UI for the side panel. Expects the `meeting-ask-*` element ids
 * from the page markup. State lives in chrome.storage, so the popup can pick
 * which chat is active and the panel follows.
 */
export interface AskPanelOptions {
  onOpenCitation: (item: StoredRecording) => void;
}

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

let options: AskPanelOptions = { onOpenCitation: () => {} };
let askActiveTabId = "";
let askScopeRecordingId: string | undefined;
let askScopeMeetingTitle: string | undefined;
let askScopeStartedAt: string | undefined;
let askScopeDurationMs: number | undefined;
let askMessages: MeetingAskMessage[] = [];
let askChatSaveTimer: number | undefined;
let askLoading = false;

export async function initAskPanel(opts: AskPanelOptions): Promise<void> {
  options = opts;
  meetingAskBtn.addEventListener("click", () => void runMeetingAsk());
  meetingAskCancelBtn.addEventListener("click", () => void cancelMeetingAsk());
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
  try {
    await restoreAskChat();
  } catch (err) {
    console.error("[ask] restore Ask chat failed", err);
  }
}

function updateAskScopeChrome(): void {
  if (askScopeRecordingId) {
    const scopeLabel = formatMeetingScopeLabel(askScopeMeetingTitle, {
      startedAt: askScopeStartedAt,
      durationMs: askScopeDurationMs,
    });
    meetingAskLabel.textContent = `Ask about: ${scopeLabel}`;
    meetingAskLabel.title = scopeLabel;
    meetingAskClearScope.classList.remove("hidden");
  } else {
    meetingAskLabel.textContent = "Ask about your meetings";
    meetingAskLabel.removeAttribute("title");
    meetingAskClearScope.classList.add("hidden");
  }
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
}): boolean {
  const name = tab.scopeRecordingId
    ? formatMeetingScopeLabel(tab.scopeMeetingTitle, {
        startedAt: tab.scopeStartedAt,
        durationMs: tab.scopeDurationMs,
      })
    : tab.label.trim() || "this chat";

  return confirm(`Close "${name}"?\n\nMessages in this chat will be deleted.`);
}

async function closeAskTab(tabId: string): Promise<void> {
  const workspace = await loadAskWorkspace();
  const closing = workspace.tabs.find((tab) => tab.id === tabId);
  if (!closing) {
    return;
  }
  if (!askTabClosePrompt(closing)) {
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
  askScopeStartedAt = item?.startedAt;
  askScopeDurationMs = item?.durationMs;
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

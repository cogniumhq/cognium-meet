import type { MeetingAskMessage } from "@cognium/meet-shared";
import type { AskChatState } from "./storage.js";

export const ASK_WORKSPACE_KEY = "meetingAskWorkspace";
export const LEGACY_ASK_CHAT_KEY = "meetingAskChat";
export const MAX_ASK_TABS = 12;

export interface AskChatTab {
  id: string;
  label: string;
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  messages: MeetingAskMessage[];
  draftInput?: string;
  pending?: boolean;
}

export interface AskChatWorkspace {
  activeTabId: string;
  tabs: AskChatTab[];
}

export function newAskTabId(): string {
  return crypto.randomUUID();
}

export function truncateAskTabLabel(text: string, max = 22): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

export function deriveAskTabLabel(tab: Pick<
  AskChatTab,
  "label" | "scopeRecordingId" | "scopeMeetingTitle" | "messages"
>): string {
  if (tab.label.trim()) {
    return tab.label.trim();
  }
  if (tab.scopeMeetingTitle?.trim()) {
    return truncateAskTabLabel(tab.scopeMeetingTitle);
  }
  if (tab.scopeRecordingId) {
    return "Recording";
  }
  const firstUser = tab.messages.find((m) => m.role === "user");
  if (firstUser?.content.trim()) {
    return truncateAskTabLabel(firstUser.content);
  }
  return "All meetings";
}

export function createAskTab(opts?: {
  scopeRecordingId?: string;
  scopeMeetingTitle?: string;
  label?: string;
}): AskChatTab {
  const tab: AskChatTab = {
    id: newAskTabId(),
    label: opts?.label?.trim() ?? "",
    scopeRecordingId: opts?.scopeRecordingId,
    scopeMeetingTitle: opts?.scopeMeetingTitle,
    messages: [],
    draftInput: "",
    pending: false,
  };
  tab.label = deriveAskTabLabel(tab);
  return tab;
}

export function defaultAskWorkspace(): AskChatWorkspace {
  const tab = createAskTab();
  return { activeTabId: tab.id, tabs: [tab] };
}

export function findAskTab(
  workspace: AskChatWorkspace,
  tabId: string,
): AskChatTab | undefined {
  return workspace.tabs.find((tab) => tab.id === tabId);
}

export function findPendingAskTab(
  workspace: AskChatWorkspace,
): AskChatTab | undefined {
  return workspace.tabs.find((tab) => tab.pending);
}

export function getActiveAskTab(workspace: AskChatWorkspace): AskChatTab {
  return findAskTab(workspace, workspace.activeTabId) ?? workspace.tabs[0];
}

export function updateAskTab(
  workspace: AskChatWorkspace,
  tabId: string,
  patch: Partial<AskChatTab>,
): AskChatWorkspace {
  const tabs = workspace.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    const merged = { ...tab, ...patch };
    merged.label = deriveAskTabLabel(merged);
    return merged;
  });
  return { ...workspace, tabs };
}

export function setActiveAskTab(
  workspace: AskChatWorkspace,
  tabId: string,
): AskChatWorkspace {
  if (!findAskTab(workspace, tabId)) {
    return workspace;
  }
  return { ...workspace, activeTabId: tabId };
}

export function addAskTab(
  workspace: AskChatWorkspace,
  tab: AskChatTab,
): AskChatWorkspace {
  if (workspace.tabs.length >= MAX_ASK_TABS) {
    return workspace;
  }
  return {
    activeTabId: tab.id,
    tabs: [...workspace.tabs, tab],
  };
}

export function removeAskTab(
  workspace: AskChatWorkspace,
  tabId: string,
): AskChatWorkspace {
  if (workspace.tabs.length <= 1) {
    const tab = createAskTab();
    return { activeTabId: tab.id, tabs: [tab] };
  }

  const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return workspace;
  }

  const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
  let activeTabId = workspace.activeTabId;
  if (activeTabId === tabId) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next.id;
  }
  return { activeTabId, tabs };
}

export function migrateLegacyAskChat(legacy: AskChatState): AskChatWorkspace {
  const tab = createAskTab({
    scopeRecordingId: legacy.scopeRecordingId,
    scopeMeetingTitle: legacy.scopeMeetingTitle,
  });
  return {
    activeTabId: tab.id,
    tabs: [
      {
        ...tab,
        messages: legacy.messages ?? [],
        draftInput: legacy.draftInput ?? "",
        pending: legacy.pending === true,
      },
    ],
  };
}

export function normalizeAskWorkspace(
  raw: unknown,
): AskChatWorkspace | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const ws = raw as AskChatWorkspace;
  if (!Array.isArray(ws.tabs) || ws.tabs.length === 0) {
    return undefined;
  }
  const tabs = ws.tabs
    .filter((tab) => tab && typeof tab.id === "string")
    .map((tab) => ({
      ...tab,
      messages: Array.isArray(tab.messages) ? tab.messages : [],
      label: deriveAskTabLabel(tab),
    }));
  if (tabs.length === 0) {
    return undefined;
  }
  const activeTabId = tabs.some((tab) => tab.id === ws.activeTabId)
    ? ws.activeTabId
    : tabs[0].id;
  return { activeTabId, tabs };
}

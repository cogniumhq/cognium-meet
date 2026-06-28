import {
  getHistory,
  removeHistoryEntry,
  updateHistoryEntry,
} from "../lib/storage.js";
import {
  deleteServerRecording,
  downloadTranscript,
  fetchRecordingStatus,
  pollRecording,
  retryRecording,
} from "../lib/upload.js";
import { deletePendingAudio, downloadPendingAudio, loadPendingAudio } from "../lib/pending-audio-store.js";
import { isRecordableTabUrl } from "../lib/recordable-tab.js";
import { initSettingsForm } from "../lib/settings-form.js";

const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopOnlyBtn = document.getElementById("stop-only-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const recordingIndicator = document.getElementById("recording-indicator") as HTMLDivElement;
const timerEl = document.getElementById("timer") as HTMLSpanElement;
const historyList = document.getElementById("history-list") as HTMLUListElement;
const mainView = document.getElementById("main-view") as HTMLDivElement;
const settingsView = document.getElementById("settings-view") as HTMLDivElement;
const settingsOpenBtn = document.getElementById("settings-open-btn") as HTMLButtonElement;
const settingsBackBtn = document.getElementById("settings-back-btn") as HTMLButtonElement;

let timerInterval: number | undefined;
let recordingStartedAt: number | undefined;

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
  settingsBackBtn.addEventListener("click", () => showSettings(false));
  await initSettingsForm(document.getElementById("settings-root")!);

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
  await renderHistory();
}

function showSettings(open: boolean): void {
  mainView.classList.toggle("hidden", open);
  settingsView.classList.toggle("hidden", !open);
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
    await renderHistory();

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

    void waitForTranscription(response.recordingId);
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

async function refreshStaleHistory(): Promise<void> {
  const history = await getHistory();
  for (const item of history) {
    if (item.status !== "processing" && item.status !== "failed") {
      continue;
    }
    if (item.localAudioId) {
      continue;
    }
    try {
      const meta = await fetchRecordingStatus(item.id);
      if (meta.status !== item.status || meta.error !== item.error) {
        await updateHistoryEntry(item.id, {
          status: meta.status,
          error: meta.error,
        });
      }
    } catch {
      // API may be offline; keep cached status.
    }
  }
}

async function waitForTranscription(id: string): Promise<void> {
  try {
    const meta = await pollRecording(id, { timeoutMs: 20 * 60 * 1000 });
    await updateHistoryEntry(id, { status: meta.status, error: meta.error });
    await renderHistory();
    if (meta.status === "completed") {
      setStatus("Transcript ready — see Recent transcripts below");
      return;
    }
    if (meta.status === "failed") {
      setStatus(meta.error ?? "Transcription failed", true);
    }
  } catch {
    // Background worker continues polling if popup closes.
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
      setStatus("Transcribing…");
      await waitForTranscription(response.recordingId);
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    await renderHistory();
  }
}

async function retryTranscription(id: string): Promise<void> {
  setStatus("Retrying transcription…");
  try {
    await retryRecording(id);
    await updateHistoryEntry(id, { status: "processing", error: undefined });
    await renderHistory();
    await waitForTranscription(id);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
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

  const tabDownload = document.createElement("button");
  tabDownload.type = "button";
  tabDownload.className = "link-btn";
  tabDownload.textContent = hasMicTrack ? "Download tab" : "Download audio";
  tabDownload.addEventListener("click", () => {
    void downloadPendingAudio(item.localAudioId!, `${base}-tab.webm`, "tab").catch((err) =>
      setStatus(err instanceof Error ? err.message : String(err), true),
    );
  });
  links.appendChild(tabDownload);

  if (hasMicTrack) {
    const micDownload = document.createElement("button");
    micDownload.type = "button";
    micDownload.className = "link-btn";
    micDownload.textContent = "Download mic";
    micDownload.addEventListener("click", () => {
      void downloadPendingAudio(item.localAudioId!, `${base}-mic.webm`, "mic").catch((err) =>
        setStatus(err instanceof Error ? err.message : String(err), true),
      );
    });
    links.appendChild(micDownload);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "link-btn danger-link";
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
): void {
  const links = document.createElement("div");
  links.className = "history-links";

  const onServer =
    !item.localAudioId &&
    (item.status === "completed" ||
      item.status === "failed" ||
      item.status === "processing");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-btn danger-link";
  remove.textContent = onServer ? "Delete" : "Remove";
  remove.addEventListener("click", () => {
    void removeFromHistory(item);
  });
  links.appendChild(remove);
  li.appendChild(links);
}

async function renderHistory(): Promise<void> {
  const history = await getHistory();

  historyList.innerHTML = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No transcripts yet.";
    historyList.appendChild(li);
    return;
  }

  for (const item of history) {
    const li = document.createElement("li");

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = item.meetingTitle ?? "Recording";

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const when = new Date(item.startedAt).toLocaleString();
    meta.textContent = `${when} · ${item.status}`;

    li.appendChild(title);
    li.appendChild(meta);

    if (item.status === "upload_failed" && item.localAudioId) {
      if (item.error) {
        const err = document.createElement("div");
        err.className = "history-error";
        err.textContent = item.error;
        li.appendChild(err);
      }
      const pending = await loadPendingAudio(item.localAudioId);
      appendLocalAudioActions(li, item, "Retry upload", Boolean(pending?.micBytes?.length));
    }

    if (item.status === "saved" && item.localAudioId) {
      const pending = await loadPendingAudio(item.localAudioId);
      appendLocalAudioActions(li, item, "Transcribe", Boolean(pending?.micBytes?.length));
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
      appendRemoveAction(li, item);
    }

    if (item.status === "completed") {
      const links = document.createElement("div");
      links.className = "history-links";

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
      li.appendChild(links);
      appendRemoveAction(li, item);
    }

    if (item.status === "processing") {
      appendRemoveAction(li, item);
    }

    historyList.appendChild(li);
  }
}

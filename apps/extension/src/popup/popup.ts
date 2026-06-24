import {
  addToHistory,
  getHistory,
  updateHistoryEntry,
  type StoredRecording,
} from "../lib/storage.js";
import { downloadTranscript, pollRecording } from "../lib/upload.js";

const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const statusText = document.getElementById("status-text") as HTMLParagraphElement;
const recordingIndicator = document.getElementById("recording-indicator") as HTMLDivElement;
const timerEl = document.getElementById("timer") as HTMLSpanElement;
const historyList = document.getElementById("history-list") as HTMLUListElement;
const optionsLink = document.getElementById("options-link") as HTMLAnchorElement;

let timerInterval: number | undefined;
let recordingStartedAt: number | undefined;

void init();

async function init(): Promise<void> {
  optionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  });

  startBtn.addEventListener("click", () => void startRecording());
  stopBtn.addEventListener("click", () => void stopRecording());

  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (status?.isRecording && status.startedAt) {
    enterRecordingUi(status.startedAt);
    const micNote = status.includedMic
      ? "tab + mic"
      : "tab audio only — enable mic in Settings";
    setStatus(`Recording (${micNote})`, !status.includedMic);
  }

  await renderHistory();
}

async function startRecording(): Promise<void> {
  startBtn.disabled = true;
  setStatus("Starting…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found");
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
    const micNote = response.includedMic
      ? "tab + mic"
      : "tab audio only — enable mic in Settings";
    setStatus(`Recording (${micNote})`, !response.includedMic);
    startBtn.disabled = false;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    startBtn.disabled = false;
  }
}

async function stopRecording(): Promise<void> {
  stopBtn.disabled = true;
  setStatus("Stopping recording…");

  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    if (!response) {
      throw new Error("No response from background worker — try reloading the extension");
    }
    if (response?.type === "RECORDING_ERROR") {
      throw new Error(response.error);
    }

    exitRecordingUi();

    if (!response.recordingId) {
      throw new Error("Upload did not return a recording id");
    }

    const entry: StoredRecording = {
      id: response.recordingId,
      meetingTitle: response.meetingTitle,
      startedAt: new Date(response.startedAt).toISOString(),
      durationMs: response.durationMs,
      status: "processing",
      createdAt: new Date().toISOString(),
    };
    await addToHistory(entry);

    setStatus("Transcribing…");
    const meta = await pollRecording(response.recordingId);
    await updateHistoryEntry(response.recordingId, {
      status: meta.status,
      error: meta.error,
    });

    if (meta.status === "failed") {
      throw new Error(meta.error ?? "Transcription failed");
    }

    setStatus("Transcript ready — see Recent transcripts below");
    await renderHistory();
  } catch (err) {
    exitRecordingUi();
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    startBtn.disabled = false;
    stopBtn.disabled = false;
  }
}

function enterRecordingUi(startedAt: number): void {
  recordingStartedAt = startedAt;
  startBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
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
    title.textContent = item.meetingTitle ?? "Google Meet";

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const when = new Date(item.startedAt).toLocaleString();
    meta.textContent = `${when} · ${item.status}`;

    li.appendChild(title);
    li.appendChild(meta);

    if (item.status === "failed" && item.error) {
      const err = document.createElement("div");
      err.className = "history-error";
      err.textContent = item.error;
      li.appendChild(err);
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
    }

    historyList.appendChild(li);
  }
}

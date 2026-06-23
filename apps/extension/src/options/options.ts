import { getSettings, saveSettings } from "../lib/storage.js";

const form = document.getElementById("settings-form") as HTMLFormElement;
const apiUrlInput = document.getElementById("api-url") as HTMLInputElement;
const apiTokenInput = document.getElementById("api-token") as HTMLInputElement;
const saveStatus = document.getElementById("save-status") as HTMLParagraphElement;
const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;
const micStatus = document.getElementById("mic-status") as HTMLParagraphElement;

void init();

async function init(): Promise<void> {
  const settings = await getSettings();
  apiUrlInput.value = settings.apiUrl;
  apiTokenInput.value = settings.apiToken;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void save();
  });

  micBtn.addEventListener("click", () => void requestMic());
  await refreshMicStatus();
}

async function refreshMicStatus(): Promise<void> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") {
      setMicStatus("Microphone access granted.", false);
      micBtn.textContent = "Microphone enabled";
    }
  } catch {
    // permissions.query may not support "microphone"; ignore.
  }
}

async function requestMic(): Promise<void> {
  micBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setMicStatus("Microphone access granted. You can close this page.", false);
    micBtn.textContent = "Microphone enabled";
  } catch (err) {
    setMicStatus(
      err instanceof Error ? err.message : "Microphone access denied",
      true,
    );
  } finally {
    micBtn.disabled = false;
  }
}

function setMicStatus(text: string, isError: boolean): void {
  micStatus.textContent = text;
  micStatus.classList.remove("hidden");
  micStatus.style.color = isError ? "#dc2626" : "#15803d";
}

async function save(): Promise<void> {
  await saveSettings({
    apiUrl: apiUrlInput.value.replace(/\/$/, ""),
    apiToken: apiTokenInput.value,
  });

  saveStatus.textContent = "Settings saved.";
  saveStatus.classList.remove("hidden");
  setTimeout(() => saveStatus.classList.add("hidden"), 2500);
}

import { listAudioInputDevices } from "../lib/audio-devices.js";
import { getSettings, saveSettings } from "../lib/storage.js";

const form = document.getElementById("settings-form") as HTMLFormElement;
const apiUrlInput = document.getElementById("api-url") as HTMLInputElement;
const apiTokenInput = document.getElementById("api-token") as HTMLInputElement;
const saveStatus = document.getElementById("save-status") as HTMLParagraphElement;
const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;
const micStatus = document.getElementById("mic-status") as HTMLParagraphElement;
const micDeviceLabel = document.getElementById("mic-device-label") as HTMLLabelElement;
const micDeviceSelect = document.getElementById("mic-device") as HTMLSelectElement;

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
  micDeviceSelect.addEventListener("change", () => void saveMicDevice());

  const hasMic = await refreshMicStatus();
  if (hasMic) {
    await populateMicDevices(settings.microphoneDeviceId ?? "");
  }
}

async function refreshMicStatus(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") {
      setMicStatus("Microphone access granted.", false);
      micBtn.textContent = "Microphone enabled";
      return true;
    }
  } catch {
    // permissions.query may not support "microphone"; ignore.
  }
  return false;
}

async function requestMic(): Promise<void> {
  micBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setMicStatus("Microphone access granted. Pick your recording device below.", false);
    micBtn.textContent = "Microphone enabled";
    const settings = await getSettings();
    await populateMicDevices(settings.microphoneDeviceId ?? "");
  } catch (err) {
    setMicStatus(
      err instanceof Error ? err.message : "Microphone access denied",
      true,
    );
  } finally {
    micBtn.disabled = false;
  }
}

async function populateMicDevices(selectedId: string): Promise<void> {
  const devices = await listAudioInputDevices();
  micDeviceSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Chrome default (not recommended)";
  micDeviceSelect.appendChild(defaultOption);

  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label;
    micDeviceSelect.appendChild(option);
  }

  const hasSelected = selectedId && devices.some((d) => d.deviceId === selectedId);
  micDeviceSelect.value = hasSelected ? selectedId : "";
  micDeviceSelect.disabled = devices.length === 0;
  micDeviceLabel.classList.remove("hidden");
}

async function saveMicDevice(): Promise<void> {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    microphoneDeviceId: micDeviceSelect.value || undefined,
  });
  setMicStatus("Microphone device saved.", false);
}

function setMicStatus(text: string, isError: boolean): void {
  micStatus.textContent = text;
  micStatus.classList.remove("hidden");
  micStatus.style.color = isError ? "#dc2626" : "#15803d";
}

async function save(): Promise<void> {
  const settings = await getSettings();
  await saveSettings({
    apiUrl: apiUrlInput.value.replace(/\/$/, ""),
    apiToken: apiTokenInput.value,
    microphoneDeviceId: micDeviceSelect.disabled
      ? settings.microphoneDeviceId
      : micDeviceSelect.value || undefined,
  });

  saveStatus.textContent = "Settings saved.";
  saveStatus.classList.remove("hidden");
  setTimeout(() => saveStatus.classList.add("hidden"), 2500);
}

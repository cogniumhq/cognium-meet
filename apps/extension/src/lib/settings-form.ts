import { listAudioInputDevices } from "./audio-devices.js";
import { getSettings, saveSettings } from "./storage.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_MODELS,
  transcriptionModelLabel,
  type TranscriptionModel,
} from "@cognium/meet-shared";

export interface SettingsFormElements {
  apiUrlInput: HTMLInputElement;
  apiTokenInput: HTMLInputElement;
  tokenToggleBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  saveStatus: HTMLElement;
  micBadge: HTMLElement;
  micBtn: HTMLButtonElement;
  micDeviceSelect: HTMLSelectElement;
  micHint: HTMLElement;
  transcriptionModelSelect: HTMLSelectElement;
}

export function getSettingsFormElements(root: ParentNode): SettingsFormElements {
  return {
    apiUrlInput: root.querySelector("#api-url") as HTMLInputElement,
    apiTokenInput: root.querySelector("#api-token") as HTMLInputElement,
    tokenToggleBtn: root.querySelector("#token-toggle") as HTMLButtonElement,
    saveBtn: root.querySelector("#save-settings-btn") as HTMLButtonElement,
    saveStatus: root.querySelector("#save-status") as HTMLElement,
    micBadge: root.querySelector("#mic-badge") as HTMLElement,
    micBtn: root.querySelector("#mic-btn") as HTMLButtonElement,
    micDeviceSelect: root.querySelector("#mic-device") as HTMLSelectElement,
    micHint: root.querySelector("#mic-hint") as HTMLElement,
    transcriptionModelSelect: root.querySelector(
      "#transcription-model",
    ) as HTMLSelectElement,
  };
}

export async function initSettingsForm(root: ParentNode): Promise<void> {
  const els = getSettingsFormElements(root);
  const settings = await getSettings();

  els.apiUrlInput.value = settings.apiUrl;
  els.apiTokenInput.value = settings.apiToken;
  populateTranscriptionModels(els, settings.transcriptionModel);

  els.tokenToggleBtn.addEventListener("click", () => {
    const showing = els.apiTokenInput.type === "text";
    els.apiTokenInput.type = showing ? "password" : "text";
    els.tokenToggleBtn.textContent = showing ? "Show" : "Hide";
    els.tokenToggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
  });

  els.saveBtn.addEventListener("click", () => void saveApiSettings(els));
  els.micBtn.addEventListener("click", () => void requestMic(els));
  els.micDeviceSelect.addEventListener("change", () => void saveMicDevice(els));
  els.transcriptionModelSelect.addEventListener("change", () =>
    void saveTranscriptionModel(els),
  );

  const hasMic = await refreshMicPermission(els);
  if (hasMic) {
    await populateMicDevices(els, settings.microphoneDeviceId ?? "");
  }
}

async function refreshMicPermission(els: SettingsFormElements): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") {
      setMicBadge(els, "granted");
      return true;
    }
    if (status.state === "denied") {
      setMicBadge(els, "denied");
      return false;
    }
  } catch {
    // permissions.query may not support "microphone"
  }

  setMicBadge(els, "unknown");
  return false;
}

function setMicBadge(
  els: SettingsFormElements,
  state: "granted" | "denied" | "unknown",
): void {
  els.micBadge.classList.remove("mic-badge--granted", "mic-badge--denied", "mic-badge--unknown");
  if (state === "granted") {
    els.micBadge.textContent = "Allowed";
    els.micBadge.classList.add("mic-badge--granted");
    els.micBtn.textContent = "Re-check access";
    els.micDeviceSelect.disabled = false;
    return;
  }

  els.micDeviceSelect.disabled = true;
  if (state === "denied") {
    els.micBadge.textContent = "Blocked";
    els.micBadge.classList.add("mic-badge--denied");
    els.micBtn.textContent = "Allow microphone";
    return;
  }

  els.micBadge.textContent = "Not set";
  els.micBadge.classList.add("mic-badge--unknown");
  els.micBtn.textContent = "Allow microphone";
}

async function requestMic(els: SettingsFormElements): Promise<void> {
  els.micBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setMicBadge(els, "granted");
    setSaveStatus(els, "Microphone allowed — choose your device below.", false);
    const settings = await getSettings();
    await populateMicDevices(els, settings.microphoneDeviceId ?? "");
  } catch (err) {
    setMicBadge(els, "denied");
    setSaveStatus(
      els,
      err instanceof Error ? err.message : "Microphone access denied",
      true,
    );
  } finally {
    els.micBtn.disabled = false;
  }
}

async function populateMicDevices(
  els: SettingsFormElements,
  selectedId: string,
): Promise<void> {
  const devices = await listAudioInputDevices();
  els.micDeviceSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent =
    devices.length === 0 ? "No devices — allow microphone first" : "Chrome default";
  els.micDeviceSelect.appendChild(defaultOption);

  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label;
    els.micDeviceSelect.appendChild(option);
  }

  const hasSelected = selectedId && devices.some((d) => d.deviceId === selectedId);
  els.micDeviceSelect.value = hasSelected ? selectedId : "";
  els.micDeviceSelect.disabled = devices.length === 0;
}

async function saveMicDevice(els: SettingsFormElements): Promise<void> {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    microphoneDeviceId: els.micDeviceSelect.value || undefined,
  });
  setSaveStatus(els, "Microphone device saved.", false);
}

function populateTranscriptionModels(
  els: SettingsFormElements,
  selected?: TranscriptionModel,
): void {
  els.transcriptionModelSelect.innerHTML = "";
  for (const model of TRANSCRIPTION_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = transcriptionModelLabel(model);
    els.transcriptionModelSelect.appendChild(option);
  }
  els.transcriptionModelSelect.value = selected ?? DEFAULT_TRANSCRIPTION_MODEL;
}

async function saveTranscriptionModel(els: SettingsFormElements): Promise<void> {
  const settings = await getSettings();
  const model = els.transcriptionModelSelect.value as TranscriptionModel;
  await saveSettings({
    ...settings,
    transcriptionModel: model,
  });
  setSaveStatus(els, "Transcription model saved.", false);
}

async function saveApiSettings(els: SettingsFormElements): Promise<void> {
  const settings = await getSettings();
  await saveSettings({
    apiUrl: els.apiUrlInput.value.replace(/\/$/, ""),
    apiToken: els.apiTokenInput.value,
    transcriptionModel:
      (els.transcriptionModelSelect.value as TranscriptionModel) ||
      settings.transcriptionModel,
    microphoneDeviceId: els.micDeviceSelect.disabled
      ? settings.microphoneDeviceId
      : els.micDeviceSelect.value || undefined,
  });
  setSaveStatus(els, "Connection settings saved.", false);
}

function setSaveStatus(els: SettingsFormElements, text: string, isError: boolean): void {
  els.saveStatus.textContent = text;
  els.saveStatus.classList.remove("hidden", "save-status--error", "save-status--ok");
  els.saveStatus.classList.add(isError ? "save-status--error" : "save-status--ok");
}

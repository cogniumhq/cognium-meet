import { listAudioInputDevices, type AudioInputDevice } from "./audio-devices.js";
import {
  listMicDevicesViaBackground,
  micDevicesLookGranted,
  openExtensionMicSettings,
  requestMicAccessViaBackground,
} from "./mic-access.js";
import { getSettings, saveSettings } from "./storage.js";
import {
  AUDIO_CAPTURE_MODES,
  audioCaptureModeLabel,
  DEFAULT_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_MODELS,
  transcriptionModelLabel,
  type AudioCaptureMode,
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
  micSettingsBtn: HTMLButtonElement;
  micDeviceSelect: HTMLSelectElement;
  micHint: HTMLElement;
  micBlockedHint: HTMLElement;
  transcriptionModelSelect: HTMLSelectElement;
  captureModeSelect: HTMLSelectElement;
  captureModeHint: HTMLElement;
  dualTrackNote: HTMLElement;
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
    micSettingsBtn: root.querySelector("#mic-settings-btn") as HTMLButtonElement,
    micDeviceSelect: root.querySelector("#mic-device") as HTMLSelectElement,
    micHint: root.querySelector("#mic-hint") as HTMLElement,
    micBlockedHint: root.querySelector("#mic-blocked-hint") as HTMLElement,
    transcriptionModelSelect: root.querySelector(
      "#transcription-model",
    ) as HTMLSelectElement,
    captureModeSelect: root.querySelector("#capture-mode") as HTMLSelectElement,
    captureModeHint: root.querySelector("#capture-mode-hint") as HTMLElement,
    dualTrackNote: root.querySelector("#dual-track-note") as HTMLElement,
  };
}

export async function initSettingsForm(root: ParentNode): Promise<void> {
  const els = getSettingsFormElements(root);
  const settings = await getSettings();

  els.apiUrlInput.value = settings.apiUrl;
  els.apiTokenInput.value = settings.apiToken;
  populateTranscriptionModels(els, settings.transcriptionModel, settings.captureMode);
  populateCaptureModes(els, settings.captureMode);
  updateCaptureModeUi(els, settings.transcriptionModel);

  els.tokenToggleBtn.addEventListener("click", () => {
    const showing = els.apiTokenInput.type === "text";
    els.apiTokenInput.type = showing ? "password" : "text";
    els.tokenToggleBtn.textContent = showing ? "Show" : "Hide";
    els.tokenToggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
  });

  els.saveBtn.addEventListener("click", () => void saveApiSettings(els));
  els.micBtn.addEventListener("click", () => void requestMic(els));
  els.micSettingsBtn.addEventListener("click", () => openExtensionMicSettings());
  els.micDeviceSelect.addEventListener("change", () => void saveMicDevice(els));
  els.transcriptionModelSelect.addEventListener("change", () =>
    void saveTranscriptionModel(els),
  );
  els.captureModeSelect.addEventListener("change", () => void saveCaptureMode(els));

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
    status.onchange = () => {
      void refreshMicPermission(els);
    };
    if (status.state === "granted") {
      setMicBadge(els, "granted");
      return true;
    }
  } catch {
    // permissions.query may not support "microphone" in this context.
  }

  try {
    const devices = await listMicDevicesViaBackground();
    if (micDevicesLookGranted(devices)) {
      setMicBadge(els, "granted");
      await populateMicDevices(els, (await getSettings()).microphoneDeviceId ?? "");
      return true;
    }
  } catch {
    // Offscreen may not be ready yet.
  }

  // Don't show "Blocked" from permissions.query alone — Chrome often reports
  // denied for extensions before the first successful Allow click.
  setMicBadge(els, "unknown");
  return false;
}

function setMicBadge(
  els: SettingsFormElements,
  state: "granted" | "denied" | "unknown",
): void {
  els.micBadge.classList.remove("mic-badge--granted", "mic-badge--denied", "mic-badge--unknown");
  els.micBlockedHint.classList.add("hidden");
  els.micSettingsBtn.classList.add("hidden");
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
    els.micBtn.textContent = "Re-check access";
    els.micBlockedHint.classList.remove("hidden");
    els.micSettingsBtn.classList.remove("hidden");
    return;
  }

  els.micBadge.textContent = "Not set";
  els.micBadge.classList.add("mic-badge--unknown");
  els.micBtn.textContent = "Allow microphone";
}

async function requestMic(els: SettingsFormElements): Promise<void> {
  els.micBtn.disabled = true;
  try {
    let granted = false;
    let lastError = "";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      granted = true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (!granted) {
      const offscreen = await requestMicAccessViaBackground();
      if (offscreen.ok) {
        granted = true;
      } else if (offscreen.error) {
        lastError = offscreen.error;
      }
    }

    if (!granted) {
      const denied = /not allowed|permission|denied|dismissed/i.test(lastError);
      setMicBadge(els, denied ? "denied" : "unknown");
      if (!denied) {
        setSaveStatus(els, lastError || "Could not open microphone", true);
      } else {
        els.saveStatus.classList.add("hidden");
      }
      return;
    }

    setMicBadge(els, "granted");
    setSaveStatus(els, "Microphone allowed — choose your device below.", false);
    const settings = await getSettings();
    await populateMicDevices(els, settings.microphoneDeviceId ?? "");
  } finally {
    els.micBtn.disabled = false;
  }
}

async function populateMicDevices(
  els: SettingsFormElements,
  selectedId: string,
): Promise<void> {
  let devices: AudioInputDevice[] = await listMicDevicesViaBackground().catch(() => []);
  if (devices.length === 0) {
    devices = await listAudioInputDevices();
  }
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
  captureMode?: AudioCaptureMode,
): void {
  els.transcriptionModelSelect.innerHTML = "";
  for (const model of TRANSCRIPTION_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = transcriptionModelLabel(model);
    els.transcriptionModelSelect.appendChild(option);
  }

  const dual = captureMode === "dual-track";
  const effective = dual ? "whisper-1" : (selected ?? DEFAULT_TRANSCRIPTION_MODEL);
  els.transcriptionModelSelect.value = effective;
  applyTranscriptionModelAvailability(els, dual);
}

function applyTranscriptionModelAvailability(
  els: SettingsFormElements,
  dual: boolean,
): void {
  for (const option of els.transcriptionModelSelect.options) {
    const isDiarize = option.value === "gpt-4o-transcribe-diarize";
    option.disabled = dual && isDiarize;
    option.hidden = dual && isDiarize;
  }

  if (dual) {
    els.transcriptionModelSelect.value = "whisper-1";
    els.transcriptionModelSelect.disabled = true;
    els.transcriptionModelSelect.setAttribute(
      "aria-description",
      "Dual-track always uses Whisper for You and Others labels",
    );
    return;
  }

  els.transcriptionModelSelect.disabled = false;
  els.transcriptionModelSelect.removeAttribute("aria-description");
}

function populateCaptureModes(
  els: SettingsFormElements,
  selected?: AudioCaptureMode,
): void {
  els.captureModeSelect.innerHTML = "";
  for (const mode of AUDIO_CAPTURE_MODES) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = audioCaptureModeLabel(mode);
    els.captureModeSelect.appendChild(option);
  }
  els.captureModeSelect.value = selected ?? "mixed";
}

function updateCaptureModeUi(
  els: SettingsFormElements,
  savedTranscriptionModel?: TranscriptionModel,
): void {
  const dual = els.captureModeSelect.value === "dual-track";
  els.dualTrackNote.classList.toggle("hidden", !dual);
  els.micHint.textContent = dual
    ? "Tab and mic are recorded as separate files. Your mic is labeled You; tab audio is Others. Allow mic and pick a device below."
    : "Tab audio is always recorded. Your mic is mixed in so your voice is included. Chrome ignores Linux/GNOME input settings — pick the device below.";

  applyTranscriptionModelAvailability(els, dual);
  if (!dual && savedTranscriptionModel) {
    els.transcriptionModelSelect.value = savedTranscriptionModel;
  }
}

async function saveCaptureMode(els: SettingsFormElements): Promise<void> {
  const settings = await getSettings();
  const captureMode = els.captureModeSelect.value as AudioCaptureMode;
  await saveSettings({
    ...settings,
    captureMode,
  });
  updateCaptureModeUi(els, settings.transcriptionModel);
  setSaveStatus(els, "Capture mode saved.", false);
}

async function saveTranscriptionModel(els: SettingsFormElements): Promise<void> {
  if (els.captureModeSelect.value === "dual-track") {
    return;
  }
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
  const captureMode =
    (els.captureModeSelect.value as AudioCaptureMode) || settings.captureMode;
  const transcriptionModel =
    captureMode === "dual-track"
      ? settings.transcriptionModel
      : ((els.transcriptionModelSelect.value as TranscriptionModel) ||
          settings.transcriptionModel);
  await saveSettings({
    apiUrl: els.apiUrlInput.value.replace(/\/$/, ""),
    apiToken: els.apiTokenInput.value,
    transcriptionModel,
    captureMode,
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

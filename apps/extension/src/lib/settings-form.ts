import { listAudioInputDevices, type AudioInputDevice } from "./audio-devices.js";
import {
  listMicDevicesViaBackground,
  micDevicesLookGranted,
  openExtensionMicSettings,
  requestMicAccessViaBackground,
} from "./mic-access.js";
import { getSettings, getOpenAiApiKey, saveOpenAiApiKey, saveSettings } from "./storage.js";
import {
  AUDIO_CAPTURE_MODES,
  audioCaptureModeLabel,
  DEFAULT_MAX_UPLOAD_MB,
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_OLLAMA_URL,
  DEFAULT_TRANSCRIPTION_MODEL,
  coerceMeetingLlmModelForProvider,
  defaultMeetingLlmModelForProvider,
  meetingLlmModelLabel,
  meetingLlmModelsForProvider,
  MEETING_LLM_PROVIDERS,
  meetingLlmProviderLabel,
  TRANSCRIPTION_MODELS,
  transcriptionModelLabel,
  type AudioCaptureMode,
  type MeetingLlmProvider,
  type TranscriptionModel,
} from "@cognium/meet-shared";

export interface SettingsFormElements {
  apiUrlInput: HTMLInputElement;
  apiTokenInput: HTMLInputElement;
  tokenToggleBtn: HTMLButtonElement;
  openaiApiKeyInput: HTMLInputElement;
  openaiKeyToggleBtn: HTMLButtonElement;
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
  meetingLlmProviderSelect: HTMLSelectElement;
  meetingNotesEnabledInput: HTMLInputElement;
  meetingAskEnabledInput: HTMLInputElement;
  meetingLlmModelSelect: HTMLSelectElement;
  ollamaUrlInput: HTMLInputElement;
  ollamaFields: HTMLElement;
  deleteAudioInput: HTMLInputElement;
  maxUploadMbInput: HTMLInputElement;
  captureModeHint: HTMLElement;
  dualTrackNote: HTMLElement;
}

export function getSettingsFormElements(root: ParentNode): SettingsFormElements {
  return {
    apiUrlInput: root.querySelector("#api-url") as HTMLInputElement,
    apiTokenInput: root.querySelector("#api-token") as HTMLInputElement,
    tokenToggleBtn: root.querySelector("#token-toggle") as HTMLButtonElement,
    openaiApiKeyInput: root.querySelector("#openai-api-key") as HTMLInputElement,
    openaiKeyToggleBtn: root.querySelector("#openai-key-toggle") as HTMLButtonElement,
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
    meetingLlmProviderSelect: root.querySelector(
      "#meeting-llm-provider",
    ) as HTMLSelectElement,
    meetingNotesEnabledInput: root.querySelector(
      "#meeting-notes-enabled",
    ) as HTMLInputElement,
    meetingAskEnabledInput: root.querySelector(
      "#meeting-ask-enabled",
    ) as HTMLInputElement,
    meetingLlmModelSelect: root.querySelector(
      "#meeting-llm-model",
    ) as HTMLSelectElement,
    ollamaUrlInput: root.querySelector("#ollama-url") as HTMLInputElement,
    ollamaFields: root.querySelector("#ollama-fields") as HTMLElement,
    deleteAudioInput: root.querySelector(
      "#delete-audio-after-transcription",
    ) as HTMLInputElement,
    maxUploadMbInput: root.querySelector("#max-upload-mb") as HTMLInputElement,
    captureModeHint: root.querySelector("#capture-mode-hint") as HTMLElement,
    dualTrackNote: root.querySelector("#dual-track-note") as HTMLElement,
  };
}

export async function initSettingsForm(root: ParentNode): Promise<void> {
  const els = getSettingsFormElements(root);
  const settings = await getSettings();
  const openaiApiKey = await getOpenAiApiKey();

  els.apiUrlInput.value = settings.apiUrl;
  els.apiTokenInput.value = settings.apiToken;
  els.openaiApiKeyInput.value = openaiApiKey ?? "";
  populateTranscriptionModels(els, settings.transcriptionModel, settings.captureMode);
  populateCaptureModes(els, settings.captureMode);
  populateMeetingLlmProviders(els, settings.meetingLlmProvider);
  const llmProvider = settings.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER;
  const savedLlmModel =
    settings.meetingLlmModel ??
    (llmProvider === "ollama" ? settings.ollamaModel : undefined) ??
    defaultMeetingLlmModelForProvider(llmProvider);
  populateMeetingLlmModels(els, llmProvider, savedLlmModel);
  els.meetingNotesEnabledInput.checked = settings.meetingNotesEnabled !== false;
  els.meetingAskEnabledInput.checked = settings.meetingAskEnabled !== false;
  els.ollamaUrlInput.value = settings.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  els.deleteAudioInput.checked = settings.deleteAudioAfterTranscription !== false;
  els.maxUploadMbInput.value = String(settings.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB);
  updateOllamaFieldsVisibility(els);
  updateCaptureModeUi(els, settings.transcriptionModel);

  els.tokenToggleBtn.addEventListener("click", () => {
    const showing = els.apiTokenInput.type === "text";
    els.apiTokenInput.type = showing ? "password" : "text";
    els.tokenToggleBtn.textContent = showing ? "Show" : "Hide";
    els.tokenToggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
  });

  els.openaiKeyToggleBtn.addEventListener("click", () => {
    const showing = els.openaiApiKeyInput.type === "text";
    els.openaiApiKeyInput.type = showing ? "password" : "text";
    els.openaiKeyToggleBtn.textContent = showing ? "Show" : "Hide";
    els.openaiKeyToggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
  });

  els.saveBtn.addEventListener("click", () => void saveApiSettings(els));
  els.micBtn.addEventListener("click", () => void requestMic(els));
  els.micSettingsBtn.addEventListener("click", () => openExtensionMicSettings());
  els.micDeviceSelect.addEventListener("change", () => void saveMicDevice(els));
  els.transcriptionModelSelect.addEventListener("change", () =>
    void saveTranscriptionModel(els),
  );
  els.captureModeSelect.addEventListener("change", () => void saveCaptureMode(els));
  els.meetingLlmProviderSelect.addEventListener("change", () => {
    const provider = els.meetingLlmProviderSelect.value as MeetingLlmProvider;
    populateMeetingLlmModels(
      els,
      provider,
      defaultMeetingLlmModelForProvider(provider),
    );
    updateOllamaFieldsVisibility(els);
    void saveMeetingAiSettings(els);
  });
  els.meetingNotesEnabledInput.addEventListener("change", () =>
    void saveMeetingAiSettings(els),
  );
  els.meetingAskEnabledInput.addEventListener("change", () =>
    void saveMeetingAiSettings(els),
  );
  els.meetingLlmModelSelect.addEventListener("change", () =>
    void saveMeetingAiSettings(els),
  );
  els.ollamaUrlInput.addEventListener("change", () => void saveMeetingAiSettings(els));
  els.deleteAudioInput.addEventListener("change", () => void saveMeetingAiSettings(els));
  els.maxUploadMbInput.addEventListener("change", () => void saveMeetingAiSettings(els));

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

function populateMeetingLlmProviders(
  els: SettingsFormElements,
  selected?: MeetingLlmProvider,
): void {
  els.meetingLlmProviderSelect.innerHTML = "";
  for (const provider of MEETING_LLM_PROVIDERS) {
    const option = document.createElement("option");
    option.value = provider;
    option.textContent = meetingLlmProviderLabel(provider);
    els.meetingLlmProviderSelect.appendChild(option);
  }
  els.meetingLlmProviderSelect.value = selected ?? DEFAULT_MEETING_LLM_PROVIDER;
}

function populateMeetingLlmModels(
  els: SettingsFormElements,
  provider: MeetingLlmProvider,
  selected?: string,
): void {
  const presets = meetingLlmModelsForProvider(provider);
  const effective =
    selected?.trim() || defaultMeetingLlmModelForProvider(provider);
  const known = new Set<string>(presets);
  const models = known.has(effective) ? [...presets] : [...presets, effective];

  els.meetingLlmModelSelect.innerHTML = "";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = meetingLlmModelLabel(model);
    els.meetingLlmModelSelect.appendChild(option);
  }
  els.meetingLlmModelSelect.value = effective;
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

function updateOllamaFieldsVisibility(els: SettingsFormElements): void {
  const ollama = els.meetingLlmProviderSelect.value === "ollama";
  els.ollamaFields.classList.toggle("hidden", !ollama);
}

async function saveMeetingAiSettings(els: SettingsFormElements): Promise<void> {
  const settings = await getSettings();
  const maxUploadMb = Number.parseInt(els.maxUploadMbInput.value, 10);
  const provider = els.meetingLlmProviderSelect.value as MeetingLlmProvider;
  const meetingLlmModel = coerceMeetingLlmModelForProvider(
    provider,
    els.meetingLlmModelSelect.value || defaultMeetingLlmModelForProvider(provider),
  );
  await saveSettings({
    ...settings,
    meetingLlmProvider: provider,
    meetingNotesEnabled: els.meetingNotesEnabledInput.checked,
    meetingAskEnabled: els.meetingAskEnabledInput.checked,
    meetingLlmModel,
    ollamaUrl: els.ollamaUrlInput.value.trim() || DEFAULT_OLLAMA_URL,
    ollamaModel: provider === "ollama" ? meetingLlmModel : settings.ollamaModel,
    deleteAudioAfterTranscription: els.deleteAudioInput.checked,
    maxUploadMb: Number.isFinite(maxUploadMb) ? maxUploadMb : DEFAULT_MAX_UPLOAD_MB,
  });
  updateOllamaFieldsVisibility(els);
  setSaveStatus(els, "AI & storage settings saved.", false);
}

async function saveMeetingLlmProvider(els: SettingsFormElements): Promise<void> {
  await saveMeetingAiSettings(els);
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
  const maxUploadMb = Number.parseInt(els.maxUploadMbInput.value, 10);
  const provider =
    (els.meetingLlmProviderSelect.value as MeetingLlmProvider) ??
    settings.meetingLlmProvider;
  const meetingLlmModel = coerceMeetingLlmModelForProvider(
    provider,
    els.meetingLlmModelSelect.value || defaultMeetingLlmModelForProvider(provider),
  );
  await saveSettings({
    apiUrl: els.apiUrlInput.value.replace(/\/$/, ""),
    apiToken: els.apiTokenInput.value,
    transcriptionModel,
    captureMode,
    meetingLlmProvider: provider,
    meetingNotesEnabled: els.meetingNotesEnabledInput.checked,
    meetingAskEnabled: els.meetingAskEnabledInput.checked,
    meetingLlmModel,
    ollamaUrl: els.ollamaUrlInput.value.trim() || DEFAULT_OLLAMA_URL,
    ollamaModel: provider === "ollama" ? meetingLlmModel : settings.ollamaModel,
    deleteAudioAfterTranscription: els.deleteAudioInput.checked,
    maxUploadMb: Number.isFinite(maxUploadMb) ? maxUploadMb : DEFAULT_MAX_UPLOAD_MB,
    microphoneDeviceId: els.micDeviceSelect.disabled
      ? settings.microphoneDeviceId
      : els.micDeviceSelect.value || undefined,
  });
  await saveOpenAiApiKey(els.openaiApiKeyInput.value);
  setSaveStatus(els, "Connection settings saved.", false);
}

function setSaveStatus(els: SettingsFormElements, text: string, isError: boolean): void {
  els.saveStatus.textContent = text;
  els.saveStatus.classList.remove("hidden", "save-status--error", "save-status--ok");
  els.saveStatus.classList.add(isError ? "save-status--error" : "save-status--ok");
}

import { listAudioInputDevices, type AudioInputDevice } from "./audio-devices.js";
import {
  listMicDevicesViaBackground,
  micDevicesLookGranted,
  openExtensionMicSettings,
  requestMicAccessViaBackground,
} from "./mic-access.js";
import {
  isOllamaModelInstalled,
  listOllamaModelsFromUrl,
  pickOllamaModel,
} from "./ollama-models.js";
import {
  getSettings,
  getOpenAiApiKey,
  getOpenRouterApiKey,
  saveOpenAiApiKey,
  saveOpenRouterApiKey,
  saveSettings,
} from "./storage.js";
import {
  AUDIO_CAPTURE_MODES,
  audioCaptureModeLabel,
  DEFAULT_MAX_UPLOAD_MB,
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_OLLAMA_URL,
  coerceMeetingLlmModelForProvider,
  coerceTranscriptionModelForProvider,
  defaultMeetingLlmModelForProvider,
  dualTrackTranscriptionModelForProvider,
  effectiveTranscriptionProvider,
  isDiarizeTranscriptionModel,
  meetingLlmModelLabel,
  meetingLlmModelsForProvider,
  MEETING_LLM_PROVIDERS,
  meetingLlmProviderLabel,
  transcriptionModelLabel,
  transcriptionModelsForProvider,
  type AudioCaptureMode,
  type MeetingLlmProvider,
  type TranscriptionModel,
} from "@cognium/meet-shared";

interface SettingsSnapshot {
  apiUrl: string;
  apiToken: string;
  openaiApiKey: string;
  openRouterApiKey: string;
  transcriptionModel: string;
  captureMode: string;
  meetingLlmProvider: string;
  meetingNotesEnabled: boolean;
  meetingAskEnabled: boolean;
  meetingLlmModel: string;
  ollamaUrl: string;
  deleteAudioAfterTranscription: boolean;
  maxUploadMb: string;
}

let savedSnapshot: SettingsSnapshot | null = null;

function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function normalizeMaxUploadMb(raw: string): string {
  const parsed = Number.parseInt(raw, 10);
  return String(Number.isFinite(parsed) ? parsed : DEFAULT_MAX_UPLOAD_MB);
}

function setFieldStatus(
  el: HTMLElement,
  text: string,
  isError: boolean,
): void {
  if (!text) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("field-status--error", "field-status--ok");
    return;
  }
  el.textContent = text;
  el.classList.remove("hidden", "field-status--error", "field-status--ok");
  el.classList.add(isError ? "field-status--error" : "field-status--ok");
}

function readFormSnapshot(els: SettingsFormElements): SettingsSnapshot {
  return {
    apiUrl: normalizeApiUrl(els.apiUrlInput.value),
    apiToken: els.apiTokenInput.value,
    openaiApiKey: els.openaiApiKeyInput.value,
    openRouterApiKey: els.openRouterApiKeyInput.value,
    transcriptionModel: els.transcriptionModelSelect.value,
    captureMode: els.captureModeSelect.value,
    meetingLlmProvider: els.meetingLlmProviderSelect.value,
    meetingNotesEnabled: els.meetingNotesEnabledInput.checked,
    meetingAskEnabled: els.meetingAskEnabledInput.checked,
    meetingLlmModel: els.meetingLlmModelSelect.value,
    ollamaUrl: els.ollamaUrlInput.value.trim() || DEFAULT_OLLAMA_URL,
    deleteAudioAfterTranscription: els.deleteAudioInput.checked,
    maxUploadMb: normalizeMaxUploadMb(els.maxUploadMbInput.value),
  };
}

function isSettingsDirty(els: SettingsFormElements): boolean {
  if (!savedSnapshot) {
    return false;
  }
  const cur = readFormSnapshot(els);
  return (
    cur.apiUrl !== savedSnapshot.apiUrl ||
    cur.apiToken !== savedSnapshot.apiToken ||
    cur.openaiApiKey !== savedSnapshot.openaiApiKey ||
    cur.openRouterApiKey !== savedSnapshot.openRouterApiKey ||
    cur.transcriptionModel !== savedSnapshot.transcriptionModel ||
    cur.captureMode !== savedSnapshot.captureMode ||
    cur.meetingLlmProvider !== savedSnapshot.meetingLlmProvider ||
    cur.meetingNotesEnabled !== savedSnapshot.meetingNotesEnabled ||
    cur.meetingAskEnabled !== savedSnapshot.meetingAskEnabled ||
    cur.meetingLlmModel !== savedSnapshot.meetingLlmModel ||
    cur.ollamaUrl !== savedSnapshot.ollamaUrl ||
    cur.deleteAudioAfterTranscription !==
      savedSnapshot.deleteAudioAfterTranscription ||
    cur.maxUploadMb !== savedSnapshot.maxUploadMb
  );
}

function updateSettingsSaveUi(els: SettingsFormElements): void {
  const dirty = isSettingsDirty(els);
  els.saveBtn.disabled = !dirty;
  if (dirty) {
    setFieldStatus(els.settingsSaveStatus, "", false);
    setFieldStatus(els.meetingAiStatus, "", false);
  }
}

function snapshotSettingsFields(els: SettingsFormElements): void {
  savedSnapshot = readFormSnapshot(els);
  updateSettingsSaveUi(els);
}

function bindSettingsDirtyTracking(els: SettingsFormElements): void {
  const onEdit = () => updateSettingsSaveUi(els);
  const textInputs: HTMLInputElement[] = [
    els.apiUrlInput,
    els.apiTokenInput,
    els.openaiApiKeyInput,
    els.openRouterApiKeyInput,
    els.ollamaUrlInput,
    els.maxUploadMbInput,
  ];
  for (const input of textInputs) {
    input.addEventListener("input", onEdit);
    input.addEventListener("change", onEdit);
  }
  const selects: HTMLSelectElement[] = [
    els.transcriptionModelSelect,
    els.captureModeSelect,
    els.meetingLlmProviderSelect,
    els.meetingLlmModelSelect,
  ];
  for (const select of selects) {
    select.addEventListener("change", onEdit);
  }
  for (const checkbox of [
    els.meetingNotesEnabledInput,
    els.meetingAskEnabledInput,
    els.deleteAudioInput,
  ]) {
    checkbox.addEventListener("change", onEdit);
  }
}

export interface SettingsFormElements {
  apiUrlInput: HTMLInputElement;
  apiTokenInput: HTMLInputElement;
  tokenToggleBtn: HTMLButtonElement;
  openaiApiKeyInput: HTMLInputElement;
  openaiKeyToggleBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  settingsSaveStatus: HTMLElement;
  meetingAiStatus: HTMLElement;
  micSaveStatus: HTMLElement;
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
  openRouterApiKeyInput: HTMLInputElement;
  openRouterKeyToggleBtn: HTMLButtonElement;
  openRouterFields: HTMLElement;
  openaiFields: HTMLElement;
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
    settingsSaveStatus: root.querySelector("#settings-save-status") as HTMLElement,
    meetingAiStatus: root.querySelector("#meeting-ai-status") as HTMLElement,
    micSaveStatus: root.querySelector("#mic-save-status") as HTMLElement,
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
    openRouterApiKeyInput: root.querySelector(
      "#openrouter-api-key",
    ) as HTMLInputElement,
    openRouterKeyToggleBtn: root.querySelector(
      "#openrouter-key-toggle",
    ) as HTMLButtonElement,
    openRouterFields: root.querySelector("#openrouter-fields") as HTMLElement,
    openaiFields: root.querySelector("#openai-fields") as HTMLElement,
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
  const [openaiApiKey, openRouterApiKey] = await Promise.all([
    getOpenAiApiKey(),
    getOpenRouterApiKey(),
  ]);

  els.apiUrlInput.value = settings.apiUrl;
  els.apiTokenInput.value = settings.apiToken;
  els.openaiApiKeyInput.value = openaiApiKey ?? "";
  els.openRouterApiKeyInput.value = openRouterApiKey ?? "";
  populateCaptureModes(els, settings.captureMode);
  populateMeetingLlmProviders(els, settings.meetingLlmProvider);
  const llmProvider = settings.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER;
  populateTranscriptionModels(
    els,
    llmProvider,
    settings.transcriptionModel,
    settings.captureMode,
  );
  const savedLlmModel =
    settings.meetingLlmModel ??
    (llmProvider === "ollama" ? settings.ollamaModel : undefined) ??
    defaultMeetingLlmModelForProvider(llmProvider);
  els.ollamaUrlInput.value = settings.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  let ollamaModelCoerced = false;
  if (llmProvider === "ollama") {
    ollamaModelCoerced = await refreshOllamaModelOptions(els, savedLlmModel);
  } else {
    populateMeetingLlmModels(els, llmProvider, savedLlmModel);
  }
  els.meetingNotesEnabledInput.checked = settings.meetingNotesEnabled !== false;
  els.meetingAskEnabledInput.checked = settings.meetingAskEnabled !== false;
  els.deleteAudioInput.checked = settings.deleteAudioAfterTranscription !== false;
  els.maxUploadMbInput.value = String(settings.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB);
  updateProviderFieldsVisibility(els);
  updateCaptureModeUi(els, settings.transcriptionModel);
  snapshotSettingsFields(els);
  // Keep Save enabled when load-time Ollama fallback differs from stored model.
  if (ollamaModelCoerced && savedSnapshot) {
    savedSnapshot = { ...savedSnapshot, meetingLlmModel: savedLlmModel };
    updateSettingsSaveUi(els);
  }
  bindSettingsDirtyTracking(els);

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

  els.openRouterKeyToggleBtn.addEventListener("click", () => {
    const showing = els.openRouterApiKeyInput.type === "text";
    els.openRouterApiKeyInput.type = showing ? "password" : "text";
    els.openRouterKeyToggleBtn.textContent = showing ? "Show" : "Hide";
    els.openRouterKeyToggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
  });

  els.saveBtn.addEventListener("click", () => void saveAllSettings(els));
  els.micBtn.addEventListener("click", () => void requestMic(els));
  els.micSettingsBtn.addEventListener("click", () => openExtensionMicSettings());
  // Microphone keeps independent save — not part of the Save settings button.
  els.micDeviceSelect.addEventListener("change", () => void saveMicDevice(els));
  els.captureModeSelect.addEventListener("change", () => {
    updateCaptureModeUi(els);
    updateSettingsSaveUi(els);
  });
  els.meetingLlmProviderSelect.addEventListener("change", () => {
    const provider = els.meetingLlmProviderSelect.value as MeetingLlmProvider;
    updateProviderFieldsVisibility(els);
    const captureMode = els.captureModeSelect.value as AudioCaptureMode;
    populateTranscriptionModels(
      els,
      provider,
      els.transcriptionModelSelect.value as TranscriptionModel,
      captureMode,
    );
    updateCaptureModeUi(els);
    if (provider === "ollama") {
      void refreshOllamaModelOptions(
        els,
        defaultMeetingLlmModelForProvider("ollama"),
      ).then(() => updateSettingsSaveUi(els));
    } else {
      populateMeetingLlmModels(
        els,
        provider,
        defaultMeetingLlmModelForProvider(provider),
      );
      updateSettingsSaveUi(els);
    }
  });
  els.ollamaUrlInput.addEventListener("change", () => {
    if (els.meetingLlmProviderSelect.value === "ollama") {
      void refreshOllamaModelOptions(els, els.meetingLlmModelSelect.value).then(
        () => updateSettingsSaveUi(els),
      );
    }
  });

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
        setFieldStatus(els.micSaveStatus, lastError || "Could not open microphone", true);
      } else {
        setFieldStatus(els.micSaveStatus, "", false);
      }
      return;
    }

    setMicBadge(els, "granted");
    setFieldStatus(els.micSaveStatus, "Microphone allowed — choose your device below.", false);
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
  setFieldStatus(els.micSaveStatus, "Microphone device saved.", false);
}

function populateTranscriptionModels(
  els: SettingsFormElements,
  meetingProvider: MeetingLlmProvider,
  selected?: TranscriptionModel | string,
  captureMode?: AudioCaptureMode,
): void {
  const sttProvider = effectiveTranscriptionProvider(meetingProvider);
  const models = transcriptionModelsForProvider(sttProvider);
  els.transcriptionModelSelect.innerHTML = "";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = transcriptionModelLabel(model);
    els.transcriptionModelSelect.appendChild(option);
  }

  const dual = captureMode === "dual-track";
  const effective = coerceTranscriptionModelForProvider(meetingProvider, selected, {
    dualTrack: dual,
  });
  els.transcriptionModelSelect.value = effective;
  applyTranscriptionModelAvailability(els, meetingProvider, dual);
}

function applyTranscriptionModelAvailability(
  els: SettingsFormElements,
  meetingProvider: MeetingLlmProvider,
  dual: boolean,
): void {
  const sttProvider = effectiveTranscriptionProvider(meetingProvider);
  for (const option of els.transcriptionModelSelect.options) {
    const hideDiarize = dual || sttProvider !== "openai";
    const isDiarize = isDiarizeTranscriptionModel(option.value);
    option.disabled = hideDiarize && isDiarize;
    option.hidden = hideDiarize && isDiarize;
  }

  if (dual) {
    els.transcriptionModelSelect.value =
      dualTrackTranscriptionModelForProvider(meetingProvider);
    els.transcriptionModelSelect.disabled = true;
    els.transcriptionModelSelect.setAttribute(
      "aria-description",
      "Dual-track always uses a Whisper-class model for You and Others labels",
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
  installedOllamaModels?: string[],
): void {
  if (provider === "ollama" && installedOllamaModels && installedOllamaModels.length > 0) {
    const fallback = defaultMeetingLlmModelForProvider("ollama");
    const effective = pickOllamaModel(installedOllamaModels, selected, fallback);

    els.meetingLlmModelSelect.innerHTML = "";
    for (const model of installedOllamaModels) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      els.meetingLlmModelSelect.appendChild(option);
    }
    els.meetingLlmModelSelect.value = effective;
    return;
  }

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

/** @returns true when the UI model was changed because savedModel is not installed. */
async function refreshOllamaModelOptions(
  els: SettingsFormElements,
  savedModel?: string,
): Promise<boolean> {
  const url = els.ollamaUrlInput.value.trim() || DEFAULT_OLLAMA_URL;
  try {
    const installed = await listOllamaModelsFromUrl(url);
    const fallback = defaultMeetingLlmModelForProvider("ollama");
    const selected = pickOllamaModel(installed, savedModel, fallback);
    populateMeetingLlmModels(els, "ollama", selected, installed);
    if (savedModel && !isOllamaModelInstalled(installed, savedModel)) {
      setFieldStatus(
        els.meetingAiStatus,
        `Model "${savedModel}" is not installed — using ${selected}. Save settings to keep this.`,
        true,
      );
      return true;
    }
    setFieldStatus(els.meetingAiStatus, "", false);
    return false;
  } catch {
    populateMeetingLlmModels(els, "ollama", savedModel);
    return false;
  }
}

function updateCaptureModeUi(
  els: SettingsFormElements,
  savedTranscriptionModel?: TranscriptionModel,
): void {
  const dual = els.captureModeSelect.value === "dual-track";
  const meetingProvider = els.meetingLlmProviderSelect.value as MeetingLlmProvider;
  els.dualTrackNote.classList.toggle("hidden", !dual);
  els.micHint.textContent = dual
    ? "Tab and mic are recorded as separate files. Your mic is labeled You; tab audio is Others. Allow mic and pick a device below."
    : "Tab audio is always recorded. Your mic is mixed in so your voice is included. Chrome ignores Linux/GNOME input settings — pick the device below.";

  applyTranscriptionModelAvailability(els, meetingProvider, dual);
  if (!dual && savedTranscriptionModel) {
    const coerced = coerceTranscriptionModelForProvider(
      meetingProvider,
      savedTranscriptionModel,
    );
    els.transcriptionModelSelect.value = coerced;
  } else if (!dual) {
    const current = els.transcriptionModelSelect.value;
    els.transcriptionModelSelect.value = coerceTranscriptionModelForProvider(
      meetingProvider,
      current,
    );
  }
}

function updateProviderFieldsVisibility(els: SettingsFormElements): void {
  const provider = els.meetingLlmProviderSelect.value;
  // OpenAI key is needed for STT when Meeting AI is OpenAI or Ollama (no local STT).
  els.openaiFields.classList.toggle(
    "hidden",
    provider !== "openai" && provider !== "ollama",
  );
  els.ollamaFields.classList.toggle("hidden", provider !== "ollama");
  els.openRouterFields.classList.toggle("hidden", provider !== "openrouter");
}

/** Saves all settings except Microphone (mic has its own independent save). */
async function saveAllSettings(els: SettingsFormElements): Promise<void> {
  if (!isSettingsDirty(els)) {
    return;
  }

  els.saveBtn.disabled = true;
  try {
    const settings = await getSettings();
    const maxUploadMb = Number.parseInt(els.maxUploadMbInput.value, 10);
    const provider = els.meetingLlmProviderSelect.value as MeetingLlmProvider;
    const meetingLlmModel = coerceMeetingLlmModelForProvider(
      provider,
      els.meetingLlmModelSelect.value ||
        defaultMeetingLlmModelForProvider(provider),
    );
    const captureMode = els.captureModeSelect.value as AudioCaptureMode;
    const transcriptionModel = coerceTranscriptionModelForProvider(
      provider,
      els.transcriptionModelSelect.value,
      { dualTrack: captureMode === "dual-track" },
    );

    await saveSettings({
      ...settings,
      apiUrl: normalizeApiUrl(els.apiUrlInput.value),
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
      maxUploadMb: Number.isFinite(maxUploadMb)
        ? maxUploadMb
        : DEFAULT_MAX_UPLOAD_MB,
    });
    await Promise.all([
      saveOpenAiApiKey(els.openaiApiKeyInput.value),
      saveOpenRouterApiKey(els.openRouterApiKeyInput.value),
    ]);

    updateProviderFieldsVisibility(els);
    snapshotSettingsFields(els);
    setFieldStatus(els.settingsSaveStatus, "Settings saved.", false);
    setFieldStatus(els.meetingAiStatus, "", false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setFieldStatus(els.settingsSaveStatus, message || "Could not save settings", true);
    updateSettingsSaveUi(els);
  }
}

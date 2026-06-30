import type { AudioInputDevice } from "./audio-devices.js";

/** Extensions use chrome-extension://… — not the website microphone list. */
export function extensionMicSettingsUrl(): string {
  const site = `chrome-extension://${chrome.runtime.id}`;
  return `chrome://settings/content/siteDetails?site=${encodeURIComponent(site)}`;
}

export function openExtensionMicSettings(): void {
  void chrome.tabs.create({ url: extensionMicSettingsUrl() });
}

export async function listMicDevicesViaBackground(): Promise<AudioInputDevice[]> {
  const response = (await chrome.runtime.sendMessage({
    type: "LIST_MIC_DEVICES",
  })) as { devices?: AudioInputDevice[]; error?: string } | undefined;

  if (!response) {
    throw new Error("No response from background worker");
  }
  if (response.error) {
    throw new Error(response.error);
  }
  return response.devices ?? [];
}

export async function requestMicAccessViaBackground(
  deviceId?: string,
): Promise<{ ok: boolean; error?: string; label?: string }> {
  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_MIC_ACCESS",
    deviceId,
  })) as { ok?: boolean; error?: string; label?: string } | undefined;

  if (!response) {
    return { ok: false, error: "No response from background worker" };
  }
  return {
    ok: Boolean(response.ok),
    error: response.error,
    label: response.label,
  };
}

export function micDevicesLookGranted(devices: AudioInputDevice[]): boolean {
  return devices.some((device) => device.label && !device.label.startsWith("Microphone "));
}

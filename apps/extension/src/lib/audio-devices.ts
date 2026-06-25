export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export function buildMicConstraints(deviceId?: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }

  return { audio, video: false };
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId.length > 0)
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
    }));
}

export async function openMicStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId));
}

export function micTrackLabel(stream: MediaStream | null): string | undefined {
  return stream?.getAudioTracks()[0]?.label;
}
